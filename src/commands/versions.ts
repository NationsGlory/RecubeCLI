/**
 * `recube versions list <tenant> [--channel]` — list published versions.
 */

import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { ui, chalk } from '../lib/ui.js';

export async function versionsListCommand(
  tenant: string,
  opts: { channel?: string } = {}
): Promise<void> {
  let session;
  try {
    session = await getAuthenticatedSession();
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      ui.log.warn(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const { versions, adminDenied } = await session.api.listVersions(tenant, opts.channel);
  if (versions.length === 0) {
    if (adminDenied) {
      ui.log.warn(
        `Liste complète des versions = scope admin requis (toi = pas admin).\nFallback public n'a rien retourné. Utilise ${chalk.cyan('recube channels list ' + tenant)} pour voir la dernière version par channel.`
      );
    } else {
      ui.log.info(
        `Aucune version pour ${tenant}${opts.channel ? ` (channel=${opts.channel})` : ''}.`
      );
    }
    return;
  }

  const header = `${'version'.padEnd(16)} ${'channel'.padEnd(12)} ${'reference'.padEnd(32)} ${'created_at'.padEnd(20)}`;
  const rows = versions.map((v) => {
    const ver = String(v.version ?? '').padEnd(16);
    const ch = String(v.channel ?? '').padEnd(12);
    const ref = String(v.reference ?? '').padEnd(32);
    const created = String(v.created_at ?? '').padEnd(20);
    return `${ver} ${ch} ${ref} ${created}`;
  });
  const note = adminDenied
    ? `${chalk.yellow('admin scope denied')} — fallback affiche dernière version par channel uniquement.`
    : '';
  ui.note(
    [chalk.dim(header), ...rows, note].filter(Boolean).join('\n'),
    `versions (${tenant})`
  );
}
