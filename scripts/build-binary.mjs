/**
 * Build a standalone single-file executable of the recube CLI — no Node
 * required on the user's machine.
 *
 * Approach: Node SEA (Single Executable Application, official Node 20+/22).
 * Chosen over bun --compile (bun not assumed installed) and pkg (deprecated /
 * unmaintained). SEA is built into Node itself → zero extra runtime, the
 * produced binary IS a Node binary with our bundled JS injected as a blob.
 *
 * Steps:
 *   1. esbuild bundles src/cli.ts → one CJS file (all deps inlined).
 *   2. `node --experimental-sea-config` produces a .blob from that file.
 *   3. copy the *current* `node` binary → `recube[.exe]`.
 *   4. `postject` injects the blob into the copy (sentinel fuse).
 *   5. (macOS) re-sign ad-hoc so Gatekeeper accepts the modified binary.
 *
 * Cross-platform : this script builds for WHATEVER OS/arch it runs on. The CI
 * matrix runs it once per target (linux-x64, linux-arm64, macos-x64,
 * macos-arm64, windows-x64) and uploads each artifact to GitHub Releases.
 *
 * Output: dist-bundle/recube-<os>-<arch>[.exe]
 *
 * Usage: node scripts/build-binary.mjs
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-bundle');
const bundlePath = path.join(outDir, 'recube.cjs');
const blobPath = path.join(outDir, 'sea-prep.blob');

// Target naming aligned with the installers (install.sh / install.ps1).
const platform = process.platform; // 'linux' | 'darwin' | 'win32'
const arch = process.arch; // 'x64' | 'arm64'
const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
const ext = platform === 'win32' ? '.exe' : '';
const binName = `recube-${osName}-${arch}${ext}`;
const binPath = path.join(outDir, binName);

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
}

// ── 0. clean ──────────────────────────────────────────────────────────────
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ── 1. bundle src/cli.ts → single CJS ───────────────────────────────────────
// CJS (not ESM) because SEA's require()-from-blob is the supported path; ESM in
// SEA needs extra ceremony. Bundle inlines chalk/commander/clack/ora. Node
// builtins stay external. `--banner` keeps the shebang harmless inside SEA.
console.log('• bundling with esbuild…');
run('node', [
  path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/cli.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  `--outfile=${bundlePath}`,
  // keytar is an optional native module the CLI loads lazily via dynamic
  // import with a try/catch fallback to the file store — leave it external so
  // the bundle never hard-fails on a missing native .node.
  '--external:keytar',
]);

// ── 2. SEA blob ─────────────────────────────────────────────────────────────
console.log('• generating SEA blob…');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

// ── 3. copy node binary ─────────────────────────────────────────────────────
console.log(`• copying node → ${binName}…`);
copyFileSync(process.execPath, binPath);
if (platform !== 'win32') chmodSync(binPath, 0o755);

// ── 3b. (macOS) remove existing signature before injection ──────────────────
if (platform === 'darwin') {
  try {
    run('codesign', ['--remove-signature', binPath]);
  } catch {
    console.warn('  (codesign --remove-signature skipped)');
  }
}

// ── 4. inject blob via postject ─────────────────────────────────────────────
console.log('• injecting blob with postject…');
const postjectArgs = [
  'postject',
  binPath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (platform === 'darwin') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}
// Use npx so CI doesn't need postject as a hard dep.
run('npx', ['--yes', ...postjectArgs], {
  shell: platform === 'win32', // npx.cmd on Windows
});

// ── 5. (macOS) ad-hoc re-sign so Gatekeeper accepts the modified binary ─────
if (platform === 'darwin') {
  try {
    run('codesign', ['--sign', '-', binPath]);
  } catch {
    console.warn('  (codesign ad-hoc sign skipped — binary may need manual sign)');
  }
}

console.log(`\n✓ built ${binPath}`);
console.log(`  test: ${binPath} --help`);
void os;
void execSync;
