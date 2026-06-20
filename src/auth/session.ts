/**
 * Session helper — single entry point for "get me an authenticated API client".
 *
 * Responsibilities :
 *   - Load credentials from store
 *   - Detect imminent expiry (< 2 min) and refresh transparently
 *   - Persist refreshed tokens
 *   - Surface a clean error when the user has never logged in
 *
 * Commands import getAuthenticatedClient() and never touch tokens directly.
 */

import { refreshAccessToken } from './client.js';
import { loadCredentials, saveCredentials, tokensAreExpired } from './store.js';
import { loadConfig } from '../lib/config.js';
import { RecubeApiClient } from '../lib/api.js';
import type { OAuthTokens } from '../types.js';

export class NotLoggedInError extends Error {
  constructor() {
    super('Pas connecté. Lance `recube login` pour t\'authentifier.');
    this.name = 'NotLoggedInError';
  }
}

export interface AuthenticatedSession {
  api: RecubeApiClient;
  tokens: OAuthTokens;
  apiBase: string;
  /** True when auth came from the `RECUBE_TOKEN` env (CI / service token),
   *  not the stored OAuth session. The CLI displays the auth mode and routes
   *  add-only error messages on this flag. */
  serviceToken: boolean;
}

/**
 * Resolve an authenticated session.
 *
 * Priority (additive — dev OAuth is never broken):
 *   1. `RECUBE_TOKEN` env set → use it verbatim as `Authorization: Bearer`,
 *      NO browser OAuth, NO stored session needed. This is the CI / service
 *      token path (token `rcs_…`, scope launcher:draft, add-only). The token
 *      is passed straight through; the server enforces what it can do.
 *   2. else → stored OAuth session (refreshed transparently). Unchanged dev
 *      behaviour.
 */
export async function getAuthenticatedSession(): Promise<AuthenticatedSession> {
  const cfg = await loadConfig();

  // ── CI / service-token path ────────────────────────────────────────────
  const envToken = process.env.RECUBE_TOKEN?.trim();
  if (envToken) {
    const api = new RecubeApiClient({ apiBase: cfg.apiBase, token: envToken });
    // Synthesize a minimal OAuthTokens shape so callers that read `.tokens`
    // keep working; no expiry/refresh — the env owns the lifecycle.
    const tokens: OAuthTokens = {
      access_token: envToken,
      refresh_token: null,
      token_type: 'Bearer',
      expires_at: 0,
      scope: '',
    };
    return { api, tokens, apiBase: cfg.apiBase, serviceToken: true };
  }

  const creds = await loadCredentials();
  if (!creds) throw new NotLoggedInError();

  let tokens = creds.tokens;
  if (tokensAreExpired(tokens) && tokens.refresh_token) {
    try {
      tokens = await refreshAccessToken({
        oauthBase: cfg.oauthBase,
        clientId: cfg.clientId,
        refreshToken: tokens.refresh_token,
      });
      await saveCredentials({ ...creds, tokens });
    } catch (err) {
      // Refresh failed — surface as not-logged-in so the caller prompts re-login.
      throw new NotLoggedInError();
    }
  } else if (tokensAreExpired(tokens) && !tokens.refresh_token) {
    throw new NotLoggedInError();
  }

  const api = new RecubeApiClient({ apiBase: cfg.apiBase, token: tokens.access_token });
  return { api, tokens, apiBase: cfg.apiBase, serviceToken: false };
}
