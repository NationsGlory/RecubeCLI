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
import { accessDeniedMessage } from '../lib/api-error.js';
import { ME_ALIAS, NoPersonalBranchError, noBranchHint, resolveChannelAlias } from '../lib/branch.js';
import { hashFile } from '../lib/publish-pipeline.js';
import {
  loadDraftState,
  saveDraftState,
  clearDraftState,
  draftStatePath,
} from '../lib/draft-state.js';
import { DraftTargetError, resolveDraftTarget } from '../lib/draft-target.js';
import { toDraftPath, InvalidDraftPathError } from '../lib/draft-path.js';
import { resolveRmTarget } from '../lib/draft-rm-resolve.js';
import { chalk, ui } from '../lib/ui.js';
import type { AuthenticatedSession } from '../auth/session.js';
import type { Draft, DraftState } from '../types.js';

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

function warn(msg: string): void {
  console.log(chalk.yellow('⚠ ') + msg);
}

/**
 * Normalise un chemin utilisateur en chemin relatif POSIX (backend SafeBuildPath)
 * ou `fail()` AVANT tout appel réseau avec un message actionnable. Centralise le
 * try/catch autour du helper pur `toDraftPath`.
 */
function normalizeDraftPathOrFail(input: string): string {
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
 * Résout `--channel @me` → la branche perso de l'appelant (dev-{handle}).
 * Toute autre valeur passe inchangée. Sort proprement (fail) si l'alias ne
 * peut pas être résolu (pas de branche perso encore provisionnée).
 */
async function resolveMeChannel(
  s: AuthenticatedSession,
  tenant: string,
  channel: string
): Promise<string> {
  if (channel !== ME_ALIAS) return channel;
  try {
    return await resolveChannelAlias(s.api, tenant, channel);
  } catch (err) {
    if (err instanceof NoPersonalBranchError) fail(noBranchHint(tenant));
    throw err;
  }
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
 *
 * Cas CI "current" (option `allowCurrent`, utilisé par `add`) : si tenant +
 * channel sont fournis SANS draftId explicite, on cible le draft OUVERT de
 * (tenant,channel) via le pseudo-id `current` → le serveur résout l'endpoint
 * `/drafts/current/files/...`. But user : le CI ne pose JAMAIS l'ID de draft
 * (il change à chaque cycle = ingérable) — juste RECUBE_TENANT + RECUBE_CHANNEL
 * fixes. Le draftId reste prioritaire s'il est fourni (flow `/{id}`).
 */
export const CURRENT_DRAFT = 'current';

async function resolveDraft(opts?: {
  draftId?: string;
  tenant?: string;
  channel?: string;
  allowCurrent?: boolean;
}): Promise<DraftState> {
  const draftId = opts?.draftId ?? process.env.RECUBE_DRAFT_ID?.trim();
  const tenant = opts?.tenant ?? process.env.RECUBE_TENANT?.trim();
  const channel = opts?.channel ?? process.env.RECUBE_CHANNEL?.trim();
  if (draftId && tenant && channel) {
    // Cible explicite (CI) — pas besoin du fichier local.
    return { tenant, channel, draftId };
  }
  // add-to-current : tenant+channel sans ID → draft ouvert résolu serveur-side.
  if (opts?.allowCurrent && !draftId && tenant && channel) {
    return { tenant, channel, draftId: CURRENT_DRAFT };
  }
  const st = await loadDraftState();
  if (st) return st;
  fail(
    'Aucun draft courant.\n  ' +
      chalk.dim('passe -t <tenant> -c <channel>') +
      '\n  ' +
      chalk.dim('ou sélectionne : recube draft use -t <tenant> -c <channel>') +
      '\n  ' +
      chalk.dim('ou crée : recube draft create -t <tenant> -c <channel>')
  );
}

/** Load the current draft pointer or fail with a clear hint. */
async function requireDraft(): Promise<DraftState> {
  return resolveDraft();
}

/**
 * Décore une DraftTargetError (résolution partagée) en message actionnable puis
 * `fail()`. Le helper `resolveDraftTarget` reste pur (messages neutres, pas de
 * chalk) — c'est ici qu'on ajoute les hints copiables selon le `code`.
 */
function failDraftTarget(
  err: DraftTargetError,
  opts: { tenant?: string; channel?: string }
): never {
  if (err.code === 'no_current') {
    fail(
      'Aucun draft courant.\n  ' +
        chalk.dim('passe -t <tenant> -c <channel>') +
        '\n  ' +
        chalk.dim('ou sélectionne : recube draft use -t <tenant> -c <channel>') +
        '\n  ' +
        chalk.dim('ou crée : recube draft create -t <tenant> -c <channel>')
    );
  }
  if (err.code === 'no_open') {
    fail(
      err.message +
        '\n  ' +
        chalk.dim(
          `Ouvre-en un : recube draft create -t ${opts.tenant ?? '<tenant>'} -c ${
            opts.channel ?? '<channel>'
          }`
        )
    );
  }
  // incomplete_flags / multi_open : le message du helper est déjà actionnable.
  fail(err.message);
}

/**
 * Résolution partagée du draft cible pour rm/diff/status/publish/use.
 * Ordre : --draft <id> (+ -t/-c) → getDraft ; -t/-c → draft OUVERT (listDrafts) ;
 * sinon → pointeur local `.recube/draft.json`. Les env RECUBE_TENANT/CHANNEL/
 * DRAFT_ID servent de défaut (parité avec l'ancien requireDraft + le flux CI).
 * `@me` est résolu ici (nécessite la session) AVANT de déléguer au helper pur.
 */
async function resolveTargetOrFail(
  s: AuthenticatedSession,
  opts: { tenant?: string; channel?: string; draft?: string }
): Promise<DraftState> {
  const tenant = opts.tenant ?? process.env.RECUBE_TENANT?.trim() ?? undefined;
  let channel = opts.channel ?? process.env.RECUBE_CHANNEL?.trim() ?? undefined;
  const draft = opts.draft ?? process.env.RECUBE_DRAFT_ID?.trim() ?? undefined;
  // `--channel @me` → la branche perso de l'appelant (dev-{handle}). Résolu
  // seulement si le tenant est connu (sinon le helper renverra incomplete_flags).
  if (channel && tenant) {
    channel = await resolveMeChannel(s, tenant, channel);
  }
  try {
    return await resolveDraftTarget(s.api, { tenant, channel, draft }, loadDraftState);
  } catch (err) {
    if (err instanceof DraftTargetError) failDraftTarget(err, { tenant, channel });
    if (err instanceof ApiError) fail(explainApiError(err, 'generic'));
    throw err;
  }
}

/** Référence auto par défaut pour publish (parité avec `recube publish`). */
function defaultDraftReference(st: DraftState): string {
  const ts = Math.floor(Date.now() / 1000);
  return `${st.tenant}-${st.channel}-${st.version ?? 'draft'}-b${ts}`;
}

/** Map an ApiError to a clear, command-specific message. */
function explainApiError(err: unknown, ctx: 'create' | 'publish' | 'add' | 'generic'): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  let code = '';
  try {
    const body = JSON.parse(err.body) as { error?: string; message?: string };
    code = body.error ?? '';
    if (ctx === 'create' && err.status === 409 && (code === 'draft_already_open' || true)) {
      return `Un draft est déjà ouvert sur ce channel (409 ${code || 'draft_already_open'}). Publie-le ou abandonne-le (recube draft abandon) avant d'en créer un autre.`;
    }
    if (
      ctx === 'create' &&
      err.status === 422 &&
      (code === 'version_not_greater' || code === 'version_collision')
    ) {
      // Override de version refusé (<= en ligne / déjà publiée). Le serveur
      // explique déjà clairement + donne la version suggérée → on le surface.
      return body.message ?? err.body;
    }
    if (ctx === 'add') {
      // Plus de 409 « aucun draft ouvert » : le serveur OUVRE désormais le draft
      // automatiquement au 1er add (ou résout l'existant). Un 404 = channel/
      // tenant inconnu ; un 422 = ouverture auto impossible (le serveur explique).
      if (err.status === 404) {
        return `Channel ou tenant introuvable (404). Vérifie --tenant / --channel (ou RECUBE_TENANT / RECUBE_CHANNEL).`;
      }
      if (err.status === 422) {
        return `Dépôt refusé (422 ${code || 'unprocessable'}) : ${body.message ?? err.body}`;
      }
      if (err.status === 403 || err.status === 401) {
        return accessDeniedMessage(
          err.status,
          err,
          'Vérifie RECUBE_TOKEN (token de service rcs_, scope launcher:draft) et que le tenant correspond.'
        );
      }
    }
    if (ctx === 'publish') {
      // Publish ASYNC (2026-07-08) : deux échecs surviennent AVANT tout poll.
      if (err.status === 503 && code === 'dispatch_failed') {
        // La queue de finalize est injoignable : le claim a été rollback
        // serveur-side (draft repassé `open`), le draft reste réutilisable.
        return (
          `Publication non lancée (503 dispatch_failed) : la file de finalisation est indisponible.\n  ` +
          chalk.dim(
            (body.message ?? 'Réessaie dans un instant ; le draft est resté ouvert (rien n\'a été publié).')
          )
        );
      }
      if (err.status === 403 && code === 'promote_required_for_derived_channel') {
        // Channel dérivé : le finalize met le live à jour inconditionnellement,
        // donc la permission de promotion est exigée pour publier tout court.
        return (
          `Publish refusé (403 promote_required_for_derived_channel) : ce channel est dérivé — sa publication met le live à jour immédiatement, donc la permission de promotion (launcher.{tenant}.promote) est requise.\n  ` +
          chalk.dim(body.message ?? 'Publie sur un channel non-dérivé, ou obtiens la permission de promotion.')
        );
      }
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
      return accessDeniedMessage(
        err.status,
        err,
        'Scope manquant ? Relance recube login avec le bon scope (launcher:draft / launcher:publish).'
      );
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
  const tenant = opts.tenant;
  // version optionnelle : vide → le serveur calcule la version en ligne +1 patch
  // (autoritaire). Fournie → override, validé > en ligne côté serveur.
  const version = opts.version;

  const s = await session();
  refuseServiceTokenForNonAdd(s, 'create');
  // `--channel @me` → la branche perso de l'appelant (dev-{handle}).
  const channel = await resolveMeChannel(s, tenant, opts.channel);
  try {
    // version_tag envoyé seulement si override fourni ; sinon omis → le serveur
    // auto-incrémente (next semver du channel).
    const draft = await s.api.createDraft(tenant, channel, {
      version_tag: version,
      base_build_id: opts.from,
    });
    // Version EFFECTIVE = celle assignée par le serveur (auto current+1 si on
    // n'a rien envoyé, sinon notre override). On persiste/affiche celle-là.
    const effectiveVersion = draft.version_tag ?? version;
    const state: DraftState = {
      tenant,
      channel,
      draftId: draft.id,
      version: effectiveVersion,
    };
    await saveDraftState(state);
    ok(
      `Draft créé : ${chalk.bold(draft.id)} (${tenant}/${channel} → ${effectiveVersion ?? '?'})`
    );
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
  // `--channel @me` → la branche perso de l'appelant (dev-{handle}).
  channel = await resolveMeChannel(s, tenant, channel);
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

/**
 * `recube draft use -t <tenant> -c <channel> [--draft <id>]` — résout le draft
 * cible (même logique partagée que rm/diff/status/publish) puis le POSE comme
 * pointeur courant `.recube/draft.json`, pour que les commandes suivantes
 * fonctionnent sans re-spécifier les flags. Sélecteur explicite (repo cloné,
 * draft créé ailleurs, pointeur effacé).
 */
export async function draftUseCommand(opts: {
  tenant?: string;
  channel?: string;
  draft?: string;
}): Promise<void> {
  if (!opts.tenant) fail('-t/--tenant requis');
  if (!opts.channel) fail('-c/--channel requis');
  const s = await session();
  // `use` liste/lit les drafts (getDraft/listDrafts) → interdit au token de service.
  refuseServiceTokenForNonAdd(s, 'use');
  const st = await resolveTargetOrFail(s, opts);
  await saveDraftState(st);
  ok(
    `draft courant = ${chalk.bold(st.draftId)} (${st.tenant}/${st.channel}${
      st.version ? `, ${st.version}` : ''
    })`
  );
  info(`  tracké dans ${chalk.dim(draftStatePath())}`);
}

export async function draftStatusCommand(
  opts: { tenant?: string; channel?: string; draft?: string } = {}
): Promise<void> {
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'status');
  const st = await resolveTargetOrFail(s, opts);
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
  opts: { path?: string; draftId?: string; tenant?: string; channel?: string; encrypt?: boolean }
): Promise<void> {
  // `add` est la SEULE commande utilisable par un token de service (rcs_,
  // add-only). Ciblage : --draft <id> (ou RECUBE_DRAFT_ID) pour un draft précis,
  // SINON --tenant/--channel (ou env) → le draft OUVERT du couple via
  // l'endpoint `/drafts/current` (le serveur résout). But user : le CI ne pose
  // JAMAIS l'ID (il change) — juste RECUBE_TENANT + RECUBE_CHANNEL fixes.
  const st = await resolveDraft({
    draftId: opts.draftId,
    tenant: opts.tenant,
    channel: opts.channel,
    allowCurrent: true,
  });
  const targetLabel =
    st.draftId === CURRENT_DRAFT
      ? `draft ouvert de ${chalk.bold(`${st.tenant}/${st.channel}`)}`
      : `draft ${chalk.bold(st.draftId)}`;
  const abs = path.resolve(jar);
  const fstat = await stat(abs).catch(() => null);
  if (!fstat || !fstat.isFile()) fail(`pas un fichier : ${abs}`);

  // Default virtual path = mods/<basename> ; normalise en chemin relatif POSIX
  // (backend SafeBuildPath) — fail côté client si invalide (.. / absolu / etc.).
  const virtual = normalizeDraftPathOrFail(opts.path ?? `mods/${path.basename(abs)}`);

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
      encrypted: opts.encrypt ?? false,
    });
    const action = committed.action === 'replace' ? 'remplacé' : 'ajouté';
    ok(`${virtual} ${action} au ${targetLabel}.`);
  } catch (err) {
    fail(explainApiError(err, 'add'));
  }
}

export async function draftRmCommand(
  targetPath: string,
  opts: { tenant?: string; channel?: string; draft?: string } = {}
): Promise<void> {
  // Normalise en chemin relatif POSIX (backend SafeBuildPath) — fail côté
  // client AVANT tout appel réseau si le chemin est invalide (.. / absolu / etc.).
  const virtual = normalizeDraftPathOrFail(targetPath);
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'rm');
  const st = await resolveTargetOrFail(s, opts);

  // Résolution case-insensitive contre les chemins RÉELS du draft : les paths
  // gardent leur casse d'origine côté backend (ex `mods/CodeChickenLib-…jar`),
  // et le DELETE est exact-match. On récupère la file-list résolue (base ⊕
  // overlay) pour retomber sur la bonne casse quand le dev en tape une autre.
  // rm peut cibler un fichier de BASE (masquage) autant qu'un overlay → la
  // liste résolue les couvre tous les deux. Best-effort : si la liste est
  // indisponible, on retombe sur l'envoi exact-path historique (kind none).
  let candidatePaths: string[] = [];
  try {
    const draft = await s.api.getDraft(st.tenant, st.channel, st.draftId);
    candidatePaths = (draft.resolved_files ?? []).map((f) => f.path);
    if (candidatePaths.length === 0) {
      // Fallback : liste résolue absente → au moins l'overlay via le diff.
      const d = await s.api.draftDiff(st.tenant, st.channel, st.draftId);
      candidatePaths = [...(d.added ?? []), ...(d.replaced ?? [])].map((f) => f.path);
    }
  } catch {
    candidatePaths = [];
  }

  const res = resolveRmTarget(virtual, candidatePaths);
  let target = virtual;
  switch (res.kind) {
    case 'exact':
      target = res.path;
      break;
    case 'ci':
      target = res.path;
      info(chalk.dim(`  casse corrigée : ${virtual} -> ${res.path}`));
      break;
    case 'ambiguous':
      fail(
        `« ${virtual} » correspond à plusieurs fichiers du draft (casse différente) :\n` +
          res.matches.map((m) => `    ${m}`).join('\n') +
          '\n  Indique la casse exacte du fichier à retirer.'
      );
      break;
    case 'none':
      // Pas trouvé dans la liste résolue : soit chemin réellement absent, soit
      // liste indisponible. On n'échoue PAS (rm peut viser un fichier hors
      // liste connue) : on envoie le chemin tel quel (fallback exact-path).
      if (candidatePaths.length > 0) {
        warn(
          `« ${virtual} » introuvable dans le draft ${chalk.bold(st.draftId)} ` +
            '(voir `recube draft diff`) — envoi du chemin tel quel.'
        );
      }
      target = virtual;
      break;
  }

  try {
    await s.api.draftFileRemove(st.tenant, st.channel, st.draftId, target);
    ok(`${target} retiré du draft ${chalk.bold(st.draftId)}.`);
  } catch (err) {
    fail(explainApiError(err, 'generic'));
  }
}

