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
import { ME_ALIAS, NoPersonalBranchError, noBranchHint, resolveChannelAlias } from '../lib/branch.js';
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

function warn(msg: string): void {
  console.log(chalk.yellow('⚠ ') + msg);
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
      chalk.dim('Dev   : recube draft create --tenant <t> --channel <c>') +
      '\n  ' +
      chalk.dim(
        'CI    : --tenant <t> --channel <c> (cible le draft ouvert ; ou --draft <id> pour un draft précis)'
      )
  );
}

/** Load the current draft pointer or fail with a clear hint. */
async function requireDraft(): Promise<DraftState> {
  return resolveDraft();
}

/**
 * Fetch le draft EN COURS (status `open`) d'un couple tenant/channel via l'API,
 * sans dépendre du pointeur local `.recube/draft.json`. Le serveur n'autorise
 * qu'UN draft ouvert par channel → au plus un résultat. Message clair si aucun
 * draft en cours (au lieu de planter sur "aucun draft courant").
 */
async function resolveOpenDraft(
  s: AuthenticatedSession,
  tenant: string,
  channel: string
): Promise<DraftState> {
  const drafts = await s.api
    .listDrafts(tenant, channel)
    .catch((err: unknown): never => fail(explainApiError(err, 'generic')));
  const open = drafts.filter((d) => d.status === 'open');
  if (open.length === 0) {
    fail(
      `Aucun draft en cours pour ${chalk.bold(`${tenant}/${channel}`)}.\n  ` +
        chalk.dim(`Ouvre-en un : recube draft create -t ${tenant} -c ${channel}`)
    );
  }
  const d = open[0];
  return { tenant, channel, draftId: d.id, version: d.version_tag };
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
        return `Accès refusé (${err.status}). Vérifie RECUBE_TOKEN (token de service rcs_, scope launcher:draft) et que le tenant correspond.`;
      }
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
    ok(`${virtual} ${action} au ${targetLabel}.`);
  } catch (err) {
    fail(explainApiError(err, 'add'));
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
  tenant?: string;
  channel?: string;
  reference?: string;
  note?: string;
  promote?: boolean;
}): Promise<void> {
  const s = await session();
  refuseServiceTokenForNonAdd(s, 'publish');

  // Résolution du draft à publier :
  //  - tenant + channel fournis → on fetch le draft EN COURS du couple (serveur),
  //    plus besoin du pointeur local ni de connaître l'ID du draft.
  //  - aucun des deux → pointeur local .recube/draft.json (flux dev habituel).
  let st: DraftState;
  if (opts.tenant && opts.channel) {
    // `--channel @me` → la branche perso de l'appelant (dev-{handle}).
    const channel = await resolveMeChannel(s, opts.tenant, opts.channel);
    st = await resolveOpenDraft(s, opts.tenant, channel);
  } else if (opts.tenant || opts.channel) {
    fail('Précise --tenant ET --channel ensemble (ou aucun des deux pour cibler le draft courant local).');
  } else {
    st = await requireDraft();
  }

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

  try {
    // Le body ne porte `promote` QUE si --promote est passé : sans le flag, le
    // corps reste identique à l'existant (build publié → dormant).
    const payload: { reference: string; note: string; promote?: boolean } = { reference, note };
    if (opts.promote) payload.promote = true;

    const res = await s.api.draftPublish(st.tenant, st.channel, st.draftId, payload);
    const b = res.finalized_build ?? {};
    ok(`Draft publié → build ${chalk.bold(b.build_id ?? '?')}  (${st.tenant}/${st.channel})`);
    info(`  reference      : ${reference}`);
    info(`  status         : ${res.status ?? 'published'}`);
    info(`  manifest_sha256: ${b.manifest_sha256 ?? '-'}`);
    info(`  files_count    : ${b.files_count ?? '-'}`);
    info(`  promu (live)   : ${res.promoted ? 'OUI' : 'NON'}`);

    if (opts.promote) {
      // Promote demandé : le publish réussit TOUJOURS (201), mais la mise en
      // ligne peut être refusée (scope/permission) ou échouer côté serveur.
      if (res.promoted) {
        ok('Build publié ET mis en ligne (promu).');
      } else if (res.promote_skipped) {
        const reason =
          res.promote_skipped === 'missing_scope'
            ? 'scope de promotion manquant'
            : res.promote_skipped === 'missing_permission'
              ? 'permission de promotion manquante'
              : `promotion refusée (${res.promote_skipped})`;
        warn(
          `Build publié mais NON mis en ligne : ${reason}.\n  ` +
            chalk.dim(
              'Utilise le panel admin ou un token avec le scope launcher:promote pour le go-live.'
            )
        );
      } else if (res.promote_error) {
        warn(
          `Build publié mais la mise en ligne a échoué : ${res.promote_message ?? res.promote_error}.\n  ` +
            chalk.dim('Le build est publié (dormant) — retente le promote via le panel admin.')
        );
      } else {
        warn(
          'Build publié mais NON mis en ligne (raison non précisée par le serveur).\n  ' +
            chalk.dim('Promote via le panel admin quand prêt.')
        );
      }
    } else {
      info(
        chalk.dim(
          '  Le PROMOTE est séparé — le build est publié mais PAS live. Promote via l\'admin/API quand prêt.'
        )
      );
    }
    // Build resté dormant (sans --promote, ou promote refusé/échoué) → hint
    // copiable pour le mettre en ligne plus tard avec `recube promote`.
    if (!res.promoted && b.build_id) {
      info(
        chalk.dim('  → Pour le mettre en ligne : ') +
          `recube promote -t ${st.tenant} -c ${st.channel} -b ${b.build_id}`
      );
    }
    // Efface le pointeur local UNIQUEMENT s'il visait CE draft (un publish ciblé
    // par --tenant/--channel ne doit pas effacer un autre draft courant local).
    const local = await loadDraftState();
    if (local?.draftId === st.draftId) {
      await clearDraftState();
      info(chalk.dim('  draft courant local effacé.'));
    }
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
