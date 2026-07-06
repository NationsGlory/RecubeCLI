/**
 * `recube branch *` — personal dev branches (`dev-{handle}`, design §6).
 *
 * A personal branch is a private channel derived from a root channel (base,
 * default `stable`) : the owner mutates an OVERLAY (add/replace/remove) on
 * top of the base, auto-recomposed + re-signed on every mutation. It is
 * always the CALLER's own branch — the backend resolves `me` server-side
 * (`resolveMe`), there is no cross-dev access. Base path :
 * `/api/v1/launcher/{tenant}/branches[/me[/overlay[/initiate]]]`.
 *
 * `recube merge` (separate command, src/commands/merge.ts) promotes the
 * overlay onto a shared channel — kept apart because it's gated on a
 * DIFFERENT permission (promote of the TARGET, not dev-branch).
 *
 * Non-interactive : plain stdout/stderr lines (no @clack TTY UI), CI-friendly
 * — mirrors draft.ts/promote.ts/core.ts. Service tokens (RECUBE_TOKEN=rcs_…)
 * are REFUSED outright : the backend never accepts them on branch routes
 * (mutating a live auto-recomposed channel is a deliberate human action) —
 * see the route-group comment in RecubeGG routes/api.php.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { getStoredUser } from '../auth/store.js';
import { ApiError } from '../lib/api.js';
import { accessDeniedMessage } from '../lib/api-error.js';
import { noBranchHint } from '../lib/branch.js';
import { toDraftPath, InvalidDraftPathError } from '../lib/draft-path.js';
import { hashFile } from '../lib/publish-pipeline.js';
import { chalk } from '../lib/ui.js';
import type { AuthenticatedSession } from '../auth/session.js';

// ── helpers (same plain style as draft.ts / core.ts / promote.ts) ──────────

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

/**
 * Normalise un chemin utilisateur en chemin relatif POSIX (backend SafeBuildPath)
 * ou `fail()` AVANT tout appel réseau. Même helper pur que draft add/rm — les
 * overlays partagent la même classe de validation de chemin côté serveur.
 */
function normalizeOverlayPathOrFail(input: string): string {
  try {
    return toDraftPath(input);
  } catch (err) {
    if (err instanceof InvalidDraftPathError) fail(err.message);
    throw err;
  }
}

