/**
 * Pure draft-target resolution (src/lib/draft-target.ts) — the shared logic
 * behind `draft rm/diff/status/publish/use`. No session/network : the API is a
 * mockable {getDraft, listDrafts} surface and the local pointer is an injected
 * loader, mirroring tests/merge-source-routing.test.ts / branch-alias.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DraftTargetError,
  resolveDraftTarget,
  type DraftResolverApi,
} from '../src/lib/draft-target.js';
import type { Draft, DraftState } from '../src/types.js';

function mkApi(over: Partial<DraftResolverApi> = {}): DraftResolverApi {
  return {
    getDraft: vi.fn(async () => ({ id: 'd1', status: 'open' }) as Draft),
    listDrafts: vi.fn(async () => [] as Draft[]),
    ...over,
  };
}

const noLocal = async (): Promise<DraftState | null> => null;

describe('resolveDraftTarget — explicit --draft', () => {
  it('fetches the draft via getDraft when draft + tenant + channel are given', async () => {
    const getDraft = vi.fn(async () => ({ id: 'd42', status: 'open', version_tag: '1.2.0' }) as Draft);
    const api = mkApi({ getDraft });
    const st = await resolveDraftTarget(api, { tenant: 'ng', channel: 'beta', draft: 'd42' }, noLocal);
    expect(getDraft).toHaveBeenCalledWith('ng', 'beta', 'd42');
    expect(st).toEqual({ tenant: 'ng', channel: 'beta', draftId: 'd42', version: '1.2.0' });
  });

  it('throws incomplete_flags when --draft is given without tenant/channel', async () => {
    const api = mkApi();
    await expect(
      resolveDraftTarget(api, { draft: 'd42' }, noLocal)
    ).rejects.toMatchObject({ code: 'incomplete_flags' });
    expect(api.getDraft).not.toHaveBeenCalled();
  });
});

describe('resolveDraftTarget — tenant/channel (open draft)', () => {
  it('returns the single open draft (ignoring published/abandoned)', async () => {
    const listDrafts = vi.fn(async () => [
      { id: 'old', status: 'published', version_tag: '1.0.0' },
      { id: 'gone', status: 'abandoned' },
      { id: 'cur', status: 'open', version_tag: '1.1.0' },
    ] as Draft[]);
    const api = mkApi({ listDrafts });
    const st = await resolveDraftTarget(api, { tenant: 'ng', channel: 'beta' }, noLocal);
    expect(listDrafts).toHaveBeenCalledWith('ng', 'beta');
    expect(st).toEqual({ tenant: 'ng', channel: 'beta', draftId: 'cur', version: '1.1.0' });
  });

  it('throws no_open when there is no open draft', async () => {
    const api = mkApi({ listDrafts: vi.fn(async () => [{ id: 'x', status: 'published' }] as Draft[]) });
    await expect(
      resolveDraftTarget(api, { tenant: 'ng', channel: 'beta' }, noLocal)
    ).rejects.toMatchObject({ code: 'no_open' });
  });

  it('throws multi_open (listing ids) when several drafts are open', async () => {
    const api = mkApi({
      listDrafts: vi.fn(async () => [
        { id: 'a1', status: 'open' },
        { id: 'b2', status: 'open' },
      ] as Draft[]),
    });
    const err = await resolveDraftTarget(api, { tenant: 'ng', channel: 'beta' }, noLocal).catch((e) => e);
    expect(err).toBeInstanceOf(DraftTargetError);
    expect(err.code).toBe('multi_open');
    expect(err.message).toContain('a1');
    expect(err.message).toContain('b2');
  });

  it('throws incomplete_flags when only one of tenant/channel is given', async () => {
    const api = mkApi();
    await expect(
      resolveDraftTarget(api, { tenant: 'ng' }, noLocal)
    ).rejects.toMatchObject({ code: 'incomplete_flags' });
    await expect(
      resolveDraftTarget(api, { channel: 'beta' }, noLocal)
    ).rejects.toMatchObject({ code: 'incomplete_flags' });
    expect(api.listDrafts).not.toHaveBeenCalled();
  });
});

describe('resolveDraftTarget — local pointer fallback', () => {
  it('returns the local pointer when no flags are given (no network)', async () => {
    const api = mkApi();
    const local: DraftState = { tenant: 'ng', channel: 'beta', draftId: 'loc', version: '2.0.0' };
    const st = await resolveDraftTarget(api, {}, async () => local);
    expect(st).toEqual(local);
    expect(api.getDraft).not.toHaveBeenCalled();
    expect(api.listDrafts).not.toHaveBeenCalled();
  });

  it('throws no_current when no flags and no local pointer', async () => {
    const api = mkApi();
    await expect(resolveDraftTarget(api, {}, noLocal)).rejects.toMatchObject({ code: 'no_current' });
  });

  it('treats blank/whitespace flags as absent (falls back to local)', async () => {
    const api = mkApi();
    const local: DraftState = { tenant: 'ng', channel: 'beta', draftId: 'loc' };
    const st = await resolveDraftTarget(api, { tenant: '  ', channel: '' }, async () => local);
    expect(st).toEqual(local);
    expect(api.listDrafts).not.toHaveBeenCalled();
  });
});
