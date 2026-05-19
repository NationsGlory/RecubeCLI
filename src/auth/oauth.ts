/**
 * OAuth Authorization Code + PKCE flow.
 *
 * Flow :
 *   1. Generate code_verifier (random 32 bytes, base64url) and
 *      code_challenge = base64url(sha256(code_verifier)).
 *   2. Spin up a one-shot local HTTP server on a random port (0 = OS pick).
 *   3. Open browser to /oauth/authorize on recube.gg with the challenge,
 *      redirect_uri pointing to the local server, and a random state.
 *   4. Server receives /callback?code=<C>&state=<S>, validates state, closes.
 *   5. Caller exchanges <C> + verifier via auth/client.ts.
 *
 * Why PKCE without a client_secret : the CLI is a public client (binary
 * distributed via npm — secret cannot be confidential). PKCE binds the
 * code to the original verifier so an attacker who intercepts the code
 * cannot exchange it for tokens.
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export function generatePkce(): PkceChallenge {
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(
    createHash('sha256').update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

export function randomState(): string {
  return base64UrlEncode(randomBytes(16));
}

export function buildAuthorizeUrl(opts: {
  oauthBase: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(`${opts.oauthBase.replace(/\/+$/, '')}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scope);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServerHandle {
  port: number;
  redirectUri: string;
  /** Resolves with code + state once the user authorizes, rejects on error/timeout. */
  result: Promise<CallbackResult>;
  /** Forcefully close the server (idempotent). */
  close: () => void;
}

/**
 * Starts a one-shot HTTP server on localhost:<random port>. The server resolves
 * the returned promise on the first GET /callback containing a `code` parameter,
 * then auto-closes. `state` is enforced by the caller (we just expose it).
 */
export function startCallbackServer(opts: {
  /** Expected state value — server rejects mismatches. */
  expectedState: string;
  /** Max wait time in ms before rejecting (default 5 minutes). */
  timeoutMs?: number;
}): CallbackServerHandle {
  let server: Server;
  let settled = false;

  const result = new Promise<CallbackResult>((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* noop */ }
      reject(new Error('OAuth callback timeout (5 min)'));
    }, timeoutMs);
    timer.unref?.();

    server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end('Bad request');
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not Found');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (error) {
        respondPage(res, false, `Erreur OAuth : ${error}`);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`OAuth error: ${error} ${url.searchParams.get('error_description') ?? ''}`));
          try { server.close(); } catch { /* noop */ }
        }
        return;
      }
      if (!code || !state) {
        respondPage(res, false, 'Paramètres manquants dans le callback.');
        return;
      }
      if (state !== opts.expectedState) {
        respondPage(res, false, 'State invalide — possible CSRF, login annulé.');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('OAuth state mismatch'));
          try { server.close(); } catch { /* noop */ }
        }
        return;
      }

      respondPage(res, true, 'Authentification réussie ! Vous pouvez fermer cet onglet.');
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, state });
        // small delay so the response body is flushed before the listener dies
        setTimeout(() => {
          try { server.close(); } catch { /* noop */ }
        }, 50).unref?.();
      }
    });

    server.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    // Fixed port (RFC 8252 + Laravel Passport exact-match on redirect_uri).
    // 51737 chosen for mnemonic + low collision risk. Override via
    // RECUBE_CLI_CALLBACK_PORT if a dev runs into a conflict.
    const port = Number.parseInt(process.env.RECUBE_CLI_CALLBACK_PORT ?? '51737', 10);
    server.listen(port, 'localhost');
  });

  // The Promise constructor runs synchronously, so `server` is assigned before
  // we return. listen() is async — addresss is null until 'listening' fires —
  // hence the `as` cast and the listening accessor below.

  const handle: CallbackServerHandle = {
    get port(): number {
      const addr = server.address() as AddressInfo | null;
      if (!addr) throw new Error('Server not listening yet');
      return addr.port;
    },
    get redirectUri(): string {
      return `http://localhost:${handle.port}/callback`;
    },
    result,
    close: () => {
      try { server.close(); } catch { /* noop */ }
    },
  };

  return handle;
}

/**
 * Wait until the callback server has bound to its port — the address() call in
 * the getter throws before listen() finishes. Resolves once safe to read .port.
 */
export function waitForListening(handle: CallbackServerHandle, retries = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = () => {
      try {
        // accessing the getter throws if not listening yet
        void handle.port;
        resolve();
      } catch {
        if (++attempts > retries) reject(new Error('callback server never bound'));
        else setTimeout(tick, 20);
      }
    };
    tick();
  });
}

export function openBrowser(url: string): void {
  // Best-effort cross-platform launcher. Failure is non-fatal — the URL is
  // also printed to stderr so the user can copy/paste manually.
  let cmd: string;
  if (process.platform === 'win32') {
    // `start ""` keeps the shell window from inheriting URL as window title.
    cmd = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, { windowsHide: true }, () => {
    /* ignore — fallback to manual copy/paste */
  });
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function respondPage(
  res: import('node:http').ServerResponse,
  success: boolean,
  message: string
): void {
  const title = success ? 'Recube CLI — Connecté' : 'Recube CLI — Erreur';
  const color = success ? '#4ade80' : '#f87171';
  const body = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center;
         justify-content: center; font-family: -apple-system, BlinkMacSystemFont,
         "Segoe UI", system-ui, sans-serif; background: #0b0f1a; color: #e5e7eb; }
  .card { max-width: 480px; padding: 32px; border: 1px solid #1f2937;
          border-radius: 12px; text-align: center; background: #111827; }
  .dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
         background: ${color}; margin-right: 8px; vertical-align: middle; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p { margin: 0; color: #9ca3af; font-size: 14px; }
</style></head>
<body><div class="card"><h1><span class="dot"></span>${title}</h1><p>${message}</p></div></body></html>`;
  res.writeHead(success ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
