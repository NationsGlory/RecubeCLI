/**
 * `recube draft *` — mutable build staging against the backend draft API
 * (commit 0dbfc7f). Base path: /api/v1/launcher/{tenant}/{channel}/drafts.
 *
 * A draft is an open, mutable file-set seeded from an optional base build. You
 * `add`/`rm` files, inspect with `diff`/`status`, then `publish` to finalize an
 * immutable build (promote stays a SEPARATE step — publish never goes live).
 *
 * Current-draft tracking : the first `create` writes `<cwd>/.recube/draft.json`
 * {tenant, channel, draftId}; subsequent commands read it so the user never
 * re-specifies the draft. Cleared on `publish` success and `abandon`.
 *
 * Non-interactive : these commands print plain lines (no @clack TTY UI) so they
 * run in CI / scripts. Auth reuses the existing OAuth session (scope
 * `launcher:draft` for add/rm/diff/status/create/abandon, `launcher:publish`
 * for publish).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { getStoredUser } from '../auth/store.js';
import { ApiError } from '../lib/api.js';
import { hashFile } from '../lib/publish-pipeline.js';
import {
  loadDraftState,
  saveDraftState,
  clearDraftState,
  draftStatePath,
} from '../lib/draft-state.js';
import { chalk } from '../lib/ui.js';
import type { AuthenticatedSession } from '../auth/session.js';
import type { DraftState } from '../types.js';

// ── helpers ────────────────────────────────────────────────────────────────

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

async function session(): Promise<AuthenticatedSession> {
  let s: AuthenticatedSession;
  try {
    s = await getAuthenticatedSession();
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      fail(
        err.message +
          '\n  ' +
          chalk.dim('recube login --scope "launcher:draft launcher:publish openid profile"') +
          '\n  ' +
          chalk.dim('(ou, en CI : exporte RECUBE_TOKEN=rcs_… pour le mode token de service)')
      );
    }
    throw err;
  }
  // Affiche le mode d'auth (sur stderr pour ne pas polluer un éventuel stdout
  // machine-lisible).
  if (s.serviceToken) {
    console.error(chalk.dim('auth : token de service (RECUBE_TOKEN, add-only)'));
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

/**
 * Refuse net une commande hors add-only quand on est en token de service.
 * Le serveur rejetterait de toute façon (rcs_ = launcher:draft add-only →
 * 401 sur create/publish/diff/show), mais on coupe AVANT l'appel réseau avec
 * un message clair. Appelé en tête des commandes non-add.
 */
function refuseServiceTokenForNonAdd(s: AuthenticatedSession, action: string): void {
  if (s.serviceToken) {
    fail(
      `Token de service = dépôt de fichiers uniquement (recube draft add).\n  ` +
        chalk.dim(
          `${action} nécessite une connexion utilisateur (recube login) ou la review web. ` +
            `Le draft doit être créé/publié par un humain ; le CI ne fait qu'ajouter ses jars.`
        )
    );
  }
}

/**
 * Résout le draft cible. En CI (token de service, pas de .recube/draft.json),
 * accepte un draft fourni explicitement via opts (--draft/--tenant/--channel)
 * ou via env (RECUBE_DRAFT_ID / RECUBE_TENANT / RECUBE_CHANNEL). Sinon, retombe
 * sur le pointeur local `.recube/draft.json` (flux dev habituel).
 */
async function resolveDraft(opts?: {
  draftId?: string;
  tenant?: string;
  channel?: string;
}): Promise<DraftState> {
  const draftId = opts?.draftId ?? process.env.RECUBE_DRAFT_ID?.trim();
  const tenant = opts?.tenant ?? process.env.RECUBE_TENANT?.trim();
  const channel = opts?.channel ?? process.env.RECUBE_CHANNEL?.trim();
  if (draftId && tenant && channel) {
    // Cible explicite (CI) — pas besoin du fichier local.
    return { tenant, channel, draftId };
  }
  const st = await loadDraftState();
  if (st) return st;
  fail(
    'Aucun draft courant.\n  ' +
      chalk.dim('Dev   : recube draft create --tenant <t> --channel <c> --version-tag <v>') +
      '\n  ' +
      chalk.dim(
        'CI    : --draft <id> --tenant <t> --channel <c> (ou env RECUBE_DRAFT_ID/RECUBE_TENANT/RECUBE_CHANNEL)'
      )
  );
}

