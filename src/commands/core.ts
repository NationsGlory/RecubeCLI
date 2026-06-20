/**
 * `recube core *` — publish / inspect the recube-core anti-cheat agent jar for
 * a launcher channel.
 *
 *   POST /api/v1/launcher/{tenant}/{channel}/core/publish      (core publish)
 *   GET  /api/v1/launcher/{tenant}/{channel}/recube-core/latest (core list)
 *
 * Unlike `recube draft *`, the SERVICE TOKEN (RECUBE_TOKEN=rcs_…) is ALLOWED on
 * `core publish` — this is the intended CI path (RecubeCore CI registers a hash
 * via the internal API, then a release pipeline publishes the signed jar to a
 * channel). We therefore do NOT call refuseServiceTokenForNonAdd here.
 *
 * publish accepts either:
 *   --file <path>                 → multipart upload of a LOCAL jar (server
 *                                   computes + checks the sha256 for you)
 *   --url <key> --sha256 <h>      → reference an object ALREADY HOSTED in R2 by
 *                                   its RELATIVE KEY (e.g. recube-core/0.4.0.jar).
 *                                   The server does NOT fetch the URL and REJECTS
 *                                   absolute URLs — relative R2 keys only. The
 *                                   sha256 must match the registered hash.
 *
 * Non-interactive : plain stdout/stderr lines (no @clack TTY UI) so it runs in
 * CI / scripts.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { getStoredUser } from '../auth/store.js';
import { ApiError } from '../lib/api.js';
import { hashFile } from '../lib/publish-pipeline.js';
import { chalk } from '../lib/ui.js';
import type { AuthenticatedSession } from '../auth/session.js';

// ── helpers (same plain style as draft.ts) ──────────────────────────────────

function fail(msg: string): never {
  console.error(chalk.red('✖ ') + msg);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(chalk.green('✔ ') + msg);
}

function info(msg: string): void {
  console.log(msg);
}

/**
 * Resolve an authenticated session. Service token (rcs_) is fully accepted —
 * `core publish` is the CI path — so we only surface the auth mode, never
 * refuse it.
 */
async function session(): Promise<AuthenticatedSession> {
  let s: AuthenticatedSession;
  try {
    s = await getAuthenticatedSession();
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      fail(
        err.message +
          '\n  ' +
          chalk.dim('recube login --scope "launcher:publish openid profile"') +
          '\n  ' +
          chalk.dim('(ou, en CI : exporte RECUBE_TOKEN=rcs_… — autorisé pour core publish)')
      );
    }
    throw err;
  }
  if (s.serviceToken) {
    console.error(chalk.dim('auth : token de service (RECUBE_TOKEN)'));
  } else {
    let who = '';
    try {
      const u = await getStoredUser();
      who = u ? `@${u.handle ?? u.id}` : '(session OAuth)';
    } catch {
      who = '(session OAuth)';
    }
    console.error(chalk.dim(`auth : ${who}`));
  }
  return s;
}

/** Map an ApiError to a clear, command-specific message. */
function explainApiError(err: unknown, ctx: 'publish' | 'list'): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  let code = '';
  try {
    const body = JSON.parse(err.body) as { error?: string; message?: string };
    code = body.error ?? '';
    if (ctx === 'publish') {
      // Gate allowlist : le serveur refuse un jar dont le hash n'est pas
      // enregistré avec un 403 `hash_not_allowed`. À traiter AVANT le 403/401
      // d'auth générique ci-dessous (même status, sens différent).
      if (err.status === 403 && code === 'hash_not_allowed') {
        return `Publish refusé (403 hash_not_allowed) : ce hash n'est pas dans l'allowlist prod. La CI RecubeCore doit d'abord enregistrer le hash (internal API recube-core:register-hash) avant publication downstream.`;
      }
      if (err.status === 422 && code === 'sha256_mismatch') {
        return `Publish refusé (422 sha256_mismatch) : le sha256 fourni ne correspond pas aux octets (re-calcule-le, ou laisse --file le faire).`;
      }
      if (err.status === 422) {
        return `Publish refusé (422 ${code || 'unprocessable'}) : ${body.message ?? err.body}`;
      }
    }
    if (err.status === 403 || err.status === 401) {
      return `Accès refusé (${err.status}). Vérifie le token (RECUBE_TOKEN rcs_ ou recube login) et le scope launcher:publish, et que le tenant correspond.`;
    }
    if (err.status === 404) {
      return `Introuvable (404). Tenant/channel inconnu(s) ?`;
    }
    return body.message ? `${err.status}: ${body.message}` : `${err.status}: ${err.body}`;
  } catch {
    return `${err.status}: ${err.body}`;
  }
}

