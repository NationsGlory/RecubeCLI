/**
 * `recube doctor` — diagnose env setup.
 *
 * Non-mutating health check. Reports :
 *   - CLI version (vs. latest npm)
 *   - Node version
 *   - Auth status + token expiry
 *   - API reachability (recube.gg/api/v1)
 *   - Accessible tenants
 *   - Build dir scan (if provided via --dir)
 *
 * Each check returns a status (ok | warn | fail | skip) plus a short hint.
 */

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { loadCredentials, tokensAreExpired } from '../auth/store.js';
import { RecubeApiClient, ApiError } from '../lib/api.js';
import { ui, chalk } from '../lib/ui.js';

const CLI_VERSION = '0.2.1';
const NPM_PACKAGE = '@recube/cli';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorOptions {
  dir?: string;
  json?: boolean;
}

export async function doctorCommand(opts: DoctorOptions = {}): Promise<void> {
  const results: CheckResult[] = [];

  results.push(await checkNodeVersion());
  results.push(await checkCliVersion());

  const cfg = await loadConfig();
  results.push({
    name: 'Config',
    status: 'ok',
    message: `apiBase=${cfg.apiBase} oauthBase=${cfg.oauthBase} clientId=${maskId(cfg.clientId)}`,
  });

  results.push(await checkNetwork(cfg.apiBase));

  const auth = await checkAuth();
  results.push(auth.result);

  if (auth.result.status === 'ok' && auth.api) {
    results.push(await checkTenants(auth.api));
  } else {
    results.push({ name: 'Tenants', status: 'skip', message: 'no valid session' });
  }

  if (opts.dir) {
    results.push(await checkBuildDir(opts.dir));
  } else {
    results.push({
      name: 'Build dir',
      status: 'skip',
      message: 'pass --dir <path> to validate a build directory',
    });
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
    return;
  }

  ui.intro('recube doctor');
  for (const r of results) {
    const badge = renderBadge(r.status);
    ui.log.message(`${badge} ${chalk.bold(r.name.padEnd(14))} ${r.message}`);
  }
  const hasFail = results.some((r) => r.status === 'fail');
  const hasWarn = results.some((r) => r.status === 'warn');
  if (hasFail) {
    ui.outro(`${chalk.red('FAIL')} — at least one critical check failed.`);
    process.exitCode = 1;
  } else if (hasWarn) {
    ui.outro(`${chalk.yellow('WARN')} — non-blocking issues detected.`);
  } else {
    ui.outro(`${chalk.green('OK')} — env looks healthy.`);
  }
}

function renderBadge(s: CheckStatus): string {
  switch (s) {
    case 'ok':
      return chalk.green('[ ok ]');
    case 'warn':
      return chalk.yellow('[warn]');
    case 'fail':
      return chalk.red('[fail]');
    case 'skip':
      return chalk.dim('[skip]');
  }
}

function maskId(id: string): string {
  if (id.length < 8) return id;
  return id.slice(0, 4) + '…' + id.slice(-4);
}

async function checkNodeVersion(): Promise<CheckResult> {
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  if (major >= 20) return { name: 'Node', status: 'ok', message: `${v} (>= 20 required)` };
  return {
    name: 'Node',
    status: 'fail',
    message: `${v} — CLI requires Node >= 20. Upgrade via nvm/volta.`,
  };
}

async function checkCliVersion(): Promise<CheckResult> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return {
        name: 'CLI version',
        status: 'warn',
        message: `current=${CLI_VERSION} (npm registry returned ${res.status})`,
      };
    }
    const data = (await res.json()) as { version?: string };
    const latest = data.version ?? '?';
    if (latest === CLI_VERSION) {
      return { name: 'CLI version', status: 'ok', message: `${CLI_VERSION} (latest)` };
    }
    return {
      name: 'CLI version',
      status: 'warn',
      message: `current=${CLI_VERSION} latest=${latest} — run npm i -g ${NPM_PACKAGE}`,
    };
  } catch {
    return {
      name: 'CLI version',
      status: 'warn',
      message: `current=${CLI_VERSION} (npm registry unreachable)`,
    };
  }
}

