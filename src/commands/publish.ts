/**
 * `recube publish` — interactive build publication.
 *
 * Walks the user through tenant / channel / version / dir / excludes / note
 * via @clack/prompts, then drives the publish-pipeline with a live progress
 * spinner.
 */

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { ui, chalk } from '../lib/ui.js';
import { loadConfig, saveConfig } from '../lib/config.js';
import { loadCredentials, saveCredentials } from '../auth/store.js';
import {
  DEFAULT_GAME_BUNDLE_EXCLUDES,
  publishBuild,
} from '../lib/publish-pipeline.js';
import { resolveRuntimeConfig, RuntimeConfigError } from '../lib/runtime-config.js';
import { findSiblingRecubeCoreJar } from '../lib/recube-core.js';

export interface PublishCommandOptions {
  tenant?: string;
  channel?: string;
  version?: string;
  dir?: string;
  note?: string;
  reference?: string;
  concurrency?: number;
  initBatch?: number;
  dryRun?: boolean;
  defaultExcludes?: boolean;
  /** Comma-separated list of additional exclude patterns. */
  exclude?: string[];
  /** Skip the interactive confirmation step. */
  yes?: boolean;
  /** Explicit runtime_config JSON file path (overrides .recube/runtime.json). */
  runtimeConfig?: string;
  /** Skip auto-detect of sibling RecubeCore jar. */
  noRecubeCore?: boolean;
  /** Extra files to attach to the bundle. Spec: `<source>:<target>` or `<source>`. */
  include?: string[];
}

/**
 * Parse a single `--include` spec.
 *
 * Format : `<source>:<target-path>` or just `<source>` (target = basename).
 * The source path is resolved relative to cwd; the target is kept as-is
 * (POSIX virtual path inside the bundle).
 *
 * Throws if the source file does not exist.
 *
 * Windows quirk : a raw drive letter prefix (`C:\…`) contains a colon but is
 * NOT the spec separator. We split on the **last** colon so the canonical
 * `C:\path\to\agent.jar:recube-core.jar` parses as
 * `source=C:\path\to\agent.jar`, `target=recube-core.jar`. If the only colon
 * in the string is a drive letter (`C:\path\agent.jar` alone), we keep the
 * whole spec as source.
 */
export function parseIncludeSpec(spec: string): { path: string; as: string } {
  let source: string;
  let target: string | undefined;
  const lastColon = spec.lastIndexOf(':');
  // Drive letter colon = position 1, preceded by a single ASCII letter.
  const lastIsDriveLetter = lastColon === 1 && /^[a-zA-Z]$/.test(spec[0]!);
  if (lastColon > 0 && !lastIsDriveLetter) {
    source = spec.slice(0, lastColon);
    target = spec.slice(lastColon + 1);
  } else {
    source = spec;
  }
  const resolvedSource = path.resolve(source);
  if (!existsSync(resolvedSource)) {
    throw new Error(`--include source not found: ${resolvedSource}`);
  }
  return {
    path: resolvedSource,
    as: target && target.length > 0 ? target : path.basename(resolvedSource),
  };
}

const VERSION_REGEX = /^[a-z0-9.+_-]+$/i;

