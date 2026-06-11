/**
 * `--include` spec parser tests.
 *
 * Covers :
 *   - `source:target` → explicit pair
 *   - `source` → target inferred from basename
 *   - Non-existent source → throws clearly
 *   - Windows drive letter heuristic (`C:\...` is NOT a separator)
 *
 * The parser is exported from `src/commands/publish.ts` for easy unit testing
 * — it does not touch the API surface, only the filesystem (existsSync).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseIncludeSpec } from '../src/commands/publish.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'recube-cli-include-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe('parseIncludeSpec', () => {
  it('parses <source>:<target> form', async () => {
    const src = path.join(tmp, 'agent.jar');
    await writeFile(src, 'JAR');

    const result = parseIncludeSpec(`${src}:recube-core.jar`);
    expect(result.path).toBe(path.resolve(src));
    expect(result.as).toBe('recube-core.jar');
  });

  it('falls back to basename when target is omitted', async () => {
    const src = path.join(tmp, 'some.jar');
    await writeFile(src, 'JAR');

    const result = parseIncludeSpec(src);
    expect(result.path).toBe(path.resolve(src));
    expect(result.as).toBe('some.jar');
  });

  it('supports nested target paths inside the bundle', async () => {
    const src = path.join(tmp, 'optifine.jar');
    await writeFile(src, 'OF');

    const result = parseIncludeSpec(`${src}:mods/optifine.jar`);
    expect(result.as).toBe('mods/optifine.jar');
  });

  it('throws a clear error when the source does not exist', () => {
    const missing = path.join(tmp, 'does-not-exist.jar');
    expect(() => parseIncludeSpec(`${missing}:recube-core.jar`)).toThrowError(
      /--include source not found/
    );
    expect(() => parseIncludeSpec(missing)).toThrowError(/--include source not found/);
  });

  it('does NOT treat a Windows drive letter as a separator', async () => {
    // Only relevant on win32 — on POSIX, drive letters look like normal
    // strings and would just fail existence check (which is fine, we just
    // verify the parser does not split on the wrong colon).
    if (process.platform !== 'win32') {
      return;
    }
    // Real file on a Windows path with drive letter.
    const src = path.join(tmp, 'agent.jar');
    await writeFile(src, 'JAR');
    // tmp is on a real drive letter, so path.resolve(tmp + ...) keeps it.
    const result = parseIncludeSpec(src); // src looks like C:\...\agent.jar
    expect(result.path).toBe(path.resolve(src));
    expect(result.as).toBe('agent.jar');
  });
});
