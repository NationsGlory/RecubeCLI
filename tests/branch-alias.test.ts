/**
 * `@me` channel alias resolution (src/lib/branch.ts), wired into
 * draft/promote/core/versions wherever a command takes -c/--channel.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecubeApiClient } from '../src/lib/api.js';
import { ME_ALIAS, NoPersonalBranchError, noBranchHint, resolveChannelAlias } from '../src/lib/branch.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mkApi(): RecubeApiClient {
  return new RecubeApiClient({ apiBase: 'https://recube.gg/api/v1', token: 'tkn' });
}

describe('resolveChannelAlias', () => {
  it('passes through any non-@me channel untouched (no network call)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveChannelAlias(mkApi(), 'ng', 'beta');
    expect(out).toBe('beta');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves @me to the real branch name', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: 1, tenant: 'ng', name: 'dev-alice' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveChannelAlias(mkApi(), 'ng', ME_ALIAS);
    expect(out).toBe('dev-alice');
  });

  it('throws NoPersonalBranchError when @me has no branch provisioned (404)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'none' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveChannelAlias(mkApi(), 'ng', ME_ALIAS)).rejects.toThrow(NoPersonalBranchError);
  });
});

describe('noBranchHint', () => {
  it('mentions the tenant and the create command', () => {
    const hint = noBranchHint('ng');
    expect(hint).toMatch(/ng/);
    expect(hint).toMatch(/recube branch create/);
  });
});
