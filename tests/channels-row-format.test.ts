/**
 * `formatChannelRow` — pure formatter for `recube channels list <tenant>`.
 *
 * The channel list is fed by TWO backend endpoints with DIFFERENT key shapes
 * (cf. Channel type / channels.ts) :
 *   - GET /games/{slug}/branches  → { channel, latest_version, permission_slug, tag }
 *   - GET /launcher/channels      → { id, slug, name (display), permission_slug, is_default }
 * The formatter must render both correctly, never emitting empty/`undefined`
 * cells (the bug that showed blank name/label + public=`no` for every row).
 */

import { describe, expect, it } from 'vitest';
import { formatChannelRow } from '../src/commands/channels.js';
import type { Channel } from '../src/types.js';

// Split a rendered row into its 4 trimmed columns (padEnd 20/24/8/8).
function cols(row: string): { name: string; label: string; pub: string; latest: string } {
  const name = row.slice(0, 20).trim();
  const label = row.slice(21, 21 + 24).trim();
  const pub = row.slice(21 + 24 + 1, 21 + 24 + 1 + 8).trim();
  const latest = row.slice(21 + 24 + 1 + 8 + 1).trim();
  return { name, label, pub, latest };
}

describe('formatChannelRow', () => {
  it('(a) branches shape { channel, latest_version, tag } → name/label/latest filled, public "-"', () => {
    const row = formatChannelRow({
      channel: 'stable',
      latest_version: '1.0.44',
      tag: 'Stable',
    } as unknown as Channel);
    const { name, label, pub, latest } = cols(row);
    expect(name).toBe('stable');
    expect(latest).toBe('1.0.44');
    expect(label).toBe('Stable');
    // no is_public and no permission_slug on this input → unknown → "-"
    expect(pub).toBe('-');
    expect(row).not.toContain('undefined');
  });

  it('(a bis) real branches carry permission_slug → public derived (null = yes, slug = no)', () => {
    const publicRow = formatChannelRow({
      channel: 'stable',
      latest_version: '1.0.44',
      permission_slug: null,
      tag: 'Stable',
    } as unknown as Channel);
    expect(cols(publicRow).pub).toBe('yes');

    const gatedRow = formatChannelRow({
      channel: 'dev-paul',
      latest_version: '1.0.45',
      permission_slug: 'launcher.dev-paul',
      tag: 'Perso',
    } as unknown as Channel);
    expect(cols(gatedRow).pub).toBe('no');
  });

  it('(a ter) real /launcher/channels shape { slug, name (display), permission_slug } → machine slug in name, display in label', () => {
    const row = formatChannelRow({
      id: 7,
      slug: 'beta',
      name: 'Beta',
      permission_slug: null,
      is_default: false,
    } as unknown as Channel);
    const { name, label, pub, latest } = cols(row);
    expect(name).toBe('beta'); // machine slug, not the display name
    expect(label).toBe('Beta'); // display name lands in the label column
    expect(pub).toBe('yes'); // permission_slug null = public
    expect(latest).toBe('-'); // this endpoint exposes no version info
  });

  it('(b) explicit is_public / label / versions_count shape → name=beta, label=Beta, public=yes, latest=3', () => {
    const row = formatChannelRow({
      name: 'beta',
      label: 'Beta',
      is_public: true,
      versions_count: 3,
    } as unknown as Channel);
    const { name, label, pub, latest } = cols(row);
    expect(name).toBe('beta');
    expect(label).toBe('Beta');
    expect(pub).toBe('yes');
    expect(latest).toBe('3');
  });

  it('(c) missing fields render "-", never undefined/empty', () => {
    const row = formatChannelRow({} as unknown as Channel);
    const { name, label, pub, latest } = cols(row);
    expect(name).toBe('-');
    expect(label).toBe('-');
    expect(pub).toBe('-');
    expect(latest).toBe('-');
    expect(row).not.toContain('undefined');
  });

  it('is_public=false renders "no" (explicit private)', () => {
    const row = formatChannelRow({ name: 'nightly', is_public: false } as unknown as Channel);
    expect(cols(row).pub).toBe('no');
  });
});
