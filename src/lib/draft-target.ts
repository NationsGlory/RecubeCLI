/**
 * Shared draft-target resolution — the single source of truth behind
 * `draft rm/diff/status/publish/use`. Kept PURE (no session, no network of its
 * own, no chalk, no process.exit) so it is trivially unit-testable : the API is
 * a mockable `{getDraft, listDrafts}` surface and the project-local pointer is
 * an injected loader.
 *
 * Resolution order (mirrors what `publish` did inline before this refactor) :
 *   1. `--draft <id>` (+ tenant + channel) → api.getDraft(tenant, channel, id).
 *   2. tenant + channel (no id)            → the single OPEN draft of the pair
 *      via api.listDrafts (0 open → no_open ; >1 open → multi_open + ids).
 *   3. no flags                            → the local `.recube/draft.json`
 *      pointer (loadLocal). Absent → no_current.
 *
 * Anything partial (only one of tenant/channel, or --draft without tenant/
 * channel) is an `incomplete_flags` error. Errors are typed (DraftTargetError
 * with a `code`) so the command layer can decorate them with actionable hints
 * without this module depending on the UI. `@me` channel aliasing is resolved
 * by the CALLER before invoking this helper (it needs the session/api and is
 * orthogonal to draft resolution).
 */

import type { Draft, DraftState } from '../types.js';

/** Minimal API surface needed to resolve a draft target (mockable in tests). */
export interface DraftResolverApi {
  getDraft(tenant: string, channel: string, draftId: string): Promise<Draft>;
  listDrafts(tenant: string, channel: string): Promise<Draft[]>;
}

/** Loader for the project-local current-draft pointer (mockable in tests). */
export type DraftStateLoader = () => Promise<DraftState | null>;

export interface ResolveDraftTargetInput {
  tenant?: string;
  channel?: string;
  /** Explicit draft id (`--draft`). */
  draft?: string;
}

export type DraftTargetErrorCode =
  | 'incomplete_flags' // --draft without -t/-c, or only one of -t/-c
  | 'no_current' // no flags + no local pointer
  | 'no_open' // -t/-c but zero open drafts
  | 'multi_open'; // -t/-c but several open drafts (ambiguous)

/** Typed resolution failure — the command layer maps `code` → an actionable hint. */
export class DraftTargetError extends Error {
  constructor(
    message: string,
    public readonly code: DraftTargetErrorCode
  ) {
    super(message);
    this.name = 'DraftTargetError';
  }
}

/** Draft statuses considered mutable / targetable. */
const OPEN_STATUS = 'open';

/** Trim to a non-empty string, or undefined (blank flags = absent). */
function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * Resolve which draft the caller means, given explicit flags and a local
 * pointer loader. See the module docstring for the resolution order. Throws
 * DraftTargetError (typed) on ambiguity/absence, or bubbles up an ApiError
 * from getDraft/listDrafts (403/404/… handled by the caller).
 */
export async function resolveDraftTarget(
  api: DraftResolverApi,
  input: ResolveDraftTargetInput,
  loadLocal: DraftStateLoader
): Promise<DraftState> {
  const tenant = clean(input.tenant);
  const channel = clean(input.channel);
  const draft = clean(input.draft);

  // 1. Explicit draft id — needs tenant + channel to build the API path.
  if (draft) {
    if (!tenant || !channel) {
      throw new DraftTargetError(
        '--draft <id> nécessite aussi -t <tenant> et -c <channel>.',
        'incomplete_flags'
      );
    }
    const d = await api.getDraft(tenant, channel, draft);
    return {
      tenant,
      channel,
      draftId: String(d.id ?? draft),
      version: d.version_tag,
    };
  }

  // 2. tenant + channel — resolve the single OPEN draft of the pair.
  if (tenant && channel) {
    const drafts = await api.listDrafts(tenant, channel);
    const open = drafts.filter((d) => String(d.status ?? OPEN_STATUS) === OPEN_STATUS);
    if (open.length === 0) {
      throw new DraftTargetError(`Aucun draft en cours pour ${tenant}/${channel}.`, 'no_open');
    }
    if (open.length > 1) {
      const ids = open.map((d) => d.id).join(', ');
      throw new DraftTargetError(
        `Plusieurs drafts ouverts pour ${tenant}/${channel} : ${ids}.\n  ` +
          'Précise lequel avec --draft <id>.',
        'multi_open'
      );
    }
    const d = open[0];
    return { tenant, channel, draftId: String(d.id), version: d.version_tag };
  }

  // Partial flags (only one of -t/-c) — ambiguous, refuse.
  if (tenant || channel) {
    throw new DraftTargetError('Précise -t <tenant> ET -c <channel> ensemble.', 'incomplete_flags');
  }

  // 3. No flags — fall back to the project-local current-draft pointer.
  const st = await loadLocal();
  if (st) return st;
  throw new DraftTargetError('Aucun draft courant.', 'no_current');
}
