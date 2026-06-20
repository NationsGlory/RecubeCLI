/**
 * Recube CLI — ASCII brand banner.
 *
 * Renders the recube cube logo + wordmark in brand violet (#7C3AED), with
 * graceful degradation across terminal color capabilities:
 *
 *   - truecolor (24-bit) : exact #7C3AED cube, #A78BFA bold wordmark
 *   - 256-color          : xterm 99 (≈ violet) cube, 141 wordmark
 *   - 8/16-color         : magenta cube, bright-magenta wordmark
 *   - no-color           : raw ASCII (NO_COLOR / non-TTY / TERM=dumb)
 *
 * The cube is a single flat color (no per-face shading) so colorisation is a
 * trivial, robust per-line wrap. Every colored line is individually wrapped in
 * SGR + RESET so a truncated stream never bleeds violet into the rest of the
 * terminal. The art is fully legible without any color — that is its strength.
 */

import { colorEnabled } from './theme.js';

// Raw cube art (no wordmark — wordmark gets a distinct, lighter color).
const CUBE_LINES = [
  '    ___________',
  '   /\\          \\',
  '  /  \\          \\',
  ' /    \\          \\',
  '/      \\          \\',
  '\\      /__________\\',
  ' \\    /          /',
  '  \\  /          /',
  '   \\/__________/',
];

const WORDMARK = '      recube';

// Compact cube — a small mark that fits cleanly inside the rounded welcome box
// (Claude-Code style). 4 lines tall vs the 9-line full art. Single flat color.
const COMPACT_CUBE_LINES = [
  ' ____ ',
  '/\\___\\',
  '\\/___/',
];

type ColorLevel = 'truecolor' | 'ansi256' | 'ansi16' | 'none';

const RESET = '\x1b[0m';

/**
 * Detect the richest color tier the current terminal supports.
 * Returns 'none' when color must be suppressed entirely.
 */
function detectLevel(): ColorLevel {
  if (!colorEnabled()) return 'none';

  const colorterm = (process.env.COLORTERM ?? process.env.COLORTYPE ?? '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) {
    return 'truecolor';
  }

  const term = (process.env.TERM ?? '').toLowerCase();
  if (term.includes('256color')) return 'ansi256';

  // FORCE_COLOR with no TERM hint: assume at least basic color.
  if (process.env.FORCE_COLOR && !term) return 'ansi256';

  if (term) return 'ansi16';

  // colorEnabled() said yes but we can't read TERM (e.g. FORCE_COLOR on a bare
  // env): fall back to safe 16-color magenta.
  return 'ansi16';
}

/**
 * SGR opening sequence for a given role at a given color level.
 * `bold` is applied to the wordmark for contrast.
 */
function open(level: ColorLevel, role: 'cube' | 'wordmark'): string {
  switch (level) {
    case 'truecolor':
      return role === 'cube'
        ? '\x1b[38;2;124;58;237m' // #7C3AED
        : '\x1b[1;38;2;167;139;250m'; // bold #A78BFA
    case 'ansi256':
      return role === 'cube'
        ? '\x1b[38;5;99m' // ≈ #7C3AED
        : '\x1b[1;38;5;141m';
    case 'ansi16':
      return role === 'cube'
        ? '\x1b[35m' // magenta
        : '\x1b[1;95m'; // bold bright magenta
    case 'none':
      return '';
  }
}

/** Wrap one line in SGR + RESET (no-op when level is 'none'). */
function colorize(line: string, level: ColorLevel, role: 'cube' | 'wordmark'): string {
  if (level === 'none') return line;
  return `${open(level, role)}${line}${RESET}`;
}

/**
 * Build the full banner string (no trailing newline).
 * Exported for reuse in help headers and tests.
 */
export function renderBanner(): string {
  const level = detectLevel();
  const lines: string[] = [];
  for (const l of CUBE_LINES) lines.push(colorize(l, level, 'cube'));
  lines.push(''); // blank gap between cube and wordmark
  lines.push(colorize(WORDMARK, level, 'wordmark'));
  return lines.join('\n');
}

/** Print the banner to stdout. */
export function printBanner(): void {
  process.stdout.write(renderBanner() + '\n');
}

/**
 * Compact cube as an array of (optionally colored) lines, for embedding inside
 * the rounded welcome box. Each line is independently SGR-wrapped + RESET so it
 * is safe to place next to other content in a box.
 */
export function compactCubeLines(): string[] {
  const level = detectLevel();
  return COMPACT_CUBE_LINES.map((l) => colorize(l, level, 'cube'));
}
