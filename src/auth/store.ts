/**
 * Token persistence.
 *
 * Primary storage : OS keychain via `keytar` when available (Linux secret-service,
 * macOS Keychain, Windows Credential Manager). Fallback : flat file at
 * ~/.recube/credentials.json with mode 0600.
 *
 * Why both : keytar ships as native module — install can fail on minimal CI
 * images, headless Linux without libsecret, or musl libc. The file fallback
 * keeps the CLI installable everywhere ; the keychain path is a strict
 * security upgrade when present.
 */

import { existsSync } from 'node:fs';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configDir, ensureConfigDir } from '../lib/config.js';
import type { CredentialStorePayload, OAuthTokens, UserProfile } from '../types.js';

const KEYCHAIN_SERVICE = 'recube-cli';
const KEYCHAIN_ACCOUNT = 'default';

function credentialsFilePath(): string {
  return path.join(configDir(), 'credentials.json');
}

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let _keytar: KeytarLike | null | undefined;

async function loadKeytar(): Promise<KeytarLike | null> {
  if (_keytar !== undefined) return _keytar;
  if (process.env.RECUBE_CLI_NO_KEYTAR === '1') {
    _keytar = null;
    return null;
  }
  try {
    // Dynamic import so optional dependency failure does not crash the CLI.
    const mod = (await import('keytar')) as unknown as { default?: KeytarLike } & KeytarLike;
    _keytar = (mod.default ?? mod) as KeytarLike;
    return _keytar;
  } catch {
    _keytar = null;
    return null;
  }
}

export async function saveCredentials(payload: CredentialStorePayload): Promise<void> {
  const keytar = await loadKeytar();
  const serialized = JSON.stringify(payload);
  if (keytar) {
    await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, serialized);
    return;
  }
  await ensureConfigDir();
  const p = credentialsFilePath();
  await writeFile(p, serialized + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') {
    // writeFile mode only applies on create — be explicit when overwriting.
    await chmod(p, 0o600).catch(() => undefined);
  }
}

export async function loadCredentials(): Promise<CredentialStorePayload | null> {
  const keytar = await loadKeytar();
  if (keytar) {
    const raw = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (raw) return safeParse(raw);
  }
  const p = credentialsFilePath();
  if (!existsSync(p)) return null;
  const raw = await readFile(p, 'utf8');
  return safeParse(raw);
}

export async function clearCredentials(): Promise<void> {
  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).catch(() => false);
  }
  const p = credentialsFilePath();
  if (existsSync(p)) await unlink(p).catch(() => undefined);
}

function safeParse(raw: string): CredentialStorePayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialStorePayload>;
    if (!parsed?.tokens?.access_token) return null;
    return parsed as CredentialStorePayload;
  } catch {
    return null;
  }
}

export function tokensAreExpired(tokens: OAuthTokens, safetyMarginSeconds = 120): boolean {
  if (!tokens.expires_at) return false;
  const now = Math.floor(Date.now() / 1000);
  return tokens.expires_at <= now + safetyMarginSeconds;
}

export async function getStoredUser(): Promise<UserProfile | null> {
  const creds = await loadCredentials();
  return creds?.user ?? null;
}
