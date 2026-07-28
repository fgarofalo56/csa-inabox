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
});
