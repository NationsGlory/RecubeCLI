/**
 * `recube draft publish` — contrat ASYNC (backend RecubeGG 2026-07-08).
 *
 * Le POST /drafts/{id}/publish ne renvoie PLUS le résultat final (ex-201
 * synchrone avec `finalized_build`/`promoted`) : il rend 202 `{queued:true}`
 * dès le claim (open->finalizing), puis le vrai travail tourne dans
 * FinalizeDraftBuildJob. La commande doit :
 *   - POST 202 → poller GET /drafts/{id} jusqu'à `published` (succès) ou
 *     `open` + `finalize_error` (échec), avec timeout.
 *   - n'effacer le pointeur local `.recube/draft.json` QUE sur `published`.
 *   - sur `finalize_error` : NE PAS effacer le pointeur (draft réutilisable).
 *   - POST 503 `dispatch_failed` : message clair, AUCUN poll démarré.
 *
 * Poll instantané en test via RECUBE_DRAFT_POLL_INTERVAL_MS=0.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../src/lib/api.js';

const h = vi.hoisted(() => ({
  getDraft: vi.fn(),
  draftPublish: vi.fn(async () => ({ id: 'd1', status: 'finalizing', queued: true })),
  loadDraftState: vi.fn(async () => ({ tenant: 'ng', channel: 'beta', draftId: 'd1', version: '1.0.0' })),
  clearDraftState: vi.fn(async () => {}),
  saveDraftState: vi.fn(async () => {}),
}));

vi.mock('../src/auth/session.js', () => ({
  getAuthenticatedSession: vi.fn(async () => ({
    api: { getDraft: h.getDraft, draftPublish: h.draftPublish },
    serviceToken: false,
  })),
  NotLoggedInError: class NotLoggedInError extends Error {},
}));

vi.mock('../src/auth/store.js', () => ({
  getStoredUser: vi.fn(async () => ({ handle: 'tester' })),
}));

vi.mock('../src/lib/draft-state.js', () => ({
  loadDraftState: h.loadDraftState,
  clearDraftState: h.clearDraftState,
  saveDraftState: h.saveDraftState,
  draftStatePath: () => '/tmp/.recube/draft.json',
}));

const { draftPublishCommand } = await import('../src/commands/draft.js');

const TARGET = { tenant: 'ng', channel: 'beta', draft: 'd1', note: 'changelog de test' };

beforeEach(() => {
  process.env.RECUBE_DRAFT_POLL_INTERVAL_MS = '0';
  h.getDraft.mockReset();
  h.draftPublish.mockClear();
  h.clearDraftState.mockClear();
  // Garde-fou : un fail() → process.exit(1) tuerait le worker vitest.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

describe('draftPublishCommand — publish async (POST 202 + poll)', () => {
  it('POST 202 → poll finalizing→published : succès + efface le pointeur local', async () => {
    h.getDraft
      // 1) résolution de la cible (resolveDraftTarget, draft explicite)
      .mockResolvedValueOnce({ id: 'd1', status: 'open', version_tag: '1.0.0' })
      // 2) poll #1 : encore en cours
      .mockResolvedValueOnce({ id: 'd1', status: 'finalizing', version_tag: '1.0.0' })
      // 3) poll #2 : publié
      .mockResolvedValue({
        id: 'd1',
        status: 'published',
        version_tag: '1.0.0',
        finalized_build_id: 'build-42',
        resolved_file_count: 3,
      });

    await draftPublishCommand({ ...TARGET, promote: false });

    // Le POST a bien été fait (sans promote), et on a poll jusqu'à published.
    expect(h.draftPublish).toHaveBeenCalledTimes(1);
    expect(h.draftPublish).toHaveBeenCalledWith(
      'ng',
      'beta',
      'd1',
      expect.objectContaining({ note: 'changelog de test' })
    );
    expect(h.draftPublish.mock.calls[0][3]).not.toHaveProperty('promote');
    // 1 resolve + 2 poll = 3 GET.
    expect(h.getDraft).toHaveBeenCalledTimes(3);
    // Pointeur effacé UNIQUEMENT sur published confirmé.
    expect(h.clearDraftState).toHaveBeenCalledTimes(1);
  });

  it('POST 202 → poll open+finalize_error : échec propre, pointeur PRÉSERVÉ', async () => {
    h.getDraft
      .mockResolvedValueOnce({ id: 'd1', status: 'open', version_tag: '1.0.0' })
      .mockResolvedValueOnce({ id: 'd1', status: 'finalizing', version_tag: '1.0.0' })
      .mockResolvedValue({
        id: 'd1',
        status: 'open',
        version_tag: '1.0.0',
        finalize_error: 'missing_recube_core: recube-core.jar absent',
      });

    // Échec de finalisation → fail() → process.exit(1).
    await expect(draftPublishCommand({ ...TARGET })).rejects.toThrow(/process\.exit/);

    expect(h.draftPublish).toHaveBeenCalledTimes(1);
    // Le pointeur local N'EST PAS effacé : le draft reste réutilisable.
    expect(h.clearDraftState).not.toHaveBeenCalled();
  });

  it('POST 503 dispatch_failed : message clair, AUCUN poll démarré', async () => {
    // Seule la résolution de la cible touche getDraft ; le POST échoue ensuite.
    h.getDraft.mockResolvedValueOnce({ id: 'd1', status: 'open', version_tag: '1.0.0' });
    h.draftPublish.mockRejectedValueOnce(
      new ApiError('503 Service Unavailable', 503, JSON.stringify({ error: 'dispatch_failed', message: 'queue down' }))
    );

    await expect(draftPublishCommand({ ...TARGET })).rejects.toThrow(/process\.exit/);

    // getDraft appelé UNE seule fois (résolution cible) — le poll n'a pas démarré.
    expect(h.getDraft).toHaveBeenCalledTimes(1);
    expect(h.draftPublish).toHaveBeenCalledTimes(1);
    expect(h.clearDraftState).not.toHaveBeenCalled();
  });
});
