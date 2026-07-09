/**
 * `--encrypt` on `recube branch overlay add <file>` : payload plumbing
 * (putBranchOverlay) + the 422 "no RecubeCore on this channel" rejection
 * message (explainBranchError, ctx 'overlay'). Mirrors
 * tests/branch-api.test.ts / tests/branch-error-format.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RecubeApiClient } from '../src/lib/api.js';
import { explainBranchError } from '../src/commands/branch.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mkApi(): RecubeApiClient {
  return new RecubeApiClient({ apiBase: 'https://recube.gg/api/v1', token: 'tkn' });
}

describe('putBranchOverlay encrypted flag', () => {
  it('includes encrypted:true in the request body when --encrypt is set', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.encrypted).toBe(true);
      return new Response(
        JSON.stringify({
          data: { overlay: { path: 'mods/x.jar', action: 'add', encrypted: true }, recomposed: true },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await mkApi().putBranchOverlay('ng', {
      path: 'mods/x.jar',
      sha256: 'a'.repeat(64),
      size: 10,
      exec: false,
      encrypted: true,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(out.overlay.encrypted).toBe(true);
  });
});

describe('encrypt rejection message', () => {
  it('surfaces a clear message on 422 encrypt-requires-recube-core', () => {
    const err = new ApiError(
      'RecubeCore requis',
      422,
      JSON.stringify({
        message: "Ce channel n'a pas RecubeCore actif : impossible de marquer un fichier chiffré.",
      })
    );

    const out = explainBranchError(err, 'overlay', 'ng');

    expect(out).toMatch(/RecubeCore/);
  });
});
