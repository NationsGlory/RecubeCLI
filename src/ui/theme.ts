/**
 * Recube CLI — centralised color theme.
 *
 * One source of truth for the brand palette so every command renders with the
 * same visual language (titles violet, success green, errors red, etc.) instead
 * of ad-hoc `chalk.cyan` calls scattered across commands.
 *
 * Color is honoured/suppressed by `chalk` itself, which already respects
 * `NO_COLOR`, `FORCE_COLOR` and non-TTY stdout. We additionally expose
 * {@link colorEnabled} so the ASCII banner (which emits raw SGR sequences, not
 * chalk) can make the same decision.
 *
 * Brand: Recube violet #7C3AED (violet-600). Wordmark / accents lean lighter to
 * #A78BFA (violet-300) for contrast on dark terminals.
 */

import chalk from 'chalk';

/**
 * Whether ANSI color should be emitted. Mirrors chalk's own logic so the
 * hand-rolled banner stays in sync with themed chalk output.
 *
 * Order matters:
 *   1. NO_COLOR set (any non-empty value) → never color (https://no-color.org)
 *   2. FORCE_COLOR set → always color (overrides TTY detection)
 *   3. stdout not a TTY (pipe / redirect / CI) → no color
 *   4. TERM=dumb → no color
 */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (!process.stdout.isTTY) return false;
  if (process.env.TERM === 'dumb') return false;
  return true;
}

// Brand violet. `chalk.hex` degrades gracefully to the nearest supported level
// (256 / 16) and becomes a no-op when color is disabled.
const VIOLET = '#7C3AED';
const VIOLET_LIGHT = '#A78BFA';

/**
 * Semantic palette. Use these instead of raw chalk colors in command code.
 */
export const theme = {
  /** Primary brand accent — section titles, the wordmark, headline emphasis. */
  brand: (s: string): string => chalk.hex(VIOLET)(s),
  /** Lighter brand tint — values, highlighted inline tokens. */
  accent: (s: string): string => chalk.hex(VIOLET_LIGHT)(s),
  /** Section / panel title (bold brand). */
  title: (s: string): string => chalk.bold(chalk.hex(VIOLET)(s)),
  /** A command the user can copy/paste (e.g. `recube login`). */
  command: (s: string): string => chalk.hex(VIOLET_LIGHT)(s),
  /** A value, path, or URL worth highlighting. */
  value: (s: string): string => chalk.cyan(s),
  /** Secondary / muted text (hints, labels, less important detail). */
  dim: (s: string): string => chalk.dim(s),
  /** Success. */
  success: (s: string): string => chalk.green(s),
  /** Error. */
  error: (s: string): string => chalk.red(s),
  /** Warning. */
  warn: (s: string): string => chalk.yellow(s),
  /** Bold passthrough (color-agnostic emphasis). */
  bold: (s: string): string => chalk.bold(s),

  // Status glyphs — reused by doctor / pipelines.
  ok: (): string => chalk.green('✔'),
  cross: (): string => chalk.red('✖'),
  bullet: (): string => chalk.hex(VIOLET_LIGHT)('•'),
  arrow: (): string => chalk.hex(VIOLET_LIGHT)('→'),
};

export { chalk };
