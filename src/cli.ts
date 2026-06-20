#!/usr/bin/env node
/**
 * Recube CLI — entry point.
 *
 * Uses commander for arg parsing. Commands themselves are isolated in
 * src/commands/* so they can be tested without touching the CLI surface.
 */

import { Command } from 'commander';
import { printHome } from './ui/home.js';
import { renderBanner } from './ui/banner.js';
import { theme } from './ui/theme.js';
import { completionCommand } from './commands/completion.js';
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
import {
  draftCreateCommand,
  draftListCommand,
  draftStatusCommand,
  draftAddCommand,
  draftRmCommand,
  draftDiffCommand,
  draftPublishCommand,
  draftAbandonCommand,
} from './commands/draft.js';

const program = new Command();

// Rich help: brand banner on top + themed Examples section at the bottom
// (commander 12 has no per-element help styling hooks, so the visual identity
// comes from the banner header and the colored addHelpText blocks).
program
  .name('recube')
  .description('Recube developer CLI — publish game builds with OAuth auth')
  .version('0.2.1', '-v, --version', 'print version')
  .addHelpText('beforeAll', () => renderBanner() + '\n')
  .addHelpText(
    'after',
    () =>
      '\n' +
      theme.title('Examples:') +
      '\n' +
      [
        `  ${theme.command('recube login --scope "launcher:publish launcher:draft profile:read"')}`,
        `  ${theme.command('recube doctor')}`,
        `  ${theme.command('recube publish -t nationsglory -c stable -V 1.0.0 -d ./build')}`,
        `  ${theme.command('recube draft create -t nationsglory -c beta -V 1.0.1')}`,
        `  ${theme.command('recube channels list nationsglory')}`,
        '',
        `${theme.title('Shell completion:')}`,
        `  ${theme.command('recube completion bash')}  ${theme.dim('# then follow the printed install hint')}`,
        '',
        `${theme.dim('Docs: ')}${theme.value('https://recube.gg/developers')}`,
      ].join('\n') +
      '\n'
  );

program
  .command('login')
  .description("S'authentifier auprès de recube.gg (OAuth PKCE)")
  .option('--scope <scopes>', 'OAuth scopes (space-separated)')
  .option('-f, --force', 'force re-login même si déjà connecté')
  .addHelpText(
    'after',
    () =>
      '\n' +
      theme.title('Examples:') +
      '\n' +
      [
        `  ${theme.command('recube login')}`,
        `  ${theme.command('recube login --scope "launcher:publish launcher:draft profile:read"')}`,
        `  ${theme.command('recube login --force')}`,
      ].join('\n') +
      '\n'
  )
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
  .option(
    '-i, --include <spec...>',
    'attacher un fichier au bundle ; format <source>:<target> ou <source> (target = basename). Répétable. Ex: -i ./recube-core-0.4.0.jar:recube-core.jar'
  )
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
    include?: string[];
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
      include: opts.include,
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

// ── drafts (mutable build staging) ───────────────────────────────────────
const draft = program
  .command('draft')
  .description('Staging de build mutable : create/add/rm/diff/publish (scope launcher:draft)');

draft
  .command('create')
  .description('Créer un draft (devient le draft courant, tracké dans .recube/draft.json)')
  .requiredOption('-t, --tenant <slug>', 'tenant slug (ex: nationsglory)')
  .requiredOption('-c, --channel <name>', 'channel (ex: stable, beta)')
  // `--version-tag` (PAS `--version`) : `--version` entre en collision avec le
  // flag version global de commander (program.version) → imprime juste "0.2.1".
  // Même convention que `recube publish --version-tag`.
  .requiredOption('-V, --version-tag <semver>', 'version tag du futur build (ex: 1.0.17)')
  .option('--from <buildId>', 'base build id à seeder (défaut: dernier build live du channel)')
  .action(
    async (opts: { tenant?: string; channel?: string; versionTag?: string; from?: string }) => {
      await draftCreateCommand({
        tenant: opts.tenant,
        channel: opts.channel,
        version: opts.versionTag,
        from: opts.from,
      });
    }
  );

draft
  .command('list')
  .description('Lister les drafts (tenant/channel du draft courant, ou via flags)')
  .option('-t, --tenant <slug>', 'tenant slug')
  .option('-c, --channel <name>', 'channel')
  .action(async (opts: { tenant?: string; channel?: string }) => {
    await draftListCommand({ tenant: opts.tenant, channel: opts.channel });
  });

draft
  .command('status')
  .description('Statut du draft courant (fichiers résolus, base, live bougé)')
  .action(async () => {
    await draftStatusCommand();
  });

draft
  .command('add <jar>')
  .description('Ajouter/remplacer un fichier dans le draft courant (hash + upload R2 + commit)')
  .option('--path <virtualPath>', 'chemin cible dans le build (défaut: mods/<basename>)')
  .action(async (jar: string, opts: { path?: string }) => {
    await draftAddCommand(jar, { path: opts.path });
  });

draft
  .command('rm <path>')
  .description('Retirer un fichier du draft courant')
  .action(async (p: string) => {
    await draftRmCommand(p);
  });

draft
  .command('diff')
  .description('Diff du draft courant vs sa base (added/replaced/removed)')
  .action(async () => {
    await draftDiffCommand();
  });

draft
  .command('publish')
  .description('Finaliser le draft courant en build immuable (scope launcher:publish ; PAS promote)')
  .requiredOption('-r, --reference <ref>', 'reference du build (≤ 96 caractères)')
  .requiredOption('-n, --note <note>', 'note/changelog (6 à 2000 caractères)')
  .action(async (opts: { reference?: string; note?: string }) => {
    await draftPublishCommand({ reference: opts.reference, note: opts.note });
  });

draft
  .command('abandon')
  .description('Abandonner le draft courant (supprime les blobs orphelins) + clear local')
  .action(async () => {
    await draftAbandonCommand();
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
  .command('completion <shell>')
  .description('Imprimer le script de complétion shell (bash|zsh|fish) + instructions')
  .addHelpText(
    'after',
    () =>
      '\n' +
      theme.title('Examples:') +
      '\n' +
      [
        `  ${theme.command('recube completion bash')} ${theme.dim('> ~/.recube-completion.bash')}`,
        `  ${theme.command('recube completion zsh')}  ${theme.dim('> "${fpath[1]}/_recube"')}`,
        `  ${theme.command('recube completion fish')} ${theme.dim('> ~/.config/fish/completions/recube.fish')}`,
      ].join('\n') +
      '\n'
  )
  .action((shell: string) => {
    completionCommand(shell);
  });

program
  .configureOutput({
    outputError: (str, write) => write(theme.error(str)),
  });

// Global async error handler — anything that bubbles out of an action() ends here.
process.on('unhandledRejection', (err) => {
  // eslint-disable-next-line no-console
  console.error('recube: unhandled error:', err);
  process.exit(1);
});

// No args (bare `recube`) → onboarding home screen instead of commander's
// terse usage line. argv = [node, cli.js].
if (process.argv.length <= 2) {
  printHome();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err: Error) => {
  // eslint-disable-next-line no-console
  console.error(theme.error(`recube: ${err.message}`));
  process.exit(1);
});
