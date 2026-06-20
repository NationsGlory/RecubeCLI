/**
 * CLI version — source unique de vérité, dérivée de package.json.
 *
 * Au build du binaire (`build:binary`), esbuild remplace `__RECUBE_VERSION__`
 * par la version lue dans package.json (via `define`). En dev (tsx / `npm run
 * dev`), `__RECUBE_VERSION__` n'est pas défini → on lit package.json à
 * l'exécution. Plus de `'0.3.0'` hardcodé à droite à gauche qui drifte.
 */

import { createRequire } from 'node:module';

// Injecté par esbuild --define au build:binary. `declare` + garde typeof pour
// que tsc (qui ne connaît pas le define) compile, et que le fallback marche en
// dev où le symbole n'existe pas.
declare const __RECUBE_VERSION__: string | undefined;

function fromPackageJson(): string {
  try {
    const require = createRequire(import.meta.url);
    // package.json est à la racine ; depuis dist/ comme depuis src/ via tsx,
    // la résolution remonte au package courant.
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

export const VERSION: string =
  typeof __RECUBE_VERSION__ !== 'undefined' && __RECUBE_VERSION__
    ? __RECUBE_VERSION__
    : fromPackageJson();
