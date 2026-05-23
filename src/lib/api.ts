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
 *
 * The client refuses to send a request without an explicit auth token — the
 * higher-level commands are responsible for refreshing tokens before calling.
 */

import type { Channel, Game, UserProfile, Version } from '../types.js';

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
