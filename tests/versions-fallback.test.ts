/**
 * Verifies the listVersions cascade :
 *   1. admin endpoint returns data
 *   2. admin 403 → branch-history endpoint
 *   3. all 404 → fallback to listChannelsForTenant (synthesize latest)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecubeApiClient } from '../src/lib/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mkApi(): RecubeApiClient {
  return new RecubeApiClient({ apiBase: 'https://recube.gg/api/v1', token: 'tkn' });
}

describe('listVersions cascade', () => {
  it('returns admin endpoint result when accessible', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/admin/games/ng/versions')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: '1', version: '1.0.0', channel: 'stable' },
              { id: '2', version: '1.0.1', channel: 'stable' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`unexpected: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { versions, adminDenied } = await mkApi().listVersions('ng');
    expect(adminDenied).toBe(false);
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe('1.0.0');
  });

  it('falls back to per-branch history on admin 403', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/admin/games/ng/versions')) {
        return new Response('forbidden', { status: 403 });
      }
      if (url.includes('/games/ng/branches/stable/versions')) {
        return new Response(
          JSON.stringify({
            data: [{ id: '1', version: '1.0.5', channel: 'stable' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`unexpected: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { versions, adminDenied } = await mkApi().listVersions('ng', 'stable');
    expect(adminDenied).toBe(true);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe('1.0.5');
  });

  it('synthesizes from branches when all version endpoints 404', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/admin/games/ng/versions')) {
        return new Response('not found', { status: 404 });
      }
      if (url.includes('/games/ng/branches/stable/versions')) {
        return new Response('not found', { status: 404 });
      }
      if (url.endsWith('/games/ng/branches')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'b1', name: 'stable', latest_version: '1.0.9' },
              { id: 'b2', name: 'beta', latest_version: '1.1.0-rc1' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`unexpected: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { versions, adminDenied } = await mkApi().listVersions('ng', 'stable');
    expect(adminDenied).toBe(false);
    expect(versions).toHaveLength(1);
    expect(versions[0].channel).toBe('stable');
    expect(versions[0].version).toBe('1.0.9');
  });

  it('returns adminDenied=true when admin 401 + nothing else exists', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/admin/games/ng/versions')) {
        return new Response('unauthorized', { status: 401 });
      }
      if (url.endsWith('/games/ng/branches')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { versions, adminDenied } = await mkApi().listVersions('ng');
    expect(adminDenied).toBe(true);
    expect(versions).toHaveLength(0);
  });

  it('synthesizes from latest_version object when not a string', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/admin/games/ng/versions')) {
        return new Response('forbidden', { status: 403 });
      }
      if (url.endsWith('/games/ng/branches')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'b1', name: 'stable', latest_version: { version: '2.0.0' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`unexpected: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { versions, adminDenied } = await mkApi().listVersions('ng');
    expect(adminDenied).toBe(true);
    expect(versions[0].version).toBe('2.0.0');
  });
});
