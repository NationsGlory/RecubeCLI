#!/usr/bin/env node
/**
 * Recube CLI — entry point.
 *
 * Uses commander for arg parsing. Commands themselves are isolated in
 * src/commands/* so they can be tested without touching the CLI surface.
 */

import { Command, Help } from 'commander';
import { VERSION } from './version.js';
import { isAuthenticated, isPublicInvocation, runAuthGate } from './auth/gate.js';
import { printHome, welcomeBox, buildAuthLine } from './ui/home.js';
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
import { corePublishCommand, coreListCommand } from './commands/core.js';
import { promoteCommand } from './commands/promote.js';
import {
  draftCreateCommand,
  draftListCommand,
  draftUseCommand,
  draftStatusCommand,
  draftAddCommand,
  draftRmCommand,
  draftDiffCommand,
  draftPublishCommand,
  draftAbandonCommand,
} from './commands/draft.js';
import {
  branchCreateCommand,
  branchShowCommand,
  branchOverlayAddCommand,
  branchOverlayRmCommand,
} from './commands/branch.js';
import { mergeCommand } from './commands/merge.js';

const program = new Command();

const DOC_URL = 'https://recube.gg/developers';

// Statut d'auth affiché dans le header des `--help` (même box que `recube` nu).
// Pré-calculé dans main() avant parseAsync car le help de commander est sync
// alors que la lecture du user est async.
let helpAuthLine: string | undefined;

// Exemples par commande, rendus dans le help custom (style page d'accueil).
const EXAMPLES: Record<string, string[]> = {
  recube: [
    'recube login --scope "launcher:publish launcher:draft profile:read"',
    'recube doctor',
    '# Flow draft : add → publish (DORMANT, sûr) → promote (LIVE, perm requise)',
    'recube draft create -t nationsglory -c beta',
    'recube draft add ./build/mods/mon-mod.jar',
    'recube draft publish -t nationsglory -c beta',
    'recube promote -t nationsglory -c beta -b <buildId>',
    '# Flow branche perso : create → overlay add/rm (itère en autonomie) → merge (live)',
    'recube branch create -t nationsglory',
    'recube branch overlay add ./build/mods/mon-mod.jar -t nationsglory',
    'recube merge -t nationsglory --into beta',
  ],
  'recube login': [
    'recube login',
    'recube login --scope "launcher:publish launcher:draft profile:read"',
    'recube login --force',
  ],
  'recube draft use': [
    '# Sélectionne le draft ouvert du couple tenant/channel comme draft courant.',
    'recube draft use -t nationsglory -c beta',
    '# Cible un draft précis (si plusieurs ouverts, ou repo cloné ailleurs).',
    'recube draft use -t nationsglory -c beta --draft <id>',
    '# Ensuite, plus besoin des flags :',
    'recube draft rm mods/vieux-mod.jar',
    'recube draft publish',
  ],
  'recube draft rm': [
    '# Draft courant (pointeur .recube/draft.json) :',
    'recube draft rm mods/vieux-mod.jar',
    "# Ou cible directement le draft ouvert d'un tenant/channel (repo cloné) :",
    'recube draft rm mods/vieux-mod.jar -t nationsglory -c beta',
  ],
  'recube draft status': [
    'recube draft status',
    'recube draft status -t nationsglory -c beta',
  ],
  'recube draft diff': [
    'recube draft diff',
    'recube draft diff -t nationsglory -c beta',
  ],
  'recube draft publish': [
    '# Par défaut : publie un build DORMANT (scellé/signé, PAS live) — défaut sûr.',
    'recube draft publish -t nationsglory -c beta',
    '# Cible un draft précis si plusieurs sont ouverts.',
    'recube draft publish -t nationsglory -c beta --draft <id>',
    '# Raccourci pour les autorisés : publie ET met en ligne dans la foulée.',
    'recube draft publish -t nationsglory -c beta --promote',
  ],
  'recube promote': [
    '# Met en ligne un build déjà publié (dormant → live) quand tu es prêt.',
    'recube promote -t nationsglory -c beta -b <buildId>',
  ],
  'recube branch': [
    'recube branch create -t nationsglory',
    'recube branch create -t nationsglory --base beta',
    'recube branch show -t nationsglory',
  ],
  'recube branch create': [
    '# Base par défaut : stable. Idempotent — relancer renvoie ta branche existante.',
    'recube branch create -t nationsglory',
    'recube branch create -t nationsglory --base beta',
  ],
  'recube branch show': ['recube branch show -t nationsglory'],
  'recube branch overlay add': [
    'recube branch overlay add ./build/mods/mon-mod.jar -t nationsglory',
    'recube branch overlay add ./build/config/mon-mod.cfg -t nationsglory --path config/mon-mod.cfg',
  ],
  'recube branch overlay rm': ['recube branch overlay rm mods/vieux-mod.jar -t nationsglory'],
  'recube merge': [
    "# Merge l'overlay de ta branche perso sur un channel PARTAGÉ — met en ligne sous ~30s.",
    'recube merge -t nationsglory --into beta',
    '# Merge un channel dérivé arbitraire (pas ta branche perso) sur la cible.',
    'recube merge -t nationsglory --from dev-alice --into beta',
    '# Override de version (sinon : auto-bump patch de la version live de la cible).',
    'recube merge -t nationsglory --into beta --version-tag 1.4.2',
    '# CI/scripts : saute la confirmation interactive.',
    'recube merge -t nationsglory --into beta --yes',
  ],
  'recube completion': [
    'recube completion bash > ~/.recube-completion.bash',
    'recube completion zsh  > "${fpath[1]}/_recube"',
    'recube completion fish > ~/.config/fish/completions/recube.fish',
  ],
};

