/**
 * Build publication pipeline.
 *
 * Port of g:/GitHub/RecubeGG/scripts/publish-version.mjs (the historical CI
 * script) — same protocol, but :
 *   - TypeScript with explicit types
 *   - Pluggable progress callback (so the CLI can drive @clack/prompts)
 *   - Pure functions wherever practical (testable without a real API)
 *   - Token passed explicitly instead of read from env
 *
 * Protocol summary (no change vs. original) :
 *   1. Scan --dir, apply excludes, optionally splice --include extras.
 *   2. Hash each file (sha256, size).
 *   3. POST /launcher/{tenant}/{channel}/builds/initiate in chunks of N — get
 *      presigned upload URLs (or "skip" actions for blobs already in R2).
 *   4. PUT blobs concurrently (default 8 workers).
 *   5. POST /launcher/{tenant}/{channel}/builds/commit with the final manifest.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  CommitResult,
  InitiateFileSlot,
  ManifestEntry,
  PublishOptions,
  PublishProgressEvent,
} from '../types.js';

export const DEFAULT_GAME_BUNDLE_EXCLUDES: string[] = [
  'logs/', 'crash-reports/', 'debug/',
  'cef_cache_MissingName/', 'ngcore_cache/',
  'java/', 'natives/', 'assets/',
  'saves/', 'versions/', 'stats/',
  'resourcepacks/', 'shaderpacks/',
  '*.log', '*.lck', '*.tmp', 'gc.log*',
  'ForgeModLoader-client-*', 'output-client.log*',
  'nbtmod.dat', 'snoopers.json',
];

const SKIP_BASENAMES = new Set(['.DS_Store', 'Thumbs.db']);

function shouldSkipBasename(name: string): boolean {
  if (SKIP_BASENAMES.has(name)) return true;
  if (name.endsWith('.tmp')) return true;
  if (name.startsWith('.')) return true;
  return false;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (const c of glob) {
    if (c === '*') re += '.*';
    else if (/[.+?^${}()|[\]\\]/.test(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

export function matchesExclude(virtualPath: string, patterns: string[]): boolean {
  const base = virtualPath.includes('/')
    ? virtualPath.slice(virtualPath.lastIndexOf('/') + 1)
    : virtualPath;
  for (const pat of patterns) {
    if (pat.endsWith('/')) {
      if (virtualPath.startsWith(pat)) return true;
      continue;
    }
    if (pat.includes('*')) {
      const re = globToRegExp(pat);
      if (pat.includes('/')) {
        if (re.test(virtualPath)) return true;
      } else {
        if (re.test(base)) return true;
      }
      continue;
    }
    if (virtualPath === pat) return true;
  }
  return false;
}

export async function scanBundle(
  root: string,
  excludes: string[]
): Promise<{ absPath: string; virtualPath: string }[]> {
  const out: { absPath: string; virtualPath: string }[] = [];
  // recursive: true requires Node 18.17+ — we declared engines >=20 so safe.
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const e of entries) {
    if (shouldSkipBasename(e.name)) continue;
    if (!e.isFile()) continue;
    // Node 20+ exposes parentPath ; some older Dirent variants used `path`.
    const parentDir =
      (e as unknown as { parentPath?: string }).parentPath ??
      (e as unknown as { path?: string }).path ??
      root;
    const abs = path.join(parentDir, e.name);
    const rel = path.relative(root, abs);
    if (rel.split(path.sep).some((seg) => shouldSkipBasename(seg))) continue;
    const virtualPath = toPosix(rel);
    if (matchesExclude(virtualPath, excludes)) continue;
    out.push({ absPath: abs, virtualPath });
  }
  return out;
}

export function hashFile(absPath: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let size = 0;
    const s = createReadStream(absPath);
    s.on('data', (chunk) => {
      h.update(chunk);
      size += (chunk as Buffer).length;
    });
    s.on('error', reject);
    s.on('end', () => resolve({ sha256: h.digest('hex'), size }));
  });
}

export async function buildLocalManifest(
  dir: string,
  excludes: string[],
  includes: { path: string; as?: string }[],
  onProgress?: (e: PublishProgressEvent) => void
): Promise<ManifestEntry[]> {
  const dirAbs = path.resolve(dir);
  const dirStat = await stat(dirAbs).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) {
    throw new Error(`dir is not a directory: ${dirAbs}`);
  }
  const scanned = await scanBundle(dirAbs, excludes);

  const extras: { absPath: string; virtualPath: string }[] = [];
  for (const inc of includes) {
    const abs = path.resolve(inc.path);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) {
      throw new Error(`--include is not a file: ${abs}`);
    }
    const virt = inc.as && inc.as !== '' ? inc.as : path.basename(abs);
    extras.push({ absPath: abs, virtualPath: toPosix(virt) });
  }

  const byVirtual = new Map<string, { absPath: string; virtualPath: string }>();
  for (const f of scanned) byVirtual.set(f.virtualPath, f);
  for (const f of extras) byVirtual.set(f.virtualPath, f);

  const list = [...byVirtual.values()].sort((a, b) =>
    a.virtualPath.localeCompare(b.virtualPath)
  );

  onProgress?.({ type: 'scan', total: list.length });

  const manifest: ManifestEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    onProgress?.({ type: 'hash', index: i + 1, total: list.length, path: f.virtualPath });
    const { sha256, size } = await hashFile(f.absPath);
    manifest.push({ path: f.virtualPath, sha256, size, _abs: f.absPath });
  }
  return manifest;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function postJsonRetry<T>(
  url: string,
  body: unknown,
  token: string,
  retries = 3,
  baseDelayMs = 500
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });
    if (res.ok) return (await res.json()) as T;
    const txt = await res.text();
    const transient = res.status === 502 || res.status === 503 || res.status === 504;
    if (!transient || attempt >= retries) {
      throw new Error(`POST ${url} -> ${res.status} ${res.statusText}: ${txt}`);
    }
    const delay = baseDelayMs * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, delay));
    attempt++;
  }
}

interface InitiateResponse {
  data?: {
    version_id?: string | number;
    files?: InitiateFileSlot[];
  };
}

async function uploadOne(
  file: ManifestEntry,
  slot: InitiateFileSlot
): Promise<void> {
  if (!slot.upload_url) throw new Error(`missing upload_url for ${file.path}`);
  const method = (slot.upload_method ?? 'PUT').toUpperCase();
  const headers: Record<string, string> = {
    ...(slot.upload_headers ?? {}),
    'Content-Length': String(file.size),
  };
  const stream = createReadStream(file._abs);
  const res = await fetch(slot.upload_url, {
    method,
    headers,
    // Node's undici fetch accepts a Readable as body when paired with
    // duplex: 'half' (RequestInit type does not yet expose duplex — cast).
    body: stream as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(
      `${method} ${slot.upload_url} -> ${res.status} ${res.statusText}: ${txt}`
    );
  }
}

async function runPool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  limit: number,
  onItemDone?: (index: number, total: number) => void
): Promise<{ index: number; error: Error }[]> {
  const errors: { index: number; error: Error }[] = [];
  let cursor = 0;
  let done = 0;
  const total = items.length;
  async function pump(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        await worker(items[i], i);
      } catch (err) {
        errors.push({ index: i, error: err as Error });
      } finally {
        done++;
        onItemDone?.(done, total);
      }
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => pump());
  await Promise.all(runners);
  return errors;
}

export async function publishBuild(opts: PublishOptions): Promise<CommitResult> {
  const manifest = await buildLocalManifest(
    opts.dir,
    opts.excludes,
    opts.includes,
    opts.onProgress
  );

  if (opts.dryRun) {
    return {
      dryRun: true,
      tenant: opts.tenant,
      channel: opts.channel,
      version: opts.version,
      files_count: manifest.length,
    } as CommitResult;
  }

  const base = opts.apiBase.replace(/\/+$/, '');
  const initUrl = `${base}/launcher/${encodeURIComponent(opts.tenant)}/${encodeURIComponent(opts.channel)}/builds/initiate`;
  const commitUrl = `${base}/launcher/${encodeURIComponent(opts.tenant)}/${encodeURIComponent(opts.channel)}/builds/commit`;

  const chunks = chunkArray(manifest, opts.initBatch);
  const allInitFiles: InitiateFileSlot[] = [];
  let versionId: string | number | null = null;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    opts.onProgress?.({
      type: 'initiate',
      batch: ci + 1,
      totalBatches: chunks.length,
      chunk: chunk.length,
    });
    const init = await postJsonRetry<InitiateResponse>(
      initUrl,
      {
        version: opts.version,
        files: chunk.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
      },
      opts.token
    );
    const slots = init?.data?.files;
    if (!Array.isArray(slots)) {
      throw new Error(`initiate response missing data.files: ${JSON.stringify(init)}`);
    }
    if (slots.length !== chunk.length) {
      throw new Error(
        `initiate chunk size mismatch batch=${ci + 1}: local=${chunk.length} remote=${slots.length}`
      );
    }
    const vid = init?.data?.version_id ?? null;
    if (versionId === null) versionId = vid;
    else if (vid !== null && vid !== versionId) {
      throw new Error(
        `race version creation: batch ${ci + 1} version_id=${vid} differs from ${versionId}`
      );
    }
    allInitFiles.push(...slots);
  }

  if (allInitFiles.length !== manifest.length) {
    throw new Error(
      `initiate aggregate count mismatch: local=${manifest.length} remote=${allInitFiles.length}`
    );
  }

  const toUpload: { file: ManifestEntry; slot: InitiateFileSlot }[] = [];
  for (let i = 0; i < allInitFiles.length; i++) {
    const slot = allInitFiles[i];
    const file = manifest[i];
    if (slot.action === 'skip') continue;
    if (slot.action !== 'upload') {
      throw new Error(`unknown action for ${file.path}: ${slot.action}`);
    }
    if (!slot.upload_url) throw new Error(`missing upload_url for ${file.path}`);
    toUpload.push({ file, slot });
  }

  const total = toUpload.length;
  const errors = await runPool(
    toUpload,
    async (item, _i) => {
      await uploadOne(item.file, item.slot);
    },
    opts.concurrency,
    (done, t) => {
      const item = toUpload[done - 1];
      opts.onProgress?.({
        type: 'upload',
        index: done,
        total: t,
        path: item?.file.path ?? '',
      });
    }
  );

  if (errors.length > 0) {
    const summary = errors
      .map(({ index, error }) => `[${index}] ${toUpload[index].file.path}: ${error.message}`)
      .join('\n');
    throw new Error(`${errors.length} upload(s) failed:\n${summary}`);
  }

  opts.onProgress?.({ type: 'commit', url: commitUrl });
  const commitRes = await postJsonRetry<{ data?: CommitResult } & CommitResult>(
    commitUrl,
    {
      version: opts.version,
      reference: opts.reference ?? `${opts.tenant}-${opts.version}-b${Date.now()}`,
      note: opts.note,
      files: manifest.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        size: f.size,
        exec: false,
      })),
    },
    opts.token
  );
  // unused helper to keep skipped count for callers (currently informative)
  void total;
  return (commitRes.data ?? commitRes) as CommitResult;
}
