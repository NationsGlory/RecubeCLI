#!/usr/bin/env node
/**
 * Recube CLI — entry point.
 *
 * Uses commander for arg parsing. Commands themselves are isolated in
 * src/commands/* so they can be tested without touching the CLI surface.
 */

import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { whoamiCommand } from './commands/whoami.js';
import { publishCommand } from './commands/publish.js';
import {
  channelsCreateCommand,
  channelsListCommand,
} from './commands/channels.js';
import { versionsListCommand } from './commands/versions.js';
import { doctorCommand } from './commands/doctor.js';

const program = new Command();

program
  .name('recube')
  .description('Recube developer CLI — publish game builds with OAuth auth')
  .version('0.2.0', '-v, --version', 'print version');

program
  .command('login')
  .description("S'authentifier auprès de recube.gg (OAuth PKCE)")
  .option('--scope <scopes>', 'OAuth scopes (space-separated)')
  .option('-f, --force', 'force re-login même si déjà connecté')
  .action(async (opts: { scope?: string; force?: boolean }) => {
    await loginCommand(opts);
  });

program
  .command('logout')
  .description('Effacer la session locale et révoquer les tokens')
  .action(async () => {
    await logoutCommand();
  });

program
  .command('whoami')
  .description("Afficher l'identité courante")
  .action(async () => {
    await whoamiCommand();
  });

program
  .command('publish')
  .description('Publier un build de jeu (interactif par défaut)')
  .option('-t, --tenant <slug>', 'tenant slug (ex: nationsglory)')
  .option('-c, --channel <name>', 'channel (ex: stable, beta)')
  .option('-V, --version-tag <semver>', 'version tag (ex: 1.0.1)')
  .option('-d, --dir <path>', "dossier du bundle (scanné récursivement)")
  .option('-n, --note <text>', 'note/changelog du build')
  .option('-r, --reference <text>', 'reference custom (default: {tenant}-{version}-b{ts})')
  .option('--concurrency <n>', 'uploads parallèles', (v) => Number.parseInt(v, 10))
  .option('--init-batch <n>', 'taille des batches initiate (1..500)', (v) => Number.parseInt(v, 10))
  .option('--default-excludes', 'appliquer les excludes par défaut')
  .option('--exclude <pattern...>', 'exclure pattern (répétable)')
  .option('--dry-run', "afficher le récap, ne pas appeler l'API")
  .option('-y, --yes', 'skip la confirmation interactive finale')
  .option('--runtime-config <file>', 'JSON file with main_class/jvm_args/java_version (override .recube/runtime.json)')
  .option('--no-recube-core', "désactive l'auto-détection du jar RecubeCore voisin")
  .action(async (opts: {
    tenant?: string;
    channel?: string;
    versionTag?: string;
    dir?: string;
    note?: string;
    reference?: string;
    concurrency?: number;
    initBatch?: number;
    defaultExcludes?: boolean;
    exclude?: string[];
    dryRun?: boolean;
    yes?: boolean;
    runtimeConfig?: string;
    recubeCore?: boolean;
  }) => {
    await publishCommand({
      tenant: opts.tenant,
      channel: opts.channel,
      version: opts.versionTag,
      dir: opts.dir,
      note: opts.note,
      reference: opts.reference,
      concurrency: opts.concurrency,
      initBatch: opts.initBatch,
      defaultExcludes: opts.defaultExcludes,
      exclude: opts.exclude,
      dryRun: opts.dryRun,
      yes: opts.yes,
      runtimeConfig: opts.runtimeConfig,
      // commander --no-recube-core sets recubeCore=false
      noRecubeCore: opts.recubeCore === false,
    });
  });

const channels = program
  .command('channels')
  .description('Gérer les channels launcher');

channels
  .command('list <tenant>')
  .description('Lister les channels pour un tenant')
  .action(async (tenant: string) => {
    await channelsListCommand(tenant);
  });

channels
  .command('create <tenant>')
  .description('Créer un nouveau channel pour un tenant')
  .action(async (tenant: string) => {
    await channelsCreateCommand(tenant);
  });

const versions = program
  .command('versions')
  .description('Inspecter les versions publiées');

versions
  .command('list <tenant>')
  .description('Lister les versions publiées pour un tenant')
  .option('-c, --channel <name>', 'filtrer par channel')
  .action(async (tenant: string, opts: { channel?: string }) => {
    await versionsListCommand(tenant, { channel: opts.channel });
  });

program
  .command('doctor')
  .description("Diagnostiquer l'environnement (Node, CLI, auth, network, tenants)")
  .option('-d, --dir <path>', 'aussi valider un build dir')
  .option('--json', 'sortir les résultats en JSON (utile pour CI)')
  .action(async (opts: { dir?: string; json?: boolean }) => {
    await doctorCommand({ dir: opts.dir, json: opts.json });
  });

program
  .configureOutput({
    outputError: (str, write) => write(str),
  });

// Global async error handler — anything that bubbles out of an action() ends here.
process.on('unhandledRejection', (err) => {
  // eslint-disable-next-line no-console
  console.error('recube: unhandled error:', err);
  process.exit(1);
});

program.parseAsync(process.argv).catch((err: Error) => {
  // eslint-disable-next-line no-console
  console.error(`recube: ${err.message}`);
  process.exit(1);
});
