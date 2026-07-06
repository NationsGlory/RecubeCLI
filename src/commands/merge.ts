/**
 * `recube merge` — merges a SOURCE overlay/channel onto a shared channel
 * (`--into`). Two routes, selected by `--from` :
 *
 *   --from @me (default)     POST /branches/me/merge            body { into, version? }
 *   --from <channel>         POST /channels/{source}/merge      body { into, version? }
 *
 * `@me` always resolves server-side to the caller's own personal branch
 * (`resolveMe`) — unchanged since v0.5.0. Any OTHER value is treated as an
 * arbitrary DERIVED channel name and hits the generalized endpoint : gated on
 * read-entitlement of the SOURCE + the PROMOTE permission of the TARGET (not
 * the source) — same anti-escalade barrier as the `@me` path (design §5/§7) :
 * having/reading a channel never grants the right to go live elsewhere.
 *
 * Destructive-ish (puts a build LIVE on a shared channel) : confirms
 * interactively unless `--yes` is passed. Service tokens (RECUBE_TOKEN=rcs_…)
 * are refused outright, same as `recube branch *` (personal-branch routes
 * never accept them server-side) — this also covers the generalized route
 * since both go through the same OAuth-only `session()` helper below.
 */

import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { getStoredUser } from '../auth/store.js';
import { ApiError } from '../lib/api.js';
import { ME_ALIAS, noBranchHint } from '../lib/branch.js';
import { chalk, ui } from '../lib/ui.js';
import type { AuthenticatedSession } from '../auth/session.js';
import type { PersonalBranch } from '../types.js';

// ── helpers (same plain style as branch.ts / draft.ts / promote.ts) ────────

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

function warn(msg: string): void {
  console.log(chalk.yellow('⚠ ') + msg);
}

async function session(): Promise<AuthenticatedSession> {
  let s: AuthenticatedSession;
  try {
    s = await getAuthenticatedSession();
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      fail(err.message + '\n  ' + chalk.dim('recube login --scope "launcher:promote profile:read"'));
    }
    throw err;
  }
  if (s.serviceToken) {
    fail(
      "Les branches perso sont réservées à une session OAuth humaine — RECUBE_TOKEN (token de service) " +
        "n'est jamais accepté sur ces routes.\n  " +
        chalk.dim('Connecte-toi : recube login')
    );
  }
  let who = '';
  try {
    const u = await getStoredUser();
    who = u ? `@${u.handle ?? u.id}` : '(session OAuth)';
  } catch {
    who = '(session OAuth)';
  }
  console.error(chalk.dim(`auth : ${who}`));
  return s;
}

/**
 * Resolve the `--from` flag to a routing decision : `@me` (default, absent
 * flag included) merges the caller's personal branch via `mergeBranch`
 * (`/branches/me/merge`) ; any other value is passed through as-is as the
 * SOURCE channel name for the generalized `mergeChannel`
 * (`/channels/{source}/merge`). Pure/no I/O — kept separate from
 * `mergeCommand` so the @me-vs-channel routing is unit-testable without
 * standing up a session.
 */
export function resolveMergeSource(from: string | undefined): { isMe: boolean; source: string } {
  const source = from ?? ME_ALIAS;
  return { isMe: source === ME_ALIAS, source };
}

function parseBody(err: ApiError): { code: string; message: string } {
  try {
    const body = JSON.parse(err.body) as { error?: string; message?: string };
    return { code: body.error ?? '', message: body.message ?? '' };
  } catch {
    return { code: '', message: '' };
  }
}

/** Map an ApiError from the merge endpoint to a clear, actionable message. */
export function explainMergeError(err: unknown, tenant: string, into: string): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);

  const { code, message } = parseBody(err);

  if (err.status === 404) {
    // Either "no personal branch" (source, resolveMe) or "target channel not
    // found" — the server's message already distinguishes them; surface it,
    // with a fallback hint if the body is unreadable.
    return (
      `Introuvable (404) : ${message || `vérifie que ta branche perso existe (recube branch show -t ${tenant}) et que le channel cible '${into}' existe.`}`
    );
  }
  if (err.status === 403) {
    return (
      `Merge refusé (403) : il te faut le scope ${chalk.bold('launcher:promote')} + la permission promote ` +
      `sur ${chalk.bold(`${tenant}/${into}`)} (ou être owner de la cible).\n  ` +
      chalk.dim(message || `Demande à un release manager, ou vise un channel où tu as promote.`)
    );
  }
  if (err.status === 429) return 'Throttle merge (10/min) — réessaie dans un instant.';
  if (err.status === 422) {
    switch (code) {
      case 'version_not_greater':
        return `Merge refusé (422 version_not_greater) : ${message || `--version doit être strictement supérieur à la version live de '${into}'.`}`;
      case 'version_collision':
        return `Merge refusé (422 version_collision) : ${message || `cette version est déjà publiée sur '${into}'.`}`;
      case 'materialize_incomplete':
        return `Merge refusé (422 materialize_incomplete) : ${message || "blob(s) source manquant(s) — refais l'overlay add du/des fichier(s) concerné(s)."}`;
      case 'target_not_ready':
        return `Merge refusé (422 target_not_ready) : ${message || `'${into}' n'a pas de build live.`}`;
      case 'target_build_missing':
        return `Merge refusé (422 target_build_missing) : ${message || 'build live de la cible introuvable.'}`;
      case 'target_manifest_unreadable':
        return `Merge refusé (422 target_manifest_unreadable) : ${message || 'manifest de la cible illisible.'}`;
      case 'source_not_derived':
        return (
          `Merge refusé (422 source_not_derived) : ${message || "le channel source n'est pas un channel dérivé — seul un channel dérivé (branche perso ou draft-channel) peut être mergé."}`
        );
      case 'version_not_applicable':
        return (
          `Merge refusé (422 version_not_applicable) : ${message || '--version-tag ne peut pas être appliqué à ce merge (pas de version explicite acceptée pour cette source/cible).'}`
        );
      default:
        return `Merge refusé (422 ${code || 'unprocessable'}) : ${message || err.body}`;
    }
  }
  if (err.status === 401) {
    return message
      ? `Accès refusé (401) : ${message}\n  Reconnecte-toi : recube login --scope "launcher:promote profile:read".`
      : `Accès refusé (401). Reconnecte-toi : recube login --scope "launcher:promote profile:read".`;
  }

  return message ? `${err.status}: ${message}` : `${err.status}: ${err.body}`;
}

