/**
 * LU-8 — thread-edge document ids must survive PHYSICAL dataset endpoints.
 *
 * Before LU-8 both endpoints were always Loom item ids (guids / slugs), so the
 * historical id form `edge_{tenant}_{from}_{to}_{action}` with a
 * `[^A-Za-z0-9_-] → _` substitution was lossless and short. Since the
 * OpenLineage emitters an endpoint can be a full `abfss://…` URI, at which
 * point the substitution is BOTH lossy (two different datasets can sanitize to
 * one id, and the upsert silently overwrites) and unbounded (a realistic
 * sovereign path pair exceeds Cosmos's 255-byte id limit and the write throws,
 * swallowed — the edge vanishes with no signal).
 *
 * Every case here is a defect that shipped, not a happy path.
 */
import { describe, it, expect } from 'vitest';
import { threadEdgeDocId } from '@/lib/thread/thread-edges';

describe('threadEdgeDocId', () => {
  it('does not collide two genuinely different datasets (`a/b` vs `a_b`)', () => {
    const a = threadEdgeDocId('TEN', {
      fromItemId: 'abfss://data@st.dfs.core.windows.net/a/b',
      toItemId: 'x',
      action: 'openlineage-pipeline',
    });
    const b = threadEdgeDocId('TEN', {
      fromItemId: 'abfss://data@st.dfs.core.windows.net/a_b',
      toItemId: 'x',
      action: 'openlineage-pipeline',
    });
    expect(a).not.toBe(b);
  });

  it('keeps a deep sovereign path pair inside the Cosmos 255-byte id limit', () => {
    const deep =
      'abfss://bronze@stloomprodeastus2.dfs.core.usgovcloudapi.net/raw/erp/sap/ecc/orders/region/na/year/2026/month/07/day/28';
    const id = threadEdgeDocId('11111111-2222-3333-4444-555555555555', {
      fromItemId: deep,
      toItemId: `${deep}/out`,
      action: 'openlineage-pipeline',
    });
    expect(Buffer.byteLength(id, 'utf-8')).toBeLessThanOrEqual(255);
  });

  it('is deterministic — the same edge upserts onto the same document', () => {
    const args = {
      fromItemId: 'abfss://data@st.dfs.core.windows.net/silver/sales',
      toItemId: 'loomdw.sales.orders',
      action: 'openlineage-pipeline',
    };
    expect(threadEdgeDocId('ten', args)).toBe(threadEdgeDocId('ten', args));
  });

  it('leaves plain Loom item ids on their HISTORICAL id (no re-keying of existing edges)', () => {
    expect(threadEdgeDocId('ten', { fromItemId: 'lh-a', toItemId: 'nb-b', action: 'weave' }))
      .toBe('edge_ten_lh-a_nb-b_weave');
  });

  // ROUND 3. The case above — plain slugs with nothing to substitute — is the
  // one shape that was never at risk. The round-2 rule was `safe === raw`, so
  // EVERY pre-existing endpoint containing a `.` or a `:` silently moved to a
  // digest-suffixed id: after deploy the same logical edge wrote a SECOND
  // Cosmos document and stopped upserting onto the existing row.
  //
  // MUTATION: replace `LEGACY_ID_CHARSET.test(raw)` with `safe === raw`.
  // → observed: 3 failures — each of these historical shapes gains a
  //   `_<sha256-32>` suffix instead of keeping its stored id.
  it('keeps the historical id for an ontology-object endpoint (`type:objId`)', () => {
    // app/api/items/ontology/[id]/run-action writes `${objectType}:${objId}`.
    expect(threadEdgeDocId('ten', {
      fromItemId: 'ont1',
      toItemId: 'CustomerObj:123',
      action: 'ontology-action',
    })).toBe('edge_ten_ont1_CustomerObj_123_ontology-action');
  });

  it('keeps the historical id for a 3-part relation (`db.schema.table`)', () => {
    // The dbt L6 parser and the Unity Catalog overlay have always written this
    // shape; LU-8's SQL sink deliberately joins onto the SAME node.
    expect(threadEdgeDocId('ten', {
      fromItemId: 'loomdw.sales.orders',
      toItemId: 'loomdw.sales.orders_agg',
      action: 'dbt-model',
    })).toBe('edge_ten_loomdw_sales_orders_loomdw_sales_orders_agg_dbt-model');
  });

  it('keeps the historical id for a workspace-scoped slug with a dot', () => {
    expect(threadEdgeDocId('11111111-2222-3333-4444-555555555555', {
      fromItemId: 'lakehouse.bronze',
      toItemId: 'notebook.clean',
      action: 'weave',
    })).toBe('edge_11111111-2222-3333-4444-555555555555_lakehouse_bronze_notebook_clean_weave');
  });

  it('STILL digests a genuinely new URI endpoint (the fix must not be a blanket revert)', () => {
    const id = threadEdgeDocId('ten', {
      fromItemId: 'abfss://data@st.dfs.core.windows.net/a/b',
      toItemId: 'x',
      action: 'openlineage-pipeline',
    });
    expect(id).toMatch(/_[0-9a-f]{32}$/);
  });
});
