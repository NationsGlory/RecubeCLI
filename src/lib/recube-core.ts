/**
 * Best-effort auto-detection of a sibling RecubeCore build artifact.
 *
 * Game builds typically need `recube-core.jar` shipped alongside the client.
 * When the user runs `recube publish` from a workspace that has the RecubeCore
 * source repo as a sibling on disk (a common dev setup), we offer to copy the
 * freshly-built jar in instead of forcing them to do it manually.
 *
 * Heuristic — search ascending parent dirs for `RecubeCore/build/libs/recube-core-*.jar`
 * up to 3 levels above the build dir. Returns the newest match (mtime).
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SEARCH_DEPTH = 3;
const SIBLING_NAMES = ['RecubeCore', 'recubecore', 'recube-core'];

export async function findSiblingRecubeCoreJar(
  buildDir: string
): Promise<{ path: string; mtimeMs: number } | null> {
  const start = path.resolve(buildDir);
  let cursor = path.dirname(start);
  for (let i = 0; i <= SEARCH_DEPTH; i++) {
    for (const sib of SIBLING_NAMES) {
      const libs = path.join(cursor, sib, 'build', 'libs');
      if (!existsSync(libs)) continue;
      const candidate = await pickNewestJar(libs);
      if (candidate) return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

async function pickNewestJar(dir: string): Promise<{ path: string; mtimeMs: number } | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.startsWith('recube-core-') || !name.endsWith('.jar')) continue;
    if (name.endsWith('-sources.jar') || name.endsWith('-javadoc.jar')) continue;
    const abs = path.join(dir, name);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { path: abs, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}
