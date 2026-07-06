/**
 * Unit tests for the shared auth-error surfacing helpers (pure, no network).
 * Regression guard : a 403/401 must surface the backend's precise message
 * (e.g. "Missing permission 'launcher.nationsglory.publish'") instead of the
 * old generic "Scope manquant ? Relance recube login…".
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api.js';
import { accessDeniedMessage, backendMessage } from '../src/lib/api-error.js';

describe('backendMessage', () => {
  it('extracts the message field from a JSON body', () => {
    const err = new ApiError('403', 403, JSON.stringify({ message: "Missing scope 'launcher:publish'" }));
    expect(backendMessage(err)).toBe("Missing scope 'launcher:publish'");
  });

  it('returns empty string for a non-ApiError', () => {
    expect(backendMessage(new Error('boom'))).toBe('');
  });

  it('returns empty string for an empty body', () => {
    expect(backendMessage(new ApiError('403', 403, ''))).toBe('');
  });

  it('returns empty string for a non-JSON body', () => {
    expect(backendMessage(new ApiError('403', 403, '<html>oops</html>'))).toBe('');
  });

  it('returns empty string when message field is absent', () => {
    expect(backendMessage(new ApiError('403', 403, JSON.stringify({ error: 'forbidden' })))).toBe('');
  });
});

describe('accessDeniedMessage', () => {
  it('surfaces the backend message as the primary line (permission case)', () => {
    const err = new ApiError('403', 403, JSON.stringify({ message: "Missing permission 'launcher.nationsglory.publish'" }));
    const out = accessDeniedMessage(403, err, 'hint here');
    expect(out).toContain("Accès refusé (403) : Missing permission 'launcher.nationsglory.publish'");
  });

  it('surfaces the backend message as the primary line (scope case)', () => {
    const err = new ApiError('403', 403, JSON.stringify({ message: "Missing scope 'launcher:publish'" }));
    const out = accessDeniedMessage(403, err, 'hint here');
    expect(out).toContain("Accès refusé (403) : Missing scope 'launcher:publish'");
  });

  it('keeps the generic hint as a secondary line when a message exists', () => {
    const err = new ApiError('403', 403, JSON.stringify({ message: 'nope' }));
    const out = accessDeniedMessage(403, err, 'run recube login');
    expect(out).toMatch(/Accès refusé \(403\) : nope/);
    expect(out).toMatch(/run recube login/);
  });

  it('falls back to the generic hint when there is no backend message', () => {
    const err = new ApiError('401', 401, '');
    const out = accessDeniedMessage(401, err, 'reconnecte-toi');
    expect(out).toBe('Accès refusé (401). reconnecte-toi');
  });

  it('does not leak the generic hint into the primary line', () => {
    const err = new ApiError('403', 403, JSON.stringify({ message: 'X' }));
    expect(accessDeniedMessage(403, err, 'HINT').startsWith('Accès refusé (403) : X')).toBe(true);
  });

  it('handles no hint gracefully', () => {
    expect(accessDeniedMessage(403, new ApiError('403', 403, ''))).toBe('Accès refusé (403).');
  });
});
