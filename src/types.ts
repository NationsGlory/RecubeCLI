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
}
