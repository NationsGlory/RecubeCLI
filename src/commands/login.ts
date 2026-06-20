/**
 * `recube login` — interactive OAuth Authorization Code + PKCE flow.
 *
 * Opens the user's browser to recube.gg/oauth/authorize, captures the redirect
 * on a local 127.0.0.1 server, exchanges the code for tokens, and persists.
 */

import {
  buildAuthorizeUrl,
  generatePkce,
  openBrowser,
  randomState,
  startCallbackServer,
  waitForListening,
} from '../auth/oauth.js';
import { exchangeAuthorizationCode } from '../auth/client.js';
import { loadCredentials, saveCredentials } from '../auth/store.js';
import { RecubeApiClient } from '../lib/api.js';
import { loadConfig } from '../lib/config.js';
import { ui, theme } from '../lib/ui.js';

const DEFAULT_SCOPE = 'launcher:publish profile:read';

export async function loginCommand(opts: { scope?: string; force?: boolean } = {}): Promise<void> {
  ui.intro('recube login');

  const existing = await loadCredentials();
  if (existing && !opts.force) {
    const confirm = await ui.confirm({
      message: `Déjà connecté en tant que ${existing.user?.handle ?? existing.user?.email ?? 'utilisateur inconnu'}. Re-login ?`,
      initialValue: false,
    });
    if (!confirm) {
      ui.outro('Inchangé.');
      return;
    }
  }

  const cfg = await loadConfig();
  const scope = opts.scope ?? DEFAULT_SCOPE;

  const pkce = generatePkce();
  const state = randomState();

  const server = startCallbackServer({ expectedState: state });
  await waitForListening(server);

  const redirectUri = server.redirectUri;
  const authorizeUrl = buildAuthorizeUrl({
    oauthBase: cfg.oauthBase,
    clientId: cfg.clientId,
    redirectUri,
    scope,
    state,
    codeChallenge: pkce.codeChallenge,
  });

  ui.note(
    `URL :\n${theme.value(authorizeUrl)}\n\nSi le navigateur ne s'ouvre pas automatiquement, copie l'URL ci-dessus.`,
    'Ouverture du navigateur...'
  );
  openBrowser(authorizeUrl);

  const spin = ui.spinner();
  spin.start("En attente de l'autorisation dans le navigateur...");

  let code: string;
  try {
    const result = await server.result;
    code = result.code;
    spin.stop('Code reçu, échange contre des tokens...');
  } catch (err) {
    spin.stop('Échec.');
    server.close();
    ui.cancel((err as Error).message);
  }

  const exchange = ui.spinner();
  exchange.start('Échange du code...');
  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      oauthBase: cfg.oauthBase,
      clientId: cfg.clientId,
      code: code!,
      redirectUri,
      codeVerifier: pkce.codeVerifier,
    });
    exchange.stop('Tokens obtenus.');
  } catch (err) {
    exchange.stop('Échec.');
    ui.cancel(`OAuth token exchange failed : ${(err as Error).message}`);
  }

  // Fetch user profile to greet the user by name.
  const apiClient = new RecubeApiClient({ apiBase: cfg.apiBase, token: tokens!.access_token });
  let userLabel = 'utilisateur';
  let user;
  try {
    user = await apiClient.whoami();
    userLabel = user.handle ?? user.display_name ?? user.email ?? String(user.id);
  } catch {
    /* whoami may require launcher.signature — non-fatal */
  }

  await saveCredentials({
    tokens: tokens!,
    user: user ?? null,
    tenant_default: existing?.tenant_default ?? null,
  });

  ui.outro(
    `${theme.success('OK')} Connecté en tant que ${theme.bold(userLabel)} (scopes: ${theme.dim(tokens!.scope || scope)})`
  );
}
