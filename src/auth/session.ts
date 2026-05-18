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
}

export async function getAuthenticatedSession(): Promise<AuthenticatedSession> {
  const cfg = await loadConfig();
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
  return { api, tokens, apiBase: cfg.apiBase };
}
