/**
 * `resolveRmTarget` — résolution CASE-INSENSITIVE de la cible d'un `recube draft
 * rm` contre les chemins RÉELS du draft (casse préservée côté backend).
 *
 * Contexte : le backend RecubeGG stocke les paths avec leur casse d'origine
 * (seuls sha256 + extensions sont lowercased). Quelques mods sont mixed-case
 * (ex `mods/CodeChickenLib-universal-1.6.4-1.0.0.62.jar`,
 * `mods/MicdoodleCore-…jar`). Un dev qui tape une autre casse (ex
 * `mods/codechickenlib-…jar`) voyait son `rm` échouer / no-op silencieux
 * (le DELETE exact-path ne matchait aucun fichier réel).
 *
 * Cette fonction est PURE (aucun I/O, aucun process.exit) → trivialement
 * testable. Elle classe l'entrée contre la liste des chemins candidats
 * (idéalement la file-list résolue base ⊕ overlay) :
 *
 *   - `exact`     : match sensible à la casse → fast path (comportement actuel).
 *   - `ci`        : une seule variante ne différant que par la casse → on
 *                   renvoie le path RÉEL (casse stockée) à retirer.
 *   - `ambiguous` : plusieurs variantes de casse → l'appelant doit demander la
 *                   casse exacte (on ne peut pas deviner).
 *   - `none`      : aucune correspondance (l'appelant décide : lister les
 *                   chemins dispo, ou retomber sur un envoi exact-path).
 */

export type RmResolution =
  | { kind: 'exact'; path: string }
  | { kind: 'ci'; path: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'none' };

/**
 * Résout `input` contre `candidatePaths` (chemins réels du draft, casse
 * préservée). L'ordre de priorité est exact > case-insensitive-unique >
 * ambigu > aucun.
 */
export function resolveRmTarget(input: string, candidatePaths: string[]): RmResolution {
  // (1) Match exact (sensible à la casse) : fast path, comportement historique.
  for (const p of candidatePaths) {
    if (p === input) return { kind: 'exact', path: p };
  }

  // (2) Match insensible à la casse contre les paths réels.
  const lower = input.toLowerCase();
  const matches = candidatePaths.filter((p) => p.toLowerCase() === lower);

  if (matches.length === 1) return { kind: 'ci', path: matches[0]! };
  if (matches.length > 1) {
    // Déterministe : trie les variantes pour un affichage stable côté CLI.
    return { kind: 'ambiguous', matches: [...matches].sort() };
  }

  return { kind: 'none' };
}
