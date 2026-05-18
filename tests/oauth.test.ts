import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  generatePkce,
  randomState,
  startCallbackServer,
  waitForListening,
} from '../src/auth/oauth.js';

describe('PKCE', () => {
  it('generates verifier (43-128 chars) + S256 challenge', () => {
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    // base64url alphabet (no +/=)
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // SHA-256 base64url is always 43 chars (no padding)
    expect(codeChallenge).toHaveLength(43);
    expect(codeChallengeMethod).toBe('S256');
  });

  it('produces distinct values per call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });

  it('state is base64url random', () => {
    const s = randomState();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThanOrEqual(20);
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes all required PKCE params', () => {
    const url = buildAuthorizeUrl({
      oauthBase: 'https://recube.gg',
      clientId: 'recube-cli',
      redirectUri: 'http://127.0.0.1:1234/callback',
      scope: 'launcher:publish profile:read',
      state: 'STATE',
      codeChallenge: 'CHAL',
    });
    const u = new URL(url);
    expect(u.origin).toBe('https://recube.gg');
    expect(u.pathname).toBe('/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('recube-cli');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1234/callback');
    expect(u.searchParams.get('scope')).toBe('launcher:publish profile:read');
    expect(u.searchParams.get('state')).toBe('STATE');
    expect(u.searchParams.get('code_challenge')).toBe('CHAL');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('startCallbackServer', () => {
  let handles: { close: () => void }[] = [];

  afterEach(() => {
    handles.forEach((h) => h.close());
    handles = [];
  });

  it('resolves with code when state matches', async () => {
    const expected = 'EXPECTED_STATE';
    const server = startCallbackServer({ expectedState: expected, timeoutMs: 3000 });
    handles.push(server);
    await waitForListening(server);

    // Fire the callback manually.
    const res = await fetch(`${server.redirectUri}?code=THE_CODE&state=${expected}`);
    expect(res.status).toBe(200);

    const result = await server.result;
    expect(result.code).toBe('THE_CODE');
    expect(result.state).toBe(expected);
  });

  it('rejects on state mismatch', async () => {
    const server = startCallbackServer({ expectedState: 'A', timeoutMs: 3000 });
    handles.push(server);
    await waitForListening(server);

    // Attach the assertion BEFORE firing the request so the rejection always
    // has a handler — avoids the PromiseRejectionHandledWarning.
    const assertion = expect(server.result).rejects.toThrow(/state mismatch/);
    await fetch(`${server.redirectUri}?code=CODE&state=B`);
    await assertion;
  });

  it('rejects on error param', async () => {
    const server = startCallbackServer({ expectedState: 'S', timeoutMs: 3000 });
    handles.push(server);
    await waitForListening(server);

    const assertion = expect(server.result).rejects.toThrow(/access_denied/);
    await fetch(`${server.redirectUri}?error=access_denied&error_description=denied&state=S`);
    await assertion;
  });
});
