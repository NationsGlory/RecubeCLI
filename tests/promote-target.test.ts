/**
 * Pure resolution logic for `recube promote` :
 *   - isBuildUuid : distingue un build_id (UUID 36) d'un tag de version (1.0.60).
 *   - resolveBuildId : trouve le build_id d'une version par son tag dans un listing.
 *
 * TDD : ces fonctions n'ont aucune dép réseau — c'est le cœur du fix UX
 * « promote -b <tag> » (résoudre le tag → build_id avant le POST).
 */

import { describe, expect, it } from 'vitest';
import { isBuildUuid, resolveBuildId } from '../src/lib/promote-target.js';
import type { Version } from '../src/types.js';

describe('isBuildUuid', () => {
  it('reconnaît un UUID 36 canonique', () => {
    expect(isBuildUuid('11111111-2222-3333-4444-555555555555')).toBe(true);
  });

  it('accepte les majuscules hex', () => {
    expect(isBuildUuid('ABCDEF00-1234-5678-9ABC-DEF012345678')).toBe(true);
  });

  it('rejette un tag de version', () => {
    expect(isBuildUuid('1.0.60')).toBe(false);
    expect(isBuildUuid('2.0.0-rc1')).toBe(false);
  });

  it('rejette une chaîne de 35 ou 37 caractères', () => {
    expect(isBuildUuid('1111111-2222-3333-4444-555555555555')).toBe(false); // 35
    expect(isBuildUuid('111111111-2222-3333-4444-555555555555')).toBe(false); // 37
  });

  it('rejette une longueur 36 avec un caractère non-hex', () => {
    expect(isBuildUuid('zzzzzzzz-2222-3333-4444-555555555555')).toBe(false);
  });

  it('trim les espaces autour de la valeur', () => {
    expect(isBuildUuid('  11111111-2222-3333-4444-555555555555  ')).toBe(true);
  });
});

describe('resolveBuildId', () => {
  const versions: Version[] = [
    { id: 'v1', version: '1.0.59', channel: 'beta', build_id: 'aaaaaaaa-1111-1111-1111-111111111111' },
    { id: 'v2', version: '1.0.60', channel: 'beta', build_id: 'bbbbbbbb-2222-2222-2222-222222222222' },
    { id: 'v3', version: '1.0.61', channel: 'beta' }, // pas de build_id (draft / synth)
  ];

  it('retourne le build_id de la version dont le tag matche', () => {
    expect(resolveBuildId(versions, '1.0.60')).toEqual({
      kind: 'ok',
      buildId: 'bbbbbbbb-2222-2222-2222-222222222222',
    });
  });

  it('kind=not_found quand le tag est absent', () => {
    expect(resolveBuildId(versions, '9.9.9')).toEqual({ kind: 'not_found' });
  });

  it('kind=no_build_id quand la version existe mais sans build_id', () => {
    expect(resolveBuildId(versions, '1.0.61')).toEqual({ kind: 'no_build_id' });
  });

  it('trim le tag recherché', () => {
    expect(resolveBuildId(versions, '  1.0.60  ')).toEqual({
      kind: 'ok',
      buildId: 'bbbbbbbb-2222-2222-2222-222222222222',
    });
  });

  it('coerce un build_id numérique en string', () => {
    const v: Version[] = [{ id: 1, version: '3.0.0', build_id: 42 as unknown as string }];
    expect(resolveBuildId(v, '3.0.0')).toEqual({ kind: 'ok', buildId: '42' });
  });
});
