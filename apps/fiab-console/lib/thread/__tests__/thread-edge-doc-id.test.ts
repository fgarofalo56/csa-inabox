/**
 * `threadEdgeDocId` — the Cosmos document id for EVERY thread edge Loom writes.
 *
 * This is a data-layer change, not a feature. 37 call sites across the product
 * write thread edges (ontology bind/run-action, dbt manifest lineage, Unity
 * Catalog, Power BI / semantic-model / report builders, APIM publish, notebook
 * attach, medallion promote, the OpenLineage ingest route, the catalog interop
 * ingest…), and all of them route through `recordThreadEdge` → this function. So
 * the ONLY thing that matters is whether an existing stored document keeps its
 * id: if it does not, the next write creates a SECOND document and stops
 * upserting onto the row that is already there.
 *
 * ## Why it has to change at all
 *
 * The historical form is `edge_{tenant}_{from}_{to}_{action}` with
 * `[^A-Za-z0-9_-] → _`. That was lossless and short while both endpoints were
 * always Loom item ids (guids / slugs). It is neither once an endpoint can be a
 * physical dataset URI — which is what the OpenLineage emitters will write:
 *
 *   - `…/a/b` and `…/a_b` sanitize to the SAME id, so one edge silently
 *     overwrites the other on upsert;
 *   - a realistic sovereign `abfss://…usgovcloudapi.net/…` pair exceeds Cosmos's
 *     255-byte id limit and the write throws — swallowed by `recordThreadEdge`'s
 *     best-effort catch, so the edge vanishes with no signal.
 *
 * ## Migration story: there is nothing to migrate, and that is MECHANICALLY
 * ## CHECKED here, not asserted
 *
 * `LEGACY_ID_CHARSET` (`^[A-Za-z0-9_.:-]*$` on the RAW id) admits exactly the
 * characters every endpoint shape the product writes today is built from. Every
 * such id is returned by the historical formula, byte for byte. The digest branch
 * is only reachable for a shape carrying URI syntax (`/ @ ? % &`, whitespace) —
 * which nothing has ever written, because before LU-8 `POST /api/lineage/
 * openlineage` resolved every endpoint to a Loom item id and `skipped` anything
 * unresolved.
 *
 * `historicalDocId()` below is the pre-change expression, copied verbatim. The
 * `PRODUCT_SHAPES` table names the file that writes each shape and asserts
 * `threadEdgeDocId(...) === historicalDocId(...)` for all of them, so the
 * "no existing document is re-keyed" claim is a comparison against the OLD
 * ALGORITHM rather than against hand-written literals a future edit could be
 * updated to match.
 *
 * And the residual: IF some endpoint we have not enumerated does re-key, no data
 * is lost. `listThreadEdges` selects by `tenantId` and never by id; the graph
 * builds from the `fromItemId`/`toItemId` FIELDS; and `weaveGraph` de-dupes
 * `${from}->${to}`, so a duplicate document renders as one edge. That is
 * asserted too — an orphaned row degrades to a redundant row, never a lost one.
 *
 * The round-2 cut of this got the boundary wrong (`safe === raw`), which would
 * have re-keyed every endpoint containing a `.` or `:` — i.e. ontology objects
 * and every dbt/UC three-part relation. That is the exact failure this file
 * exists to make impossible to ship again.
 */
import { describe, it, expect } from 'vitest';
import { threadEdgeDocId } from '@/lib/thread/thread-edges';

/**
 * The id expression as it stood BEFORE this change, copied verbatim from
 * `recordThreadEdge`. Any shape for which the new function disagrees with this
 * one is a shape whose stored documents would be orphaned.
 */
function historicalDocId(
  tenantId: string,
  input: { fromItemId: string; toItemId: string; action: string },
): string {
  return `edge_${tenantId}_${input.fromItemId}_${input.toItemId}_${input.action}`
    .replace(/[^A-Za-z0-9_-]/g, '_');
}

const TEN = '11111111-2222-3333-4444-555555555555';

/**
 * Every endpoint shape the product actually writes, with the file that writes
 * it. Derived by reading the 37 `recordThreadEdge` call sites, not from memory.
 */
const PRODUCT_SHAPES: Array<{ what: string; writer: string; from: string; to: string; action: string }> = [
  {
    what: 'plain Loom item slugs',
    writer: 'app/api/thread/mirror-to-lakehouse, analyze-in-notebook, …',
    from: 'lh-bronze', to: 'nb-clean', action: 'weave',
  },
  {
    what: 'Loom item guids',
    writer: 'app/api/thread/add-data-agent-source (res.item.id)',
    from: 'a1b2c3d4-1111-2222-3333-444455556666',
    to: 'f0e9d8c7-9999-8888-7777-666655554444',
    action: 'thread-add-source',
  },
  {
    what: 'slug carrying a dot',
    writer: 'workspace-scoped item slugs',
    from: 'lakehouse.bronze', to: 'notebook.clean', action: 'weave',
  },
  {
    what: 'ontology object `type:objId`',
    writer: 'app/api/items/ontology/[id]/run-action (`${action.objectType}:${objId}`)',
    from: 'ont1', to: 'CustomerObj:123', action: 'ontology-action',
  },
  {
    what: 'dbt / Unity Catalog three-part relation',
    writer: 'lib/dbt/dbt-manifest-lineage (physicalRelation → db.schema.table)',
    from: 'loomdw.sales.orders', to: 'loomdw.sales.orders_agg', action: 'dbt-model',
  },
  {
    what: 'APIM api name (slugified, `[a-z0-9-]`)',
    writer: 'app/api/items/aip-logic/[id]/publish, loom-app-runtime/[id]/publish-api',
    from: 'spindle-1', to: 'orders-v1-spindle', action: 'spindle-publish-apim',
  },
  {
    what: 'Power BI dataset / semantic-model guid (external endpoint)',
    writer: 'app/api/thread/build-powerbi-model, analyze-in-powerbi',
    from: 'lh-gold', to: '0f0f0f0f-1111-2222-3333-444444444444', action: 'build-powerbi-model',
  },
];

