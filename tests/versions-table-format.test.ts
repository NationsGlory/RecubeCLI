/**
 * `buildVersionsTable` — pure formatter for `recube versions list`.
 *
 * The build `id` (UID) MUST appear so the dev knows which value to feed to
 * `recube promote -b <buildId>`. These tests pin the id column + row rendering.
 */

import { describe, expect, it } from 'vitest';
import { buildVersionsTable } from '../src/commands/versions.js';
import type { Version } from '../src/types.js';

describe('buildVersionsTable', () => {
  it('exposes an id column in the header (before version)', () => {
    const { header } = buildVersionsTable([]);
    expect(header).toMatch(/\bid\b/);
    expect(header.indexOf('id')).toBeLessThan(header.indexOf('version'));
    expect(header).toContain('version');
    expect(header).toContain('channel');
    expect(header).toContain('reference');
    expect(header).toContain('created_at');
  });

  it('renders the build id (UID) as the first field of each row', () => {
    const versions: Version[] = [
      {
        id: '01J9ZXC8ABBUILDUID000001',
        version: '1.2.3',
        channel: 'beta',
        reference: 'sha:deadbeef',
        created_at: '2026-07-01T10:00:00Z',
      },
    ];
    const { rows } = buildVersionsTable(versions);
    expect(rows).toHaveLength(1);
    // UID appears verbatim and leads the row.
    expect(rows[0]).toContain('01J9ZXC8ABBUILDUID000001');
    expect(rows[0].trimStart().startsWith('01J9ZXC8ABBUILDUID000001')).toBe(true);
    // Other fields still present.
    expect(rows[0]).toContain('1.2.3');
    expect(rows[0]).toContain('beta');
    expect(rows[0]).toContain('sha:deadbeef');
    expect(rows[0]).toContain('2026-07-01T10:00:00Z');
  });

  it('exposes a build_id column and renders it (résout promote -b <tag>)', () => {
    const { header } = buildVersionsTable([]);
    expect(header).toContain('build_id');
    const versions: Version[] = [
      {
        id: 'v-row-1',
        version: '1.0.60',
        channel: 'beta',
        build_id: 'bbbbbbbb-2222-2222-2222-222222222222',
      },
    ];
    const { rows } = buildVersionsTable(versions);
    expect(rows[0]).toContain('bbbbbbbb-2222-2222-2222-222222222222');
  });

  it('tolerates numeric ids and missing optional fields', () => {
    const versions: Version[] = [{ id: 42, version: '2.0.0' }];
    const { rows } = buildVersionsTable(versions);
    expect(rows[0]).toContain('42');
    expect(rows[0]).toContain('2.0.0');
  });

  it('rend "-" (pas vide/undefined) pour les champs absents (fallback admin-denied)', () => {
    // Cas fallback : seuls channel + version (+ build_id parfois) sont connus.
    const versions: Version[] = [{ version: '1.0.44', channel: 'stable' }];
    const { rows } = buildVersionsTable(versions);
    expect(rows[0]).not.toContain('undefined');
    // id manquant → placeholder "-" en tête de ligne.
    expect(rows[0].trimStart().startsWith('-')).toBe(true);
    expect(rows[0]).toContain('1.0.44');
    expect(rows[0]).toContain('stable');
  });
});