async function checkNetwork(apiBase: string): Promise<CheckResult> {
  try {
    const url = apiBase.replace(/\/+$/, '') + '/me';
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 || res.status === 403) {
      return { name: 'Network', status: 'ok', message: `${apiBase} reachable (auth required)` };
    }
    if (res.ok) return { name: 'Network', status: 'ok', message: `${apiBase} reachable` };
    return {
      name: 'Network',
      status: 'warn',
      message: `${apiBase} returned ${res.status} ${res.statusText}`,
    };
  } catch (err) {
    return {
      name: 'Network',
      status: 'fail',
      message: `${apiBase} unreachable: ${(err as Error).message}`,
    };
  }
}

async function checkAuth(): Promise<{ result: CheckResult; api: RecubeApiClient | null }> {
  const cfg = await loadConfig();
  const creds = await loadCredentials();
  if (!creds) {
    return {
      result: { name: 'Auth', status: 'warn', message: 'not logged in — run `recube login`' },
      api: null,
    };
  }
  const expired = tokensAreExpired(creds.tokens);
  const expiresAt = new Date(creds.tokens.expires_at * 1000).toISOString();
  if (expired) {
    if (creds.tokens.refresh_token) {
      return {
        result: {
          name: 'Auth',
          status: 'warn',
          message: `token expired at ${expiresAt} (refresh available — will renew on next call)`,
        },
        api: null,
      };
    }
    return {
      result: {
        name: 'Auth',
        status: 'fail',
        message: `token expired at ${expiresAt} and no refresh_token — run \`recube login\``,
      },
      api: null,
    };
  }
  const api = new RecubeApiClient({ apiBase: cfg.apiBase, token: creds.tokens.access_token });
  return {
    result: {
      name: 'Auth',
      status: 'ok',
      message: `logged in as ${creds.user?.handle ?? creds.user?.email ?? '?'} (expires ${expiresAt})`,
    },
    api,
  };
}

async function checkTenants(api: RecubeApiClient): Promise<CheckResult> {
  try {
    const games = await api.listGames();
    if (games.length === 0) {
      return { name: 'Tenants', status: 'warn', message: '0 tenants accessible' };
    }
    const list = games
      .slice(0, 5)
      .map((g) => g.slug)
      .join(', ');
    const more = games.length > 5 ? ` (+${games.length - 5} more)` : '';
    return { name: 'Tenants', status: 'ok', message: `${games.length}: ${list}${more}` };
  } catch (err) {
    if (err instanceof ApiError) {
      return { name: 'Tenants', status: 'fail', message: `${err.status} ${err.message}` };
    }
    return { name: 'Tenants', status: 'fail', message: (err as Error).message };
  }
}

async function checkBuildDir(dir: string): Promise<CheckResult> {
  const abs = path.resolve(dir);
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) {
    return { name: 'Build dir', status: 'fail', message: `not a directory: ${abs}` };
  }
  const findings: string[] = [];
  if (existsSync(path.join(abs, 'mods'))) findings.push('mods/');
  if (existsSync(path.join(abs, 'config'))) findings.push('config/');
  if (existsSync(path.join(abs, '.recube', 'runtime.json'))) findings.push('.recube/runtime.json');
  // Anti-cheat agent — the backend BuildPipeline expects this jar at the
  // root of the bundle (see RecubeGG BuildPipeline.php:619). The legacy
  // `mods/recube-core.jar` path is kept here purely as a "did you forget
  // to move it?" hint — it does NOT satisfy the backend check.
  if (existsSync(path.join(abs, 'recube-core.jar'))) findings.push('recube-core.jar');
  if (existsSync(path.join(abs, 'mods', 'recube-core.jar'))) {
    findings.push('mods/recube-core.jar (warning: must be at root, not under mods/)');
  }
  const status: CheckStatus = findings.length > 0 ? 'ok' : 'warn';
  return {
    name: 'Build dir',
    status,
    message: `${abs} — found: ${findings.length > 0 ? findings.join(', ') : 'nothing recognizable'}`,
  };
}