/** Nom complet d'une commande (chemin depuis la racine) : "recube draft create". */
function fullName(cmd: Command): string {
  const parts: string[] = [];
  let c: Command | null = cmd;
  while (c) {
    parts.unshift(c.name());
    c = c.parent;
  }

  return parts.join(' ');
}

/**
 * Help custom — même langage visuel que l'écran d'accueil (`recube` nu) : box de
 * marque en tête, sections en listes à puces violet (Usage / Arguments /
 * Commandes / Options / Exemples), footer Docs. Appliqué à TOUTES les commandes
 * via applyHelpConfig (commander n'hérite pas configureHelp aux sous-commandes).
 */
function formatHelp(cmd: Command, helper: Help): string {
  const t = theme;
  const out: string[] = ['', welcomeBox(helpAuthLine), ''];

  out.push(`  ${t.title('Usage')}`, `     ${t.command(helper.commandUsage(cmd))}`, '');

  const desc = helper.commandDescription(cmd);
  if (desc) {
    out.push(`  ${t.dim(desc)}`, '');
  }

  const section = (label: string, items: Array<{ term: string; desc: string }>): void => {
    if (!items.length) {
      return;
    }
    out.push(`  ${t.title(label)}`, '');
    for (const it of items) {
      out.push(`  ${t.bullet()} ${t.command(it.term)}`);
      if (it.desc) {
        out.push(`     ${t.dim(it.desc)}`);
      }
    }
    out.push('');
  };

  section(
    'Arguments',
    helper.visibleArguments(cmd).map((a) => ({
      term: helper.argumentTerm(a),
      desc: helper.argumentDescription(a),
    }))
  );
  section(
    'Commandes',
    helper.visibleCommands(cmd).map((s) => ({
      term: helper.subcommandTerm(s),
      desc: helper.subcommandDescription(s),
    }))
  );
  section(
    'Options',
    helper.visibleOptions(cmd).map((o) => ({
      term: helper.optionTerm(o),
      desc: helper.optionDescription(o),
    }))
  );

  const ex = EXAMPLES[fullName(cmd)];
  if (ex?.length) {
    out.push(`  ${t.title('Exemples')}`, '');
    for (const e of ex) {
      // Les lignes d'annotation (`# …`) sont rendues comme notes discrètes,
      // sans puce, pour distinguer le POURQUOI/flow des commandes copiables.
      if (e.startsWith('#')) {
        out.push(`     ${t.dim(e)}`);
      } else {
        out.push(`  ${t.bullet()} ${t.command(e)}`);
      }
    }
    out.push('');
  }

  out.push(`  ${t.arrow()} ${t.dim('Docs :')} ${t.value(DOC_URL)}`, '');

  return out.join('\n');
}

