/**
 * `recube update` — self-update du binaire SEA (Node Single Executable
 * Application, cf. scripts/build-binary.mjs) depuis GitHub Releases.
 *
 * Réutilise EXACTEMENT le même modèle de confiance que install.ps1/install.sh
 * (checksum SHA-256 + signature RSA, clé publique Recube épinglée) — mais en
 * FAIL-CLOSED sur les deux, pas de skip silencieux si absents : contrairement
 * à un install initial où l'utilisateur vient d'un lien HTTPS de confiance
 * (recube.gg), un `recube update` tourne depuis un binaire déjà installé —
 * aucune raison d'accepter une release incomplète/altérée ici.
 *
 * Ne fait RIEN si le process courant n'est pas un binaire SEA (npm global /
 * tsx dev) : ces installs se mettent à jour via `npm update -g` / git pull,
 * pas en se remplaçant eux-mêmes.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { VERSION } from '../version.js';

const REPO = process.env.RECUBE_REPO ?? 'NationsGlory/RecubeCLI';

// Même clé publique que install.ps1 (RSAKeyValue XML → modulus/exponent
// base64 standard). Convertie ici en JWK (base64url, requis par node:crypto)
// UNE fois au chargement du module plutôt qu'à chaque appel.
const PUBLIC_KEY_MODULUS_B64 =
  'z8YFN+9/fMfOIQ9gVsj5V1tk5B56rPFC3v51fUIQPHXVQvVO0x4CIChTA2d9IcIQEA2XoSqkDNKd7fGgaUwu+HOVAX14Bpn2VtZzhaP69GHI/6yGEr2lmAk4YcKXDu67HWRCiWLeSKASD9nLlXN+qwi6KFJ8aqOd6lO2rOS4aqLnwpCC8azrJSGJHvMSnGf+7zE0/tQdiZGsKG2llGeUflLHDwdxJnN9gWyBHADJLrYoDDetrkXXnXyGHfIl7YLWblHTeOLgyL5dnAGdtb9u8lk302iIAsM9ER9SjUUz3BMXfh+ptdHbqZeHui7qaUWgqcoMDNmB6L5INg0K4m2EfiAlNgaygn/QbD/bzOXKbxr8B+jT1QQKIK4EKVVnzkfEarU84MSg5qMdVMQPpit8TtJRkjLEiSUeYwcsf0r8GDLm5aB0fgHjeoCZduVn802At7DXpEVllgdiJdYf97y9blGoqutrRs4TjHIL56UCFLm6o/OuQOeVU4XKRhBdGsWF';
const PUBLIC_KEY_EXPONENT_B64 = 'AQAB';

function b64ToB64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function recubePublicKey() {
  return createPublicKey({
    key: {
      kty: 'RSA',
      n: b64ToB64Url(PUBLIC_KEY_MODULUS_B64),
      e: b64ToB64Url(PUBLIC_KEY_EXPONENT_B64),
    },
    format: 'jwk',
  });
}

export interface PlatformTarget {
  os: 'windows' | 'linux' | 'macos';
  arch: 'x64' | 'arm64';
  assetName: string;
}

/** Même détection que install.sh/install.ps1 (process.platform/arch ≡ uname/PROCESSOR_ARCHITECTURE). */
export function detectPlatform(): PlatformTarget {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const ext = os === 'windows' ? '.exe' : '';

  return { os, arch, assetName: `recube-${os}-${arch}${ext}` };
}