async function session(): Promise<AuthenticatedSession> {
  let s: AuthenticatedSession;
  try {
    s = await getAuthenticatedSession();
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      fail(
        err.message + '\n  ' + chalk.dim('recube login --scope "launcher:draft profile:read"')
      );
    }
    throw err;
  }
  // Branches perso ne sont JAMAIS accessibles via token de service — refus
  // net AVANT tout appel réseau (le serveur rejetterait de toute façon, mais
  // avec un message clair on évite un aller-retour + une 403 opaque).
  if (s.serviceToken) {
    fail(
      "Les branches perso sont réservées à une session OAuth humaine — RECUBE_TOKEN (token de service) " +
        "n'est jamais accepté sur ces routes (mutation d'un channel live auto-recomposé = action humaine " +
        'délibérée).\n  ' +
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

/** Map an ApiError to a clear, command-specific message. */
function explainBranchError(
  err: unknown,
  ctx: 'provision' | 'show' | 'overlay',
  tenant: string
): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);

  // resolveMe() 404 (no personal branch yet) is common to show/overlay —
  // always rewrite as the actionable FR hint instead of the raw English
  // backend message ("No personal branch — provision it first...").
  if (err.status === 404 && ctx !== 'provision') {
    return noBranchHint(tenant);
  }

  let code = '';
  let message = '';
  let fieldErrors: Record<string, string[]> | undefined;
  try {
    const body = JSON.parse(err.body) as {
      error?: string;
      message?: string;
      errors?: Record<string, string[]>;
    };
    code = body.error ?? '';
    message = body.message ?? '';
    fieldErrors = body.errors;
  } catch {
    // corps non-JSON — on retombe sur err.body brut plus bas.
  }

  if (ctx === 'provision') {
    if (err.status === 403) {
      return (
        `Création refusée (403) : il te faut la permission ${chalk.bold(`launcher.${tenant}.dev-branch`)}.\n  ` +
        chalk.dim("Demande à un admin de te l'accorder.")
      );
    }
    if (err.status === 422) {
      switch (code) {
        case 'base_not_found':
          return `Création refusée (422 base_not_found) : ${message || 'channel de base introuvable.'}`;
        case 'base_not_allowed':
          return `Création refusée (422 base_not_allowed) : ${message || "channel de base non autorisé (branche perso d'un autre dev, ou channel privé)."}`;
        case 'base_not_ready':
          return `Création refusée (422 base_not_ready) : ${message || "la base n'a pas de build live à composer."}`;
        default:
          return `Création refusée (422 ${code || 'unprocessable'}) : ${message || err.body}`;
      }
    }
    if (err.status === 429) return 'Throttle provisioning (10/min) — réessaie dans un instant.';
  }

  if (ctx === 'overlay' && err.status === 422) {
    if (fieldErrors && Object.keys(fieldErrors).length > 0) {
      const lines = Object.entries(fieldErrors).map(([field, msgs]) => `    - ${field}: ${msgs.join(', ')}`);
      return `Dépôt refusé (422 validation) :\n${lines.join('\n')}`;
    }
    return `Dépôt refusé (422 ${code || 'unprocessable'}) : ${message || err.body}`;
  }

  if (err.status === 403 || err.status === 401) {
    return accessDeniedMessage(
      err.status,
      err,
      'Vérifie le scope launcher:draft + ta session OAuth ' +
        '(les tokens de service ne sont jamais acceptés sur les branches perso).'
    );
  }

  return message ? `${err.status}: ${message}` : `${err.status}: ${err.body}`;
}

// ── commands ─────────────────────────────────────────────────────────────

export async function branchCreateCommand(opts: { tenant?: string; base?: string }): Promise<void> {
  if (!opts.tenant) fail('--tenant requis');
  const tenant = opts.tenant;
  const base = opts.base ?? 'stable';

  const s = await session();
  try {
    const { branch, created } = await s.api.provisionBranch(tenant, { base });
    if (created) {
      ok(`Branche perso créée : ${chalk.bold(branch.name)} (base: ${branch.base_channel_name ?? base})`);
    } else {
      info(`Branche perso déjà existante : ${chalk.bold(branch.name)} (base: ${branch.base_channel_name ?? '?'})`);
    }
    info(`  overlay_rev     : ${branch.overlay_rev ?? 0}`);
    info(`  latest_build_id : ${branch.latest_build_id ?? '(en attente de composition)'}`);
    if (!branch.latest_build_id) {
      warn('  Composition initiale absente — vérifie avec `recube branch show` dans un instant.');
    }
    info(chalk.dim(`  → recube branch show --tenant ${tenant}`));
  } catch (err) {
    fail(explainBranchError(err, 'provision', tenant));
  }
}

export async function branchShowCommand(opts: { tenant?: string }): Promise<void> {
  if (!opts.tenant) fail('--tenant requis');
  const tenant = opts.tenant;

  const s = await session();
  try {
    const branch = await s.api.getMyBranch(tenant);
    if (!branch) {
      info(noBranchHint(tenant));
      return;
    }
    info(`Branche perso ${chalk.bold(branch.name)}  (${tenant})`);
    info(`  base              : ${branch.base_channel_name ?? '-'}`);
    info(`  latest_build_id   : ${branch.latest_build_id ?? '(aucun)'}`);
    info(`  overlay_rev       : ${branch.overlay_rev ?? 0}`);
    info(`  dernière activité : ${branch.last_activity_at ?? '-'}`);
    const overlay = branch.overlay ?? [];
    info(`  overlay (${overlay.length} fichier(s)) :`);
    if (overlay.length === 0) {
      info('    (vide — iso base)');
    } else {
      for (const o of overlay) {
        const mark =
          o.action === 'add' ? chalk.green('+') : o.action === 'remove' ? chalk.red('-') : chalk.yellow('~');
        info(`    ${mark} ${o.path}${o.exec ? ' (exec)' : ''}`);
      }
    }
    info(chalk.dim(`  → recube merge --tenant ${tenant} --into <channel> pour mettre en ligne.`));
  } catch (err) {
    fail(explainBranchError(err, 'show', tenant));
  }
}

