/**
 * Current-draft tracker — `<cwd>/.recube/draft.json`.
 *
 * A draft is mutable build staging on the backend. The CLI persists the
 * "current" draft pointer (tenant, channel, draftId) PROJECT-LOCALLY so the
 * follow-up commands (`add`/`rm`/`diff`/`status`/`publish`/`abandon`) operate
 * on it without re-specifying --tenant/--channel/--draft each time.
 *
 * Why project-local (cwd) and not the user config dir (~/.recube) : the draft
 * is tied to a build working directory (the mod author runs `recube draft *`
 * from where their jars live), exactly like the existing `.recube/runtime.json`
 * convention. Different repos / build dirs can each track their own draft.
 *
 * File shape : { tenant, channel, draftId, version? }. Written 0600, dir 0700.
 * Cleared on `publish` success and `abandon`.
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DraftState } from '../types.js';

export function draftStateDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.recube');
}

export function draftStatePath(cwd: string = process.cwd()): string {
  return path.join(draftStateDir(cwd), 'draft.json');
}

/** Load the current-draft pointer, or null if none tracked / unreadable. */
export async function loadDraftState(cwd: string = process.cwd()): Promise<DraftState | null> {
  const p = draftStatePath(cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DraftState>;
    if (!parsed.tenant || !parsed.channel || !parsed.draftId) return null;
    return {
      tenant: parsed.tenant,
      channel: parsed.channel,
      draftId: parsed.draftId,
      version: parsed.version,
    };
  } catch {
    return null;
  }
}

/** Persist the current-draft pointer (creates `.recube/` if needed). */
export async function saveDraftState(
  state: DraftState,
  cwd: string = process.cwd()
): Promise<void> {
  const dir = draftStateDir(cwd);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(draftStatePath(cwd), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

/** Remove the current-draft pointer (publish success / abandon). Best-effort. */
export async function clearDraftState(cwd: string = process.cwd()): Promise<void> {
  const p = draftStatePath(cwd);
  if (existsSync(p)) {
    try {
      await unlink(p);
    } catch {
      /* best-effort */
    }
  }
}
