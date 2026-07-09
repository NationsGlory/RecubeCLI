/**
 * `recube branch overlay add <file> [--encrypt]` + `recube branch show`
 * encrypted rendering — COMMAND-LEVEL where it matters.
 *
 * Like draft-encrypt-flag.test.ts, the overlay-add tests execute the real
 * `branchOverlayAddCommand` against a real `RecubeApiClient` with global
 * `fetch` stubbed, so the ACTUAL serialization is checked : `encrypted` is
 * TRI-STATE (absent = inherit, true/false = force). No `--encrypt` MUST omit
 * the key (not send `encrypted:false`).
 *
 * Also covers:
 *  - the 422 "no RecubeCore on this channel" rejection message
 *    (explainBranchError, ctx 'overlay') — pure function.
 *  - L2 ISO : `branch show` renders 🔒 next to encrypted overlay entries
 *    (mirrors the 🔒 in `draft files`). Backend echo of `encrypted` on the
 *    overlay is a separate recubegg fix — when absent, the badge is simply
 *    omitted (no crash), which this test's negative case also exercises.
 */

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiError } from '../src/lib/api.js';

vi.mock('../src/auth/session.js', () => ({
  getAuthenticatedSession: vi.fn(async () => {
    const { RecubeApiClient } = await import('../src/lib/api.js');
    return {
      api: new RecubeApiClient({ apiBase: 'https://recube.gg/api/v1', token: 'tkn' }),
      serviceToken: false,
    };
  }),
  NotLoggedInError: class NotLoggedInError extends Error {},
}));

vi.mock('../src/auth/store.js', () => ({
  getStoredUser: vi.fn(async () => ({ handle: 'alice' })),
}));

const { branchOverlayAddCommand, branchShowCommand, explainBranchError } = await import(
  '../src/commands/branch.js'
);

let dir: string;
let filePath: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'recube-branch-encrypt-'));
  filePath = path.join(dir, 'x.jar');
  writeFileSync(filePath, 'fake-jar-bytes');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Stub fetch : overlay initiate → `skip`, overlay commit (POST /me/overlay) →
 * capture the RAW serialized body. Returns an accessor for the parsed body.
 */
function stubFetchCapture(): { get: () => Record<string, unknown> | null } {
  const holder: { body: Record<string, unknown> | null } = { body: null };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/me/overlay/initiate')) {
      return new Response(JSON.stringify({ data: { action: 'skip' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/me/overlay')) {
      holder.body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ data: { overlay: { path: 'x.jar', action: 'add' }, recomposed: true } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { get: () => holder.body };
}

describe('branchOverlayAddCommand — tri-state encrypted', () => {
  it('OMITS encrypted from the overlay body when --encrypt is not passed (inherit)', async () => {
    const cap = stubFetchCapture();

    await branchOverlayAddCommand(filePath, { tenant: 'ng' });

    const body = cap.get();
    expect(body).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(body, 'encrypted')).toBe(false);
    expect((body as Record<string, unknown>).encrypted).toBeUndefined();
    // exec keeps its non-inherited default (false) — unchanged by this fix.
    expect((body as Record<string, unknown>).exec).toBe(false);
  });

  it('sends encrypted:true in the overlay body when --encrypt is passed (force on)', async () => {
    const cap = stubFetchCapture();

    await branchOverlayAddCommand(filePath, { tenant: 'ng', encrypt: true });

    const body = cap.get();
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).encrypted).toBe(true);
  });
});

describe('branchShowCommand — badge chiffré (L2 ISO)', () => {
  function stubBranch(overlay: unknown[]): void {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { id: 1, tenant: 'ng', name: 'dev-alice', overlay_rev: 1, overlay },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
  }

  it('shows 🔒 next to an encrypted overlay entry, not a plain one', async () => {
    stubBranch([
      { path: 'mods/secret.jar', action: 'add', encrypted: true },
      { path: 'mods/plain.jar', action: 'add', encrypted: false },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await branchShowCommand({ tenant: 'ng' });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const secret = lines.find((l) => l.includes('mods/secret.jar'));
    const plain = lines.find((l) => l.includes('mods/plain.jar'));
    expect(secret).toBeDefined();
    expect(secret).toMatch(/🔒/);
    expect(plain).toBeDefined();
    expect(plain).not.toMatch(/🔒/);
  });

  it('renders without crashing (no badge) when the backend omits encrypted', async () => {
    stubBranch([{ path: 'mods/legacy.jar', action: 'add' }]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await branchShowCommand({ tenant: 'ng' });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const row = lines.find((l) => l.includes('mods/legacy.jar'));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/🔒/);
  });
});

describe('encrypt rejection message', () => {
  it('surfaces a clear message on 422 encrypt-requires-recube-core', () => {
    const err = new ApiError(
      'RecubeCore requis',
      422,
      JSON.stringify({
        message: "Ce channel n'a pas RecubeCore actif : impossible de marquer un fichier chiffré.",
      })
    );

    const out = explainBranchError(err, 'overlay', 'ng');

    expect(out).toMatch(/RecubeCore/);
  });
});