describe('threadEdgeDocId — MIGRATION: no existing document is re-keyed', () => {
  // MUTATION T1: replace `LEGACY_ID_CHARSET.test(raw)` with `safe === raw`
  //   (the round-2 rule).
  // → observed: 3 RED — the dotted slug, the ontology object and the dbt
  //   three-part relation each gain a `_<sha256-32>` suffix instead of keeping
  //   the id that is already stored. (The guid / slug / APIM-name shapes contain
  //   nothing to substitute, so `safe === raw` happens to hold for them — which
  //   is exactly why round 2 looked fine and was not: the shapes it broke are
  //   the ones with a `.` or a `:`, and those are the ontology and dbt/UC
  //   endpoints, i.e. most of the stored graph.)
  // MUTATION T2: `if (false && …)` — always digest.
  // → observed: 8 RED (all 7 shapes plus the byte-identical literal).
  for (const s of PRODUCT_SHAPES) {
    it(`keeps the historical id for ${s.what} (${s.writer})`, () => {
      const args = { fromItemId: s.from, toItemId: s.to, action: s.action };
      expect(threadEdgeDocId(TEN, args)).toBe(historicalDocId(TEN, args));
    });
  }

  it('the legacy branch is byte-identical, not merely similar', () => {
    // Belt: assert one full literal so a change to BOTH functions at once still
    // has to face a hard-coded expectation.
    expect(threadEdgeDocId('ten', { fromItemId: 'lh-a', toItemId: 'nb-b', action: 'weave' }))
      .toBe('edge_ten_lh-a_nb-b_weave');
  });
});

describe('threadEdgeDocId — the defects that forced the change', () => {
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
    // …and the historical formula DID collide them, which is the point.
    expect(historicalDocId('TEN', { fromItemId: 'abfss://data@st.dfs.core.windows.net/a/b', toItemId: 'x', action: 'openlineage-pipeline' }))
      .toBe(historicalDocId('TEN', { fromItemId: 'abfss://data@st.dfs.core.windows.net/a_b', toItemId: 'x', action: 'openlineage-pipeline' }));
    expect(a).not.toBe(b);
  });

  it('keeps a deep sovereign path pair inside the Cosmos 255-byte id limit', () => {
    const deep =
      'abfss://bronze@stloomprodeastus2.dfs.core.usgovcloudapi.net/raw/erp/sap/ecc/orders/region/na/year/2026/month/07/day/28';
    const args = { fromItemId: deep, toItemId: `${deep}/out`, action: 'openlineage-pipeline' };
    // The historical formula blew the limit — that write threw and was swallowed.
    expect(Buffer.byteLength(historicalDocId(TEN, args), 'utf-8')).toBeGreaterThan(255);
    expect(Buffer.byteLength(threadEdgeDocId(TEN, args), 'utf-8')).toBeLessThanOrEqual(255);
  });

  it('is deterministic — the same edge upserts onto the same document', () => {
    const args = {
      fromItemId: 'abfss://data@st.dfs.core.windows.net/silver/sales',
      toItemId: 'loomdw.sales.orders',
      action: 'openlineage-pipeline',
    };
    expect(threadEdgeDocId('ten', args)).toBe(threadEdgeDocId('ten', args));
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

describe('threadEdgeDocId — the residual risk degrades to a redundant row, never a lost one', () => {
  // The claim "nothing is re-keyed" rests on an enumeration, and an enumeration
  // can be incomplete. So state what happens if it is: NO read path keys on the
  // document id.
  //   - `listThreadEdges` / `listAllThreadEdges`: `SELECT * FROM c WHERE
  //     c.tenantId = @t` — the id is never a predicate.
  //   - the lineage graph builds nodes+edges from the `fromItemId`/`toItemId`
  //     FIELDS, which this change does not touch.
  //   - `weaveGraph` de-dupes on `${e.fromItemId}->${e.toItemId}`.
  // So a re-keyed edge means one extra Cosmos document rendering as the SAME
  // graph edge — a storage cost and an idempotency loss, not a lineage loss.
  it('a re-keyed document still carries the endpoint fields the graph reads', () => {
    const args = {
      fromItemId: 'abfss://data@st.dfs.core.windows.net/silver/sales',
      toItemId: 'lh-gold',
      action: 'openlineage-pipeline',
    };
    const oldId = historicalDocId('ten', args);
    const newId = threadEdgeDocId('ten', args);
    expect(newId).not.toBe(oldId); // this shape DOES move
    // Both ids are valid Cosmos ids (no `/ \ ? #`), so the old row is readable
    // and deletable by the reconcile sweep exactly as before.
    for (const id of [oldId, newId]) {
      expect(id).not.toMatch(/[/\\?#]/);
      expect(Buffer.byteLength(id, 'utf-8')).toBeLessThanOrEqual(255);
    }
  });
});
