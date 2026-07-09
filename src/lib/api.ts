/**
 * Thin REST client for the Recube API.
 *
 * Wraps endpoints discovered in routes/api.php :
 *   - GET  /v1/me                                  → whoami
 *   - GET  /v1/games                               → tenant list
 *   - GET  /v1/games/{slug}                        → tenant detail
 *   - GET  /v1/games/{slug}/branches               → channel list (legacy name "branches")
 *   - GET  /v1/launcher/channels                   → launcher channels (refactor 2026-05-16)
 *   - POST /v1/launcher/channels                   → create channel
 *   - POST /v1/launcher/{tenant}/{channel}/builds/{initiate,commit}
 *   - POST /v1/launcher/{tenant}/branches/me/merge          → merge caller's personal branch onto a target channel
 *   - POST /v1/launcher/{tenant}/channels/{source}/merge    → merge an arbitrary derived channel onto a target channel
 *
 * The client refuses to send a request without an explicit auth token — the
 * higher-level commands are responsible for refreshing tokens before calling.
 */

import type {
  BranchMergeResult,
  BranchOverlayInitiateSlot,
  BranchOverlayPutResult,
  Channel,
  Draft,
  DraftDiff,
  DraftFilesFlatResult,
  DraftInitiateSlot,
  DraftPublishResult,
  Game,
  PersonalBranch,
  PromoteResult,
  UserProfile,
  Version,
} from '../types.js';