// ── commands ─────────────────────────────────────────────────────────────

export async function corePublishCommand(opts: {
  tenant?: string;
  channel?: string;
  version?: string;
  file?: string;
  url?: string;
  sha256?: string;
}): Promise<void> {
  if (!opts.tenant) fail('--tenant requis');
  if (!opts.version) fail('--version requis (tag, ex: 0.4.0)');
  const tenant = opts.tenant;
  const channel = opts.channel ?? 'tenant-wide';
  const version = opts.version;

  // Exactly one source : --file OR (--url + --sha256).
  if (!opts.file && !opts.url) {
    fail('Source requise : --file <jar> OU --url <u> --sha256 <h>.');
  }
  if (opts.file && opts.url) {
    fail('--file et --url sont mutuellement exclusifs.');
  }
  if (opts.url && !opts.sha256) {
    fail(
      '--sha256 requis avec --url (clé R2 relative déjà hébergée, ex : recube-core/0.4.0.jar ; ' +
        'le serveur ne fetch pas l\'URL — le sha256 doit correspondre au hash enregistré).'
    );
  }

  const s = await session();
  try {
    if (opts.file) {
      const abs = path.resolve(opts.file);
      const fstat = await stat(abs).catch(() => null);
      if (!fstat || !fstat.isFile()) fail(`pas un fichier : ${abs}`);
      const { sha256, size } = await hashFile(abs);
      if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`sha256 inattendu pour ${abs}`);
      info(`${chalk.dim('hash')}  ${path.basename(abs)}  ${sha256.slice(0, 12)}…  ${size} B`);
      info(`${chalk.dim('POST')}  upload multipart → ${tenant}/${channel} (v${version})`);
      const res = await s.api.corePublishFile(tenant, channel, {
        version,
        filePath: abs,
        fileName: path.basename(abs),
        sha256,
      });
      ok(`recube-core v${version} publié sur ${chalk.bold(`${tenant}/${channel}`)}.`);
      info(`  sha256 : ${String(res.sha256 ?? sha256)}`);
      if (res.url) info(`  url    : ${String(res.url)}`);
    } else {
      info(`${chalk.dim('POST')}  ${tenant}/${channel} (v${version}) ← ${opts.url}`);
      const res = await s.api.corePublishByUrl(tenant, channel, {
        version,
        url: opts.url as string,
        sha256: opts.sha256 as string,
      });
      ok(`recube-core v${version} publié sur ${chalk.bold(`${tenant}/${channel}`)}.`);
      info(`  sha256 : ${String(res.sha256 ?? opts.sha256)}`);
      info(`  url    : ${String(res.url ?? opts.url)}`);
    }
  } catch (err) {
    fail(explainApiError(err, 'publish'));
  }
}

export async function coreListCommand(opts: {
  tenant?: string;
  channel?: string;
}): Promise<void> {
  if (!opts.tenant) fail('--tenant requis');
  const tenant = opts.tenant;
  // Défaut aligné sur `core publish` ('tenant-wide') : cohérent avec resolveFor
  // côté serveur qui fallback sur la row tenant-wide (channel NULL).
  const channel = opts.channel ?? 'tenant-wide';

  const s = await session();
  try {
    const latest = await s.api.coreLatest(tenant, channel);
    if (!latest) {
      info(`Aucun recube-core publié pour ${chalk.bold(`${tenant}/${channel}`)}.`);
      return;
    }
    info(`recube-core courant — ${chalk.bold(`${tenant}/${channel}`)}`);
    info(`  version : ${latest.version ?? '-'}`);
    info(`  sha256  : ${latest.sha256 ?? '-'}`);
    info(`  url     : ${latest.url ?? '-'}`);
  } catch (err) {
    fail(explainApiError(err, 'list'));
  }
}
