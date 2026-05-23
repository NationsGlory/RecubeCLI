/**
 * runtime_config — JVM launch metadata attached to a published build.
 *
 * Shape mirrors what RecubeGG persists alongside a version (main_class,
 * client_jar, java_version, java_vendor, java_min_version, jvm_args). When
 * absent on commit, backend inherits from the latest version on same channel
 * (BuildPipeline 364f97c).
 *
 * Two ways to supply :
 *   1. Explicit flag : `recube publish --runtime-config ./my-runtime.json`
 *   2. Convention : `.recube/runtime.json` at the root of the build dir
 *
 * If both are present, the explicit flag wins.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface RuntimeConfig {
  main_class?: string;
  client_jar?: string;
  java_version?: number;
  java_vendor?: string;
  java_min_version?: string;
  jvm_args?: string[];
}

const STRING_KEYS = ['main_class', 'client_jar', 'java_vendor', 'java_min_version'] as const;

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

export function validateRuntimeConfig(raw: unknown, source: string): RuntimeConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeConfigError(`${source}: expected a JSON object, got ${typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  const out: RuntimeConfig = {};

  for (const key of STRING_KEYS) {
    if (obj[key] === undefined || obj[key] === null) continue;
    if (typeof obj[key] !== 'string') {
      throw new RuntimeConfigError(`${source}: ${key} must be a string`);
    }
    out[key] = obj[key] as string;
  }

  if (obj.java_version !== undefined && obj.java_version !== null) {
    const v = obj.java_version;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new RuntimeConfigError(`${source}: java_version must be a positive integer`);
    }
    out.java_version = v;
  }

  if (obj.jvm_args !== undefined && obj.jvm_args !== null) {
    if (!Array.isArray(obj.jvm_args)) {
      throw new RuntimeConfigError(`${source}: jvm_args must be an array of strings`);
    }
    for (const arg of obj.jvm_args) {
      if (typeof arg !== 'string') {
        throw new RuntimeConfigError(`${source}: jvm_args[*] must be a string, got ${typeof arg}`);
      }
    }
    out.jvm_args = obj.jvm_args as string[];
  }

  return out;
}

export async function readRuntimeConfigFile(filePath: string): Promise<RuntimeConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new RuntimeConfigError(`Cannot read ${filePath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RuntimeConfigError(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
  return validateRuntimeConfig(parsed, filePath);
}

export function defaultRuntimeConfigPath(buildDir: string): string {
  return path.join(buildDir, '.recube', 'runtime.json');
}

/**
 * Resolve runtime_config from CLI inputs.
 *
 * Precedence : explicit `flagPath` > auto-detected `.recube/runtime.json`.
 * Returns `null` if neither found (backend then inherits from latest version).
 */
export async function resolveRuntimeConfig(
  buildDir: string,
  flagPath?: string
): Promise<{ config: RuntimeConfig; source: string } | null> {
  if (flagPath) {
    const abs = path.resolve(flagPath);
    const config = await readRuntimeConfigFile(abs);
    return { config, source: abs };
  }
  const autoPath = defaultRuntimeConfigPath(buildDir);
  if (existsSync(autoPath)) {
    const config = await readRuntimeConfigFile(autoPath);
    return { config, source: autoPath };
  }
  return null;
}