/** Load the current draft pointer or fail with a clear hint. */
async function requireDraft(): Promise<DraftState> {
  return resolveDraft();
}

/** Map an ApiError to a clear, command-specific message. */
function explainApiError(err: unknown, ctx: 'create' | 'publish' | 'generic'): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  let code = '';
  try {
    const body = JSON.parse(err.body) as { error?: string; message?: string };
    code = body.error ?? '';
    if (ctx === 'create' && err.status === 409 && (code === 'draft_already_open' || true)) {
      return `Un draft est déjà ouvert sur ce channel (409 ${code || 'draft_already_open'}). Publie-le ou abandonne-le (recube draft abandon) avant d'en créer un autre.`;
    }
    if (ctx === 'publish') {
      if (err.status === 422) {
        switch (code) {
          case 'missing_recube_core':
            return `Publish refusé (422 missing_recube_core) : le draft doit contenir recube-core.jar (anti-cheat) à la racine.`;
          case 'unknown_recube_core_hash':
            return `Publish refusé (422 unknown_recube_core_hash) : le recube-core.jar du draft n'est pas dans l'allowlist prod. Utilise un build d'agent approuvé.`;
          case 'empty_draft':
            return `Publish refusé (422 empty_draft) : le draft ne contient aucun fichier résolu.`;
          case 'blob_missing':
            return `Publish refusé (422 blob_missing) : un blob référencé n'est pas en R2. Re-fais le add du/des fichier(s) manquant(s).`;
          default:
            return `Publish refusé (422 ${code || 'unprocessable'}) : ${body.message ?? err.body}`;
        }
      }
      if (err.status === 409) {
        return `Publish refusé (409 ${code || 'draft_not_open'}) : le draft n'est plus ouvert (déjà publié ou abandonné).`;
      }
    }
    if (err.status === 403 || err.status === 401) {
      return `Accès refusé (${err.status}). Scope manquant ? Relance recube login avec le bon scope (launcher:draft / launcher:publish).`;
    }
    return body.message ? `${err.status}: ${body.message}` : `${err.status}: ${err.body}`;
  } catch {
    return `${err.status}: ${err.body}`;
  }
}

// ── commands ─────────────────────────────────────────────────────────────

export async function draftCreateCommand(opts: {
  tenant?: string;
  channel?: string;
  version?: string;
  from?: string;
}): Promise<void> {
  if (!opts.tenant) fail('--tenant requis');
  if (!opts.channel) fail('--channel requis');
  if (!opts.version) fail('--version requis (tag, ex: 1.0.17)');
  const tenant = opts.tenant;
  const channel = opts.channel;
  const version = opts.version;

  const s = await session();
  refuseServiceTokenForNonAdd(s, 'create');
  try {
    const draft = await s.api.createDraft(tenant, channel, {
      version_tag: version,
      base_build_id: opts.from,
    });
    const state: DraftState = { tenant, channel, draftId: draft.id, version };
    await saveDraftState(state);
    ok(`Draft créé : ${chalk.bold(draft.id)} (${tenant}/${channel} → ${version})`);
    info(
      `  base: ${opts.from ?? draft.base_build_id ?? '(latest live)'}  status: ${draft.status ?? 'open'}`
    );
    info(`  tracké dans ${chalk.dim(draftStatePath())}`);
  } catch (err) {
    fail(explainApiError(err, 'create'));
  }
}

