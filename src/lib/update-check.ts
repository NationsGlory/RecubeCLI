/**
 * Vérif MAJ pour le header CLI (`recube` bare + `--help`) — PAS `recube
 * update` lui-même (ça reste explicite, cf. commands/update.ts).
 *
 * Contraintes : jamais bloquant (timeout court, abandonne en silence si offline
 * ou lent), jamais spammé (cache TTL — sinon chaque `--help` tape l'API GitHub),
 * jamais affiché pour un install non-SEA (npm global / tsx dev : `recube
 * update` n'a rien à proposer là, cf. self-update.ts isSeaBinary()).
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configDir, ensureConfigDir } from './config.js';
import { CURRENT_VERSION, fetchLatestRelease, isNewer, isSeaBinary } from './self-update.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

interface UpdateCheckCache {
  checkedAt: number;
  latestVersion: string;
  latestTag: string;
}

export interface UpdateNotice {
  latestVersion: string;
  latestTag: string;
}

function cachePath(): string {
  return path.join(configDir(), 'update-check.json');
}

async function readCache(): Promise<UpdateCheckCache | null> {
  const p = cachePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, 'utf8')) as UpdateCheckCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: UpdateCheckCache): Promise<void> {
  try {
    await ensureConfigDir();
    await writeFile(cachePath(), JSON.stringify(cache) + '\n', { mode: 0o600 });
  } catch {
    // Cache non-essentiel — un échec d'écriture (FS read-only, etc.) ne doit
    // jamais faire planter le header.
  }
}

/**
 * Best-effort : renvoie null si pas de MAJ dispo, réseau down/lent, cache
 * illisible, ou install non-SEA. Ne lève jamais — appelée depuis le rendu
 * synchrone du header, une exception ici planterait `recube --help`.
 */
export async function checkForUpdate(): Promise<UpdateNotice | null> {
  if (process.env.RECUBE_CLI_NO_UPDATE_CHECK === '1') return null;
  if (!isSeaBinary()) return null;

  try {
    const cached = await readCache();
    const fresh = cached && Date.now() - cached.checkedAt < CACHE_TTL_MS;

    let latestVersion: string;
    let latestTag: string;
    if (fresh && cached) {
      latestVersion = cached.latestVersion;
      latestTag = cached.latestTag;
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const release = await fetchLatestRelease(undefined, controller.signal);
        latestVersion = release.version;
        latestTag = release.tag;
      } finally {
        clearTimeout(timer);
      }
      await writeCache({ checkedAt: Date.now(), latestVersion, latestTag });
    }

    if (!isNewer(latestVersion, CURRENT_VERSION)) return null;
    return { latestVersion, latestTag };
  } catch {
    return null;
  }
}
