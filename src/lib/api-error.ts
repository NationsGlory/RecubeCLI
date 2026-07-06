/**
 * Shared helpers to surface the REAL backend error message on auth failures.
 *
 * Historically every command mapped a 403/401 to a generic
 * "Accès refusé (403). Scope manquant ? Relance recube login…" — dropping the
 * precise reason the backend actually returned. The server distinguishes
 * "Missing scope 'X'" from "Missing permission 'launcher.{tenant}.publish'" ;
 * a dev with the scope but not the permission (or the reverse) was misled.
 *
 * These helpers extract the backend `message` from the JSON body and surface it
 * as the primary line, keeping the generic hint only as a secondary fallback.
 */

import { ApiError } from './api.js';

/**
 * Parse the JSON body of an ApiError and return its human-readable `message`
 * field, or '' when the body is absent / non-JSON / has no message. Pure.
 */
export function backendMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return '';
  if (!err.body) return '';
  try {
    const body = JSON.parse(err.body) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
}

/**
 * Build an access-denied line for a 401/403.
 *
 * - If the backend provided a `message`, surface it as the primary line
 *   ("Accès refusé (403) : <message>") and keep the generic `hint` as a dimmed
 *   secondary line (so the actionable remediation is still there).
 * - If there is no backend message, fall back to the generic hint only.
 *
 * `hint` is plain (already-styled) text supplied by the caller. Pure.
 */
export function accessDeniedMessage(status: number, err: unknown, hint?: string): string {
  const msg = backendMessage(err);
  if (msg) {
    return hint ? `Accès refusé (${status}) : ${msg}\n  ${hint}` : `Accès refusé (${status}) : ${msg}`;
  }
  return hint ? `Accès refusé (${status}). ${hint}` : `Accès refusé (${status}).`;
}