/** Est-ce qu'on tourne comme binaire SEA compilé (vs npm global / tsx dev) ? */
export function isSeaBinary(): boolean {
  try {
    // `node:sea` est expérimental (Node 20.12+/21.7+) — absent en dev (tsx) et
    // sur un Node trop ancien. Un throw ou isSea()===false = pas un SEA.
    // require() (pas import) : le module peut ne pas exister du tout selon la
    // version Node, un import statique ferait échouer la résolution ESM.
    // `import.meta.url || process.execPath` : esbuild bundle ce fichier en CJS
    // pour le binaire SEA (build-binary.mjs), et `import.meta.url` devient
    // `undefined` à l'exécution dans ce bundle CJS (quirk esbuild constaté en
    // prod : createRequire(undefined) lève ERR_INVALID_ARG_VALUE, isSeaBinary()
    // retombait toujours sur false MÊME dans le vrai binaire compilé). 'node:sea'
    // étant un module builtin, la base de résolution n'a aucune importance —
    // n'importe quel chemin absolu valide convient, `process.execPath` est
    // toujours défini dans les deux contextes (dev ESM et bundle CJS).
    const require = createRequire(import.meta.url || process.execPath);
    const sea = require('node:sea') as { isSea?: () => boolean };
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch {
    return false;
  }
}

export interface LatestRelease {
  tag: string;
  version: string;
}

export async function fetchLatestRelease(repo: string = REPO): Promise<LatestRelease> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'recube-cli' },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} en résolvant la dernière release de ${repo}.`);
  }
  const body = (await res.json()) as { tag_name?: string };
  const tag = body.tag_name ?? '';
  if (!tag) throw new Error('Réponse GitHub sans tag_name.');

  return { tag, version: tag.replace(/^v/, '') };
}

/** Compare 2 versions semver simples (x.y.z, pas de pre-release/build metadata). */
export function isNewer(remote: string, local: string): boolean {
  const a = remote.split('.').map((n) => parseInt(n, 10) || 0);
  const b = local.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`téléchargement échoué (${res.status}) : ${url}`);

  return Buffer.from(await res.arrayBuffer());
}

export interface UpdateResult {
  installedVersion: string;
  binaryPath: string;
}

/**
 * Télécharge + vérifie (checksum ET signature, fail-closed) + installe le
 * binaire de la release donnée à la place du binaire courant. Ne touche RIEN
 * tant que la vérification n'a pas réussi (abort-before-mutation).
 */
export async function downloadAndInstall(release: LatestRelease, repo: string = REPO): Promise<UpdateResult> {
  const target = detectPlatform();
  const base = `https://github.com/${repo}/releases/download/${release.tag}`;
  const binUrl = `${base}/${target.assetName}`;
  const sumUrl = `${binUrl}.sha256`;
  const sigUrl = `${binUrl}.sig`;

  const [binBuf, sumBuf, sigBuf] = await Promise.all([
    downloadToBuffer(binUrl),
    downloadToBuffer(sumUrl).catch(() => null),
    downloadToBuffer(sigUrl).catch(() => null),
  ]);

  if (!sumBuf) {
    throw new Error('checksum introuvable — release incomplète, mise à jour refusée.');
  }
  const expected = sumBuf.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash('sha256').update(binBuf).digest('hex');
  if (!expected || actual !== expected) {
    throw new Error(`checksum invalide (attendu ${expected ?? '?'}, obtenu ${actual}) — binaire altéré, mise à jour refusée.`);
  }

  if (!sigBuf || sigBuf.length === 0) {
    throw new Error('signature RSA introuvable — release non authentifiée, mise à jour refusée.');
  }
  const validSignature = cryptoVerify('sha256', binBuf, recubePublicKey(), sigBuf);
  if (!validSignature) {
    throw new Error('signature RSA invalide — binaire non authentifié par Recube, mise à jour refusée.');
  }

  // Vérification passée : installe. Le fichier temporaire vit dans le MÊME
  // dossier que la cible pour que le rename final soit atomique (même
  // filesystem) — un rename cross-device échouerait silencieusement en EXDEV.
  const currentPath = process.execPath;
  const destDir = path.dirname(currentPath);
  const tmpPath = path.join(destDir, `.recube-update-${process.pid}.tmp`);
  writeFileSync(tmpPath, binBuf);
  if (target.os !== 'windows') chmodSync(tmpPath, 0o755);

  try {
    if (target.os === 'windows') {
      // Windows verrouille l'exe en cours d'exécution : impossible de le
      // supprimer/écraser directement. On le pousse de côté (rename autorisé
      // même si le process tourne dessus) puis on installe le nouveau à sa
      // place ; le .old est nettoyé au mieux (peut échouer si verrouillé une
      // fraction de seconde de plus, sans gravité — nettoyé au prochain
      // `recube update`).
      const oldPath = `${currentPath}.old`;
      try {
        rmSync(oldPath, { force: true });
      } catch {
        /* résidu d'un update précédent verrouillé — ignore */
      }
      renameSync(currentPath, oldPath);
      renameSync(tmpPath, currentPath);
      try {
        rmSync(oldPath, { force: true });
      } catch {
        /* sera nettoyé au prochain update */
      }
    } else {
      // Unix : rename() est atomique et safe même si le process courant a le
      // fichier ouvert (l'inode reste valide pour lui, le nouveau nom pointe
      // sur le nouveau contenu pour toute invocation future).
      renameSync(tmpPath, currentPath);
    }
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }

  return { installedVersion: release.version, binaryPath: currentPath };
}

export { VERSION as CURRENT_VERSION };
