import { describe, expect, it } from 'vitest';
import { formatPublishError } from '../src/commands/publish.js';

describe('formatPublishError', () => {
  it('hints login on 401', () => {
    const out = formatPublishError(
      new Error('POST https://recube.gg/v1/launcher/ng/stable/builds/commit -> 401 Unauthorized: token expired')
    );
    expect(out).toMatch(/recube login/);
  });

  it('hints scope on 403', () => {
    const out = formatPublishError(
      new Error('POST https://recube.gg/v1/launcher/ng/stable/builds/initiate -> 403 Forbidden: missing scope')
    );
    expect(out).toMatch(/launcher\.\{tenant\}\.publish/);
  });

  it('extracts laravel validation fields on 422', () => {
    const body = JSON.stringify({
      message: 'The given data was invalid.',
      errors: { version: ['required'], 'files.0.sha256': ['invalid hash'] },
    });
    const out = formatPublishError(
      new Error(`POST https://recube.gg/v1/launcher/ng/stable/builds/commit -> 422 Unprocessable Entity: ${body}`)
    );
    expect(out).toMatch(/version/);
    expect(out).toMatch(/files\.0\.sha256/);
    expect(out).toMatch(/required/);
  });

  it('hints network on fetch failure', () => {
    const out = formatPublishError(new Error('fetch failed: ENOTFOUND recube.gg'));
    expect(out).toMatch(/recube doctor/);
  });

  it('returns original on unknown error', () => {
    const out = formatPublishError(new Error('random thing'));
    expect(out).toBe('random thing');
  });
});
