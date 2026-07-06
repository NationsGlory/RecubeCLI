/**
 * `toDraftPath` (src/lib/draft-path.ts) — normalisation pure d'un chemin
 * utilisateur en chemin relatif POSIX accepté par le backend (SafeBuildPath).
 * Régression du bug Windows : `recube draft rm <path>` renvoyait 422 pour tous
 * les chemins (`./mods/x.jar`, `/mods/x.jar`, backslashes…) parce que le
 * `split(path.sep).join('/')` ne strippait ni `./`, ni `/` de tête, ni `C:/`,
 * et ne convertissait pas les backslashes hors Windows.
 *
 * Le dernier bloc prouve (api mockée) que `draftFileRemove` reçoit bien un
 * chemin normalisé pour l'entrée `./mods/x.jar` (fail côté client sinon).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { toDraftPath, InvalidDraftPathError } from '../src/lib/draft-path.js';

describe('toDraftPath — normalisation POSIX relative', () => {
  it('laisse un chemin relatif POSIX inchangé', () => {
    expect(toDraftPath('mods/x.jar')).toBe('mods/x.jar');
  });

  it('strippe un préfixe "./"', () => {
    expect(toDraftPath('./mods/x.jar')).toBe('mods/x.jar');
  });

  it('convertit les backslashes + strippe "./" (".\\mods\\x.jar")', () => {
    expect(toDraftPath('.\\mods\\x.jar')).toBe('mods/x.jar');
  });

  it('convertit les backslashes ("mods\\x.jar")', () => {
    expect(toDraftPath('mods\\x.jar')).toBe('mods/x.jar');
  });

  it('strippe un slash de tête (absolu → relatif)', () => {
    expect(toDraftPath('/mods/x.jar')).toBe('mods/x.jar');
  });

  it('strippe une lettre de lecteur ("C:/mods/x.jar")', () => {
    expect(toDraftPath('C:/mods/x.jar')).toBe('mods/x.jar');
  });

  it('strippe une lettre de lecteur + backslashes ("C:\\mods\\x.jar")', () => {
    expect(toDraftPath('C:\\mods\\x.jar')).toBe('mods/x.jar');
  });

  it('fusionne les slashes multiples', () => {
    expect(toDraftPath('mods//sub///x.jar')).toBe('mods/sub/x.jar');
  });

  it('throw sur un segment ".." ("../x")', () => {
    expect(() => toDraftPath('../x')).toThrow(InvalidDraftPathError);
  });

  it('throw sur ".." interne ("a/../b")', () => {
    expect(() => toDraftPath('a/../b')).toThrow(InvalidDraftPathError);
  });

  it('throw quand la normalisation vide le chemin ("./")', () => {
    expect(() => toDraftPath('./')).toThrow(InvalidDraftPathError);
  });

  it('throw sur un "." interne ("mods/./x.jar")', () => {
    expect(() => toDraftPath('mods/./x.jar')).toThrow(InvalidDraftPathError);
  });
});

// ── intégration : draftRmCommand envoie un chemin normalisé à l'API ──────────

const h = vi.hoisted(() => ({
  draftFileRemove: vi.fn(async () => ({})),
  getDraft: vi.fn(async () => ({ id: 'd1', status: 'open', version_tag: '1.0.0' })),
}));

vi.mock('../src/auth/session.js', () => ({
  getAuthenticatedSession: vi.fn(async () => ({
    api: { draftFileRemove: h.draftFileRemove, getDraft: h.getDraft },
    serviceToken: false,
  })),
  NotLoggedInError: class NotLoggedInError extends Error {},
}));

vi.mock('../src/auth/store.js', () => ({
  getStoredUser: vi.fn(async () => ({ handle: 'tester' })),
}));

// Importé APRÈS les mocks (draft.ts tire session.js/store.js).
const { draftRmCommand } = await import('../src/commands/draft.js');

describe('draftRmCommand — chemin normalisé vers draftFileRemove', () => {
  beforeEach(() => {
    h.draftFileRemove.mockClear();
    h.getDraft.mockClear();
    // Garde-fou : un fail() → process.exit(1) tuerait le worker vitest.
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  it("normalise './mods/x.jar' → 'mods/x.jar' avant l'appel API", async () => {
    await draftRmCommand('./mods/x.jar', { tenant: 'ng', channel: 'beta', draft: 'd1' });
    expect(h.draftFileRemove).toHaveBeenCalledWith('ng', 'beta', 'd1', 'mods/x.jar');
  });

  it('fail côté client sur un chemin traversal (pas d\'appel réseau)', async () => {
    await expect(
      draftRmCommand('../evil.jar', { tenant: 'ng', channel: 'beta', draft: 'd1' })
    ).rejects.toThrow(/process\.exit/);
    expect(h.draftFileRemove).not.toHaveBeenCalled();
  });
});
