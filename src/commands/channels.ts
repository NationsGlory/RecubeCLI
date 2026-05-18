/**
 * `recube channels list <tenant>` and `recube channels create <tenant>`.
 *
 * Note : `/v1/launcher/channels` is launcher-wide (refactor 2026-05-16) — not
 * per-tenant in the URL. The tenant argument is used only as a UX hint and to
 * filter the list client-side if the API ever scopes channels per tenant.
 */

import { getAuthenticatedSession, NotLoggedInError } from '../auth/session.js';
import { ui, chalk } from '../lib/ui.js';
import type { Channel } from '../types.js';

export async function channelsListCommand(tenant: string): Promise<void> {
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

  // Prefer the per-tenant "branches" endpoint (returns channels + latest version).
  // Fallback to /launcher/channels if the tenant endpoint is empty.
  let channels = await session.api.listChannelsForTenant(tenant);
  if (channels.length === 0) {
    channels = await session.api.listChannels();
  }

  if (channels.length === 0) {
    ui.log.info(
      `Aucun channel pour ${chalk.bold(tenant)}.\nCrée-en un avec ${chalk.cyan('recube channels create ' + tenant)}.`
    );
    return;
  }

  const rows = channels.map(formatChannelRow);
  const header = `${'name'.padEnd(20)} ${'label'.padEnd(24)} ${'public'.padEnd(8)} ${'versions'.padEnd(8)}`;
  ui.note([chalk.dim(header), ...rows].join('\n'), `channels (${tenant})`);
}

export async function channelsCreateCommand(tenant: string): Promise<void> {
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

  ui.intro(`channels create — ${tenant}`);

  const name = await ui.text({
    message: 'name (slug, ex: stable, beta, nightly)',
    validate: (v) => (!/^[a-z0-9-]+$/.test(v) ? 'lowercase + digits + dashes only' : undefined),
  });
  const label = await ui.text({
    message: 'label (display name)',
    placeholder: 'ex: Stable',
  });
  const description = await ui.text({
    message: 'description (optional)',
    placeholder: '(vide pour skip)',
  });
  const isPublic = await ui.confirm({
    message: 'public (visible aux users non-staff) ?',
    initialValue: true,
  });

  const spin = ui.spinner();
  spin.start('Création...');
  try {
    const created = await session.api.createChannel({
      name,
      label: label || undefined,
      description: description || undefined,
      is_public: isPublic,
    });
    spin.stop('Channel créé.');
    ui.outro(`${chalk.green('OK')} ${created.name} (id=${created.id})`);
  } catch (err) {
    spin.stop('Échec.');
    ui.cancel((err as Error).message);
  }
}

function formatChannelRow(c: Channel): string {
  const name = (c.name ?? '').padEnd(20);
  const label = (c.label ?? '').padEnd(24);
  const pub = (c.is_public ? 'yes' : 'no').padEnd(8);
  const versions = String(c.versions_count ?? '-').padEnd(8);
  return `${name} ${label} ${pub} ${versions}`;
}
