/**
 * Banner color-tier detection + completion script generation.
 *
 * Banner: we manipulate env + a fake TTY flag and assert the emitted SGR
 * sequence matches the documented tier (truecolor / 256 / 16 / none).
 * Completion: assert each shell script contains the command vocabulary and the
 * install instructions, and is non-empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completionScript, SHELLS } from '../src/ui/completion.js';

describe('completion scripts', () => {
  for (const shell of SHELLS) {
    it(`generates a non-empty ${shell} script with install hint`, () => {
      const out = completionScript(shell);
      expect(out.length).toBeGreaterThan(50);
      expect(out.toLowerCase()).toContain('install');
      // Mentions the top-level commands.
      expect(out).toContain('login');
      expect(out).toContain('publish');
      expect(out).toContain('draft');
    });
  }

  it('bash script registers the complete function', () => {
    expect(completionScript('bash')).toContain('complete -F _recube_completion recube');
  });

  it('zsh script has the #compdef directive', () => {
    expect(completionScript('zsh')).toMatch(/^#compdef recube/);
  });

  it('fish script uses complete -c recube', () => {
    expect(completionScript('fish')).toContain('complete -c recube');
  });
});

describe('banner color tiers', () => {
  const origEnv = { ...process.env };
  const origIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...origEnv };
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
  });

  function setEnv(env: Record<string, string | undefined>, isTTY: boolean): void {
    for (const k of ['NO_COLOR', 'FORCE_COLOR', 'COLORTERM', 'COLORTYPE', 'TERM']) {
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  }

  async function render(): Promise<string> {
    // renderBanner() reads env + isTTY at call-time, so a single import is fine;
    // resetModules() in beforeEach keeps each case isolated regardless.
    const mod = await import('../src/ui/banner.js');
    return mod.renderBanner();
  }

  it('emits truecolor SGR when COLORTERM=truecolor on a TTY', async () => {
    setEnv({ COLORTERM: 'truecolor' }, true);
    const out = await render();
    expect(out).toContain('\x1b[38;2;124;58;237m'); // cube #7C3AED
    expect(out).toContain('\x1b[1;38;2;167;139;250m'); // wordmark #A78BFA
  });

  it('emits 256-color SGR for *-256color terminals', async () => {
    setEnv({ TERM: 'xterm-256color' }, true);
    const out = await render();
    expect(out).toContain('\x1b[38;5;99m');
    expect(out).toContain('\x1b[1;38;5;141m');
  });

  it('emits 16-color magenta for a basic TTY', async () => {
    setEnv({ TERM: 'xterm' }, true);
    const out = await render();
    expect(out).toContain('\x1b[35m');
    expect(out).toContain('\x1b[1;95m');
  });

  it('emits NO ansi when NO_COLOR is set', async () => {
    setEnv({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true);
    const out = await render();
    expect(out).not.toContain('\x1b[');
    expect(out).toContain('recube');
  });

  it('emits NO ansi when stdout is not a TTY (pipe/CI)', async () => {
    setEnv({ COLORTERM: 'truecolor', TERM: 'xterm-256color' }, false);
    const out = await render();
    expect(out).not.toContain('\x1b[');
  });
});
