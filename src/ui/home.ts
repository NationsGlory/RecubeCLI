/**
 * `recube` sans argument — l'écran d'accueil / onboarding.
 *
 * Look & feel inspiré du CLI de Claude Code (Anthropic) : une boîte d'accueil
 * arrondie et aérée, marque + tagline + statut d'auth, suivie d'un parcours
 * « pour démarrer » épuré et d'une astuce. Accent violet #7C3AED partout (cf.
 * theme.ts), respect strict de NO_COLOR / non-TTY. Tout en français.
 *
 * Volontairement court — la surface exhaustive vit dans `recube --help`.
 */

import { compactCubeLines } from './banner.js';
import { box } from './box.js';
import { theme } from './theme.js';
import { getStoredUser } from '../auth/store.js';

const DOC_URL = 'https://recube.gg/developers';

/**
 * Boîte d'accueil arrondie : cube compact à gauche, marque + tagline + statut
 * d'auth à droite. Style « ✻ Welcome to Claude Code » adapté recube.
 */
function welcomeBox(authLine: string): string {
  const t = theme;
  const cube = compactCubeLines();
  // Texte à droite du cube — aligné sur la hauteur du cube (3 lignes) + marque.
  const right = [
    `${t.brand('✦')} ${t.title('recube')} ${t.dim('CLI développeur')}`,
    t.dim('Publie des builds de jeu — auth OAuth, drafts, channels.'),
    authLine,
  ];
  // Compose côte à côte : cube (col gauche) + texte (col droite), padding entre.
  const rows: string[] = [];
  const cubeH = cube.length;
  const max = Math.max(cubeH, right.length);
  // Largeur du cube (lignes peuvent être inégales) — on pad sur la plus large.
  const cubeW = Math.max(...cube.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length));
  for (let i = 0; i < max; i++) {
    const c = cube[i] ?? '';
    const cVisible = c.replace(/\x1b\[[0-9;]*m/g, '').length;
    const cPad = ' '.repeat(cubeW - cVisible);
    const r = right[i] ?? '';
    rows.push(`${c}${cPad}   ${r}`);
  }
  return box(rows);
}

export async function printHome(): Promise<void> {
  const t = theme;

  // Statut d'auth — lecture du cache local (jamais bloquant, pas de réseau).
  let authLine: string;
  try {
    const user = await getStoredUser();
    authLine = user
      ? `${t.success('●')} ${t.dim('connecté :')} ${t.accent('@' + (user.handle ?? user.id))}`
      : `${t.dim('○ non connecté —')} ${t.command('recube login')}`;
  } catch {
    authLine = `${t.dim('○ non connecté —')} ${t.command('recube login')}`;
  }

  const lines: string[] = [
    '',
    welcomeBox(authLine),
    '',
    t.title('  Pour démarrer'),
    '',
    `  ${t.bullet()} ${t.bold("S'authentifier")}`,
    `     ${t.command('recube login')}  ${t.dim('# + --scope "launcher:publish launcher:draft" pour les drafts')}`,
    '',
    `  ${t.bullet()} ${t.bold('Vérifier ton environnement')}`,
    `     ${t.command('recube doctor')}   ${t.dim('# node, auth, réseau, tenants')}`,
    '',
    `  ${t.bullet()} ${t.bold('Publier un build')}`,
    `     ${t.command('recube publish -t nationsglory -c stable -V 1.0.0 -d ./build')}`,
    '',
    `  ${t.bullet()} ${t.bold('Itérer avec les drafts mutables')}`,
    `     ${t.command('recube draft create -t nationsglory -c beta -V 1.0.1')}`,
    `     ${t.command('recube draft add ./mods/my-mod.jar')}`,
    `     ${t.command('recube draft publish -r ma-ref -n "changelog"')}`,
    '',
    box([
      `${t.brand('Astuce')} ${t.dim('·')} ${t.dim('prépare une build à plusieurs avec')} ${t.command('recube draft')} ${t.dim(': add/rm/diff,')}`,
      `${t.dim('puis')} ${t.command('recube draft publish')} ${t.dim('quand tout est prêt (le promote reste séparé).')}`,
    ]),
    '',
    `  ${t.arrow()} ${t.dim('Toutes les commandes :')}  ${t.command('recube --help')}`,
    `  ${t.arrow()} ${t.dim('Complétion shell :')}     ${t.command('recube completion bash|zsh|fish')}`,
    `  ${t.arrow()} ${t.dim('Docs :')}                 ${t.value(DOC_URL)}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}