export async function draftDiffCommand(
  opts: { tenant?: string; channel?: string; draft?: string } = {}
): Promise<void> {
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'diff');
  const st = await resolveTargetOrFail(s, opts);
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

/** `origin` → badge coloré 1 caractère, même code couleur que draftDiffCommand. */
function originBadge(origin: string): string {
  if (origin === 'added') return chalk.green('+');
  if (origin === 'replaced') return chalk.yellow('~');

  return chalk.dim('=');
}

/** Formatte une taille en octets en unité lisible (Ko/Mo/Go), 1 décimale. */
function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} Go`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} Mo`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} Ko`;

  return `${bytes} o`;
}

export async function draftFilesCommand(
  opts: { tenant?: string; channel?: string; draft?: string; all?: boolean } = {}
): Promise<void> {
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'files');
  const st = await resolveTargetOrFail(s, opts);
  const overlayOnly = !opts.all;

  try {
    let page = 1;
    let totalPages = 1;
    let total = 0;
    const rows: string[] = [];

    do {
      const res = await s.api.draftFilesFlat(st.tenant, st.channel, st.draftId, page, 200, overlayOnly);
      total = res.total;
      totalPages = res.total_pages;
      for (const f of res.files) {
        const badge = f.removed ? chalk.red('-') : originBadge(f.origin);
        const size = formatSize(f.size).padStart(9);
        const sha = f.sha256.slice(0, 10);
        const meta = f.uploaded_at
          ? chalk.dim(` (ajouté ${new Date(f.uploaded_at).toLocaleString()} par ${f.uploaded_by ?? '?'})`)
          : '';
        rows.push(`  ${badge} ${size}  ${sha}  ${f.path}${meta}`);
      }
      page++;
    } while (page <= totalPages);

    const label = overlayOnly
      ? `Fichiers ajoutés/remplacés/retirés dans le draft ${chalk.bold(st.draftId)} (${total}) :`
      : `Fichiers du draft ${chalk.bold(st.draftId)} (${total} au total, base + overlay) :`;
    info(label);
    for (const r of rows) info(r);
    if (rows.length === 0) {
      info(chalk.dim('  (aucun fichier ajouté/remplacé/retiré — draft vide ou base non modifiée)'));
    }
    info(
      chalk.dim(
        '  + ajouté  ~ remplacé  = hérité (base)  - retiré | taille · sha (10) · chemin · métadonnée d\'upload'
      )
    );
    if (overlayOnly) {
      info(chalk.dim('  --all pour voir aussi les fichiers hérités du base (build résolu complet).'));
    }
  } catch (err) {
    fail(explainApiError(err, 'generic'));
  }
}

// ── poll de finalisation (publish async) ─────────────────────────────────────

/**
 * Intervalle et timeout du poll de finalisation. Surchargés par env pour les
 * tests (poll instantané) et pour donner une échappatoire ops sur les très gros
 * builds. Lus à l'appel (pas au chargement du module) pour que les tests
 * puissent les poser avant d'invoquer la commande.
 */
function pollIntervalMs(): number {
  const v = Number(process.env.RECUBE_DRAFT_POLL_INTERVAL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 2500;
}
function pollTimeoutMs(): number {
  const v = Number(process.env.RECUBE_DRAFT_POLL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Issue terminale du poll de finalisation d'un publish async. */
type FinalizeOutcome =
  | { kind: 'published'; buildId: string | null; draft: Draft }
  | { kind: 'failed'; error: string }
  | { kind: 'timeout' };

/**
 * Poll GET /drafts/{id} jusqu'à un état terminal (le publish est ASYNC depuis
 * 2026-07-08 : le POST rend 202 immédiatement, le vrai travail tourne dans
 * FinalizeDraftBuildJob). Terminaisons :
 *   - `status === 'published'`            → succès (finalized_build_id non-null).
 *   - `status === 'open'` + finalize_error → échec (draft rollback, réutilisable).
 *   - timeout dépassé                     → indéterminé (gros build en cours ?).
 * `status === 'finalizing'` (ou `open` transitoire sans erreur) → on repoll.
 * Une erreur réseau transitoire pendant le poll est retentée jusqu'au timeout ;
 * une ApiError d'autz (401/403/404) coupe net via `fail()`.
 */
async function pollDraftFinalize(s: AuthenticatedSession, st: DraftState): Promise<FinalizeOutcome> {
  const intervalMs = pollIntervalMs();
  const deadline = Date.now() + pollTimeoutMs();
  const interactive = Boolean(process.stdout.isTTY);
  const spin = interactive ? ui.spinner() : null;
  const startedAt = Date.now();
  spin?.start('Finalisation du build en cours…');

  for (;;) {
    let d: Draft;
    try {
      d = await s.api.getDraft(st.tenant, st.channel, st.draftId);
    } catch (err) {
      // Autz / draft disparu = non-transitoire : inutile de retenter.
      if (
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403 || err.status === 404)
      ) {
        spin?.stop('Poll interrompu.');
        fail(explainApiError(err, 'generic'));
      }
      // Sinon (réseau, 5xx transitoire) : on retente jusqu'au timeout.
      if (Date.now() >= deadline) {
        spin?.stop('Délai de finalisation dépassé.');
        return { kind: 'timeout' };
      }
      await sleep(intervalMs);
      continue;
    }

    const status = String(d.status ?? '');
    if (status === 'published') {
      spin?.stop('Build finalisé.');
      return {
        kind: 'published',
        buildId: d.finalized_build_id != null ? String(d.finalized_build_id) : null,
        draft: d,
      };
    }
    if (status === 'open' && d.finalize_error) {
      spin?.stop('Finalisation échouée.');
      return { kind: 'failed', error: String(d.finalize_error) };
    }

    if (Date.now() >= deadline) {
      spin?.stop('Délai de finalisation dépassé.');
      return { kind: 'timeout' };
    }
    spin?.message(`Finalisation du build en cours… (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    await sleep(intervalMs);
  }
}

