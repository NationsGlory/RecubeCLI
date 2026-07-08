/**
 * Shared type definitions for the Recube CLI.
 *
 * Kept dependency-free so tests can import without pulling Node-only modules.
 */

export interface OAuthTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: number; // unix seconds
  token_type: string; // typically "Bearer"
  scope: string;
}

export interface CredentialStorePayload {
  tokens: OAuthTokens;
  user?: UserProfile | null;
  tenant_default?: string | null;
}

export interface UserProfile {
  id: string | number;
  handle?: string;
  email?: string;
  display_name?: string;
  scopes?: string[];
}

export interface RecubeConfig {
  apiBase: string;
  oauthBase: string;
  clientId: string;
  // optional CLI defaults
  tenant?: string;
  channel?: string;
  concurrency?: number;
  initBatch?: number;
}

export interface PublishOptions {
  tenant: string;
  channel: string;
  version: string;
  dir: string;
  includes: { path: string; as?: string }[];
  excludes: string[];
  note: string;
  reference?: string;
  concurrency: number;
  initBatch: number;
  apiBase: string;
  token: string;
  dryRun?: boolean;
  /**
   * JVM launch metadata (main_class, jvm_args, java_version, …). When omitted,
   * the backend inherits from the latest version on same channel.
   */
  runtimeConfig?: Record<string, unknown>;
  onProgress?: (event: PublishProgressEvent) => void;
}

export type PublishProgressEvent =
  | { type: 'scan'; total: number }
  | { type: 'hash'; index: number; total: number; path: string }
  | { type: 'initiate'; batch: number; totalBatches: number; chunk: number }
  | { type: 'upload'; index: number; total: number; path: string }
  | { type: 'commit'; url: string };

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
  /** Absolute filesystem path — never sent to API. */
  _abs: string;
}

export interface InitiateFileSlot {
  action: 'upload' | 'skip';
  upload_url?: string;
  upload_method?: string;
  upload_headers?: Record<string, string>;
}

export interface CommitResult {
  build_id?: string | number;
  manifest_sha256?: string;
  manifest_url?: string;
  version_id?: string | number;
  [k: string]: unknown;
}

export interface Channel {
  id: string | number;
  name: string;
  label?: string;
  is_public?: boolean;
  is_default?: boolean;
  description?: string | null;
  // Versions count may be exposed under different keys — keep loose.
  versions_count?: number;
  // ── Shape variants tolerated by formatChannelRow ─────────────────────
  // Two backend endpoints feed the channel list with DIFFERENT keys :
  //   - GET /launcher/channels (LauncherChannelsController::serializePublic)
  //     → { id, slug, name (display), permission_slug, sort_order, is_default }
  //   - GET /games/{slug}/branches (GameVersionsController::branches)
  //     → { channel, latest_version, permission_slug, tag, tag_color }
  // Neither exposes is_public / versions_count. Public is derived from
  // permission_slug (null/'' = public). These optional fields keep the row
  // formatter type-clean (no `as any`).
  slug?: string;
  channel?: string;
  latest_version?: string;
  tag?: string | null;
  tag_color?: string | null;
  permission_slug?: string | null;
}

export interface Game {
  slug: string;
  name?: string;
  label?: string;
}

export interface Version {
  id: string | number;
  version: string;
  channel?: string;
  reference?: string | null;
  note?: string | null;
  created_at?: string;
  files_count?: number;
  /**
   * Build promotable de cette version (dep backend GG : le listing expose
   * désormais le build_id par version). Consommé par `recube promote -b <tag>`
   * pour résoudre un tag de version → build_id avant le POST promote.
   */
  build_id?: string | number | null;
}

// ── Drafts (mutable build staging, backend commit 0dbfc7f) ───────────────
// A draft is an open, mutable file-set seeded from an optional base build.
// add/rm/diff/publish operate on the draft; publish finalizes it into an
// immutable build (separate promote step still required to go live).

/** Pointer to the "current" draft tracked locally in `.recube/draft.json`. */
export interface DraftState {
  tenant: string;
  channel: string;
  draftId: string;
  /** Version tag the draft will publish as (informational, set at create). */
  version?: string;
}

/** Draft record as returned by /drafts (list/create/status). */
export interface Draft {
  id: string;
  tenant?: string;
  channel?: string;
  version_tag?: string;
  base_build_id?: string | null;
  status?: 'open' | 'published' | 'abandoned' | string;
  resolved_file_count?: number;
  resolved_files?: { path: string; sha256: string; size: number; exec?: boolean }[];
  live_moved_since_base?: boolean;
  created_at?: string;
  [k: string]: unknown;
}

