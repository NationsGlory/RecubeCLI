/**
 * `isNewer`/`detectPlatform` (src/lib/self-update.ts) — logique pure derrière
 * `recube update`. La comparaison de version est le point le plus critique à
 * ne pas rater : un faux "déjà à jour" laisse un binaire vulnérable en place,
 * un faux "plus récent" pourrait déclencher une régression vers une version
 * antérieure si jamais un tag GitHub était mal formé.
 */

import { verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { detectPlatform, isNewer, recubePublicKey } from '../src/lib/self-update.js';

describe('isNewer — comparaison semver simple', () => {
  it('détecte un patch supérieur', () => {
    expect(isNewer('0.7.9', '0.7.8')).toBe(true);
  });

  it('détecte un minor/major supérieur', () => {
    expect(isNewer('0.8.0', '0.7.8')).toBe(true);
    expect(isNewer('1.0.0', '0.7.8')).toBe(true);
  });

  it('renvoie false pour une version identique', () => {
    expect(isNewer('0.7.8', '0.7.8')).toBe(false);
  });

  it('renvoie false pour une version antérieure (jamais de downgrade silencieux)', () => {
    expect(isNewer('0.7.7', '0.7.8')).toBe(false);
    expect(isNewer('0.6.9', '0.7.8')).toBe(false);
  });

  it('tolère des longueurs de segments différentes (1.0 vs 1.0.0)', () => {
    expect(isNewer('1.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.1', '1.0')).toBe(true);
  });

  it('traite un segment non-numérique comme 0 plutôt que de planter', () => {
    expect(isNewer('0.7.x', '0.7.8')).toBe(false);
  });
});

describe('recubePublicKey — même clé que install.ps1, format JWK utilisable', () => {
  it('construit une clé RSA valide sans lever', () => {
    const key = recubePublicKey();
    expect(key.asymmetricKeyType).toBe('rsa');
  });

  it('rejette une signature invalide plutôt que de lever ou accepter à tort', () => {
    const key = recubePublicKey();
    const bogusSig = Buffer.alloc(256, 0x42);
    const data = Buffer.from('donnée quelconque');
    expect(verify('sha256', data, key, bogusSig)).toBe(false);
  });
});

describe('detectPlatform — nommage aligné sur install.sh/install.ps1', () => {
  it('renvoie un os connu et un nom d\'asset cohérent', () => {
    const p = detectPlatform();
    expect(['windows', 'linux', 'macos']).toContain(p.os);
    expect(p.assetName).toBe(`recube-${p.os}-${p.arch}${p.os === 'windows' ? '.exe' : ''}`);
  });
});
