/**
 * `draftFileCommit` — payload plumbing for the `--encrypt` flag (`recube draft
 * add <jar> --encrypt`). Same `vi.stubGlobal('fetch', ...)` pattern as
 * tests/branch-api.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecubeApiClient } from '../src/lib/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mkApi(): RecubeApiClient {
  return new RecubeApiClient({ apiBase: 'https://recube.gg/api/v1', token: 'tkn' });
}

describe('draftFileCommit encrypted flag', () => {
  it('includes encrypted:true in the request body when --encrypt is set', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.encrypted).toBe(true);
      return new Response(JSON.stringify({ data: { action: 'add', encrypted: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await mkApi().draftFileCommit('ng', 'beta', 'draft-1', {
      path: 'mods/x.jar',
      sha256: 'a'.repeat(64),
      size: 10,
      exec: false,
      encrypted: true,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(out.encrypted).toBe(true);
  });

  it('defaults encrypted to false when omitted (backward compat)', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.encrypted).toBe(false);
      return new Response(JSON.stringify({ data: { action: 'add' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await mkApi().draftFileCommit('ng', 'beta', 'draft-1', {
      path: 'mods/x.jar',
      sha256: 'a'.repeat(64),
      size: 10,
      exec: false,
      encrypted: false,
    });

    expect(fetchMock).toHaveBeenCalled();
  });
});
