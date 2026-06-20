/**
 * Thin wrapper around @clack/prompts so commands can keep their flow readable.
 *
 * Centralises intro/outro styling and cancel-handling so we never accidentally
 * crash on Ctrl-C (clack returns a Symbol that must be detected via isCancel).
 */

import * as p from '@clack/prompts';
import chalk from 'chalk';
import { theme } from '../ui/theme.js';

export const ui = {
  intro(title: string): void {
    // Brand-violet pill instead of cyan for a consistent identity.
    p.intro(chalk.bgHex('#7C3AED').white(` ${title} `));
  },
  outro(msg: string): void {
    p.outro(msg);
  },
  note(msg: string, title?: string): void {
    p.note(msg, title);
  },
  log: p.log,
  spinner: p.spinner,
  cancel(msg: string): never {
    p.cancel(msg);
    process.exit(1);
  },
  async text(opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string> {
    const result = await p.text({
      message: opts.message,
      placeholder: opts.placeholder,
      defaultValue: opts.defaultValue,
      validate: opts.validate,
    });
    if (p.isCancel(result)) ui.cancel('Annulé.');
    return String(result);
  },
  async select<T extends string>(opts: {
    message: string;
    options: { value: T; label: string; hint?: string }[];
    initialValue?: T;
  }): Promise<T> {
    // @clack/prompts Option<T> requires the options array to be inferred as
    // Option<Value>[] ; passing a plain object literal loses that branding,
    // so cast through unknown.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (p.select as any)(opts);
    if (p.isCancel(result)) ui.cancel('Annulé.');
    return result as T;
  },
  async confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean> {
    const result = await p.confirm(opts);
    if (p.isCancel(result)) ui.cancel('Annulé.');
    return Boolean(result);
  },
};

export { chalk, theme };
