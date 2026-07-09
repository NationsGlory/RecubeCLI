/**
 * `recube draft files` — "chiffré" badge (🔒) next to encrypted entries.
 * Same mocking approach as tests/draft-files-overlay-only.test.ts (mocks
 * the auth session + api.draftFilesFlat/getDraft), plus a console.log spy
 * to inspect the rendered rows (draftFilesCommand prints via `info()` →
 * `console.log`, there is no other output surface to assert against).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  draftFilesFlat: vi.fn(async () => ({
    files: [
      {
        path: 'mods/x.jar',
        sha256: 'a'.repeat(64),
        size: 10,
        exec: false,
        encrypted: true,
        origin: 'added',
        removed: false,
        uploaded_at: null,
        uploaded_by: null,
      },
      {
        path: 'mods/plain.jar',
        sha256: 'b'.repeat(64),
        size: 20,
        exec: false,
        encrypted: false,
        origin: 'added',
        removed: false,
        uploaded_at: null,
        uploaded_by: null,
      },
    ],
    total: 2,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('draftFilesCommand — badge chiffré', () => {
  it('affiche un indicateur 🔒 à côté des fichiers chiffrés, pas des autres', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await draftFilesCommand({ tenant: 'ng', channel: 'beta', draft: 'd1' });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const encryptedRow = lines.find((l) => l.includes('mods/x.jar'));
    const plainRow = lines.find((l) => l.includes('mods/plain.jar'));

    expect(encryptedRow).toBeDefined();
    expect(encryptedRow).toMatch(/🔒/);
    expect(plainRow).toBeDefined();
    expect(plainRow).not.toMatch(/🔒/);
  });

  it('mentionne le symbole 🔒 dans la légende', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await draftFilesCommand({ tenant: 'ng', channel: 'beta', draft: 'd1' });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const legend = lines.find((l) => l.includes('hérité') && l.includes('sha (10)'));
    expect(legend).toBeDefined();
    expect(legend).toMatch(/🔒/);
  });
});
