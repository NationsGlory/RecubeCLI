import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultRuntimeConfigPath,
  readRuntimeConfigFile,
  resolveRuntimeConfig,
  RuntimeConfigError,
  validateRuntimeConfig,
} from '../src/lib/runtime-config.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'recube-cli-rt-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe('validateRuntimeConfig', () => {
  it('accepts full valid payload', () => {
    const cfg = validateRuntimeConfig(
      {
        main_class: 'Start',
        client_jar: 'NGClient.jar',
        java_version: 21,
        java_vendor: 'temurin',
        java_min_version: '21.0.0',
        jvm_args: ['-Xmx2G', '-Xms512M'],
      },
      'test'
    );
    expect(cfg.main_class).toBe('Start');
    expect(cfg.java_version).toBe(21);
    expect(cfg.jvm_args).toEqual(['-Xmx2G', '-Xms512M']);
  });

  it('accepts partial payload (only some fields)', () => {
    const cfg = validateRuntimeConfig({ main_class: 'Start' }, 'test');
    expect(cfg.main_class).toBe('Start');
    expect(cfg.java_version).toBeUndefined();
  });

  it('rejects non-object', () => {
    expect(() => validateRuntimeConfig(['not', 'object'], 'src')).toThrow(RuntimeConfigError);
    expect(() => validateRuntimeConfig('string', 'src')).toThrow(RuntimeConfigError);
    expect(() => validateRuntimeConfig(null, 'src')).toThrow(RuntimeConfigError);
  });

  it('rejects bad string fields', () => {
    expect(() => validateRuntimeConfig({ main_class: 42 }, 'src')).toThrow(/main_class/);
  });

  it('rejects bad java_version', () => {
    expect(() => validateRuntimeConfig({ java_version: '21' }, 'src')).toThrow(/java_version/);
    expect(() => validateRuntimeConfig({ java_version: 0 }, 'src')).toThrow(/java_version/);
    expect(() => validateRuntimeConfig({ java_version: 8.5 }, 'src')).toThrow(/java_version/);
  });

  it('rejects bad jvm_args', () => {
    expect(() => validateRuntimeConfig({ jvm_args: 'string' }, 'src')).toThrow(/jvm_args/);
    expect(() => validateRuntimeConfig({ jvm_args: [1, 2] }, 'src')).toThrow(/jvm_args/);
  });

  it('ignores null/undefined fields gracefully', () => {
    const cfg = validateRuntimeConfig({ main_class: null, jvm_args: undefined }, 'src');
    expect(cfg.main_class).toBeUndefined();
    expect(cfg.jvm_args).toBeUndefined();
  });
});

describe('readRuntimeConfigFile', () => {
  it('reads and parses a valid file', async () => {
    const filePath = path.join(tmp, 'runtime.json');
    await writeFile(filePath, JSON.stringify({ main_class: 'Start', java_version: 21 }));
    const cfg = await readRuntimeConfigFile(filePath);
    expect(cfg.main_class).toBe('Start');
    expect(cfg.java_version).toBe(21);
  });

  it('throws on missing file', async () => {
    await expect(readRuntimeConfigFile(path.join(tmp, 'nope.json'))).rejects.toThrow(
      RuntimeConfigError
    );
  });

  it('throws on invalid JSON', async () => {
    const filePath = path.join(tmp, 'bad.json');
    await writeFile(filePath, '{ not: json }');
    await expect(readRuntimeConfigFile(filePath)).rejects.toThrow(/Invalid JSON/);
  });
});

describe('resolveRuntimeConfig', () => {
  it('returns null if no flag and no .recube/runtime.json', async () => {
    const result = await resolveRuntimeConfig(tmp);
    expect(result).toBeNull();
  });

  it('reads .recube/runtime.json auto-detect', async () => {
    await mkdir(path.join(tmp, '.recube'), { recursive: true });
    await writeFile(
      defaultRuntimeConfigPath(tmp),
      JSON.stringify({ main_class: 'AutoDetected' })
    );
    const result = await resolveRuntimeConfig(tmp);
    expect(result).not.toBeNull();
    expect(result!.config.main_class).toBe('AutoDetected');
    expect(result!.source).toContain('.recube');
  });

  it('explicit flag overrides auto-detect', async () => {
    await mkdir(path.join(tmp, '.recube'), { recursive: true });
    await writeFile(defaultRuntimeConfigPath(tmp), JSON.stringify({ main_class: 'AutoDetected' }));
    const flagFile = path.join(tmp, 'custom.json');
    await writeFile(flagFile, JSON.stringify({ main_class: 'FlagWins' }));
    const result = await resolveRuntimeConfig(tmp, flagFile);
    expect(result!.config.main_class).toBe('FlagWins');
    expect(result!.source).toBe(path.resolve(flagFile));
  });

  it('throws on invalid auto-detect file', async () => {
    await mkdir(path.join(tmp, '.recube'), { recursive: true });
    await writeFile(defaultRuntimeConfigPath(tmp), '{');
    await expect(resolveRuntimeConfig(tmp)).rejects.toThrow(RuntimeConfigError);
  });
});