export async function draftPublishCommand(opts: {
  tenant?: string;
  channel?: string;
  draft?: string;
  reference?: string;
  note?: string;
  promote?: boolean;
}): Promise<void> {
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'publish');

  // Résolution du draft à publier (logique partagée avec rm/diff/status/use) :
  //  - --draft <id> (+ -t/-c) → getDraft ; -t/-c → draft EN COURS (listDrafts) ;
  //  - aucun flag → pointeur local .recube/draft.json (flux dev habituel).
  const st = await resolveTargetOrFail(s, {
    tenant: opts.tenant,
    channel: opts.channel,
    draft: opts.draft,
  });

  // reference : auto-défaut (parité avec `recube publish`) si absente.
  const reference = opts.reference ?? defaultDraftReference(st);
  if (reference.length > 96) fail('reference trop longue (max 96 caractères)');

  // note : générée par défaut si absente (le changelog explicite reste
  // recommandé via -n, on prévient quand on retombe sur le défaut).
  let note = opts.note;
  if (!note) {
    note = `Publication du build ${st.version ?? '(auto)'} sur ${st.channel}`;
    info(chalk.yellow('  note par défaut générée — précise -n "<changelog>" pour un descriptif explicite.'));
  }
  if (note.length < 6 || note.length > 2000) {
    fail('--note doit faire entre 6 et 2000 caractères');
  }

  // 1) POST publish : ASYNC → 202 (queued) après le claim atomique. Les seules
  //    erreurs à traiter ICI (avant tout poll) sont 503 dispatch_failed et 403
  //    promote_required_for_derived_channel → explainApiError + arrêt immédiat.
  const payload: { reference: string; note: string; promote?: boolean } = { reference, note };
  if (opts.promote) payload.promote = true;
  try {
    await s.api.draftPublish(st.tenant, st.channel, st.draftId, payload);
  } catch (err) {
    fail(explainApiError(err, 'publish'));
  }
  info(
    chalk.dim(
      `Publication du draft ${chalk.bold(st.draftId)} lancée (${st.tenant}/${st.channel}) — finalisation en file d'attente…`
    )
  );

  // 2) Poll GET /drafts/{id} jusqu'à un état terminal (published / open+error /
  //    timeout). On n'efface le pointeur local QUE sur un `published` confirmé.
  const outcome = await pollDraftFinalize(s, st);

  if (outcome.kind === 'failed') {
    // Échec de finalisation : le draft est rollback en `open` côté serveur, donc
    // RÉUTILISABLE — on NE touche PAS le pointeur local (l'user corrige + republie).
    fail(
      `Finalisation échouée — le build n'a PAS été publié : ${outcome.error}\n  ` +
        chalk.dim(
          `Le draft ${st.draftId} est resté ouvert (réutilisable) : corrige puis relance recube draft publish.`
        )
    );
  }

  if (outcome.kind === 'timeout') {
    // Indéterminé : gros build encore en traitement le plus souvent, pas une
    // erreur franche. On garde le pointeur local et on rend la main sans échouer.
    warn(
      `Finalisation toujours en cours après ${Math.round(pollTimeoutMs() / 1000)}s — arrêt du suivi (le build peut encore aboutir).\n  ` +
        chalk.dim(
          `Vérifie l'état plus tard : recube draft status -t ${st.tenant} -c ${st.channel} --draft ${st.draftId}`
        )
    );
    return;
  }

  // outcome.kind === 'published'
  const b = outcome.draft;
  const buildId = outcome.buildId;
  ok(`Draft publié → build ${chalk.bold(buildId ?? '?')}  (${st.tenant}/${st.channel})`);
  info(`  reference   : ${reference}`);
  info(`  version     : ${b.version_tag ?? st.version ?? '-'}`);
  info(`  fichiers    : ${b.resolved_file_count ?? '-'}`);

  if (opts.promote) {
    // Promote demandé : la mise en ligne est appliquée par le job de finalize
    // (best-effort, non re-throw). Le payload draft ne l'expose PAS → on ne peut
    // pas la CONFIRMER ici : on l'annonce et on donne le moyen de vérifier/forcer.
    info(
      chalk.dim(
        '  promote demandé — la mise en ligne est appliquée par le job de finalisation (best-effort, non garanti si permission/erreur).'
      )
    );
  } else {
    info(
      chalk.dim(
        '  Le PROMOTE est séparé — le build est publié mais PAS forcément live. Promote via l\'admin/API quand prêt.'
      )
    );
  }
  if (buildId) {
    info(
      chalk.dim(opts.promote ? '  → Vérifie/force la mise en ligne : ' : '  → Pour le mettre en ligne : ') +
        `recube promote -t ${st.tenant} -c ${st.channel} -b ${buildId}`
    );
  }

  // Efface le pointeur local UNIQUEMENT sur publish CONFIRMÉ et s'il visait CE
  // draft (un publish ciblé par --tenant/--channel ne doit pas effacer un autre
  // draft courant local).
  const local = await loadDraftState();
  if (local?.draftId === st.draftId) {
    await clearDraftState();
    info(chalk.dim('  draft courant local effacé.'));
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
