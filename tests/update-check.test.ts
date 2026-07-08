/**
 * `checkForUpdate` (src/lib/update-check.ts) — notice de MAJ pour le header
 * CLI (`recube` bare + `--help`). Le point critique : ne JAMAIS bloquer ni
 * planter le rendu du header (offline, cache corrompu, install non-SEA), et
 * ne JAMAIS re-taper l'API GitHub à chaque `--help` (cache TTL).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_CONFIG_DIR = path.join(os.tmpdir(), 'recube-cli-update-check-test');

vi.mock('../src/lib/config.js', () => ({
  configDir: () => TEST_CONFIG_DIR,
  ensureConfigDir: async () => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  },
}));

const h = vi.hoisted(() => ({
  isSeaBinary: vi.fn(() => true),
  fetchLatestRelease: vi.fn(async () => ({ tag: 'v0.8.0', version: '0.8.0' })),
  isNewer: vi.fn((remote: string, local: string) => remote !== local),
}));

vi.mock('../src/lib/self-update.js', () => ({
  isSeaBinary: h.isSeaBinary,
  fetchLatestRelease: h.fetchLatestRelease,
  isNewer: h.isNewer,
  CURRENT_VERSION: '0.7.9',
}));

const { checkForUpdate } = await import('../src/lib/update-check.js');
const cacheFile = path.join(TEST_CONFIG_DIR, 'update-check.json');

beforeEach(() => {
  h.isSeaBinary.mockReturnValue(true);
  h.fetchLatestRelease.mockClear().mockResolvedValue({ tag: 'v0.8.0', version: '0.8.0' });
  h.isNewer.mockClear().mockImplementation((remote: string, local: string) => remote !== local);
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  delete process.env.RECUBE_CLI_NO_UPDATE_CHECK;
});

afterEach(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

describe('checkForUpdate — garde-fous', () => {
  it('renvoie null pour un install non-SEA (npm/tsx)', async () => {
    h.isSeaBinary.mockReturnValue(false);
    expect(await checkForUpdate()).toBeNull();
    expect(h.fetchLatestRelease).not.toHaveBeenCalled();
  });

  it('renvoie null si RECUBE_CLI_NO_UPDATE_CHECK=1', async () => {
    process.env.RECUBE_CLI_NO_UPDATE_CHECK = '1';
    expect(await checkForUpdate()).toBeNull();
    expect(h.fetchLatestRelease).not.toHaveBeenCalled();
  });

  it('renvoie null si déjà à jour (isNewer=false)', async () => {
    h.isNewer.mockReturnValue(false);
    expect(await checkForUpdate()).toBeNull();
  });

  it("renvoie null (jamais de throw) si fetchLatestRelease échoue (offline/timeout)", async () => {
    h.fetchLatestRelease.mockRejectedValue(new Error('network down'));
    await expect(checkForUpdate()).resolves.toBeNull();
  });
});

describe('checkForUpdate — MAJ disponible + cache', () => {
  it('renvoie la notice et écrit le cache au 1er appel (cache froid)', async () => {
    const notice = await checkForUpdate();
    expect(notice).toEqual({ latestVersion: '0.8.0', latestTag: 'v0.8.0' });
    expect(h.fetchLatestRelease).toHaveBeenCalledTimes(1);
    expect(existsSync(cacheFile)).toBe(true);
  });

  it('sert le cache frais sans rappeler fetchLatestRelease', async () => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    writeFileSync(
      cacheFile,
      JSON.stringify({ checkedAt: Date.now(), latestVersion: '0.9.0', latestTag: 'v0.9.0' })
    );

    const notice = await checkForUpdate();
    expect(notice).toEqual({ latestVersion: '0.9.0', latestTag: 'v0.9.0' });
    expect(h.fetchLatestRelease).not.toHaveBeenCalled();
  });

  it('ignore un cache périmé (>6h) et re-fetch', async () => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;
    writeFileSync(
      cacheFile,
      JSON.stringify({
        checkedAt: Date.now() - SEVEN_HOURS_MS,
        latestVersion: '0.7.9',
        latestTag: 'v0.7.9',
      })
    );

    const notice = await checkForUpdate();
    expect(h.fetchLatestRelease).toHaveBeenCalledTimes(1);
    expect(notice).toEqual({ latestVersion: '0.8.0', latestTag: 'v0.8.0' });
  });

  it('ignore un cache illisible (JSON corrompu) et re-fetch sans planter', async () => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    writeFileSync(cacheFile, '{not valid json');

    await expect(checkForUpdate()).resolves.toEqual({
      latestVersion: '0.8.0',
      latestTag: 'v0.8.0',
    });
  });
});
