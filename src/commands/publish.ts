/**
 * `recube publish` — interactive build publication.
 *
 * Walks the user through tenant / channel / version / dir / excludes / note
 * via @clack/prompts, then drives the publish-pipeline with a live progress
 * spinner.
 */

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

  // ── Note ───────────────────────────────────────────────────────────
  const note = opts.note ?? (await ui.text({
    message: 'note (changelog/description du build)',
    placeholder: 'Build via CI',
    defaultValue: 'Build via CI',
  }));

  // ── Recap + confirm ────────────────────────────────────────────────
  const recap = [
    `${chalk.dim('tenant   ')} ${chalk.bold(tenant)}`,
    `${chalk.dim('channel  ')} ${chalk.bold(channel)}`,
    `${chalk.dim('version  ')} ${chalk.bold(version)}`,
    `${chalk.dim('dir      ')} ${absDir}`,
    `${chalk.dim('excludes ')} ${excludes.length} patterns`,
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
  try {
    const result = await publishBuild({
      tenant,
      channel,
      version: version!,
      dir: absDir,
      includes: [],
      excludes,
      note,
      reference: opts.reference,
      concurrency: opts.concurrency ?? cfg.concurrency ?? 8,
      initBatch: opts.initBatch ?? cfg.initBatch ?? 50,
      apiBase: session.apiBase,
      token: session.tokens.access_token,
      dryRun: opts.dryRun ?? false,
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
          case 'upload':
            spin.message(`Upload ${e.index}/${e.total} ${truncate(e.path, 60)}`);
            break;
          case 'commit':
            spin.message('Commit du manifest...');
            break;
        }
      },
    });
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
    ui.cancel((err as Error).message);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(-(max - 1));
}
