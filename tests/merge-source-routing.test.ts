/**
 * `--from` routing for `recube merge` — '@me' (default, absent flag included)
 * must resolve to the personal-branch route ; any other value is treated as
 * an arbitrary derived channel name for the generalized route. Pure function,
 * no session/network — mirrors tests/branch-error-format.test.ts style.
 */

import { describe, expect, it } from 'vitest';
import { resolveMergeSource } from '../src/commands/merge.js';

describe('resolveMergeSource', () => {
  it('defaults to @me when --from is absent', () => {
    expect(resolveMergeSource(undefined)).toEqual({ isMe: true, source: '@me' });
  });

  it('resolves an explicit @me the same as absent', () => {
    expect(resolveMergeSource('@me')).toEqual({ isMe: true, source: '@me' });
  });

  it('treats any other value as an arbitrary derived channel name', () => {
    expect(resolveMergeSource('dev-alice')).toEqual({ isMe: false, source: 'dev-alice' });
    expect(resolveMergeSource('release-canary')).toEqual({ isMe: false, source: 'release-canary' });
  });

  it('is case-sensitive on the @me alias (no accidental match)', () => {
    expect(resolveMergeSource('@Me').isMe).toBe(false);
  });
});