export async function draftListCommand(opts: {
  tenant?: string;
  channel?: string;
}): Promise<void> {
  // Resolve tenant/channel from flags or the current draft pointer.
  let tenant = opts.tenant;
  let channel = opts.channel;
  if (!tenant || !channel) {
    const st = await loadDraftState();
    tenant = tenant ?? st?.tenant;
    channel = channel ?? st?.channel;
  }
  if (!tenant || !channel) {
    fail('Précise --tenant et --channel (ou crée un draft courant).');
  }

  const s = await session();
  refuseServiceTokenForNonAdd(s, 'list');
  try {
    const drafts = await s.api.listDrafts(tenant, channel);
    if (drafts.length === 0) {
      info(`Aucun draft pour ${chalk.bold(`${tenant}/${channel}`)}.`);
      return;
    }
    const current = (await loadDraftState())?.draftId;
    info(chalk.dim(`${'id'.padEnd(38)} ${'version'.padEnd(10)} ${'status'.padEnd(10)} files`));
    for (const d of drafts) {
      const mark = d.id === current ? chalk.green('*') : ' ';
      info(
        `${mark} ${String(d.id).padEnd(38)} ${String(d.version_tag ?? '-').padEnd(10)} ${String(
          d.status ?? '-'
        ).padEnd(10)} ${d.resolved_file_count ?? '-'}`
      );
    }
  } catch (err) {
    fail(explainApiError(err, 'generic'));
  }
}

export async function draftStatusCommand(): Promise<void> {
  const st = await requireDraft();
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'status');
  try {
    const d = await s.api.getDraft(st.tenant, st.channel, st.draftId);
    info(`Draft ${chalk.bold(d.id)}  (${st.tenant}/${st.channel})`);
    info(`  version    : ${d.version_tag ?? st.version ?? '-'}`);
    info(`  status     : ${d.status ?? '-'}`);
    info(`  base build : ${d.base_build_id ?? '(latest live)'}`);
    info(`  files      : ${d.resolved_file_count ?? d.resolved_files?.length ?? '-'}`);
    if (d.live_moved_since_base) {
      info(
        chalk.yellow(
          '  ⚠ live a bougé depuis la base du draft — vérifie le diff avant publish (recube draft diff).'
        )
      );
    }
  } catch (err) {
    fail(explainApiError(err, 'generic'));
  }
}

export async function draftAddCommand(
  jar: string,
  opts: { path?: string; draftId?: string; tenant?: string; channel?: string }
): Promise<void> {
  // `add` est la SEULE commande utilisable par un token de service (rcs_,
  // add-only). En CI, le draft est ciblé via --draft/--tenant/--channel ou env
  // (le draft a été créé par un humain au préalable).
  const st = await resolveDraft({
    draftId: opts.draftId,
    tenant: opts.tenant,
    channel: opts.channel,
  });
  const abs = path.resolve(jar);
  const fstat = await stat(abs).catch(() => null);
  if (!fstat || !fstat.isFile()) fail(`pas un fichier : ${abs}`);

  // Default virtual path = mods/<basename> ; normalize to POSIX separators.
  const virtual = (opts.path ?? `mods/${path.basename(abs)}`).split(path.sep).join('/');

  const { sha256, size } = await hashFile(abs);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`sha256 inattendu pour ${abs}`);

  const s = await session();
  try {
    info(`${chalk.dim('hash')}  ${virtual}  ${sha256.slice(0, 12)}…  ${size} B`);
    const slot = await s.api.draftFileInitiate(st.tenant, st.channel, st.draftId, {
      path: virtual,
      sha256,
      size,
    });

    if (slot.action === 'upload') {
      if (!slot.upload_url) fail('initiate=upload mais pas d\'upload_url');
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

    // Commit the file into the draft's resolved set.
    const committed = await s.api.draftFileCommit(st.tenant, st.channel, st.draftId, {
      path: virtual,
      sha256,
      size,
      exec: false,
    });
    const action = committed.action === 'replace' ? 'remplacé' : 'ajouté';
    ok(`${virtual} ${action} au draft ${chalk.bold(st.draftId)}.`);
  } catch (err) {
    fail(explainApiError(err, 'generic'));
  }
}

