/**
 * `toDraftPath` — normalise un chemin d'entrée utilisateur en chemin RELATIF
 * POSIX accepté par le backend (SafeBuildPath côté RecubeGG).
 *
 * Le serveur refuse (422 "chemin de fichier invalide") tout chemin absolu,
 * contenant `..`, un backslash, un `:`, un caractère interdit, ou un segment
 * `.`. Sur Windows, un simple `split(path.sep).join('/')` est INSUFFISANT : il
 * ne convertit les backslashes que si `path.sep === '\\'`, ne retire pas un
 * préfixe `./` (segment `.` rejeté), un slash de tête (absolu) ni une lettre de
 * lecteur `C:/`. Ce helper est PUR (pas d'I/O, pas de process.exit) pour être
 * trivialement testable et réutilisable (draft add/rm, branch overlay add/rm).
 *
 * Normalisation :
 *   (a) `\` → `/`
 *   (b) retire une lettre de lecteur de tête (`C:/…`)
 *   (c) retire les préfixes `./` et `/` de tête, de façon répétée (absolu →
 *       relatif, `././` → ``)
 *   (d) fusionne les `//` multiples et retire les slashes de fin
 *   (e) si le résultat est vide, ou qu'un segment `.` / `..` subsiste → throw
 *       une Error claire AVANT tout appel réseau (échec côté client).
 */

/** Erreur de normalisation de chemin (échec côté client, message actionnable). */
export class InvalidDraftPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDraftPathError';
  }
}

/**
 * Normalise `input` en chemin relatif POSIX. Throw InvalidDraftPathError si le
 * chemin ne peut pas être rendu sûr (vide, ou segment `.` / `..` résiduel).
 */
export function toDraftPath(input: string): string {
  if (typeof input !== 'string') {
    throw new InvalidDraftPathError('chemin invalide : chaîne attendue.');
  }

  // (a) backslashes → slashes (indépendant de path.sep de la plateforme).
  let out = input.replace(/\\/g, '/');

  // (b) retire une lettre de lecteur de tête (C:/…, c:/…).
  out = out.replace(/^[A-Za-z]:\//, '');

  // (c) retire les préfixes "./" et "/" de tête, de façon répétée
  //     (gère "./", "/", "././", "/./", "//", etc.).
  let prev: string;
  do {
    prev = out;
    out = out.replace(/^\.\//, ''); // "./" de tête
    out = out.replace(/^\/+/, ''); // "/" de tête (absolu → relatif)
  } while (out !== prev);

  // (d) fusionne les "//" multiples + retire les slashes de fin.
  out = out.replace(/\/{2,}/g, '/').replace(/\/+$/, '');

  if (out === '') {
    throw new InvalidDraftPathError('chemin invalide : chemin vide après normalisation.');
  }

  // (e) aucun segment "." ou ".." ne doit subsister.
  for (const seg of out.split('/')) {
    if (seg === '.' || seg === '..') {
      throw new InvalidDraftPathError(
        `chemin invalide : '.'/'..' non autorisé dans un draft (reçu « ${input} »).`
      );
    }
  }

  return out;
}
