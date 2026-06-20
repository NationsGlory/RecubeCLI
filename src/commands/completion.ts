/**
 * `recube completion <bash|zsh|fish>` — print a shell completion script.
 *
 * Pure stdout: the script (with install instructions as leading comments) is
 * written verbatim so `recube completion bash > file` works cleanly. No ANSI.
 */

import { completionScript, SHELLS, type Shell } from '../ui/completion.js';
import { theme } from '../ui/theme.js';

export function completionCommand(shell?: string): void {
  if (!shell) {
    process.stderr.write(
      `${theme.error('error:')} missing shell argument.\n` +
        `usage: ${theme.command('recube completion <bash|zsh|fish>')}\n`
    );
    process.exitCode = 1;
    return;
  }
  const s = shell.toLowerCase();
  if (!SHELLS.includes(s as Shell)) {
    process.stderr.write(
      `${theme.error('error:')} unsupported shell "${shell}".\n` +
        `supported: ${SHELLS.join(', ')}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(completionScript(s as Shell));
}
