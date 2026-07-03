/**
 * RecubeApiClient personal-branch methods : provision/{me,overlay,merge}.
 * Same `vi.stubGlobal('fetch', ...)` pattern as tests/versions-fallback.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RecubeApiClient } from '../src/lib/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mkApi(): RecubeApiClient {
  return new RecubeApiClient({ apiBase: 'https://recube.gg/api/v1', token: 'tkn' });
}

describe('provisionBranch', () => {
  it('reports created=true on 201', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { id: 1, tenant: 'ng', name: 'dev-alice', base_channel_name: 'stable' } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const { branch, created } = await mkApi().provisionBranch('ng', { base: 'stable' });
    expect(created).toBe(true);
    expect(branch.name).toBe('dev-alice');
  });

  it('reports created=false on 200 (idempotent re-provision)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { id: 1, tenant: 'ng', name: 'dev-alice', base_channel_name: 'stable' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const { created } = await mkApi().provisionBranch('ng', {});
    expect(created).toBe(false);
  });

  it('throws ApiError on 422 (base_not_ready)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'no live build', error: 'base_not_ready' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(mkApi().provisionBranch('ng', { base: 'beta' })).rejects.toThrow(ApiError);
  });
});

describe('getMyBranch', () => {
  it('returns the branch payload with overlay on 200', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            id: 1,
            tenant: 'ng',
            name: 'dev-alice',
            overlay_rev: 3,
            overlay: [{ path: 'mods/x.jar', action: 'add', sha256: 'a'.repeat(64), size: 10 }],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const branch = await mkApi().getMyBranch('ng');
    expect(branch?.name).toBe('dev-alice');
    expect(branch?.overlay).toHaveLength(1);
  });

  it('returns null on 404 (not provisioned)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'No personal branch' }), { status: 404 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const branch = await mkApi().getMyBranch('ng');
    expect(branch).toBeNull();
  });

  it('rethrows non-404 errors', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(mkApi().getMyBranch('ng')).rejects.toThrow(ApiError);
  });
});

describe('overlay initiate/put/remove', () => {
  it('initiateBranchOverlay returns an upload slot', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { action: 'upload', path: 'mods/x.jar', sha256: 'a'.repeat(64), size: 10, upload_url: 'https://r2/x' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const slot = await mkApi().initiateBranchOverlay('ng', { path: 'mods/x.jar', sha256: 'a'.repeat(64), size: 10 });
    expect(slot.action).toBe('upload');
    expect(slot.upload_url).toBe('https://r2/x');
  });

  it('putBranchOverlay returns the recompose outcome', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { overlay: { path: 'mods/x.jar', action: 'add' }, recomposed: true, build_id: 'b1' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await mkApi().putBranchOverlay('ng', {
      path: 'mods/x.jar',
      sha256: 'a'.repeat(64),
      size: 10,
    });
    expect(out.overlay.action).toBe('add');
    expect(out.recomposed).toBe(true);
    expect(out.build_id).toBe('b1');
  });

  it('removeBranchOverlay sends a DELETE with a JSON body', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('DELETE');
      expect(JSON.parse(String(init?.body))).toEqual({ path: 'mods/old.jar' });
      return new Response(
        JSON.stringify({ data: { overlay: { path: 'mods/old.jar', action: 'remove' }, recomposed: true } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await mkApi().removeBranchOverlay('ng', 'mods/old.jar');
    expect(out.overlay.action).toBe('remove');
  });
});

describe('mergeBranch', () => {
  it('posts { into, version? } and returns the merge result', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      expect(url).toContain('/launcher/ng/branches/me/merge');
      expect(JSON.parse(String(init?.body))).toEqual({ into: 'beta', version: '1.2.0' });
      return new Response(JSON.stringify({ data: { into: 'beta', build_id: 'b2' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await mkApi().mergeBranch('ng', { into: 'beta', version: '1.2.0' });
    expect(res.into).toBe('beta');
    expect(res.build_id).toBe('b2');
  });

  it('surfaces a 422 version_collision as an ApiError', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'already published', error: 'version_collision' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(mkApi().mergeBranch('ng', { into: 'beta', version: '1.0.0' })).rejects.toMatchObject({
      status: 422,
    });
  });
});
