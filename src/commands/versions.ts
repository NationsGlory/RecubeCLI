/**
 * `recube versions list <tenant> [--channel]` — list published versions.
 */

import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { NoPersonalBranchError, noBranchHint, resolveChannelAlias } from '../lib/branch.js';
import { ui, chalk } from '../lib/ui.js';
import type { Version } from '../types.js';

/**
 * Pure formatter for the versions table. The build `id` (UID) leads each row
 * À DESSEIN : c'est la valeur que le dev passe à `recube promote -b <buildId>`.
 * Sans elle, impossible de savoir quel build promouvoir. Renvoie `header` +
 * `rows` séparés pour que l'appelant puisse dimmer le header (chalk) sans
 * polluer la sortie testable.
 */
export function buildVersionsTable(versions: Version[]): { header: string; rows: string[] } {
  const header =
    `${'id'.padEnd(26)} ${'version'.padEnd(14)} ${'channel'.padEnd(10)} ` +
    `${'reference'.padEnd(24)} ${'created_at'.padEnd(20)}`;
  const rows = versions.map((v) => {
    const id = String(v.id ?? '').padEnd(26);
    const ver = String(v.version ?? '').padEnd(14);
    const ch = String(v.channel ?? '').padEnd(10);
    const ref = String(v.reference ?? '').padEnd(24);
    const created = String(v.created_at ?? '').padEnd(20);
    return `${id} ${ver} ${ch} ${ref} ${created}`;
  });
  return { header, rows };
}

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

  // `--channel @me` → la branche perso de l'appelant (dev-{handle}).
  let channel = opts.channel;
  if (channel) {
    try {
      channel = await resolveChannelAlias(session.api, tenant, channel);
    } catch (err) {
      if (err instanceof NoPersonalBranchError) {
        ui.log.warn(noBranchHint(tenant));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  }

  const { versions, adminDenied } = await session.api.listVersions(tenant, channel);
  if (versions.length === 0) {
    if (adminDenied) {
      ui.log.warn(
        `Liste complète des versions = scope admin requis (toi = pas admin).\nFallback public n'a rien retourné. Utilise ${chalk.cyan('recube channels list ' + tenant)} pour voir la dernière version par channel.`
      );
    } else {
      ui.log.info(`Aucune version pour ${tenant}${channel ? ` (channel=${channel})` : ''}.`);
    }
    return;
  }

  const { header, rows } = buildVersionsTable(versions);
  const note = adminDenied
    ? `${chalk.yellow('admin scope denied')} — fallback affiche dernière version par channel uniquement.`
    : '';
  ui.note(
    [chalk.dim(header), ...rows, note].filter(Boolean).join('\n'),
    `versions (${tenant})`
  );
}
