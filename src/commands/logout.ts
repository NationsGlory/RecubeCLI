/**
 * `recube logout` — clear local credentials and best-effort revoke server-side.
 */

import { clearCredentials, loadCredentials } from '../auth/store.js';
import { revokeToken } from '../auth/client.js';
import { loadConfig } from '../lib/config.js';
import { ui, chalk } from '../lib/ui.js';

export async function logoutCommand(): Promise<void> {
  const creds = await loadCredentials();
  if (!creds) {
    ui.log.info('Pas de session active.');
    return;
  }
  const cfg = await loadConfig();
  // Best-effort revoke ; never blocks logout.
  if (creds.tokens.access_token) {
    await revokeToken({
      oauthBase: cfg.oauthBase,
      clientId: cfg.clientId,
      token: creds.tokens.access_token,
      tokenTypeHint: 'access_token',
    });
  }
  if (creds.tokens.refresh_token) {
    await revokeToken({
      oauthBase: cfg.oauthBase,
      clientId: cfg.clientId,
      token: creds.tokens.refresh_token,
      tokenTypeHint: 'refresh_token',
    });
  }
  await clearCredentials();
  ui.log.success(`${chalk.green('OK')} Déconnecté.`);
}
