/**
 * `resolveRmTarget` (src/lib/draft-rm-resolve.ts) — résolution case-insensitive
 * de la cible d'un `recube draft rm` contre les chemins RÉELS du draft.
 *
 * Régression : les paths des mods gardent leur casse réelle côté backend (ex
 * `mods/CodeChickenLib-universal-1.6.4-1.0.0.62.jar`). Un `rm` tapé en autre
 * casse échouait (DELETE exact-path → aucun match). Ces tests fixent les 4
 * classes de résolution : exact, ci-unique (path réel), ambigu, aucun.
 */

import { describe, expect, it } from 'vitest';
import { resolveRmTarget } from '../src/lib/draft-rm-resolve.js';

const REAL = [
  'mods/CodeChickenLib-universal-1.6.4-1.0.0.62.jar',
  'mods/MicdoodleCore-1.6.4-2.0.6.jar',
  'mods/buildcraft-1.6.4.jar',
  'config/foo.cfg',
];

describe('resolveRmTarget — résolution case-insensitive de draft rm', () => {
  it('match EXACT (sensible à la casse) → kind exact, fast path', () => {
    const r = resolveRmTarget('mods/CodeChickenLib-universal-1.6.4-1.0.0.62.jar', REAL);
    expect(r).toEqual({
      kind: 'exact',
      path: 'mods/CodeChickenLib-universal-1.6.4-1.0.0.62.jar',
    });
  });

  it('un lowercase déjà exact reste exact (pas de faux ci)', () => {
    const r = resolveRmTarget('mods/buildcraft-1.6.4.jar', REAL);
    expect(r).toEqual({ kind: 'exact', path: 'mods/buildcraft-1.6.4.jar' });
  });

  it('CI unique → kind ci + renvoie le path RÉEL (casse stockée)', () => {
    const r = resolveRmTarget('mods/codechickenlib-universal-1.6.4-1.0.0.62.jar', REAL);
    expect(r).toEqual({
      kind: 'ci',
      path: 'mods/CodeChickenLib-universal-1.6.4-1.0.0.62.jar',
    });
  });

  it('CI unique — casse mélangée arbitraire → path réel', () => {
    const r = resolveRmTarget('MODS/MicdoodleCORE-1.6.4-2.0.6.JAR', REAL);
    expect(r).toEqual({ kind: 'ci', path: 'mods/MicdoodleCore-1.6.4-2.0.6.jar' });
  });

  it('ambigu : 2 variantes ne différant que par la casse → kind ambiguous + variantes triées', () => {
    const candidates = ['mods/Foo.jar', 'mods/foo.jar', 'config/bar.cfg'];
    const r = resolveRmTarget('mods/FOO.jar', candidates);
    expect(r).toEqual({ kind: 'ambiguous', matches: ['mods/Foo.jar', 'mods/foo.jar'] });
  });

  it('un input exact prime sur des variantes de casse coexistantes (pas ambigu)', () => {
    const candidates = ['mods/Foo.jar', 'mods/foo.jar'];
    const r = resolveRmTarget('mods/foo.jar', candidates);
    expect(r).toEqual({ kind: 'exact', path: 'mods/foo.jar' });
  });

  it('aucun match → kind none (l’appelant listera les dispos / retombera exact-path)', () => {
    const r = resolveRmTarget('mods/does-not-exist.jar', REAL);
    expect(r).toEqual({ kind: 'none' });
  });

  it('liste de candidats vide → none', () => {
    expect(resolveRmTarget('mods/x.jar', [])).toEqual({ kind: 'none' });
  });
});
