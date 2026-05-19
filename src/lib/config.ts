/**
 * Config file management.
 *
 * Stores per-user CLI defaults at ~/.recube/config.json (or %APPDATA%/Recube/config.json on Windows).
 * Distinct from credentials file (auth/store.ts) to keep secrets isolated from
 * non-sensitive preferences (default tenant, custom apiBase, etc.).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RecubeConfig } from '../types.js';

// Public OAuth client registered server-side (recube.gg/admin/oauth-apps).
// Type: public + PKCE. Redirect: http://127.0.0.1:51737/callback. Grants:
// authorization_code + refresh_token. Override via RECUBE_CLI_CLIENT_ID env
// var or ~/.recube/config.json.clientId for self-hosted Recube deployments.
const DEFAULT_CLIENT_ID = 'bc2bd10d-9142-4009-b307-0d02c438d295';
const DEFAULT_API_BASE = 'https://recube.gg/api/v1';
const DEFAULT_OAUTH_BASE = 'https://recube.gg';

export function configDir(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Recube');
  }
  // XDG_CONFIG_HOME fallback ~/.recube on *nix / macOS.
  return path.join(os.homedir(), '.recube');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export async function ensureConfigDir(): Promise<void> {
  const dir = configDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

function applyEnvOverrides(cfg: RecubeConfig): RecubeConfig {
  return {
    ...cfg,
    apiBase: process.env.RECUBE_API_BASE ?? cfg.apiBase,
    oauthBase: process.env.RECUBE_OAUTH_BASE ?? cfg.oauthBase,
    clientId: process.env.RECUBE_CLI_CLIENT_ID ?? cfg.clientId,
  };
}

export async function loadConfig(): Promise<RecubeConfig> {
  const defaults: RecubeConfig = {
    apiBase: DEFAULT_API_BASE,
    oauthBase: DEFAULT_OAUTH_BASE,
    clientId: DEFAULT_CLIENT_ID,
  };

  const p = configPath();
  if (!existsSync(p)) return applyEnvOverrides(defaults);

  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RecubeConfig>;
    return applyEnvOverrides({
      ...defaults,
      ...parsed,
      apiBase: (parsed.apiBase ?? defaults.apiBase).replace(/\/+$/, ''),
      oauthBase: (parsed.oauthBase ?? defaults.oauthBase).replace(/\/+$/, ''),
    });
  } catch {
    return applyEnvOverrides(defaults);
  }
}

export async function saveConfig(patch: Partial<RecubeConfig>): Promise<void> {
  const current = await loadConfig();
  const next: RecubeConfig = { ...current, ...patch };
  await ensureConfigDir();
  await writeFile(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
}