export interface ApiClientOptions {
  apiBase: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class RecubeApiClient {
  constructor(private readonly opts: ApiClientOptions) {
    if (!opts.token) throw new Error('RecubeApiClient: token required');
  }

  // ── Identity ───────────────────────────────────────────────────────
  async whoami(): Promise<UserProfile> {
    const data = await this.get<{ data?: UserProfile } & UserProfile>('/me');
    // Laravel resource conventions return `{ data: {...} }` ; tolerate flat too.
    return (data.data ?? data) as UserProfile;
  }

  // ── Games / tenants ────────────────────────────────────────────────
  async listGames(): Promise<Game[]> {
    const data = await this.get<{ data?: Game[] } | Game[]>('/games');
    if (Array.isArray(data)) return data;
    return data.data ?? [];
  }

  async showGame(slug: string): Promise<Game | null> {
    try {
      const data = await this.get<{ data?: Game } & Game>(`/games/${encodeURIComponent(slug)}`);
      return (data.data ?? data) as Game;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  // ── Channels (launcher-level, refactor 2026-05-16) ────────────────
  async listChannels(): Promise<Channel[]> {
    const data = await this.get<{ data?: Channel[] } | Channel[]>('/launcher/channels');
    if (Array.isArray(data)) return data;
    return data.data ?? [];
  }

  async createChannel(payload: {
    name: string;
    label?: string;
    description?: string;
    is_public?: boolean;
  }): Promise<Channel> {
    const data = await this.post<{ data?: Channel } & Channel>('/launcher/channels', payload);
    return (data.data ?? data) as Channel;
  }

  // ── Drafts (mutable build staging) ────────────────────────────────
  // Base path: /launcher/{tenant}/{channel}/drafts. All return Laravel
  // resource envelopes `{ data: ... }` — we unwrap to the inner payload.
  private draftsBase(tenant: string, channel: string): string {
    return `/launcher/${encodeURIComponent(tenant)}/${encodeURIComponent(channel)}/drafts`;
  }

  async createDraft(
    tenant: string,
    channel: string,
    payload: { version_tag?: string; base_build_id?: string }
  ): Promise<Draft> {
    const d = await this.post<{ data?: Draft } & Draft>(this.draftsBase(tenant, channel), payload);
    return (d.data ?? d) as Draft;
  }

  async listDrafts(tenant: string, channel: string): Promise<Draft[]> {
    const d = await this.get<{ data?: Draft[] } | Draft[]>(this.draftsBase(tenant, channel));
    return Array.isArray(d) ? d : d.data ?? [];
  }

  async getDraft(tenant: string, channel: string, draftId: string): Promise<Draft> {
    const d = await this.get<{ data?: Draft } & Draft>(
      `${this.draftsBase(tenant, channel)}/${encodeURIComponent(draftId)}`
    );
    return (d.data ?? d) as Draft;
  }

  async draftFileInitiate(
    tenant: string,
    channel: string,
    draftId: string,
    payload: { path: string; sha256: string; size: number }
  ): Promise<DraftInitiateSlot> {
    const d = await this.post<{ data?: DraftInitiateSlot } & DraftInitiateSlot>(
      `${this.draftsBase(tenant, channel)}/${encodeURIComponent(draftId)}/files/initiate`,
      payload
    );
    return (d.data ?? d) as DraftInitiateSlot;
  }

  async draftFileCommit(
    tenant: string,
    channel: string,
    draftId: string,
    payload: { path: string; sha256: string; size: number; exec?: boolean; encrypted?: boolean }
  ): Promise<{ action?: string; [k: string]: unknown }> {
    const d = await this.post<{ data?: Record<string, unknown> } & Record<string, unknown>>(
      `${this.draftsBase(tenant, channel)}/${encodeURIComponent(draftId)}/files`,
      payload
    );
    return (d.data ?? d) as { action?: string; [k: string]: unknown };
  }

  async draftFileRemove(
    tenant: string,
    channel: string,
    draftId: string,
    pathToRemove: string
  ): Promise<{ [k: string]: unknown }> {
    const d = await this.del<{ data?: Record<string, unknown> } & Record<string, unknown>>(
      `${this.draftsBase(tenant, channel)}/${encodeURIComponent(draftId)}/files`,
      { path: pathToRemove }
    );
    return (d?.data ?? d ?? {}) as { [k: string]: unknown };
  }

  async draftDiff(tenant: string, channel: string, draftId: string): Promise<DraftDiff> {
    const d = await this.get<{ data?: DraftDiff } & DraftDiff>(
      `${this.draftsBase(tenant, channel)}/${encodeURIComponent(draftId)}/diff`
    );
    return (d.data ?? d) as DraftDiff;
  }

  /**
   * Liste PLATE paginée du build résolu du draft (base ⊕ overlay) — `?flat=1`
   * (cf. RecubeGG DraftBuildsController::listFiles). `overlayOnly` (défaut
   * true) filtre aux seuls fichiers ajoutés/remplacés/retirés PAR CE draft
   * (masque les ~2849 fichiers hérités du base jamais touchés) — sinon `recube
   * draft files` listait TOUT le build résolu au lieu du contenu du draft
   * (bug rapporté 2026-07-08). Sert `recube draft files`. Le CLI pagine
   * lui-même si `total_pages > 1`.
   */
  async draftFilesFlat(
    tenant: string,
    channel: string,
    draftId: string,
    page: number = 1,
    perPage: number = 200,
    overlayOnly: boolean = true
  ): Promise<DraftFilesFlatResult> {
    const d = await this.get<{ data?: DraftFilesFlatResult } & DraftFilesFlatResult>(
      `${this.draftsBase(tenant, channel)}/${encodeURIComponent(draftId)}/files?flat=1&page=${page}&per_page=${perPage}&overlay_only=${overlayOnly ? 1 : 0}`
    );
    return (d.data ?? d) as DraftFilesFlatResult;
  }

  /**
   * ASYNC (2026-07-08) : renvoie 202 `{data: {...draftPayload, queued: true}}`
   * dès que le draft est réclamé (open->finalizing) ; le résultat final se lit
   * en pollant `getDraft` (status `published` + `finalized_build_id`, ou `open`
   * + `finalize_error`). Peut throw ApiError 503 (`dispatch_failed`) ou 403
   * (`promote_required_for_derived_channel`) AVANT tout poll.
   */
  async draftPublish(
    tenant: string,
    channel: string,
    draftId: string,
    payload: { reference: string; note: string; promote?: boolean }
  ): Promise<DraftPublishResult> {
    const d = await this.post<{ data?: DraftPublishResult } & DraftPublishResult>(
      `${this.draftsBase(tenant, channel)}/${encodeURIComponent(draftId)}/publish`,
      payload
    );
    return (d.data ?? d) as DraftPublishResult;
  }

  async draftAbandon(
    tenant: string,
    channel: string,
    draftId: string
  ): Promise<{ status?: string; deleted_objects?: number; [k: string]: unknown }> {
    const d = await this.del<{ data?: Record<string, unknown> } & Record<string, unknown>>(
      `${this.draftsBase(tenant, channel)}/${encodeURIComponent(draftId)}`
    );
    return (d?.data ?? d ?? {}) as {
      status?: string;
      deleted_objects?: number;
      [k: string]: unknown;
    };
  }

  // ── recube-core (anti-cheat agent) ────────────────────────────────
  // Publish a recube-core build to a launcher channel and read the current
  // latest. Base path mirrors the launcher draft routes :
  //   POST /launcher/{tenant}/{channel}/core/publish
  //   GET  /launcher/{tenant}/{channel}/recube-core/latest
  // The publish accepts either a multipart upload (--file) or a JSON body
  // referencing an already-hosted R2 object by RELATIVE KEY ({url, sha256,
  // version}, where `url` is a relative R2 key, not an absolute URL).
  private launcherBase(tenant: string, channel: string): string {
    return `/launcher/${encodeURIComponent(tenant)}/${encodeURIComponent(channel)}`;
  }

  /**
   * recube-core publish is ISO PER TENANT (2026-07-08) : the server writes ONE
   * canonical tenant-wide key and ignores the `{channel}` route segment for
   * storage. `corePublishByUrl`/`corePublishFile` therefore do NOT take a
   * `channel` parameter — they always target this fixed segment, so callers
   * can't accidentally publish to a real branch. `core list` (`coreLatest`)
   * is unaffected and keeps a real `channel` argument.
   */
  private static readonly CORE_PUBLISH_CHANNEL = 'tenant-wide';

  /**
   * Publish a recube-core build by referencing an object ALREADY HOSTED in R2,
   * passed as a RELATIVE R2 KEY (e.g. `recube-core/0.4.0.jar`). The server does
   * NOT fetch the URL and does NOT re-verify the sha256 against fetched bytes —
   * it rejects absolute URLs and only accepts relative keys. The provided
   * sha256 must match what was registered for that hash (allowlist gate). To
   * publish a LOCAL jar (server computes/checks the hash for you), use --file
   * (corePublishFile) instead. Service tokens (rcs_) are allowed here — this is
   * the CI path.
   */
  async corePublishByUrl(
    tenant: string,
    payload: { version: string; url: string; sha256: string }
  ): Promise<{ [k: string]: unknown }> {
    const d = await this.post<{ data?: Record<string, unknown> } & Record<string, unknown>>(
      `${this.launcherBase(tenant, RecubeApiClient.CORE_PUBLISH_CHANNEL)}/core/publish`,
      payload
    );
    return (d?.data ?? d ?? {}) as { [k: string]: unknown };
  }

  /**
   * Publish a recube-core build by streaming the jar as multipart/form-data.
   * Fields : `version` + `file` (the jar). The server computes/stores the
   * sha256. Uses an undici-compatible FormData + ReadableStream body.
   */
  async corePublishFile(
    tenant: string,
    payload: { version: string; filePath: string; fileName?: string; sha256?: string }
  ): Promise<{ [k: string]: unknown }> {
    const { createReadStream } = await import('node:fs');
    const { stat } = await import('node:fs/promises');
    const nodePath = (await import('node:path')).default;

    const fstat = await stat(payload.filePath);
    const fileName = payload.fileName ?? nodePath.basename(payload.filePath);

    const form = new FormData();
    form.set('version', payload.version);
    if (payload.sha256) form.set('sha256', payload.sha256);
    // Wrap the read stream as a Blob-like via undici File from a stream is not
    // portable ; read into a Blob keeps it simple and the core jar is small.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(payload.filePath);
      rs.on('data', (c: string | Buffer) => {
        chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
      });
      rs.on('end', () => resolve());
      rs.on('error', reject);
    });
    const blob = new Blob([Buffer.concat(chunks)], { type: 'application/java-archive' });
    form.set('file', blob, fileName);

    const res = await fetch(
      this.url(`${this.launcherBase(tenant, RecubeApiClient.CORE_PUBLISH_CHANNEL)}/core/publish`),
      {
        method: 'POST',
        // NB: do NOT set Content-Type — fetch derives the multipart boundary.
        headers: this.headers(),
        body: form,
      }
    );
    const out = await this.parse<{ data?: Record<string, unknown> } & Record<string, unknown>>(
      res
    );
    void fstat; // size available if the server ever wants it; kept for clarity
    return (out?.data ?? out ?? {}) as { [k: string]: unknown };
  }

  /**
   * Current recube-core for a channel. Returns null on 204 (none published).
   */
  async coreLatest(
    tenant: string,
    channel: string
  ): Promise<{ version?: string; sha256?: string; url?: string; [k: string]: unknown } | null> {
    const res = await fetch(
      this.url(`${this.launcherBase(tenant, channel)}/recube-core/latest`),
      { method: 'GET', headers: this.headers() }
    );
    if (res.status === 204) return null;
    const d = await this.parse<{ data?: Record<string, unknown> } & Record<string, unknown>>(
      res
    );
    const inner = (d?.data ?? d ?? null) as Record<string, unknown> | null;
    if (!inner || Object.keys(inner).length === 0) return null;
    return inner as { version?: string; sha256?: string; url?: string; [k: string]: unknown };
  }

  // ── Promote (dormant build → live) ────────────────────────────────
  /**
   * Met en ligne un build DÉJÀ publié (dormant → live) :
   *   POST /launcher/{tenant}/{channel}/promote/{buildId}   (body vide)
   * Endpoint séparé du publish — perm-gated (scope launcher:promote +
   * perm launcher.{tenant}.promote). Un token publish-only reçoit 403 ici.
   */
  async promote(tenant: string, channel: string, buildId: string): Promise<PromoteResult> {
    const d = await this.post<{ data?: PromoteResult } & PromoteResult>(
      `${this.launcherBase(tenant, channel)}/promote/${encodeURIComponent(buildId)}`,
      {}
    );
    return (d.data ?? d) as PromoteResult;
  }

  // ── Personal branches (dev-{handle}, base ⊕ overlay) ──────────────
  // Base path : /launcher/{tenant}/branches. Server never accepts a service
  // token here (mutating a live auto-recomposed channel is a deliberate
  // human action) — callers should refuse RECUBE_TOKEN sessions before use.
  private branchesBase(tenant: string): string {
    return `/launcher/${encodeURIComponent(tenant)}/branches`;
  }

  /**
   * Provision (idempotent) the caller's personal branch. Body : { base? }
   * (server default : `stable`). The response body never carries a
   * `created` flag — the ONLY signal is the HTTP status (201 = just
   * created, 200 = already existed) — so this reads `res.status` directly
   * instead of going through the generic `post<T>()` helper.
   */
  async provisionBranch(
    tenant: string,
    payload: { base?: string }
  ): Promise<{ branch: PersonalBranch; created: boolean }> {
    const res = await fetch(this.url(this.branchesBase(tenant)), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const d = await this.parse<{ data?: PersonalBranch } & PersonalBranch>(res);
    return { branch: (d.data ?? d) as PersonalBranch, created: res.status === 201 };
  }

  /** GET /branches/me — the caller's personal branch, or null if not provisioned (404). */
  async getMyBranch(tenant: string): Promise<PersonalBranch | null> {
    try {
      const d = await this.get<{ data?: PersonalBranch } & PersonalBranch>(
        `${this.branchesBase(tenant)}/me`
      );
      return (d.data ?? d) as PersonalBranch;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** POST /branches/me/overlay/initiate — presigned PUT for an overlay blob. */
  async initiateBranchOverlay(
    tenant: string,
    payload: { path: string; sha256: string; size: number }
  ): Promise<BranchOverlayInitiateSlot> {
    const d = await this.post<{ data?: BranchOverlayInitiateSlot } & BranchOverlayInitiateSlot>(
      `${this.branchesBase(tenant)}/me/overlay/initiate`,
      payload
    );
    return (d.data ?? d) as BranchOverlayInitiateSlot;
  }

  /** POST /branches/me/overlay — commit an add/replace after the R2 upload. */
  async putBranchOverlay(
    tenant: string,
    payload: { path: string; sha256: string; size: number; exec?: boolean; encrypted?: boolean }
  ): Promise<BranchOverlayPutResult> {
    const d = await this.post<{ data?: BranchOverlayPutResult } & BranchOverlayPutResult>(
      `${this.branchesBase(tenant)}/me/overlay`,
      payload
    );
    return (d.data ?? d) as BranchOverlayPutResult;
  }

  /** DELETE /branches/me/overlay — remove a path (works even on base-inherited files). */
  async removeBranchOverlay(tenant: string, targetPath: string): Promise<BranchOverlayPutResult> {
    const d = await this.del<{ data?: BranchOverlayPutResult } & BranchOverlayPutResult>(
      `${this.branchesBase(tenant)}/me/overlay`,
      { path: targetPath }
    );
    return (d?.data ?? d) as BranchOverlayPutResult;
  }

  /**
   * POST /branches/me/merge — merge the caller's overlay onto a shared
   * channel (`into`). Gated server-side on the PROMOTE permission of the
   * TARGET (not the branch). `version` optional — server auto-bumps patch
   * when omitted.
   */
  async mergeBranch(
    tenant: string,
    payload: { into: string; version?: string }
  ): Promise<BranchMergeResult> {
    const d = await this.post<{ data?: BranchMergeResult } & BranchMergeResult>(
      `${this.branchesBase(tenant)}/me/merge`,
      payload
    );
    return (d.data ?? d) as BranchMergeResult;
  }

  /**
   * POST /launcher/{tenant}/channels/{source}/merge — merge an arbitrary
   * DERIVED channel (`source`) onto a shared target channel (`into`).
   * Generalization of `mergeBranch` (which is hardwired to the caller's own
   * personal branch via `/branches/me/merge`) : this works for ANY derived
   * channel the caller has read-entitlement on, not just `@me`. Gated
   * server-side on the PROMOTE permission of the TARGET (not the source) —
   * same anti-escalade barrier as `mergeBranch`/`promote`. `version` is
   * optional — server auto-bumps patch when omitted.
   */
  async mergeChannel(
    tenant: string,
    source: string,
    payload: { into: string; version?: string }
  ): Promise<BranchMergeResult> {
    const d = await this.post<{ data?: BranchMergeResult } & BranchMergeResult>(
      `/launcher/${encodeURIComponent(tenant)}/channels/${encodeURIComponent(source)}/merge`,
      payload
    );
    return (d.data ?? d) as BranchMergeResult;
  }

  // ── Versions (per tenant/channel) ─────────────────────────────────
  // Laravel exposes /v1/games/{slug}/branches → returns branches with latest
  // version. Tolerate either shape ; if API changes, adjust here only.
  async listChannelsForTenant(slug: string): Promise<Channel[]> {
    try {
      const data = await this.get<{ data?: Channel[] } | Channel[]>(
        `/games/${encodeURIComponent(slug)}/branches`
      );
      const list = Array.isArray(data) ? data : data.data ?? [];
      // shape: { name, label, latest_version, ... } — keep as-is, caller adapts
      return list as Channel[];
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return [];
      throw err;
    }
  }

  /**
   * Strategy (most-specific → most-generic) :
   *   1. Admin endpoint `/admin/games/{slug}/versions` (requires admin scope).
   *   2. Public per-branch history `/games/{slug}/branches/{branch}/versions`
   *      (if the backend exposes it ; some tenants do, some don't).
   *   3. Fallback : `listChannelsForTenant` and synthesize a single
   *      `(latest)` row per channel with `latest_version` if exposed.
   *
   * `adminDenied` is set when step 1 returned 401/403 so callers can hint the
   * user that listing full version history requires admin permissions.
   */
  async listVersions(
    slug: string,
    channel?: string
  ): Promise<{ versions: Version[]; adminDenied: boolean }> {
    let adminDenied = false;
    try {
      const url = `/admin/games/${encodeURIComponent(slug)}/versions${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`;
      const data = await this.get<{ data?: Version[] } | Version[]>(url);
      const list = Array.isArray(data) ? data : data.data ?? [];
      return { versions: list, adminDenied: false };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 401 || err.status === 403) adminDenied = true;
      else if (err.status !== 404) throw err;
    }

    if (channel) {
      try {
        const url = `/games/${encodeURIComponent(slug)}/branches/${encodeURIComponent(channel)}/versions`;
        const data = await this.get<{ data?: Version[] } | Version[]>(url);
        const list = Array.isArray(data) ? data : data.data ?? [];
        if (list.length > 0) return { versions: list, adminDenied };
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.status !== 404 && err.status !== 401 && err.status !== 403) throw err;
      }
    }

    const branches = await this.listChannelsForTenant(slug);
    const filtered = channel ? branches.filter((b) => b.name === channel) : branches;
    const synth: Version[] = filtered
      .map((b) => {
        const latest = (b as unknown as { latest_version?: string | { version?: string } })
          .latest_version;
        const version =
          typeof latest === 'string'
            ? latest
            : typeof latest === 'object' && latest && 'version' in latest
              ? String(latest.version ?? '(latest)')
              : '(latest)';
        return {
          id: String(b.id ?? b.name),
          version,
          channel: b.name,
          // Le listing channels expose la live promotable par channel → on la
          // remonte pour que `recube promote -b <version>` la résolve même en
          // fallback (scope admin refusé). reference/created_at restent absents
          // (non exposés ici) → rendus `-` par buildVersionsTable.
          build_id:
            (b as unknown as { latest_build_id?: string | number | null })
              .latest_build_id ?? null,
        } as Version;
      })
      .filter((v) => v.version);
    return { versions: synth, adminDenied };
  }

  // ── Generic HTTP helpers ──────────────────────────────────────────
  async get<T>(pathname: string): Promise<T> {
    const res = await fetch(this.url(pathname), {
      method: 'GET',
      headers: this.headers(),
    });
    return this.parse<T>(res);
  }

  async post<T>(pathname: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(pathname), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return this.parse<T>(res);
  }

  async put<T>(pathname: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(pathname), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return this.parse<T>(res);
  }

  /**
   * DELETE with an optional JSON body. The draft file-removal endpoint
   * (`DELETE /drafts/{id}/files`) keys the target by a `{path}` body rather
   * than a path segment, so we must support a request body on DELETE.
   */
  async del<T>(pathname: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(pathname), {
      method: 'DELETE',
      headers:
        body === undefined
          ? this.headers()
          : { ...this.headers(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.parse<T>(res);
  }

  private url(pathname: string): string {
    const base = this.opts.apiBase.replace(/\/+$/, '');
    return `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: 'application/json',
      'User-Agent': 'recube-cli',
    };
  }

  private async parse<T>(res: Response): Promise<T> {
    const txt = await res.text();
    if (!res.ok) {
      throw new ApiError(
        `${res.status} ${res.statusText}`,
        res.status,
        txt
      );
    }
    if (!txt) return undefined as unknown as T;
    try {
      return JSON.parse(txt) as T;
    } catch {
      throw new ApiError('Invalid JSON response', res.status, txt);
    }
  }
}
