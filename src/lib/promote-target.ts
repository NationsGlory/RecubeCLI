/**
 * Résolution de la cible de `recube promote`.
 *
 * L'utilisateur passe `-b <val>` (ou `--version <tag>`). `<val>` peut être :
 *   - un build_id (UUID 36 : `[0-9a-f-]{36}`) → promu tel quel (POST direct) ;
 *   - un tag de version (ex `1.0.60`) → on résout le build_id via le listing
 *     des versions (`recube versions list`), qui expose `build_id` par version.
 *
 * Fonctions PURES (zéro I/O) pour être testables sans réseau — c'est le cœur
 * du fix UX (avant, `-b 1.0.60` partait tel quel au POST → 404).
 */

import type { Version } from '../types.js';

/** Un build_id est un UUID de 36 caractères hex + tirets. */
const BUILD_UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * true si `val` ressemble à un build_id (UUID 36), false si c'est un tag de
 * version. Trim les espaces (copier-coller depuis un tableau).
 */
export function isBuildUuid(val: string): boolean {
  return BUILD_UUID_RE.test(val.trim());
}

export type ResolveBuildIdResult =
  | { kind: 'ok'; buildId: string }
  | { kind: 'not_found' }
  | { kind: 'no_build_id' };

/**
 * Cherche dans `versions` celle dont le tag == `tag` et renvoie son build_id.
 *   - ok           : version trouvée + build_id présent.
 *   - not_found    : aucun tag ne matche.
 *   - no_build_id  : version trouvée mais sans build_id promotable
 *                    (ex : ligne synthétisée du fallback, ou draft non publié).
 */
export function resolveBuildId(versions: Version[], tag: string): ResolveBuildIdResult {
  const wanted = tag.trim();
  const match = versions.find((v) => String(v.version ?? '').trim() === wanted);
  if (!match) return { kind: 'not_found' };
  const buildId = match.build_id;
  if (buildId === undefined || buildId === null || String(buildId).trim() === '') {
    return { kind: 'no_build_id' };
  }
  return { kind: 'ok', buildId: String(buildId) };
}
