import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GAME_BUNDLE_EXCLUDES,
  buildLocalManifest,
  hashFile,
  matchesExclude,
  publishBuild,
  scanBundle,
} from '../src/lib/publish-pipeline.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtempInOs();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  vi.unstubAllGlobals();
});

async function mkdtempInOs(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(os.tmpdir(), 'recube-cli-test-'));
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

describe('matchesExclude', () => {
  it('matches dir prefix (logs/)', () => {
    expect(matchesExclude('logs/today.log', ['logs/'])).toBe(true);
    expect(matchesExclude('config/logs.json', ['logs/'])).toBe(false);
  });

  it('matches basename glob (*.log)', () => {
    expect(matchesExclude('foo/bar/baz.log', ['*.log'])).toBe(true);
    expect(matchesExclude('foo/bar/baz.txt', ['*.log'])).toBe(false);
  });

  it('matches exact path', () => {
    expect(matchesExclude('snoopers.json', ['snoopers.json'])).toBe(true);
    expect(matchesExclude('extra/snoopers.json', ['snoopers.json'])).toBe(false);
  });

  it('applies default exclude set on typical Minecraft tree', () => {
    expect(matchesExclude('logs/latest.log', DEFAULT_GAME_BUNDLE_EXCLUDES)).toBe(true);
    expect(matchesExclude('crash-reports/2026.txt', DEFAULT_GAME_BUNDLE_EXCLUDES)).toBe(true);
    expect(matchesExclude('java/bin/java', DEFAULT_GAME_BUNDLE_EXCLUDES)).toBe(true);
    expect(matchesExclude('mods/recube-core.jar', DEFAULT_GAME_BUNDLE_EXCLUDES)).toBe(false);
  });
});

describe('scanBundle', () => {
  it('lists files recursively and applies excludes', async () => {
    await writeTree(tmp, {
      'mods/recube-core.jar': 'jar',
      'config/options.txt': 'opt',
      'logs/latest.log': 'log',
      'crash-reports/c.txt': 'crash',
      '.cache/x.bin': 'cache',
    });
    const found = await scanBundle(tmp, DEFAULT_GAME_BUNDLE_EXCLUDES);
    const paths = found.map((f) => f.virtualPath).sort();
    expect(paths).toEqual(['config/options.txt', 'mods/recube-core.jar']);
  });
});

describe('hashFile', () => {
  it('hashes content deterministically', async () => {
    const abs = path.join(tmp, 'a.txt');
    await writeFile(abs, 'hello');
    const { sha256, size } = await hashFile(abs);
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(size).toBe(5);
  });
});

describe('buildLocalManifest', () => {
  it('sorts by virtual path and applies includes', async () => {
    await writeTree(tmp, {
      'b.txt': 'b',
      'a.txt': 'a',
    });
    // Place extra OUTSIDE the scanned tree so it only enters via --include
    // (otherwise scanBundle picks it up and duplicates the entry).
    const extraDir = await mkdtempInOs();
    const extra = path.join(extraDir, 'extra.bin');
    await writeFile(extra, 'X');

    try {
      const manifest = await buildLocalManifest(tmp, [], [{ path: extra, as: 'mods/extra.bin' }]);
      const paths = manifest.map((m) => m.path);
      // sorted alphabetically: a.txt, b.txt, mods/extra.bin
      expect(paths).toEqual(['a.txt', 'b.txt', 'mods/extra.bin']);
      expect(manifest[0].size).toBe(1);
    } finally {
      await rm(extraDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('publishBuild (mocked fetch)', () => {
  it('initiate → upload → commit happy path', async () => {
    await writeTree(tmp, {
      'a.txt': 'AAAA',
      'b.txt': 'BBBB',
    });

    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body });

      if (url.endsWith('/builds/initiate')) {
        const body = JSON.parse(String(init!.body)) as { files: { path: string }[] };
        return new Response(
          JSON.stringify({
            data: {
              version_id: 42,
              files: body.files.map(() => ({
                action: 'upload',
                upload_url: 'https://r2.example.com/upload/' + Math.random(),
                upload_method: 'PUT',
                upload_headers: {},
              })),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://r2.example.com/')) {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/builds/commit')) {
        return new Response(
          JSON.stringify({
            data: { build_id: 'build-123', manifest_sha256: 'deadbeef', version_id: 42 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishBuild({
      tenant: 'nationsglory',
      channel: 'stable',
      version: '1.0.1',
      dir: tmp,
      includes: [],
      excludes: [],
      note: 'test',
      concurrency: 2,
      initBatch: 50,
      apiBase: 'https://recube.gg/api/v1',
      token: 'tkn',
    });

    const result_typed = result as { build_id?: string; manifest_sha256?: string };
    expect(result_typed.build_id).toBe('build-123');
    expect(result_typed.manifest_sha256).toBe('deadbeef');

    // 1 initiate, 2 uploads, 1 commit
    expect(calls.filter((c) => c.url.endsWith('/builds/initiate'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith('https://r2.'))).toHaveLength(2);
    expect(calls.filter((c) => c.url.endsWith('/builds/commit'))).toHaveLength(1);
  });

  it('respects skip actions (no upload for already-known blobs)', async () => {
    await writeTree(tmp, {
      'a.txt': 'AAAA',
      'b.txt': 'BBBB',
    });

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.endsWith('/builds/initiate')) {
        const body = JSON.parse(String(init!.body)) as { files: { path: string }[] };
        return new Response(
          JSON.stringify({
            data: {
              version_id: 7,
              files: body.files.map((f) =>
                f.path === 'a.txt'
                  ? { action: 'skip' }
                  : { action: 'upload', upload_url: 'https://r2.example.com/x', upload_method: 'PUT' }
              ),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://r2.example.com/')) return new Response('', { status: 200 });
      if (url.endsWith('/builds/commit')) {
        return new Response(JSON.stringify({ data: { build_id: 'b', manifest_sha256: 's' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    let uploadCount = 0;
    await publishBuild({
      tenant: 'ng',
      channel: 'stable',
      version: '1',
      dir: tmp,
      includes: [],
      excludes: [],
      note: '',
      concurrency: 4,
      initBatch: 50,
      apiBase: 'https://recube.gg/api/v1',
      token: 'tkn',
      onProgress: (e) => {
        if (e.type === 'upload') uploadCount++;
      },
    });

    expect(uploadCount).toBe(1); // only b.txt uploaded, a.txt skipped
  });

  it('dry-run skips API calls entirely', async () => {
    await writeTree(tmp, { 'a.txt': 'x' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishBuild({
      tenant: 't',
      channel: 'c',
      version: 'v',
      dir: tmp,
      includes: [],
      excludes: [],
      note: 'n',
      concurrency: 1,
      initBatch: 50,
      apiBase: 'https://recube.gg/api/v1',
      token: 'tkn',
      dryRun: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((result as { dryRun?: boolean }).dryRun).toBe(true);
  });
});