export async function branchOverlayAddCommand(
  file: string,
  opts: { tenant?: string; path?: string; exec?: boolean }
): Promise<void> {
  if (!opts.tenant) fail('--tenant requis');
  const tenant = opts.tenant;
  const abs = path.resolve(file);
  const fstat = await stat(abs).catch(() => null);
  if (!fstat || !fstat.isFile()) fail(`pas un fichier : ${abs}`);

  // Default virtual path = basename at the branch root (no `mods/` prefix
  // assumption like draft add — overlay paths mirror the FULL build tree,
  // not just mods). Normalise en chemin relatif POSIX (backend SafeBuildPath).
  const virtual = normalizeOverlayPathOrFail(opts.path ?? path.basename(abs));

  const { sha256, size } = await hashFile(abs);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`sha256 inattendu pour ${abs}`);

  const s = await session();
  try {
    info(`${chalk.dim('hash')}  ${virtual}  ${sha256.slice(0, 12)}…  ${size} B`);
    const slot = await s.api.initiateBranchOverlay(tenant, { path: virtual, sha256, size });

    if (slot.action === 'upload') {
      if (!slot.upload_url) fail("initiate=upload mais pas d'upload_url");
      const method = (slot.upload_method ?? 'PUT').toUpperCase();
      const headers: Record<string, string> = {
        ...(slot.upload_headers ?? {}),
        'Content-Length': String(size),
      };
      info(`${chalk.dim('PUT ')}  upload vers R2…`);
      const body = createReadStream(abs);
      const res = await fetch(slot.upload_url, {
        method,
        headers,
        body: body as unknown as BodyInit,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        fail(`${method} R2 -> ${res.status} ${res.statusText}: ${txt}`);
      }
    } else {
      info(`${chalk.dim('skip')}  déjà en R2 (dédup par sha256)`);
    }

    const out = await s.api.putBranchOverlay(tenant, {
      path: virtual,
      sha256,
      size,
      exec: opts.exec ?? false,
    });
    const action = out.overlay.action === 'replace' ? 'remplacé' : 'ajouté';
    ok(`${virtual} ${action} sur ta branche perso (${tenant}).`);
    info(
      `  recompose : ${out.recomposed ? chalk.green('ok') : chalk.yellow('non confirmée')}` +
        `${out.build_id ? `  build ${out.build_id}` : ''}`
    );
    if (!out.recomposed) {
      warn('  Vérifie `recube branch show` pour confirmer la composition.');
    }
  } catch (err) {
    fail(explainBranchError(err, 'overlay', tenant));
  }
}

export async function branchOverlayRmCommand(
  targetPath: string,
  opts: { tenant?: string }
): Promise<void> {
  if (!opts.tenant) fail('--tenant requis');
  const tenant = opts.tenant;
  const virtual = normalizeOverlayPathOrFail(targetPath);

  const s = await session();
  try {
    const out = await s.api.removeBranchOverlay(tenant, virtual);
    ok(`${virtual} retiré de ta branche perso (${tenant}).`);
    info(
      `  recompose : ${out.recomposed ? chalk.green('ok') : chalk.yellow('non confirmée')}` +
        `${out.build_id ? `  build ${out.build_id}` : ''}`
    );
  } catch (err) {
    fail(explainBranchError(err, 'overlay', tenant));
  }
}

export { explainBranchError };
