/**
 * HTTP client for the OAuth token endpoint.
 *
 * Isolated from oauth.ts so the PKCE flow can be tested independently of the
 * actual token exchange (mock this module in unit tests).
 */

import type { OAuthTokens } from '../types.js';

export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface ExchangeCodeOptions {
  oauthBase: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface RefreshTokenOptions {
  oauthBase: string;
  clientId: string;
  refreshToken: string;
  scope?: string;
}

export async function exchangeAuthorizationCode(
  opts: ExchangeCodeOptions
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  return postToken(opts.oauthBase, body);
}

export async function refreshAccessToken(opts: RefreshTokenOptions): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
  });
  if (opts.scope) body.set('scope', opts.scope);
  return postToken(opts.oauthBase, body);
}

export async function revokeToken(opts: {
  oauthBase: string;
  clientId: string;
  token: string;
  tokenTypeHint?: 'access_token' | 'refresh_token';
}): Promise<void> {
  const url = `${opts.oauthBase.replace(/\/+$/, '')}/oauth/token/revoke`;
  const body = new URLSearchParams({
    client_id: opts.clientId,
    token: opts.token,
  });
  if (opts.tokenTypeHint) body.set('token_type_hint', opts.tokenTypeHint);
  // Best-effort : server may return 200 with empty body or 404 if endpoint
  // is unimplemented. We swallow non-2xx because client-side state is already
  // cleared by logout() — the server-side revoke is defense-in-depth.
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  }).catch(() => undefined);
}

/**
 * Laravel Passport n'inclut PAS de champ `scope` dans la réponse `/oauth/token`
 * (contrairement au standard OAuth2) → on dérive les scopes du claim `scopes`
 * du JWT access_token, qui est la source de vérité (toujours présent). Sans ça,
 * `tokens.scope` reste vide et `recube whoami` affichait « scopes (none) »
 * malgré un token parfaitement scopé (incident 2026-06-25).
 */
export function scopesFromAccessToken(accessToken: string): string {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return '';
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    const claims = JSON.parse(json) as { scopes?: unknown };
    return Array.isArray(claims.scopes) ? claims.scopes.join(' ') : '';
  } catch {
    return '';
  }
}

async function postToken(oauthBase: string, body: URLSearchParams): Promise<OAuthTokens> {
  const url = `${oauthBase.replace(/\/+$/, '')}/oauth/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new OAuthError(
      `POST ${url} -> ${res.status} ${res.statusText}`,
      res.status,
      txt
    );
  }
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(txt) as TokenResponse;
  } catch {
    throw new OAuthError(`POST ${url} -> invalid JSON response`, res.status, txt);
  }
  if (!parsed.access_token) {
    throw new OAuthError(`POST ${url} -> missing access_token`, res.status, txt);
  }
  const expiresIn = parsed.expires_in ?? 3600;
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token ?? null,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    token_type: parsed.token_type ?? 'Bearer',
    scope: parsed.scope || scopesFromAccessToken(parsed.access_token),
  };
}
