/**
 * `recube whoami` — print the current authenticated identity.
 */

import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { loadCredentials } from '../auth/store.js';
import { ui, chalk } from '../lib/ui.js';

export async function whoamiCommand(): Promise<void> {
  let session;
  try {
    session = await getAuthenticatedSession();
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      ui.log.warn(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Try fresh /me ; fall back to the cached user if the API rejects.
  let user;
  try {
    user = await session.api.whoami();
  } catch {
    const creds = await loadCredentials();
    user = creds?.user ?? null;
  }

  if (!user) {
    ui.log.warn('Authentifié mais profil indisponible (token valide, /me bloqué).');
    return;
  }

  const lines: string[] = [];
  lines.push(`  ${chalk.dim('id        ')} ${user.id}`);
  if (user.handle) lines.push(`  ${chalk.dim('handle    ')} @${user.handle}`);
  if (user.display_name) lines.push(`  ${chalk.dim('name      ')} ${user.display_name}`);
  if (user.email) lines.push(`  ${chalk.dim('email     ')} ${user.email}`);
  lines.push(`  ${chalk.dim('scopes    ')} ${session.tokens.scope || '(none)'}`);
  const expiresIn = session.tokens.expires_at - Math.floor(Date.now() / 1000);
  const minutes = Math.max(0, Math.round(expiresIn / 60));
  lines.push(`  ${chalk.dim('expires in')} ${minutes} min`);
  lines.push(`  ${chalk.dim('apiBase   ')} ${session.apiBase}`);

  ui.note(lines.join('\n'), 'whoami');
}