/** Applique le help custom à une commande ET toutes ses sous-commandes. */
function applyHelpConfig(cmd: Command): void {
  cmd.configureHelp({ formatHelp });
  cmd.commands.forEach((sub) => applyHelpConfig(sub));
}

program
  .name('recube')
  .description('Recube CLI développeur — publie des builds de jeu avec auth OAuth')
  .version(VERSION, '-v, --version', 'afficher la version')
  // Traduit le flag d'aide intégré de commander (sinon "display help for command").
  .helpOption('-h, --help', "afficher l'aide");

program
  .command('login')
  .description("S'authentifier auprès de recube.gg (OAuth PKCE)")
  .option('--scope <scopes>', 'scopes OAuth (séparés par des espaces)')
  .option('-f, --force', 'forcer la reconnexion même si déjà connecté')
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
  .option('-t, --tenant <slug>', 'slug du tenant (ex : nationsglory)')
  .option('-c, --channel <name>', 'channel (ex : stable, beta)')
  .option('-V, --version-tag <semver>', 'tag de version (ex : 1.0.1)')
  .option('-d, --dir <path>', 'dossier du bundle (scanné récursivement)')
  .option('-n, --note <text>', 'note/changelog du build')
  .option('-r, --reference <text>', 'référence personnalisée (défaut : {tenant}-{version}-b{ts})')
  .option('--concurrency <n>', 'uploads parallèles', (v) => Number.parseInt(v, 10))
  .option('--init-batch <n>', 'taille des lots initiate (1..500)', (v) => Number.parseInt(v, 10))
  .option('--default-excludes', 'appliquer les exclusions par défaut')
  .option('--exclude <pattern...>', 'exclure un motif (répétable)')
  .option('--dry-run', "afficher le récap, ne pas appeler l'API")
  .option('-y, --yes', 'sauter la confirmation interactive finale')
  .option('--runtime-config <file>', 'fichier JSON main_class/jvm_args/java_version (override .recube/runtime.json)')
  .option('--no-recube-core', "désactive l'auto-détection du jar RecubeCore voisin")
  .option(
    '-i, --include <spec...>',
    'attacher un fichier au bundle ; format <source>:<cible> ou <source> (cible = nom de fichier). Répétable. Ex : -i ./recube-core-0.4.0.jar:recube-core.jar'
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

// ── promote (build dormant → live) ───────────────────────────────────────
// Séparé de publish À DESSEIN : publish scelle un build DORMANT (défaut sûr),
// promote le met en ligne quand on est prêt. Perm-gated (launcher:promote) →
// un token compromis ne peut jamais servir aux joueurs sans cette perm.
program
  .command('promote')
  .description(
    'Mettre en ligne un build déjà publié (dormant → live) quand tu es prêt. ' +
      'Perm-gated (scope launcher:promote + perm launcher.{tenant}.promote) : un token ' +
      'compromis peut publier un build dormant mais jamais le servir aux joueurs sans cette perm.'
  )
  .requiredOption('-t, --tenant <slug>', 'slug du tenant (ex : nationsglory)')
  .requiredOption('-c, --channel <name>', 'channel (ex : stable, beta, @me = ta branche perso)')
  .option(
    '-b, --build <buildOrTag>',
    'build_id (UUID) OU tag de version (ex : 1.0.60) à mettre en ligne ; le tag est résolu en build_id via le listing des versions'
  )
  .option(
    '--version <tag>',
    'alias explicite : force le traitement de la valeur comme tag de version (résolu en build_id)'
  )
  .action(async (opts: { tenant?: string; channel?: string; build?: string; version?: string }) => {
    await promoteCommand({
      tenant: opts.tenant,
      channel: opts.channel,
      build: opts.build,
      version: opts.version,
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
  .option('-c, --channel <name>', 'filtrer par channel (@me = ta branche perso)')
  .action(async (tenant: string, opts: { channel?: string }) => {
    await versionsListCommand(tenant, { channel: opts.channel });
  });

// ── recube-core (anti-cheat agent) ───────────────────────────────────────
// publish accepte service-token (rcs_) — c'est le chemin CI (cf. core.ts).
const core = program
  .command('core')
  .description('Gestion recube-core (anti-cheat)');

core
  .command('publish')
  .description('Publier un build recube-core sur un channel (token de service rcs_ autorisé = CI)')
  .requiredOption('-t, --tenant <t>', 'slug du tenant (ex : nationsglory)')
  .option('-c, --channel <c>', 'channel cible (@me = ta branche perso)', 'tenant-wide')
  .requiredOption('-V, --version <v>', 'tag de version (ex : 0.4.0)')
  .option('--file <path>', 'jar local à uploader (multipart, hash serveur) ; OU --url/--sha256')
  .option('--url <key>', 'clé R2 relative déjà hébergée (ex : recube-core/0.4.0.jar ; PAS une URL absolue)')
  .option('--sha256 <h>', 'sha256 attendu (requis avec --url ; doit correspondre au hash enregistré)')
  .action(
    async (opts: {
      tenant?: string;
      channel?: string;
      version?: string;
      file?: string;
      url?: string;
      sha256?: string;
    }) => {
      await corePublishCommand({
        tenant: opts.tenant,
        channel: opts.channel,
        version: opts.version,
        file: opts.file,
        url: opts.url,
        sha256: opts.sha256,
      });
    }
  );

core
  .command('list')
  .description('Afficher le recube-core courant d\'un channel (version/sha256/url)')
  .requiredOption('-t, --tenant <t>', 'slug du tenant')
  .option('-c, --channel <c>', 'channel (défaut : tenant-wide ; @me = ta branche perso)')
  .action(async (opts: { tenant?: string; channel?: string }) => {
    await coreListCommand({ tenant: opts.tenant, channel: opts.channel });
  });

// ── drafts (mutable build staging) ───────────────────────────────────────
const draft = program
  .command('draft')
  .description('Staging de build mutable : create/add/rm/diff/publish (scope launcher:draft)');

draft
  .command('create')
  .description('Créer un draft (devient le draft courant, tracké dans .recube/draft.json)')
  .requiredOption('-t, --tenant <slug>', 'slug du tenant (ex : nationsglory)')
  .requiredOption('-c, --channel <name>', 'channel (ex: stable, beta, @me = ta branche perso)')
  // `--version-tag` (PAS `--version`) : `--version` entre en collision avec le
  // flag version global de commander (program.version) → imprime juste "0.2.1".
  // Optionnel : vide → le serveur auto-remplit la version en ligne +1 patch.
  // Fourni → override (bump minor/major), toujours validé > en ligne côté serveur.
  .option('-V, --version-tag <semver>', 'override de version (défaut : version en ligne +1 patch)')
  .option('--from <buildId>', 'build de base à seeder (défaut : dernier build live du channel)')
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
  .option('-t, --tenant <slug>', 'slug du tenant')
  .option('-c, --channel <name>', 'channel (@me = ta branche perso)')
  .action(async (opts: { tenant?: string; channel?: string }) => {
    await draftListCommand({ tenant: opts.tenant, channel: opts.channel });
  });

draft
  .command('use')
  .description('Sélectionner le draft courant (le pose dans .recube/draft.json) — les commandes suivantes marchent sans re-spécifier les flags')
  .requiredOption('-t, --tenant <slug>', 'slug du tenant (ex : nationsglory)')
  .requiredOption('-c, --channel <name>', 'channel (ex : beta, @me = ta branche perso)')
  .option('--draft <id>', 'id du draft précis (défaut : le draft ouvert du tenant/channel)')
  .action(async (opts: { tenant?: string; channel?: string; draft?: string }) => {
    await draftUseCommand({ tenant: opts.tenant, channel: opts.channel, draft: opts.draft });
  });

draft
  .command('status')
  .description('Statut du draft (fichiers résolus, base, live bougé). Draft courant par défaut, ou via -t/-c[/--draft].')
  .option('-t, --tenant <slug>', 'tenant du draft cible (défaut : draft courant local)')
  .option('-c, --channel <name>', 'channel du draft cible (@me = ta branche perso)')
  .option('--draft <id>', 'id du draft précis (avec -t/-c ; défaut : le draft ouvert)')
  .action(async (opts: { tenant?: string; channel?: string; draft?: string }) => {
    await draftStatusCommand({ tenant: opts.tenant, channel: opts.channel, draft: opts.draft });
  });

draft
  .command('add <jar>')
  .description('Ajouter/remplacer un fichier dans un draft (hash + upload R2 + commit). Seule commande utilisable avec un token de service RECUBE_TOKEN (CI).')
  .option('--path <virtualPath>', 'chemin cible dans le build (défaut: mods/<basename>)')
  // Ciblage CI : si pas de .recube/draft.json (ex GitHub Actions), pointer le
  // draft explicitement (ou via env RECUBE_DRAFT_ID/RECUBE_TENANT/RECUBE_CHANNEL).
  .option('--draft <id>', 'id du draft cible (CI ; défaut: .recube/draft.json ou env RECUBE_DRAFT_ID)')
  .option('-t, --tenant <slug>', 'tenant du draft cible (CI ; ou env RECUBE_TENANT)')
  .option('-c, --channel <name>', 'channel du draft cible (CI ; ou env RECUBE_CHANNEL)')
  .action(
    async (jar: string, opts: { path?: string; draft?: string; tenant?: string; channel?: string }) => {
      await draftAddCommand(jar, {
        path: opts.path,
        draftId: opts.draft,
        tenant: opts.tenant,
        channel: opts.channel,
      });
    }
  );

draft
  .command('rm <path>')
  .description('Retirer un fichier du draft. Draft courant par défaut, ou via -t/-c[/--draft].')
  .option('-t, --tenant <slug>', 'tenant du draft cible (défaut : draft courant local)')
  .option('-c, --channel <name>', 'channel du draft cible (@me = ta branche perso)')
  .option('--draft <id>', 'id du draft précis (avec -t/-c ; défaut : le draft ouvert)')
  .action(async (p: string, opts: { tenant?: string; channel?: string; draft?: string }) => {
    await draftRmCommand(p, { tenant: opts.tenant, channel: opts.channel, draft: opts.draft });
  });

draft
  .command('diff')
  .description('Diff du draft vs sa base (ajoutés/remplacés/retirés). Draft courant par défaut, ou via -t/-c[/--draft].')
  .option('-t, --tenant <slug>', 'tenant du draft cible (défaut : draft courant local)')
  .option('-c, --channel <name>', 'channel du draft cible (@me = ta branche perso)')
  .option('--draft <id>', 'id du draft précis (avec -t/-c ; défaut : le draft ouvert)')
  .action(async (opts: { tenant?: string; channel?: string; draft?: string }) => {
    await draftDiffCommand({ tenant: opts.tenant, channel: opts.channel, draft: opts.draft });
  });

draft
  .command('publish')
  .description(
    'Finaliser le draft en build DORMANT (scellé/signé, scope launcher:publish, mais PAS servi ' +
      'aux joueurs — défaut sûr). Ajoute --promote pour le mettre en ligne dans la foulée si ton ' +
      'token a la perm de promotion ; sinon promote plus tard avec `recube promote`.'
  )
  .option('-t, --tenant <slug>', 'tenant du draft à publier — fetch le draft en cours (défaut : draft courant local)')
  .option('-c, --channel <name>', 'channel du draft à publier (@me = ta branche perso) — fetch le draft en cours (défaut : draft courant local)')
  .option('--draft <id>', 'id du draft précis à publier (avec -t/-c ; défaut : le draft ouvert)')
  .option('-r, --reference <ref>', 'reference du build (≤ 96 car ; défaut auto : {tenant}-{channel}-{version}-b{ts})')
  .option('-n, --note <note>', 'note/changelog (6 à 2000 car ; défaut généré si absent)')
  .option('-p, --promote', 'met le build en ligne immédiatement après publication (dormant → live ; nécessite le scope+perm de promotion)')
  .action(async (opts: { tenant?: string; channel?: string; draft?: string; reference?: string; note?: string; promote?: boolean }) => {
    await draftPublishCommand({
      tenant: opts.tenant,
      channel: opts.channel,
      draft: opts.draft,
      reference: opts.reference,
      note: opts.note,
      promote: opts.promote,
    });
  });

draft
  .command('abandon')
  .description('Abandonner le draft courant (supprime les blobs orphelins) + clear local')
  .action(async () => {
    await draftAbandonCommand();
  });

// ── branch (branches perso dev-{handle}, base ⊕ overlay) ─────────────────
// Toujours TA propre branche (le serveur résout `me`, jamais d'accès
// cross-dev) — pas de --channel ici, contrairement à draft/promote/core/
// versions où `@me` est un ALIAS qu'on résout vers cette même branche.
const branch = program
  .command('branch')
  .description('Branche perso dev-{handle} : create/show/overlay add/rm (scope launcher:draft, jamais de token de service)');

branch
  .command('create')
  .description("Provisionner (idempotent) ta branche perso, basée sur --base (défaut stable)")
  .requiredOption('-t, --tenant <slug>', 'slug du tenant (ex : nationsglory)')
  .option('--base <channel>', 'channel de base à composer (défaut : stable)')
  .action(async (opts: { tenant?: string; base?: string }) => {
    await branchCreateCommand({ tenant: opts.tenant, base: opts.base });
  });

branch
  .command('show')
  .description('Afficher ta branche perso (base, dernier build, overlay_rev, overlay détaillé)')
  .requiredOption('-t, --tenant <slug>', 'slug du tenant (ex : nationsglory)')
  .action(async (opts: { tenant?: string }) => {
    await branchShowCommand({ tenant: opts.tenant });
  });

const branchOverlay = branch
  .command('overlay')
  .description('Muter l\'overlay de ta branche perso (add/rm) — recompose + re-signe à chaque appel');

branchOverlay
  .command('add <file>')
  .description('Ajouter/remplacer un fichier dans ta branche perso (hash + upload R2 + commit + recompose)')
  .requiredOption('-t, --tenant <slug>', 'slug du tenant (ex : nationsglory)')
  .option('--path <virtualPath>', 'chemin cible dans le build (défaut : basename du fichier)')
  .option('--exec', 'marquer le fichier exécutable')
  .action(async (file: string, opts: { tenant?: string; path?: string; exec?: boolean }) => {
    await branchOverlayAddCommand(file, { tenant: opts.tenant, path: opts.path, exec: opts.exec });
  });

branchOverlay
  .command('rm <path>')
  .description("Retirer un fichier de ta branche perso (fonctionne aussi sur un fichier hérité de la base)")
  .requiredOption('-t, --tenant <slug>', 'slug du tenant (ex : nationsglory)')
  .action(async (p: string, opts: { tenant?: string }) => {
    await branchOverlayRmCommand(p, { tenant: opts.tenant });
  });

// ── merge (source dérivée → channel partagé) ──────────────────────────────
// Séparé de `branch` À DESSEIN : gaté sur la perm promote de la CIBLE (pas la
// perm dev-branch/read de la source) — même barrière anti-escalade que
// promote. `--from` généralisé au-delà de `@me` : '@me' passe par
// /branches/me/merge, tout autre nom de channel dérivé passe par le nouvel
// endpoint /channels/{source}/merge (voir src/commands/merge.ts).
program
  .command('merge')
  .description(
    "Merger une source (ta branche perso ou un channel dérivé arbitraire) sur un channel PARTAGÉ (--into) " +
      '— met en ligne sous ~30s. Perm-gated sur la perm promote de la CIBLE (scope launcher:promote), ' +
      'pas sur la source.'
  )
  .requiredOption('-t, --tenant <slug>', 'slug du tenant (ex : nationsglory)')
  .requiredOption('-i, --into <channel>', 'channel cible partagé (ex : beta, stable)')
  .option(
    '--from <alias>',
    "source du merge — '@me' (ta branche perso, défaut) ou le nom d'un channel dérivé arbitraire",
    '@me'
  )
  // `--version-tag` (PAS `--version`, même gotcha que `draft create`) :
  // `--version` entre en collision avec le flag version global de commander
  // (program.version()) et imprimerait juste le numéro de version du CLI.
  .option(
    '-V, --version-tag <semver>',
    'override de version (défaut : auto-bump patch de la version live de la cible)'
  )
  .option('-y, --yes', 'sauter la confirmation interactive (CI/scripts)')
  .action(
    async (opts: {
      tenant?: string;
      into?: string;
      from?: string;
      versionTag?: string;
      yes?: boolean;
    }) => {
      await mergeCommand({
        tenant: opts.tenant,
        into: opts.into,
        from: opts.from,
        version: opts.versionTag,
        yes: opts.yes,
      });
    }
  );

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
  .action((shell: string) => {
    completionCommand(shell);
  });

// Traduit la commande d'aide auto-générée (sinon "display help for command").
program.helpCommand('help [command]', "afficher l'aide d'une commande");

// Applique le help custom (box + listes à puces) à TOUTES les commandes.
applyHelpConfig(program);

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

// ── Bootstrap (avec auth-gate à la Claude Code) ──────────────────────────────
// Avant TOUT rendu (home, help, commande), on gate l'accès : si non
// authentifié (ni session OAuth ni RECUBE_TOKEN) ET commande hors allowlist
// (login/completion/--version), on n'affiche PAS le détail des commandes — on
// invite à se connecter + lance le flow login. RECUBE_TOKEN bypasse le gate.
async function main(): Promise<void> {
  const authed = await isAuthenticated();
  const publicInvocation = isPublicInvocation(process.argv);

  if (!authed && !publicInvocation) {
    await runAuthGate(); // exit à l'intérieur (login lancé OU instruction headless)
    return;
  }

  // Authentifié OU invocation publique → comportement normal.
  // Bare `recube` (argv ≤ 2) → home onboarding. Sinon → commander.
  if (process.argv.length <= 2) {
    await printHome();
    process.exit(0);
  }
  // Header des --help = box d'accueil avec statut d'auth. La ligne d'auth est
  // async (cache local) → on la pré-calcule ici (le help de commander est sync).
  if (process.argv.some((a) => a === '-h' || a === '--help' || a === 'help')) {
    helpAuthLine = await buildAuthLine();
  }
  await program.parseAsync(process.argv);
}

main().catch((err: Error) => {
  // eslint-disable-next-line no-console
  console.error(theme.error(`recube: ${err.message}`));
  process.exit(1);
});
