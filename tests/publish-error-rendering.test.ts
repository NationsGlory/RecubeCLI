/**
 * Targeted error-rendering tests for the `missing_recube_core` backend response
 * (RecubeGG commit 98845d4 introduced `{ok:false, error:'missing_recube_core', message:'…'}`).
 *
 * The CLI must surface :
 *   - The channel name (parsed from the URL in the error string)
 *   - A clear `-i <path>:recube-core.jar` remediation hint
 *   - The sibling-repo fallback hint
 *   - The explicit note that the jar must be at the bundle root, not under mods/
 */
import { describe, expect, it } from 'vitest';
import { formatPublishError } from '../src/commands/publish.js';

describe('formatPublishError — missing_recube_core', () => {
  it('renders the targeted hint when backend rejects with missing_recube_core', () => {
    const body = JSON.stringify({
      ok: false,
      error: 'missing_recube_core',
      message: 'recube-core.jar is required for channel "stable".',
    });
    const out = formatPublishError(
      new Error(
        `POST https://recube.gg/api/v1/launcher/nationsglory/stable/builds/commit -> 422 Unprocessable Entity: ${body}`
      )
    );
    expect(out).toMatch(/Publish refused/);
    expect(out).toMatch(/stable/);
    expect(out).toMatch(/-i <path>\/recube-core-\*\.jar:recube-core\.jar/);
    expect(out).toMatch(/RecubeCore/);
    expect(out).toMatch(/root of the bundle/);
    expect(out).toMatch(/NOT under mods\//);
  });

  it('handles missing_recube_core without a backend message field', () => {
    const body = JSON.stringify({ ok: false, error: 'missing_recube_core' });
    const out = formatPublishError(
      new Error(
        `POST https://recube.gg/api/v1/launcher/paladium/beta/builds/initiate -> 422 Unprocessable Entity: ${body}`
      )
    );
    expect(out).toMatch(/Publish refused/);
    expect(out).toMatch(/beta/);
    expect(out).toMatch(/-i </);
  });

  it('falls back to generic 422 rendering for other errors', () => {
    const body = JSON.stringify({
      message: 'The given data was invalid.',
      errors: { 'files.0.sha256': ['invalid hash'] },
    });
    const out = formatPublishError(
      new Error(
        `POST https://recube.gg/api/v1/launcher/ng/stable/builds/commit -> 422 Unprocessable Entity: ${body}`
      )
    );
    expect(out).toMatch(/Validation 422/);
    expect(out).toMatch(/files\.0\.sha256/);
    expect(out).not.toMatch(/Publish refused/);
  });
});
