/**
 * Verifies that `publishBuild` forwards `runtime_config` to the commit endpoint.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishBuild } from '../src/lib/publish-pipeline.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'recube-cli-rtcommit-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  vi.unstubAllGlobals();
});

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

describe('publishBuild runtime_config', () => {
  it('forwards runtime_config in commit body when provided', async () => {
    await writeTree(tmp, { 'a.txt': 'AAAA' });

    let commitBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/builds/initiate')) {
        const body = JSON.parse(String(init!.body)) as { files: { path: string }[] };
        return new Response(
          JSON.stringify({
            data: {
              version_id: 1,
              files: body.files.map(() => ({
                action: 'upload',
                upload_url: 'https://r2.example.com/x',
                upload_method: 'PUT',
              })),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://r2.example.com/')) return new Response('', { status: 200 });
      if (url.endsWith('/builds/commit')) {
        commitBody = JSON.parse(String(init!.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: { build_id: 'b', manifest_sha256: 's' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await publishBuild({
      tenant: 'ng',
      channel: 'stable',
      version: '1',
      dir: tmp,
      includes: [],
      excludes: [],
      note: '',
      concurrency: 1,
      initBatch: 50,
      apiBase: 'https://recube.gg/api/v1',
      token: 'tkn',
      runtimeConfig: {
        main_class: 'Start',
        java_version: 21,
        jvm_args: ['-Xmx2G'],
      },
    });

    expect(commitBody).not.toBeNull();
    expect(commitBody!.runtime_config).toEqual({
      main_class: 'Start',
      java_version: 21,
      jvm_args: ['-Xmx2G'],
    });
  });

  it('omits runtime_config in commit body when not provided', async () => {
    await writeTree(tmp, { 'a.txt': 'AAAA' });

    let commitBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/builds/initiate')) {
        const body = JSON.parse(String(init!.body)) as { files: { path: string }[] };
        return new Response(
          JSON.stringify({
            data: {
              version_id: 1,
              files: body.files.map(() => ({
                action: 'upload',
                upload_url: 'https://r2.example.com/x',
                upload_method: 'PUT',
              })),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://r2.example.com/')) return new Response('', { status: 200 });
      if (url.endsWith('/builds/commit')) {
        commitBody = JSON.parse(String(init!.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: { build_id: 'b' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await publishBuild({
      tenant: 'ng',
      channel: 'stable',
      version: '1',
      dir: tmp,
      includes: [],
      excludes: [],
      note: '',
      concurrency: 1,
      initBatch: 50,
      apiBase: 'https://recube.gg/api/v1',
      token: 'tkn',
    });

    expect(commitBody).not.toBeNull();
    expect(commitBody!.runtime_config).toBeUndefined();
  });
});