/** Slot returned by POST /drafts/{id}/files/initiate. */
export interface DraftInitiateSlot {
  action: 'skip' | 'upload';
  upload_url?: string;
  upload_method?: string;
  upload_headers?: Record<string, string>;
}

/** Une entrée de GET /drafts/{id}/files (mode flat ou arbo). */
export interface DraftFileEntry {
  path: string;
  name?: string;
  sha256: string;
  size: number;
  exec: boolean;
  origin: 'base' | 'added' | 'replaced' | string;
  removed: boolean;
  uploaded_at?: string | null;
  uploaded_by?: string | null;
}

/** GET /drafts/{id}/files?flat=1 (liste plate paginée, sans filtre). */
export interface DraftFilesFlatResult {
  files: DraftFileEntry[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
  query: string;
}

/** GET /drafts/{id}/diff. */
export interface DraftDiff {
  added: { path: string; sha256?: string; size?: number }[];
  replaced: { path: string; sha256?: string; size?: number }[];
  removed: { path: string }[];
  base_file_count?: number;
  live_moved_since_base?: boolean;
}

/** POST /drafts/{id}/publish. */
export interface DraftPublishResult {
  status?: string;
  finalized_build?: {
    build_id?: string;
    manifest_sha256?: string;
    files_count?: number;
    [k: string]: unknown;
  };
  /** true = build mis en ligne (promote OK) ; false/absent = build dormant. */
  promoted?: boolean;
  /**
   * Promote demandé (--promote) mais refusé AVANT exécution : le publish a
   * réussi quand même (201). `missing_scope` = token sans launcher:promote ;
   * `missing_permission` = user sans droit de promotion.
   */
  promote_skipped?: 'missing_scope' | 'missing_permission' | string;
  /** Promote demandé mais échoué à l'exécution (code d'erreur serveur). */
  promote_error?: string;
  /** Message humain associé à `promote_error`. */
  promote_message?: string;
  [k: string]: unknown;
}

/**
 * POST /launcher/{tenant}/{channel}/promote/{buildId} — met en ligne un build
 * DÉJÀ publié (dormant → live). Endpoint séparé du publish (perm-gated
 * launcher:promote + launcher.{tenant}.promote).
 */
export interface PromoteResult {
  ok?: boolean;
  build_id?: string;
  /** Build précédemment en ligne sur ce channel (null si c'était le 1er). */
  previous_build_id?: string | null;
  manifest_sha256?: string;
  promoted_at?: string;
  tenant?: string;
  channel?: string;
  [k: string]: unknown;
}

// ── Personal branches (dev-{handle}, base ⊕ overlay, backend PersonalBranchController) ──
// A personal branch is a private TenantChannel derived from a root channel
// (default `stable`) : the owner mutates an overlay (add/replace/remove) on
// top of the base, auto-recomposed + re-signed on every mutation. Never
// accessible via a service token server-side (mutating a live auto-recomposed
// channel is a deliberate human action).

/** GET/POST /launcher/{tenant}/branches(/me) payload shape (branchPayload()). */
export interface PersonalBranch {
  id: string | number;
  tenant: string;
  name: string;
  label?: string | null;
  base_channel_name?: string | null;
  owner_user_id?: string | number | null;
  auto_recompose?: boolean;
  latest_build_id?: string | number | null;
  composed_from_base_build_id?: string | number | null;
  overlay_rev?: number;
  last_activity_at?: string | null;
  /** Only present on GET /branches/me (withOverlay: true). */
  overlay?: BranchOverlayEntry[];
  [k: string]: unknown;
}

/** One row of a personal branch's overlay (ChannelOverlay). */
export interface BranchOverlayEntry {
  path: string;
  action: 'add' | 'replace' | 'remove';
  sha256?: string | null;
  size?: number | null;
  exec?: boolean;
}

/** POST /branches/me/overlay/initiate — presigned PUT slot for an overlay blob. */
export interface BranchOverlayInitiateSlot {
  action: 'skip' | 'upload';
  path: string;
  sha256: string;
  size: number;
  upload_url?: string;
  upload_method?: string;
  upload_headers?: Record<string, string>;
}

/** POST/DELETE /branches/me/overlay result — commit + recompose outcome. */
export interface BranchOverlayPutResult {
  overlay: { path: string; action: string; sha256?: string | null; size?: number | null; exec?: boolean };
  recomposed: boolean;
  build_id?: string | null;
}

/**
 * POST /branches/me/merge — merges the caller's overlay onto a shared
 * (root) channel `into`. Gated server-side on the PROMOTE permission of the
 * TARGET, not the branch itself.
 */
export interface BranchMergeResult {
  into: string;
  build_id: string;
}