/** Interactive confirm gate shared by both merge routes (--yes bypasses it). */
async function confirmMergeOrExit(target: string, yes: boolean | undefined): Promise<void> {
  if (yes) return;
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (!interactive) {
    fail('Confirmation requise en mode non-interactif : ajoute --yes pour merger (CI/scripts).');
  }
  const proceed = await ui.confirm({
    message: `Merger sur ${target} maintenant ?`,
    initialValue: false,
  });
  if (!proceed) fail('Annulé.');
}

// ── command ──────────────────────────────────────────────────────────────

export async function mergeCommand(opts: {
  tenant?: string;
  from?: string;
  into?: string;
  version?: string;
  yes?: boolean;
}): Promise<void> {
  if (!opts.tenant) fail('--tenant requis');
  if (!opts.into) fail('--into requis (channel cible, ex : beta, stable)');
  const tenant = opts.tenant;
  const into = opts.into;

  if (opts.version && !/^\d+\.\d+\.\d+$/.test(opts.version)) {
    fail('--version doit être un semver x.y.z (ex : 1.4.2).');
  }

  const { isMe, source } = resolveMergeSource(opts.from);
  const s = await session();

  if (isMe) {
    let branch: PersonalBranch | null;
    try {
      branch = await s.api.getMyBranch(tenant);
    } catch (err) {
      fail(explainMergeError(err, tenant, into));
    }
    if (!branch) fail(noBranchHint(tenant));

    const overlayCount = branch.overlay?.length ?? 0;
    info(`Branche perso ${chalk.bold(branch.name)} → merge vers ${chalk.bold(`${tenant}/${into}`)}`);
    info(`  overlay actuel : ${overlayCount} entrée(s) (add/replace/remove)`);
    info(`  version        : ${opts.version ?? '(auto-bump patch de la version live de la cible)'}`);
    warn(
      `Ceci va METTRE EN LIGNE l'overlay sur le channel PARTAGÉ '${into}' — les joueurs de ce channel ` +
        'verront le changement sous ~30s après le build. Ton overlay perso PERSISTE (tu peux itérer après).'
    );

    await confirmMergeOrExit(`${tenant}/${into}`, opts.yes);

    try {
      const res = await s.api.mergeBranch(tenant, { into, version: opts.version });
      ok(
        `Overlay mergé sur ${chalk.bold(`${tenant}/${res.into}`)} → build ${chalk.bold(res.build_id)}. ` +
          'Live sous ~30s.'
      );
      info(chalk.dim(`  → recube versions list ${tenant} --channel ${res.into}`));
    } catch (err) {
      fail(explainMergeError(err, tenant, into));
    }
    return;
  }

  // Generalized route : `source` is an arbitrary derived channel name (not
  // @me) — no personal-branch fetch, straight to /channels/{source}/merge.
  info(`Channel ${chalk.bold(source)} → merge vers ${chalk.bold(`${tenant}/${into}`)}`);
  info(`  version : ${opts.version ?? '(auto-bump patch de la version live de la cible)'}`);
  warn(
    `Ceci va METTRE EN LIGNE le contenu de '${source}' sur le channel PARTAGÉ '${into}' — les joueurs de ` +
      'ce channel verront le changement sous ~30s après le build.'
  );

  await confirmMergeOrExit(`${tenant}/${into}`, opts.yes);

  try {
    const res = await s.api.mergeChannel(tenant, source, { into, version: opts.version });
    ok(
      `'${source}' mergé sur ${chalk.bold(`${tenant}/${res.into}`)} → build ${chalk.bold(res.build_id)}. ` +
        'Live sous ~30s.'
    );
    info(chalk.dim(`  → recube versions list ${tenant} --channel ${res.into}`));
  } catch (err) {
    fail(explainMergeError(err, tenant, into));
  }
}
