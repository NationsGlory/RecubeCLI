/**
 * Shell completion script generation for `recube`.
 *
 * Approach: hand-rolled static scripts derived from the commander command tree.
 * We deliberately avoid a runtime-callback design (where the shell shells out to
 * `recube --complete ...` on every TAB) — that adds Node startup latency to each
 * keypress and a network-free CLI should complete instantly. Instead we emit a
 * self-contained script that knows the command/subcommand/flag vocabulary.
 *
 * The vocabulary lives in {@link SPEC} below so it stays close to the command
 * definitions in cli.ts. When a command/flag is added there, mirror it here.
 *
 * Supported shells: bash, zsh, fish. `recube completion <shell>` prints the
 * script to stdout plus install instructions (as shell comments) so it survives
 * `recube completion bash > file` cleanly.
 */

export type Shell = 'bash' | 'zsh' | 'fish';

export const SHELLS: Shell[] = ['bash', 'zsh', 'fish'];

interface CmdSpec {
  name: string;
  /** Subcommands (e.g. draft -> create/add/...). */
  sub?: string[];
  /** Long flags for this command (without values). */
  flags?: string[];
}

/** Top-level commands and their flags / subcommands. Mirror of cli.ts. */
const SPEC: CmdSpec[] = [
  { name: 'login', flags: ['--scope', '--force', '--help'] },
  { name: 'logout', flags: ['--help'] },
  { name: 'whoami', flags: ['--help'] },
  {
    name: 'publish',
    flags: [
      '--tenant',
      '--channel',
      '--version-tag',
      '--dir',
      '--note',
      '--reference',
      '--concurrency',
      '--init-batch',
      '--default-excludes',
      '--exclude',
      '--dry-run',
      '--yes',
      '--runtime-config',
      '--no-recube-core',
      '--include',
      '--help',
    ],
  },
  { name: 'channels', sub: ['list', 'create'], flags: ['--help'] },
  { name: 'versions', sub: ['list'], flags: ['--channel', '--help'] },
  {
    name: 'draft',
    sub: ['create', 'list', 'status', 'add', 'rm', 'diff', 'publish', 'abandon'],
    flags: ['--help'],
  },
  { name: 'doctor', flags: ['--dir', '--json', '--help'] },
  { name: 'completion', sub: [...SHELLS], flags: ['--help'] },
  { name: 'help', flags: [] },
];

const TOP_COMMANDS = SPEC.map((c) => c.name).join(' ');
const GLOBAL_FLAGS = '-v --version -h --help';

function subsFor(name: string): string {
  return SPEC.find((c) => c.name === name)?.sub?.join(' ') ?? '';
}
function flagsFor(name: string): string {
  return SPEC.find((c) => c.name === name)?.flags?.join(' ') ?? '';
}

// ── bash ──────────────────────────────────────────────────────────────────
function bashScript(): string {
  // Build per-command case arms for subcommands + flags.
  const subArms = SPEC.filter((c) => c.sub?.length)
    .map((c) => `        ${c.name}) COMPREPLY=( $(compgen -W "${subsFor(c.name)} ${flagsFor(c.name)}" -- "$cur") ); return 0 ;;`)
    .join('\n');
  const flagArms = SPEC.filter((c) => !c.sub?.length && c.flags?.length)
    .map((c) => `        ${c.name}) COMPREPLY=( $(compgen -W "${flagsFor(c.name)}" -- "$cur") ); return 0 ;;`)
    .join('\n');

  return `# recube bash completion
# Install:
#   recube completion bash > ~/.recube-completion.bash
#   echo 'source ~/.recube-completion.bash' >> ~/.bashrc
# Or system-wide:
#   recube completion bash | sudo tee /etc/bash_completion.d/recube > /dev/null
_recube_completion() {
    local cur prev words cword
    _get_comp_words_by_ref -n : cur prev words cword 2>/dev/null || {
        cur="\${COMP_WORDS[COMP_CWORD]}"
        prev="\${COMP_WORDS[COMP_CWORD-1]}"
    }
    local commands="${TOP_COMMANDS}"

    if [ "\$cword" -le 1 ]; then
        COMPREPLY=( \$(compgen -W "\$commands ${GLOBAL_FLAGS}" -- "\$cur") )
        return 0
    fi

    case "\${words[1]}" in
${subArms}
${flagArms}
        *) COMPREPLY=( \$(compgen -W "\$commands" -- "\$cur") ) ;;
    esac
}
complete -F _recube_completion recube
`;
}

// ── zsh ───────────────────────────────────────────────────────────────────
function zshScript(): string {
  const descArms = SPEC.map((c) => `    '${c.name}'`).join('\n');
  const subArms = SPEC.filter((c) => c.sub?.length)
    .map((c) => `            ${c.name}) _values 'subcommand' ${c.sub!.map((s) => `'${s}'`).join(' ')} ;;`)
    .join('\n');

  return `#compdef recube
# recube zsh completion
# Install:
#   recube completion zsh > "\${fpath[1]}/_recube"
#   # then restart your shell (ensure compinit runs)
# Or:
#   recube completion zsh > ~/.recube-completion.zsh
#   echo 'source ~/.recube-completion.zsh' >> ~/.zshrc
_recube() {
    local -a commands
    commands=(
${descArms}
        '-v:print version'
        '--version:print version'
        '-h:help'
        '--help:help'
    )
    if (( CURRENT == 2 )); then
        _describe 'recube command' commands
        return
    fi
    case "\${words[2]}" in
${subArms}
            *) ;;
    esac
}
_recube "\$@"
`;
}

// ── fish ──────────────────────────────────────────────────────────────────
function fishScript(): string {
  const lines: string[] = [
    '# recube fish completion',
    '# Install:',
    '#   recube completion fish > ~/.config/fish/completions/recube.fish',
    '',
    '# Disable file completion by default; commands opt back in as needed.',
    'complete -c recube -f',
    '',
    '# Top-level commands (only when no subcommand seen yet).',
    'function __recube_no_subcommand',
    '    set -l cmd (commandline -opc)',
    '    if test (count $cmd) -eq 1',
    '        return 0',
    '    end',
    '    return 1',
    'end',
    '',
  ];
  for (const c of SPEC) {
    lines.push(`complete -c recube -n '__recube_no_subcommand' -a '${c.name}'`);
  }
  lines.push('', '# Subcommands.');
  for (const c of SPEC.filter((x) => x.sub?.length)) {
    for (const s of c.sub!) {
      lines.push(
        `complete -c recube -n '__fish_seen_subcommand_from ${c.name}' -a '${s}'`
      );
    }
  }
  lines.push('', '# Global flags.');
  lines.push("complete -c recube -l help -d 'Show help'");
  lines.push("complete -c recube -l version -s v -d 'Print version'");
  return lines.join('\n') + '\n';
}

/** Return the completion script for the requested shell. */
export function completionScript(shell: Shell): string {
  switch (shell) {
    case 'bash':
      return bashScript();
    case 'zsh':
      return zshScript();
    case 'fish':
      return fishScript();
  }
}
