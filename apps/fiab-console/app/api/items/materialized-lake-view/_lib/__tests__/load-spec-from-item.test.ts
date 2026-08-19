/**
 * #3549 / #3551 — a bundle-installed materialized-lake-view must open with its
 * definition.
 *
 * THE LATENT INSTANCE THIS PINS. `specFromItem` is the single accessor every
 * MLV route uses to reach the item's definition (preview / refresh / runs /
 * lineage / adf-pipeline all call it). It read `state.spec` only — the shape the
 * editor's own refresh route writes. But an app-bundle install stamps its
 * content at `state.content` (`app/api/apps/[id]/install/route.ts`), and the
 * install-time provisioner reads exactly `content.spec || content.mlv`
 * (`lib/install/provisioners/materialized-lake-view.ts:29`).
 *
 * So a bundled MLV could be materialized on the lake, reported `created`, and
 * then open with no definition at all — the same "install claims content the
 * editor cannot see" shape measured live on five other item types. No shipped
 * bundle installs an MLV today, which is why it had not surfaced; this closes it
 * before a sixth item type lands on it.
 */
import { describe, it, expect } from 'vitest';
import { specFromItem } from '../load';

const SPEC = {
  name: 'mlv_daily_revenue',
  database: 'gold',
  language: 'sql' as const,
  sql: 'SELECT product_id, SUM(total_revenue) AS revenue FROM gold.orders GROUP BY product_id',
};

function item(state: unknown) {
  return { id: 'mlv-1', workspaceId: 'ws-1', itemType: 'materialized-lake-view', state } as any;
}

describe('specFromItem', () => {
  it('reads the editor-authored state.spec', () => {
    expect(specFromItem(item({ spec: SPEC }))).toEqual(SPEC);
  });

  it('reads a BUNDLE-INSTALLED definition from state.content.spec', () => {
    expect(specFromItem(item({ content: { kind: 'materialized-lake-view', spec: SPEC } }))).toEqual(SPEC);
  });

  it('reads the alternate bundle key state.content.mlv the provisioner also accepts', () => {
    expect(specFromItem(item({ content: { kind: 'materialized-lake-view', mlv: SPEC } }))).toEqual(SPEC);
  });

  it('a user edit wins over the bundle template', () => {
    const edited = { ...SPEC, sql: 'SELECT 1' };
    expect(specFromItem(item({ spec: edited, content: { spec: SPEC } }))).toEqual(edited);
  });

  it('no definition anywhere → null (unchanged)', () => {
    expect(specFromItem(item({}))).toBeNull();
    expect(specFromItem(item({ content: {} }))).toBeNull();
    expect(specFromItem(null)).toBeNull();
  });

  it('a non-object definition is rejected rather than returned', () => {
    expect(specFromItem(item({ spec: 'not-a-spec' }))).toBeNull();
    expect(specFromItem(item({ content: { spec: 42 } }))).toBeNull();
  });
});
