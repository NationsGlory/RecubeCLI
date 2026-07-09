/**
 * `recube draft add <jar> [--encrypt]` — COMMAND-LEVEL tests.
 *
 * These execute the real `draftAddCommand` against a real `RecubeApiClient`
 * (injected via a mocked session) with global `fetch` stubbed, so the ACTUAL
 * JSON serialization path is exercised. That is the point: `encrypted` is
 * TRI-STATE server-side (absent = inherit, true/false = force). The CLI must
 * OMIT the key when `--encrypt` is not passed (relying on JSON.stringify
 * dropping `undefined`), NOT send `encrypted:false` — otherwise the CI, which
 * re-uploads already-encrypted mods via `recube draft add x.jar` with no flag,
 * would silently force-off encryption and publish the jar in clear.
 *
 * An earlier API-client-level test asserted `body.encrypted === false` as the
 * "backward compat" contract — that CEMENTED the H1 bug. Replaced here by a
 * command-level omission assertion (the only kind that would have caught it,
 * since the raw api client bypasses the command's tri-state mapping).
 */

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../src/auth/session.js', () => ({
  getAuthenticatedSession: vi.fn(async () => {
    const { RecubeApiClient } = await import('../src/lib/api.js');
    return {
      api: new RecubeApiClient({ apiBase: 'https://recube.gg/api/v1', token: 'tkn' }),
      serviceToken: true,
    };
  }),
  NotLoggedInError: class NotLoggedInError extends Error {},
}));

vi.mock('../src/auth/store.js', () => ({
  getStoredUser: vi.fn(async () => ({ handle: 'ci' })),
}));

const { draftAddCommand } = await import('../src/commands/draft.js');

let dir: string;
let jarPath: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'recube-encrypt-'));
  jarPath = path.join(dir, 'x.jar');
  writeFileSync(jarPath, 'fake-jar-bytes');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Stub fetch : initiate → `skip` (no R2 upload), commit → capture the RAW
 * serialized request body (this is literally the wire payload). Returns an
 * accessor for the parsed commit body.
 */
function stubFetchCapture(): { get: () => Record<string, unknown> | null } {
  const holder: { body: Record<string, unknown> | null } = { body: null };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/files/initiate')) {
      return new Response(JSON.stringify({ data: { action: 'skip' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/files')) {
      holder.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: { action: 'add' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { get: () => holder.body };
}

describe('draftAddCommand — tri-state encrypted', () => {
  it('OMITS encrypted from the commit body when --encrypt is not passed (inherit)', async () => {
    const cap = stubFetchCapture();

    await draftAddCommand(jarPath, { tenant: 'ng', channel: 'beta', draftId: 'd1' });

    const body = cap.get();
    expect(body).not.toBeNull();
    // The wire body must NOT carry the key at all → backend inherits.
    expect(Object.prototype.hasOwnProperty.call(body, 'encrypted')).toBe(false);
    expect((body as Record<string, unknown>).encrypted).toBeUndefined();
  });

  it('sends encrypted:true in the commit body when --encrypt is passed (force on)', async () => {
    const cap = stubFetchCapture();

    await draftAddCommand(jarPath, { tenant: 'ng', channel: 'beta', draftId: 'd1', encrypt: true });

    const body = cap.get();
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).encrypted).toBe(true);
  });
});
