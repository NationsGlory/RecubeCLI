/**
 * `recube promote` — met en ligne un build DÉJÀ publié (dormant → live).
 *
 *   POST /api/v1/launcher/{tenant}/{channel}/promote/{buildId}   (body vide)
 *
 * Séparé de `draft publish` À DESSEIN : `publish` scelle/signe un build DORMANT
 * (défaut sûr, PAS servi aux joueurs) ; `promote` le rend live quand le dev est
 * prêt. Perm-gated : scope `launcher:promote` + perm `launcher.{tenant}.promote`.
 * Un token compromis peut au pire publier un draft dormant, jamais shipper aux
 * joueurs sans la perm promote.
 *
 * Non-interactif : lignes stdout/stderr simples (pas d'UI @clack), CI-friendly.
 */

import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { getStoredUser } from '../auth/store.js';
import { ApiError } from '../lib/api.js';
import { NoPersonalBranchError, noBranchHint, resolveChannelAlias } from '../lib/branch.js';
import { isBuildUuid, resolveBuildId } from '../lib/promote-target.js';
import { chalk } from '../lib/ui.js';
import type { AuthenticatedSession } from '../auth/session.js';
import type { Version } from '../types.js';

// ── helpers (même style plain que draft.ts / core.ts) ───────────────────────

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
          chalk.dim('recube login --scope "launcher:promote openid profile"') +
          '\n  ' +
          chalk.dim('(ou, en CI : exporte RECUBE_TOKEN=rcs_… avec le scope launcher:promote)')
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

/**
 * Map une ApiError du promote vers un message clair.
 *  - 403  : scope/perm de promotion manquant (le cas le plus courant).
 *  - 404/409/422 : le serveur porte un `message` explicite (build_not_found,
 *    orphan_build, channel_mismatch, version_archived, build_not_signed,
 *    missing_recube_core, unknown_recube_core_hash…) → on le surface.
 *  - 429  : throttle (5/min).
 */
function explainPromoteError(err: unknown, tenant: string, wasRawUuid = false): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);

  let code = '';
  let message = '';
  try {
    const body = JSON.parse(err.body) as { error?: string; message?: string };
    code = body.error ?? '';
    message = body.message ?? '';
  } catch {
    // corps non-JSON — on retombe sur err.body brut plus bas.
  }

  // UUID passé en dur mais le serveur ne trouve pas de build : c'est très
  // probablement un id de DRAFT (non publié), pas un build promotable.
  if (err.status === 404 && wasRawUuid && (code === 'build_not_found' || !code)) {
    return (
      "cet id ressemble à un draft, pas à un build.\n  " +
      chalk.dim(
        'Promeus par tag de version (recube promote -b 1.0.60) ou utilise le ' +
          'build_id de « recube versions list ».'
      )
    );
  }

  if (err.status === 403) {
    // Surface le message backend précis (ex: "Missing permission
    // 'launcher.ng.promote'" vs "Missing scope 'launcher:promote'") en primaire,
    // et garde le hint scope/perm en secondaire.
    const primary = message
      ? `Promotion refusée (403) : ${message}`
      : `Promotion refusée (403) : il te faut le scope ${chalk.bold('launcher:promote')} + la perm ${chalk.bold(`launcher.${tenant}.promote`)} sur ton token.`;
    return (
      primary +
      '\n  ' +
      chalk.dim(
        message
          ? `Requiert le scope launcher:promote + la perm launcher.${tenant}.promote. Demande à un release manager ou utilise un token autorisé.`
          : 'Demande à un release manager ou utilise un token autorisé.'
      )
    );
  }
  if (err.status === 429) {
    return 'Throttle promotion (5/min) — réessaie dans un instant.';
  }
  if (err.status === 404 || err.status === 409 || err.status === 422) {
    return `Promotion refusée (${err.status}${code ? ' ' + code : ''}) : ${message || err.body}`;
  }
  return message ? `${err.status}: ${message}` : `${err.status}: ${err.body}`;
}

// ── command ──────────────────────────────────────────────────────────────

export async function promoteCommand(opts: {
  tenant?: string;
  channel?: string;
  build?: string;
  tag?: string;
}): Promise<void> {
  if (!opts.tenant) fail('--tenant requis');
  if (!opts.channel) fail('--channel requis');
  // `--tag <tag>` est un alias explicite de `-b <tag>` : force le traitement
  // « tag de version » même si la valeur ressemble à un UUID.
  const raw = opts.tag ?? opts.build;
  const forceTag = opts.tag != null;
  if (!raw)
    fail(
      '--build requis (id du build OU tag de version à mettre en ligne)\n  ' +
        chalk.dim(
          `ex : recube promote -t ${opts.tenant} -c ${opts.channel ?? '<channel>'} -b 1.0.60\n  ` +
            `trouve tag + build_id via : recube versions list ${opts.tenant}` +
            (opts.channel ? ` -c ${opts.channel}` : '')
        )
    );
  const tenant = opts.tenant;

  const s = await session();
  // `--channel @me` → la branche perso de l'appelant (dev-{handle}).
  let channel: string;
  try {
    channel = await resolveChannelAlias(s.api, tenant, opts.channel);
  } catch (err) {
    if (err instanceof NoPersonalBranchError) fail(noBranchHint(tenant));
    throw err;
  }

  // Résolution de la cible : UUID → build_id direct ; sinon tag de version →
  // on résout le build_id via le listing des versions du tenant/channel.
  const rawIsUuid = !forceTag && isBuildUuid(raw);
  let buildId: string;
  if (rawIsUuid) {
    buildId = raw.trim();
  } else {
    let versions: Version[];
    try {
      ({ versions } = await s.api.listVersions(tenant, channel));
    } catch (err) {
      fail(explainPromoteError(err, tenant));
    }
    const resolved = resolveBuildId(versions, raw);
    if (resolved.kind === 'not_found') {
      fail(
        `version ${chalk.bold(raw.trim())} introuvable sur ${tenant}/${channel} ` +
          `(voir ${chalk.cyan(`recube versions list ${tenant} -c ${channel}`)})`
      );
    }
    if (resolved.kind === 'no_build_id') {
      fail(
        `la version ${chalk.bold(raw.trim())} n'a pas de build promotable ` +
          `(aucun build_id : build non publié ou fallback sans historique).`
      );
    }
    buildId = resolved.buildId;
    info(
      `${chalk.dim('résolu')}  version ${chalk.bold(raw.trim())} → build ${chalk.bold(buildId)}`
    );
  }

  try {
    info(`${chalk.dim('POST')}  promote ${chalk.bold(buildId)} → ${tenant}/${channel}`);
    const res = await s.api.promote(tenant, channel, buildId);
    ok(
      `Build ${chalk.bold(res.build_id ?? buildId)} mis en ligne — actif pour les joueurs du channel ` +
        `${chalk.bold(channel)} sous ~30s.`
    );
    if (res.previous_build_id) {
      info(`  build précédent : ${res.previous_build_id}`);
    }
    if (res.manifest_sha256) info(`  manifest_sha256: ${res.manifest_sha256}`);
    if (res.promoted_at) info(`  promoted_at     : ${res.promoted_at}`);
  } catch (err) {
    fail(explainPromoteError(err, tenant, rawIsUuid));
  }
}
