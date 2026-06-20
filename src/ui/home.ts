/**
 * `recube` with no args — the onboarding home screen.
 *
 * Banner + tagline + a focused "getting started" path for a brand-new dev:
 * login (with the right scope), the 3 commands they will use daily, and a doc
 * link. Intentionally short — the exhaustive surface lives in `recube --help`.
 */

import { printBanner } from './banner.js';
import { theme } from './theme.js';

const DOC_URL = 'https://recube.gg/developers';

export function printHome(): void {
  printBanner();
  const t = theme;
  const lines: string[] = [
    '',
    `  ${t.dim('Recube developer CLI')} ${t.dim('—')} ${t.dim('publish game builds with OAuth auth')}`,
    '',
    t.title('  GETTING STARTED'),
    '',
    `  ${t.bullet()} ${t.bold('1. Authenticate')}`,
    `      ${t.command('recube login')}`,
    `      ${t.dim('# need draft staging too:')}`,
    `      ${t.command('recube login --scope "launcher:publish launcher:draft profile:read"')}`,
    '',
    `  ${t.bullet()} ${t.bold('2. Check your environment')}`,
    `      ${t.command('recube doctor')}            ${t.dim('# node, auth, network, tenants')}`,
    `      ${t.command('recube whoami')}            ${t.dim('# current identity + scopes')}`,
    '',
    `  ${t.bullet()} ${t.bold('3. Publish a build')}`,
    `      ${t.command('recube publish -t nationsglory -c stable -V 1.0.0 -d ./build')}`,
    `      ${t.dim('# or run it interactively:')}`,
    `      ${t.command('recube publish')}`,
    '',
    `  ${t.bullet()} ${t.bold('4. Iterate with mutable drafts')}`,
    `      ${t.command('recube draft create -t nationsglory -c beta -V 1.0.1')}`,
    `      ${t.command('recube draft add ./mods/my-mod.jar')}`,
    `      ${t.command('recube draft publish -r my-ref -n "changelog"')}`,
    '',
    t.title('  NEXT'),
    `  ${t.arrow()} ${t.dim('Full command list:')}   ${t.command('recube --help')}`,
    `  ${t.arrow()} ${t.dim('Shell completion:')}    ${t.command('recube completion bash|zsh|fish')}`,
    `  ${t.arrow()} ${t.dim('Docs:')}                ${t.value(DOC_URL)}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}