export async function draftRmCommand(targetPath: string): Promise<void> {
  const st = await requireDraft();
  const virtual = targetPath.split(path.sep).join('/');
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'rm');
  try {
    await s.api.draftFileRemove(st.tenant, st.channel, st.draftId, virtual);
    ok(`${virtual} retiré du draft ${chalk.bold(st.draftId)}.`);
  } catch (err) {
    fail(explainApiError(err, 'generic'));
  }
}

export async function draftDiffCommand(): Promise<void> {
  const st = await requireDraft();
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'diff');
  try {
    const d = await s.api.draftDiff(st.tenant, st.channel, st.draftId);
    const added = d.added ?? [];
    const replaced = d.replaced ?? [];
    const removed = d.removed ?? [];
    info(`Diff draft ${chalk.bold(st.draftId)} vs base (${d.base_file_count ?? '?'} fichiers)`);
    if (added.length + replaced.length + removed.length === 0) {
      info('  (aucun changement)');
    } else {
      for (const f of added) info(chalk.green(`  + ${f.path}`));
      for (const f of replaced) info(chalk.yellow(`  ~ ${f.path}`));
      for (const f of removed) info(chalk.red(`  - ${f.path}`));
      info(
        chalk.dim(
          `  ${added.length} ajouté(s), ${replaced.length} remplacé(s), ${removed.length} retiré(s)`
        )
      );
    }
    if (d.live_moved_since_base) {
      info(
        chalk.yellow(
          '  ⚠ live a bougé depuis la base du draft — la publication se basera sur l\'état du draft.'
        )
      );
    }
  } catch (err) {
    fail(explainApiError(err, 'generic'));
  }
}

export async function draftPublishCommand(opts: {
  reference?: string;
  note?: string;
}): Promise<void> {
  const st = await requireDraft();
  if (!opts.reference) fail('--reference requis (≤ 96 caractères)');
  if (opts.reference.length > 96) fail('--reference trop long (max 96)');
  if (!opts.note) fail('--note requis (6 à 2000 caractères)');
  if (opts.note.length < 6 || opts.note.length > 2000) {
    fail('--note doit faire entre 6 et 2000 caractères');
  }

  const s = await session();
  refuseServiceTokenForNonAdd(s, 'publish');
  try {
    const res = await s.api.draftPublish(st.tenant, st.channel, st.draftId, {
      reference: opts.reference,
      note: opts.note,
    });
    const b = res.finalized_build ?? {};
    ok(`Draft publié → build ${chalk.bold(b.build_id ?? '?')}`);
    info(`  status         : ${res.status ?? 'published'}`);
    info(`  manifest_sha256: ${b.manifest_sha256 ?? '-'}`);
    info(`  files_count    : ${b.files_count ?? '-'}`);
    info(`  promu (live)   : ${res.promoted ? 'OUI' : 'NON'}`);
    info(
      chalk.dim(
        '  Le PROMOTE est séparé — le build est publié mais PAS live. Promote via l\'admin/API quand prêt.'
      )
    );
    // Draft is consumed on successful publish.
    await clearDraftState();
    info(chalk.dim('  draft courant local effacé.'));
  } catch (err) {
    fail(explainApiError(err, 'publish'));
  }
}

export async function draftAbandonCommand(): Promise<void> {
  const st = await requireDraft();
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'abandon');
  try {
    const res = await s.api.draftAbandon(st.tenant, st.channel, st.draftId);
    await clearDraftState();
    ok(
      `Draft ${chalk.bold(st.draftId)} abandonné (${res.status ?? 'abandoned'}, ${
        res.deleted_objects ?? 0
      } objet(s) supprimé(s)).`
    );
    info(chalk.dim('  draft courant local effacé.'));
  } catch (err) {
    fail(explainApiError(err, 'generic'));
  }
}
