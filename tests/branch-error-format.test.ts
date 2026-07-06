/**
 * Error-formatting for `recube branch *` / `recube merge` — mirrors
 * tests/publish-error-format.test.ts (exported pure functions, no network).
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api.js';
import { explainBranchError } from '../src/commands/branch.js';
import { explainMergeError } from '../src/commands/merge.js';

describe('explainBranchError', () => {
  it('hints the dev-branch permission on provision 403', () => {
    const err = new ApiError('403', 403, JSON.stringify({ message: "Missing permission 'launcher.ng.dev-branch'." }));
    const out = explainBranchError(err, 'provision', 'ng');
    expect(out).toMatch(/launcher\.ng\.dev-branch/);
  });

  it('surfaces base_not_ready on provision 422', () => {
    const err = new ApiError(
      '422',
      422,
      JSON.stringify({ message: "La base 'beta' n'a pas de build live à composer.", error: 'base_not_ready' })
    );
    const out = explainBranchError(err, 'provision', 'ng');
    expect(out).toMatch(/base_not_ready/);
    expect(out).toMatch(/build live/);
  });

  it('rewrites a 404 on show/overlay as the @me hint (not the raw backend message)', () => {
    const err = new ApiError('404', 404, JSON.stringify({ message: 'No personal branch — provision it first.' }));
    expect(explainBranchError(err, 'show', 'ng')).toMatch(/recube branch create/);
    expect(explainBranchError(err, 'overlay', 'ng')).toMatch(/recube branch create/);
  });

  it('lists field-level validation errors on overlay 422', () => {
    const err = new ApiError(
      '422',
      422,
      JSON.stringify({ message: 'The given data was invalid.', errors: { sha256: ['invalid hash'] } })
    );
    const out = explainBranchError(err, 'overlay', 'ng');
    expect(out).toMatch(/sha256/);
    expect(out).toMatch(/invalid hash/);
  });

  it('hints the scope on a generic 403 (non-provision)', () => {
    const err = new ApiError('403', 403, JSON.stringify({ message: 'Missing launcher scope' }));
    const out = explainBranchError(err, 'overlay', 'ng');
    expect(out).toMatch(/launcher:draft/);
  });

  it('surfaces the precise backend message on a generic 403 (scope vs perm)', () => {
    const err = new ApiError(
      '403',
      403,
      JSON.stringify({ message: "Missing permission 'launcher.ng.publish'." })
    );
    const out = explainBranchError(err, 'overlay', 'ng');
    expect(out).toMatch(/Accès refusé \(403\) : Missing permission 'launcher\.ng\.publish'\./);
    // generic hint kept as secondary
    expect(out).toMatch(/launcher:draft/);
  });

  it('returns the raw message for a non-ApiError', () => {
    const out = explainBranchError(new Error('boom'), 'show', 'ng');
    expect(out).toBe('boom');
  });
});

describe('explainMergeError', () => {
  it('hints promote scope + permission on 403', () => {
    const err = new ApiError('403', 403, JSON.stringify({ message: "Missing promote permission on 'beta'." }));
    const out = explainMergeError(err, 'ng', 'beta');
    expect(out).toMatch(/launcher:promote/);
    expect(out).toMatch(/ng\/beta/);
  });

  it.each([
    'version_not_greater',
    'version_collision',
    'materialize_incomplete',
    'target_not_ready',
    'source_not_derived',
    'version_not_applicable',
  ])('surfaces %s on 422', (code) => {
    const err = new ApiError('422', 422, JSON.stringify({ message: `detail for ${code}`, error: code }));
    const out = explainMergeError(err, 'ng', 'beta');
    expect(out).toMatch(new RegExp(code));
    expect(out).toMatch(new RegExp(`detail for ${code}`));
  });

  it('falls back to a generic source_not_derived hint when the backend sends no message', () => {
    const err = new ApiError('422', 422, JSON.stringify({ error: 'source_not_derived' }));
    const out = explainMergeError(err, 'ng', 'beta');
    expect(out).toMatch(/source_not_derived/);
    expect(out).toMatch(/dérivé/);
  });

  it('falls back to a generic version_not_applicable hint when the backend sends no message', () => {
    const err = new ApiError('422', 422, JSON.stringify({ error: 'version_not_applicable' }));
    const out = explainMergeError(err, 'ng', 'beta');
    expect(out).toMatch(/version_not_applicable/);
    expect(out).toMatch(/--version-tag/);
  });

  it('hints throttle on 429', () => {
    const err = new ApiError('429', 429, '');
    expect(explainMergeError(err, 'ng', 'beta')).toMatch(/throttle/i);
  });

  it('surfaces the precise backend message on 401', () => {
    const err = new ApiError('401', 401, JSON.stringify({ message: "Missing scope 'launcher:promote'." }));
    const out = explainMergeError(err, 'ng', 'beta');
    expect(out).toMatch(/Accès refusé \(401\) : Missing scope 'launcher:promote'\./);
    expect(out).toMatch(/recube login/);
  });

  it('surfaces the not-found message on 404', () => {
    const err = new ApiError('404', 404, JSON.stringify({ message: "Target channel 'beta' not found." }));
    expect(explainMergeError(err, 'ng', 'beta')).toMatch(/beta/);
  });

  it('returns the raw message for a non-ApiError', () => {
    expect(explainMergeError(new Error('boom'), 'ng', 'beta')).toBe('boom');
  });
});