export async function publishCommand(opts: PublishCommandOptions = {}): Promise<void> {
  ui.intro('recube publish');

  let session;
  try {
    session = await getAuthenticatedSession();
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      ui.cancel(err.message);
    }
    throw err;
  }

  const cfg = await loadConfig();
  const creds = await loadCredentials();

  // ── Tenant ─────────────────────────────────────────────────────────
  let tenant = opts.tenant;
  if (!tenant) {
    const spin = ui.spinner();
    spin.start('Récupération des tenants...');
    const games = await session.api.listGames().catch(() => []);
    spin.stop(`${games.length} tenants disponibles.`);
    if (games.length === 0) {
      ui.cancel('Aucun tenant accessible. Vérifie tes permissions launcher.{tenant}.publish.');
    }
    tenant = await ui.select({
      message: 'tenant',
      options: games.map((g) => ({
        value: g.slug,
        label: g.label ?? g.name ?? g.slug,
        hint: g.slug,
      })),
      initialValue: (creds?.tenant_default ?? cfg.tenant ?? games[0].slug) as string,
    });
  }

  // ── Channel ────────────────────────────────────────────────────────
  let channel = opts.channel;
  if (!channel) {
    const spin = ui.spinner();
    spin.start('Récupération des channels...');
    let channels = await session.api.listChannelsForTenant(tenant).catch(() => []);
    if (channels.length === 0) channels = await session.api.listChannels().catch(() => []);
    spin.stop(`${channels.length} channels.`);
    if (channels.length === 0) {
      ui.cancel(
        `Aucun channel pour ${tenant}. Crée-en un d'abord avec ${chalk.cyan('recube channels create ' + tenant)} (ou via /admin/games/${tenant}/channels sur recube.gg).`
      );
    }
    channel = await ui.select({
      message: 'channel',
      options: channels.map((c) => ({
        value: c.name,
        label: c.label ?? c.name,
        hint: c.is_default ? 'default' : c.is_public ? 'public' : 'private',
      })),
      initialValue: (cfg.channel ?? channels[0].name) as string,
    });
  }

  // ── Version ────────────────────────────────────────────────────────
  let version = opts.version;
  if (!version) {
    version = await ui.text({
      message: 'version (ex: 1.0.1)',
      validate: (v) =>
        !v
          ? 'version required'
          : !VERSION_REGEX.test(v)
            ? 'invalid version (allowed: a-z 0-9 . + _ -)'
            : undefined,
    });
  } else if (!VERSION_REGEX.test(version)) {
    ui.cancel(`invalid version: ${version}`);
  }

  // ── Dir ────────────────────────────────────────────────────────────
  let dir = opts.dir;
  if (!dir) {
    dir = await ui.text({
      message: 'bundle dir (chemin vers le dossier à publier)',
      placeholder: './build',
      validate: (v) => (!v ? 'dir required' : undefined),
    });
  }
  const absDir = path.resolve(dir);
  const st = await stat(absDir).catch(() => null);
  if (!st || !st.isDirectory()) ui.cancel(`pas un dossier: ${absDir}`);

  // ── Excludes ───────────────────────────────────────────────────────
  const useDefaults = opts.defaultExcludes ?? (await ui.confirm({
    message: `Appliquer les excludes par défaut (${DEFAULT_GAME_BUNDLE_EXCLUDES.length} patterns) ?`,
    initialValue: true,
  }));
  const userExcludes = opts.exclude ?? [];
  const excludes = useDefaults
    ? [...DEFAULT_GAME_BUNDLE_EXCLUDES, ...userExcludes]
    : userExcludes;

  // ── runtime_config ─────────────────────────────────────────────────
  // Flag wins over auto-detect. If neither, backend inherits from latest version.
  let runtimeConfig: Record<string, unknown> | undefined;
  let runtimeConfigSource: string | null = null;
  try {
    const resolved = await resolveRuntimeConfig(absDir, opts.runtimeConfig);
    if (resolved) {
      runtimeConfig = resolved.config as unknown as Record<string, unknown>;
      runtimeConfigSource = resolved.source;
    }
  } catch (err) {
    if (err instanceof RuntimeConfigError) ui.cancel(err.message);
    throw err;
  }

  // ── Auto-detect sibling RecubeCore jar ─────────────────────────────
  // The backend BuildPipeline expects `recube-core.jar` at the *root* of the
  // bundle, not under `mods/` (cf. RecubeGG BuildPipeline.php:619 /
  // extractRecubeCoreEntry — exact equality match on the manifest path). The
  // launcher consumes this entry as the anti-cheat agent jar; placing it
  // under `mods/` would be silently refused with `missing_recube_core`.
  const extraIncludes: { path: string; as?: string }[] = [];
  if (!opts.noRecubeCore) {
    const sibling = await findSiblingRecubeCoreJar(absDir).catch(() => null);
    if (sibling) {
      const accept = opts.yes
        ? true
        : await ui.confirm({
            message: `Trouvé ${chalk.cyan(path.basename(sibling.path))} dans un repo RecubeCore voisin. L'inclure comme ${chalk.bold('recube-core.jar')} (racine du bundle) ?`,
            initialValue: true,
          });
      if (accept) extraIncludes.push({ path: sibling.path, as: 'recube-core.jar' });
    }
  }

  // ── Manual --include extras ────────────────────────────────────────
  // Each spec is `<source>:<target>` or `<source>` (target = basename).
  // Parsed *after* auto-detect so a manual entry can override the sibling
  // jar via the standard last-write-wins logic in buildLocalManifest.
  for (const spec of opts.include ?? []) {
    extraIncludes.push(parseIncludeSpec(spec));
  }

  // ── Note ───────────────────────────────────────────────────────────
  const note = opts.note ?? (await ui.text({
    message: 'note (changelog/description du build)',
    placeholder: 'Build via CI',
    defaultValue: 'Build via CI',
  }));

  // ── Recap + confirm ────────────────────────────────────────────────
  // Note : built AFTER auto-detect + --include resolution so the includes
  // line reflects the actual list that will be uploaded (vs. always showing
  // "none" because the recap was emitted before the auto-detect prompt fired).
  const runtimeRecap = runtimeConfigSource
    ? `${chalk.green('yes')} (${runtimeConfigSource})`
    : `${chalk.dim('no')} (backend inherits from latest version)`;
  const includesRecap = extraIncludes.length > 0
    ? extraIncludes
        .map((i) => `${path.basename(i.path)} → ${i.as ?? path.basename(i.path)}`)
        .join(', ')
    : chalk.dim('none');
  const recap = [
    `${chalk.dim('tenant   ')} ${chalk.bold(tenant)}`,
    `${chalk.dim('channel  ')} ${chalk.bold(channel)}`,
    `${chalk.dim('version  ')} ${chalk.bold(version)}`,
    `${chalk.dim('dir      ')} ${absDir}`,
    `${chalk.dim('excludes ')} ${excludes.length} patterns`,
    `${chalk.dim('includes ')} ${includesRecap}`,
    `${chalk.dim('runtime  ')} ${runtimeRecap}`,
    `${chalk.dim('note     ')} ${note}`,
    opts.dryRun ? `${chalk.dim('mode     ')} ${chalk.yellow('DRY-RUN')}` : '',
  ].filter(Boolean).join('\n');
  ui.note(recap, 'récap');

  if (!opts.yes) {
    const proceed = await ui.confirm({ message: 'Publier ?', initialValue: true });
    if (!proceed) ui.cancel('Annulé.');
  }

  // ── Run pipeline ───────────────────────────────────────────────────
  const spin = ui.spinner();
  spin.start('Scan du bundle...');

  let lastTotal = 0;
  const t0 = Date.now();
  let uploadedBytes = 0;
  let manifestBytes = 0;
  try {
    const result = await publishBuild({
      tenant,
      channel,
      version: version!,
      dir: absDir,
      includes: extraIncludes,
      excludes,
      note,
      reference: opts.reference,
      concurrency: opts.concurrency ?? cfg.concurrency ?? 8,
      initBatch: opts.initBatch ?? cfg.initBatch ?? 50,
      apiBase: session.apiBase,
      token: session.tokens.access_token,
      dryRun: opts.dryRun ?? false,
      runtimeConfig,
      onProgress: (e) => {
        switch (e.type) {
          case 'scan':
            lastTotal = e.total;
            spin.message(`Scan terminé : ${e.total} fichiers`);
            break;
          case 'hash':
            spin.message(`Hash ${e.index}/${e.total} ${truncate(e.path, 60)}`);
            break;
          case 'initiate':
            spin.message(`Initiate batch ${e.batch}/${e.totalBatches} (${e.chunk} files)`);
            break;
          case 'upload': {
            const elapsed = (Date.now() - t0) / 1000;
            const kbs = elapsed > 0 ? Math.round(uploadedBytes / 1024 / elapsed) : 0;
            const eta = e.total > 0 && e.index > 0
              ? Math.round(((e.total - e.index) * elapsed) / e.index)
              : 0;
            spin.message(
              `Upload ${e.index}/${e.total} ${kbs} KB/s eta ${eta}s ${truncate(e.path, 50)}`
            );
            break;
          }
          case 'commit':
            spin.message('Commit du manifest...');
            break;
        }
      },
    });
    void manifestBytes;
    void uploadedBytes;
    spin.stop('Publié.');

    if (opts.dryRun) {
      ui.outro(`${chalk.yellow('DRY-RUN')} — ${lastTotal} fichiers scannés, aucun upload effectué.`);
      return;
    }

    // Persist tenant as default for next time.
    if (creds) await saveCredentials({ ...creds, tenant_default: tenant });
    if (cfg.tenant !== tenant) await saveConfig({ tenant, channel });

    const buildId = (result as { build_id?: string | number }).build_id ?? '?';
    const manifestSha = (result as { manifest_sha256?: string }).manifest_sha256 ?? '?';
    ui.outro(
      `${chalk.green('OK')} build_id=${chalk.bold(String(buildId))} manifest_sha256=${chalk.dim(manifestSha)}`
    );
  } catch (err) {
    spin.stop('Échec.');
    ui.cancel(formatPublishError(err as Error));
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(-(max - 1));
}

