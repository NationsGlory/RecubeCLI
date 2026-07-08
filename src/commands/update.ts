/**
 * `recube update` — met à jour le binaire SEA vers la dernière release GitHub.
 * No-op explicite (message clair) si on tourne via npm/tsx (pas un binaire
 * compilé) : ces installs se gèrent avec `npm update -g @nationsglory/cli`.
 */

import {
  CURRENT_VERSION,
  detectPlatform,
  downloadAndInstall,
  fetchLatestRelease,
  isNewer,
  isSeaBinary,
} from '../lib/self-update.js';
import { chalk } from '../lib/ui.js';

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

export async function updateCommand(opts: { check?: boolean } = {}): Promise<void> {
  if (!isSeaBinary()) {
    fail(
      "cette installation n'est pas un binaire autonome (npm global ou source).\n  " +
        chalk.dim('npm : npm update -g @nationsglory/cli') +
        '\n  ' +
        chalk.dim('source : git pull && npm install')
    );
  }

  info(`Version installée : ${chalk.bold(CURRENT_VERSION)}`);
  let latest;
  try {
    latest = await fetchLatestRelease();
  } catch (err) {
    fail(`impossible de vérifier la dernière version : ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isNewer(latest.version, CURRENT_VERSION)) {
    ok(`déjà à jour (dernière release : ${latest.version}).`);
    return;
  }

  info(`Nouvelle version disponible : ${chalk.bold(latest.version)} (${latest.tag})`);
  if (opts.check) {
    info(chalk.dim('  --check : lance `recube update` (sans --check) pour installer.'));
    return;
  }

  const target = detectPlatform();
  info(`Téléchargement de ${chalk.dim(target.assetName)}…`);
  try {
    const result = await downloadAndInstall(latest);
    ok(`Mis à jour vers ${chalk.bold(result.installedVersion)} (${result.binaryPath}).`);
    info(chalk.dim('  Relance ta commande, ou vérifie avec `recube --version`.'));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
