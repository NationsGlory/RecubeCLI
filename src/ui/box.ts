/**
 * Rounded-box renderer — Claude-Code-style welcome / section panels.
 *
 * Draws a rounded-corner border (╭─╮ │ ╰─╯) around content lines, padded with
 * one space of horizontal air. The box auto-sizes to the widest VISIBLE line
 * (ANSI escape sequences are stripped for width math so coloured content still
 * aligns). The border itself is brand-violet via the theme, and degrades to a
 * plain box when color is disabled (NO_COLOR / non-TTY) — chalk handles that.
 *
 * Intentionally minimal: lots of air, no heavy separators, one accent color.
 */

import { theme } from './theme.js';

const RE_ANSI = /\x1b\[[0-9;]*m/g;

/** Visible width of a string, ignoring ANSI SGR sequences. */
export function visibleWidth(s: string): number {
  return s.replace(RE_ANSI, '').length;
}

export interface BoxOptions {
  /** Horizontal padding inside the border (spaces). Default 1. */
  padX?: number;
  /** Minimum inner content width (visible chars). Box grows past it as needed. */
  minWidth?: number;
}

/**
 * Render `lines` inside a rounded border. Lines may contain ANSI color; width
 * is computed on the visible text so alignment stays correct.
 */
export function box(lines: string[], opts: BoxOptions = {}): string {
  const padX = opts.padX ?? 1;
  const inner = Math.max(opts.minWidth ?? 0, ...lines.map(visibleWidth));
  const pad = ' '.repeat(padX);
  const horizontal = '─'.repeat(inner + padX * 2);

  const top = theme.brand(`╭${horizontal}╮`);
  const bottom = theme.brand(`╰${horizontal}╯`);
  const side = theme.brand('│');

  const body = lines.map((l) => {
    const gap = ' '.repeat(inner - visibleWidth(l));
    return `${side}${pad}${l}${gap}${pad}${side}`;
  });

  return [top, ...body, bottom].join('\n');
}
