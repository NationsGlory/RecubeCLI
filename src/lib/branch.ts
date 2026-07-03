/**
 * `@me` channel alias — resolves to the caller's personal dev branch
 * (`dev-{handle}`, design §6) via `GET /launcher/{tenant}/branches/me`. Wired
 * into every existing command that accepts `-c/--channel` (draft
 * create/list/publish, promote, core publish/list, versions list) so a dev
 * can target their own branch without knowing/typing its generated name.
 *
 * Deliberately NOT wired into `draft add`/`draft rm` : that CI-critical
 * add-only path is service-token oriented (RECUBE_TOKEN=rcs_…), and the
 * backend explicitly refuses service tokens on personal-branch routes
 * (mutating a live auto-recomposed channel is a deliberate human action) —
 * `@me` there would only ever resolve for an interactive OAuth session, and
 * `draft add` is consumed by other repos' CI pipelines (RecubeCore, etc.), so
 * it's left untouched to avoid any risk to that flow. Use
 * `recube branch overlay add` for personal-branch file drops instead.
 */

import type { RecubeApiClient } from './api.js';

export const ME_ALIAS = '@me';

export class NoPersonalBranchError extends Error {
  constructor(public readonly tenant: string) {
    super(`Aucune branche perso sur '${tenant}'.`);
    this.name = 'NoPersonalBranchError';
  }
}

/**
 * Resolve `@me` → the real branch name (`dev-{handle}`) for `tenant`. Any
 * other channel value passes through untouched (no network call). Throws
 * `NoPersonalBranchError` when the caller has no branch provisioned yet —
 * callers should catch it and surface `noBranchHint(tenant)`.
 */
export async function resolveChannelAlias(
  api: RecubeApiClient,
  tenant: string,
  channel: string
): Promise<string> {
  if (channel !== ME_ALIAS) return channel;
  const branch = await api.getMyBranch(tenant);
  if (!branch) throw new NoPersonalBranchError(tenant);
  return branch.name;
}

/** Standard actionable hint when `@me` can't resolve (no branch provisioned). */
export function noBranchHint(tenant: string): string {
  return (
    `Aucune branche perso sur '${tenant}'.\n  ` +
    `Crée-en une : recube branch create --tenant ${tenant}`
  );
}
