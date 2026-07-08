/**
 * `recube draft files` (src/commands/draft.ts) — bug rapporté 2026-07-08 :
 * la commande listait TOUT le build résolu (base ⊕ overlay, ~2849 fichiers)
 * au lieu des seuls fichiers ajoutés/remplacés/retirés PAR le draft. Fix :
 * `overlayOnly` par défaut true (RecubeGG DraftBuildsController::listFiles
 * accepte maintenant `overlay_only`), `--all` pour repasser en mode complet.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  draftFilesFlat: vi.fn(async () => ({
    files: [{ path: 'mods/x.jar', sha256: 'a'.repeat(64), size: 10, exec: false, origin: 'added', removed: false, uploaded_at: null, uploaded_by: null }],
    total: 1,
    page: 1,
    per_page: 200,
    total_pages: 1,
    query: '',
  })),
  getDraft: vi.fn(async () => ({ id: 'd1', status: 'open', version_tag: '1.0.0' })),
}));

vi.mock('../src/auth/session.js', () => ({
  getAuthenticatedSession: vi.fn(async () => ({
    api: { draftFilesFlat: h.draftFilesFlat, getDraft: h.getDraft },
    serviceToken: false,
  })),
  NotLoggedInError: class NotLoggedInError extends Error {},
}));

vi.mock('../src/auth/store.js', () => ({
  getStoredUser: vi.fn(async () => ({ handle: 'tester' })),
}));

const { draftFilesCommand } = await import('../src/commands/draft.js');

beforeEach(() => {
  h.draftFilesFlat.mockClear();
  h.getDraft.mockClear();
});

describe('draftFilesCommand — overlay_only par défaut', () => {
  it('sans --all : appelle draftFilesFlat avec overlayOnly=true', async () => {
    await draftFilesCommand({ tenant: 'ng', channel: 'beta', draft: 'd1' });
    expect(h.draftFilesFlat).toHaveBeenCalledWith('ng', 'beta', 'd1', 1, 200, true);
  });

  it('avec --all : appelle draftFilesFlat avec overlayOnly=false', async () => {
    await draftFilesCommand({ tenant: 'ng', channel: 'beta', draft: 'd1', all: true });
    expect(h.draftFilesFlat).toHaveBeenCalledWith('ng', 'beta', 'd1', 1, 200, false);
  });
});