/**
 * Extract the backend `message` field from a stringified publish-pipeline error
 * (`… : {body}`). Returns '' when the trailing body is absent / non-JSON / has
 * no message. Used to surface the precise backend reason on 401/403/…
 */
function extractBackendMessage(msg: string): string {
  const bodyMatch = msg.match(/:\s*(\{.*\})\s*$/s);
  if (!bodyMatch) return '';
  try {
    const body = JSON.parse(bodyMatch[1]) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
}

/**
 * Map common backend errors to actionable hints. Pattern-matches on the
 * stringified error from publish-pipeline (`POST {url} -> {status} {text}: {body}`).
 */
export function formatPublishError(err: Error): string {
  const msg = err.message;
  const statusMatch = msg.match(/-> (\d{3}) /);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  if (status === 401 || status === 403) {
    // Surface le message backend précis s'il est présent (le body est appendu à
    // la fin de `msg` par publish-pipeline). Le serveur distingue "Missing scope
    // 'X'" de "Missing permission 'launcher.{tenant}.publish'" — on l'affiche en
    // primaire au lieu de noyer le diag dans un hint générique.
    const detail = extractBackendMessage(msg);
    const lead = detail ? `${chalk.red(`Accès refusé (${status})`)} : ${detail}` : msg;
    const hint =
      status === 401
        ? `Hint : token expiré ou révoqué. Relance ${chalk.cyan('recube login')}.`
        : `Hint : scope/permission manquant(e). Il te faut le scope ${chalk.cyan('launcher:publish')} + la perm ${chalk.cyan('launcher.{tenant}.publish')} — demande à un admin recube.gg.`;
    return `${lead}\n\n${hint}`;
  }
  if (status === 422) {
    const bodyMatch = msg.match(/:\s*(\{.*\})\s*$/s);
    if (bodyMatch) {
      try {
        const body = JSON.parse(bodyMatch[1]) as {
          ok?: boolean;
          error?: string;
          message?: string;
          errors?: Record<string, string[]>;
        };
        // Targeted handling for the recube-core anti-cheat enforcement
        // (BuildPipeline.php commit() emits `{ok:false, error:'missing_recube_core', message:'…'}`).
        // Surface the remediation hint upfront — `mods/` does NOT satisfy the
        // check, only root `recube-core.jar`.
        if (body.error === 'missing_recube_core') {
          const channelHint = msg.match(/\/launcher\/[^/]+\/([^/]+)\/builds/);
          const chanLabel = channelHint?.[1] ?? 'this channel';
          return [
            `${chalk.red('Publish refused')} : recube-core.jar is mandatory for channel "${chanLabel}".`,
            body.message ? `  ${chalk.dim(body.message)}` : '',
            '',
            `  Hint : add the agent via ${chalk.cyan('-i <path>/recube-core-*.jar:recube-core.jar')}`,
            `         OR keep a sibling RecubeCore repo at ${chalk.cyan('../../RecubeCore')} for auto-detect.`,
            `         Note : the jar MUST land at the root of the bundle (NOT under mods/).`,
          ]
            .filter(Boolean)
            .join('\n');
        }
        const fields = body.errors
          ? Object.entries(body.errors)
              .map(([f, errs]) => `  - ${chalk.bold(f)}: ${errs.join(', ')}`)
              .join('\n')
          : '';
        return `${chalk.red('Validation 422')} : ${body.message ?? 'invalid payload'}\n${fields}`;
      } catch {
        // fallthrough
      }
    }
    return `${msg}\n\nHint : payload rejeté par le backend (champ manquant ou invalide).`;
  }
  if (status === 413) {
    return `${msg}\n\nHint : fichier trop gros pour l'upload. Vérifie les limites R2 ou split le bundle.`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) {
    return `${msg}\n\nHint : recube.gg inaccessible. Check ta connexion (VPN ? firewall ?) et ${chalk.cyan('recube doctor')}.`;
  }
  return msg;
}
