/**
 * Auth gate — à la Claude Code : on force la connexion AVANT de révéler le
 * détail des commandes / le help complet.
 *
 * Règles :
 *   - Authentifié = session OAuth stockée OU `RECUBE_TOKEN` (CI). RECUBE_TOKEN
 *     bypasse TOUT le gate (c'est de l'auth — le CI ne doit jamais être bloqué).
 *   - Non authentifié : seules les commandes de l'allowlist passent
 *     (login, completion, --version/-v, et le help de login). `recube` bare,
 *     `recube --help`, et toute commande hors allowlist → gate : banner +
 *     « connecte-toi » + lancement du flow login (fallback instruction en
 *     headless / sans navigateur). Le help complet n'est PAS révélé.
 *
 * Le check est synchrone-ish (lecture cache local, pas de réseau) et tourne au
 * bootstrap AVANT que commander parse → court-circuite avant tout rendu de help
 * ou d'action.
 */

import { loadCredentials } from './store.js';
import { renderBanner } from '../ui/banner.js';
import { theme } from '../ui/theme.js';

/** Commandes accessibles SANS authentification. */
const PUBLIC_COMMANDS = new Set(['login', 'completion']);

/** True si une auth est présente (session OAuth OU RECUBE_TOKEN). */
export async function isAuthenticated(): Promise<boolean> {
  // RECUBE_TOKEN (CI / service token) = auth → bypass complet du gate.
  if (process.env.RECUBE_TOKEN?.trim()) return true;
  try {
    const creds = await loadCredentials();
    return creds != null;
  } catch {
    return false;
  }
}

/**
 * Décide si la commande demandée nécessite le gate (= non publique).
 * `argv` = process.argv (on lit à partir de l'index 2).
 *
 * Sont AUTORISÉS sans auth :
 *   - aucune sous-commande mais `--version`/`-v` (juste la version)
 *   - une sous-commande de l'allowlist (login, completion) — y compris son --help
 *   - bare `recube` et `recube --help` NE sont PAS autorisés (→ gate), pour ne
 *     pas révéler la liste des commandes.
 */
export function isPublicInvocation(argv: string[]): boolean {
  const args = argv.slice(2);

  // `--version` / `-v` seul : autorisé (pas de détail de commandes révélé).
  // On le tolère même combiné, commander le gère ; ici on regarde le 1er token.
  const first = args.find((a) => !a.startsWith('-'));
  if (!first) {
    // Pas de sous-commande. Autorisé UNIQUEMENT si --version/-v explicite.
    if (args.includes('--version') || args.includes('-v')) return true;
    return false; // bare `recube` ou `recube --help` → gate
  }

  return PUBLIC_COMMANDS.has(first);
}

/**
 * Affiche le gate (banner + invite) puis tente de lancer le flow login.
 * Headless / pas de TTY → on n'auto-prompt pas (clack planterait) : on imprime
 * l'instruction `recube login`. Process exit 1 dans ce cas (commande bloquée).
 * Si le login interactif réussit, on n'enchaîne PAS automatiquement la commande
 * d'origine (comportement simple + prévisible) : on invite à relancer.
 */
export async function runAuthGate(): Promise<void> {
  const t = theme;
  process.stdout.write(renderBanner() + '\n\n');
  process.stdout.write(
    `  ${t.bold('Connecte-toi pour utiliser le CLI.')}\n` +
      `  ${t.dim('Recube CLI exige une authentification (OAuth recube.gg) avant la première utilisation.')}\n\n`
  );

  // Headless / non-TTY (CI sans RECUBE_TOKEN, pipe) → pas d'auto-prompt
  // navigateur (le flow clack/PKCE a besoin d'un TTY + d'un navigateur).
  const interactive = process.stdout.isTTY && process.stdin.isTTY;
  if (!interactive) {
    process.stdout.write(
      `  ${t.arrow()} ${t.dim('Connecte-toi :')} ${t.command('recube login')}\n` +
        `  ${t.arrow()} ${t.dim('En CI :')} ${t.command('RECUBE_TOKEN=rcs_… recube …')} ${t.dim('(token de service)')}\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `  ${t.dim('Lancement de la connexion…')} ${t.dim('(ou : ')}${t.command('recube login')}${t.dim(')')}\n\n`
  );
  // Import dynamique pour ne pas charger le flow OAuth (et ses deps) quand le
  // gate n'est pas déclenché.
  const { loginCommand } = await import('../commands/login.js');
  await loginCommand();
  process.stdout.write(
    `\n  ${t.success('✓')} ${t.dim('Connecté. Relance ta commande, ex :')} ${t.command('recube --help')}\n`
  );
  process.exit(0);
}
