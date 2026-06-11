/**
 * Regression guard for the auto-detect path mismatch (0.2.1 hotfix).
 *
 * The backend `BuildPipeline` (RecubeGG/app/Services/BuildPipeline.php:619)
 * looks for the recube-core anti-cheat agent at the **root** of the bundle
 * manifest — `recube-core.jar`, exact string match. Prior versions of this
 * CLI auto-attached the sibling jar as `mods/recube-core.jar`, which silently
 * failed the enforcement check.
 *
 * This test feeds a real sibling jar through `buildLocalManifest` with the
 * exact include spec that `publishCommand` now emits (`as: 'recube-core.jar'`)
 * and asserts that the resulting manifest entry lives at the root.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSiblingRecubeCoreJar } from '../src/lib/recube-core.js';
import { buildLocalManifest } from '../src/lib/publish-pipeline.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'recube-cli-corepath-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('sibling RecubeCore include path', () => {
  it('auto-detected jar lands at root recube-core.jar (not mods/)', async () => {
    // Layout :
    //   root/NGClient/build/             ← bundle dir
    //   root/RecubeCore/build/libs/recube-core-0.4.0-SNAPSHOT.jar  ← sibling
    const buildDir = path.join(root, 'NGClient', 'build');
    const sibling = path.join(root, 'RecubeCore', 'build', 'libs');
    await mkdir(buildDir, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const jarPath = path.join(sibling, 'recube-core-0.4.0-SNAPSHOT.jar');
    await writeFile(jarPath, 'AGENT_BYTES');

    // Also place a couple of bundle files so the manifest isn't empty.
    await writeFile(path.join(buildDir, 'NGClient.jar'), 'CLIENT');
    await mkdir(path.join(buildDir, 'mods'), { recursive: true });
    await writeFile(path.join(buildDir, 'mods', 'forge.jar'), 'FORGE');

    const found = await findSiblingRecubeCoreJar(buildDir);
    expect(found).not.toBeNull();
    expect(found!.path).toBe(jarPath);

    // Replicates what publish.ts now does : `as: 'recube-core.jar'`.
    const manifest = await buildLocalManifest(
      buildDir,
      [],
      [{ path: found!.path, as: 'recube-core.jar' }]
    );
    const paths = manifest.map((m) => m.path).sort();

    // Critical assertion : the jar is at the root, NOT under mods/.
    expect(paths).toContain('recube-core.jar');
    expect(paths).not.toContain('mods/recube-core.jar');
  });

  it('does not silently produce mods/recube-core.jar entry from a sibling repo', async () => {
    // Defensive — even if a future refactor changes the auto-detect logic,
    // we never want the *manifest* to carry a mods/recube-core.jar entry
    // sourced from the sibling jar, because that satisfies neither the
    // backend enforcement nor the launcher download contract.
    const buildDir = path.join(root, 'bundle');
    const sibling = path.join(root, 'RecubeCore', 'build', 'libs');
    await mkdir(buildDir, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const jarPath = path.join(sibling, 'recube-core-0.4.0.jar');
    await writeFile(jarPath, 'A');
    await writeFile(path.join(buildDir, 'dummy.txt'), 'D');

    const found = await findSiblingRecubeCoreJar(buildDir);
    const manifest = await buildLocalManifest(
      buildDir,
      [],
      [{ path: found!.path, as: 'recube-core.jar' }]
    );
    for (const entry of manifest) {
      expect(entry.path.startsWith('mods/recube-core')).toBe(false);
    }
  });
});
