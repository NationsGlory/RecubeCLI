import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSiblingRecubeCoreJar } from '../src/lib/recube-core.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'recube-cli-sibling-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('findSiblingRecubeCoreJar', () => {
  it('returns null when no sibling RecubeCore exists', async () => {
    const buildDir = path.join(root, 'project', 'build');
    await mkdir(buildDir, { recursive: true });
    const found = await findSiblingRecubeCoreJar(buildDir);
    expect(found).toBeNull();
  });

  it('finds jar in sibling RecubeCore/build/libs', async () => {
    const buildDir = path.join(root, 'NGClient', 'build');
    const sibling = path.join(root, 'RecubeCore', 'build', 'libs');
    await mkdir(buildDir, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const jarPath = path.join(sibling, 'recube-core-0.4.0-SNAPSHOT.jar');
    await writeFile(jarPath, 'jarbytes');

    const found = await findSiblingRecubeCoreJar(buildDir);
    expect(found).not.toBeNull();
    expect(found!.path).toBe(jarPath);
  });

  it('picks the newest jar when multiple exist', async () => {
    const buildDir = path.join(root, 'NGClient', 'build');
    const sibling = path.join(root, 'RecubeCore', 'build', 'libs');
    await mkdir(buildDir, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const old = path.join(sibling, 'recube-core-0.3.0.jar');
    const fresh = path.join(sibling, 'recube-core-0.4.0.jar');
    await writeFile(old, 'old');
    await writeFile(fresh, 'fresh');
    // backdate old jar by 1 hour
    const past = new Date(Date.now() - 3600 * 1000);
    await utimes(old, past, past);

    const found = await findSiblingRecubeCoreJar(buildDir);
    expect(found!.path).toBe(fresh);
  });

  it('ignores -sources.jar and -javadoc.jar', async () => {
    const buildDir = path.join(root, 'NGClient', 'build');
    const sibling = path.join(root, 'RecubeCore', 'build', 'libs');
    await mkdir(buildDir, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, 'recube-core-0.4.0-sources.jar'), 's');
    await writeFile(path.join(sibling, 'recube-core-0.4.0-javadoc.jar'), 'j');

    const found = await findSiblingRecubeCoreJar(buildDir);
    expect(found).toBeNull();
  });
});
