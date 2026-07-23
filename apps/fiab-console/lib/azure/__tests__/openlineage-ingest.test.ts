/**
 * L2 — OpenLineage → L1 column-model mapper goldens.
 *
 * Golden RunEvent fixtures (shaped exactly like the openlineage-spark http
 * transport's payload: abfss namespace + path name, columnLineage facet on the
 * OUTPUT dataset) → expected `columnMappings` (`confidence:'declared'`), plus
 * the rev-2 security caps (dataset fan-out, columnMappings fan-out) and the
 * schema-validation rejection paths.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRunEvent,
  mapRunEventToEdges,
  datasetUri,
  OL_MAX_DATASETS,
  OL_MAX_COLUMN_MAPPINGS,
} from '../openlineage-ingest';

const NS = 'abfss://bronze@saloomdemo.dfs.core.windows.net';

/** The golden fixture: a Spark `df.select(...).join(...).write` COMPLETE event
 *  with two inputs feeding one output, declared column lineage on the output. */
function goldenRunEvent() {
  return {
    eventType: 'COMPLETE',
    eventTime: '2026-07-22T18:00:00Z',
    run: { runId: '01890a5d-ad4f-7a4b-b1a2-3f8c1c2d4e5f' },
    job: { namespace: 'loom', name: 'notebook.sales_enrich' },
    inputs: [
      { namespace: NS, name: '/lakehouses/lh-sales/tables/orders' },
      { namespace: NS, name: '/lakehouses/lh-sales/tables/customers' },
    ],
    outputs: [
      {
        namespace: NS,
        name: '/lakehouses/lh-sales/tables/orders_enriched',
        facets: {
          columnLineage: {
            fields: {
              order_id: {
                inputFields: [
                  { namespace: NS, name: '/lakehouses/lh-sales/tables/orders', field: 'id',
                    transformations: [{ type: 'DIRECT', subtype: 'IDENTITY' }] },
                ],
              },
              customer_name: {
                inputFields: [
                  { namespace: NS, name: '/lakehouses/lh-sales/tables/customers', field: 'name',
                    transformations: [{ type: 'DIRECT', subtype: 'TRANSFORMATION', description: 'UPPER(name)' }] },
                ],
              },
              total_amount: {
                inputFields: [
                  { namespace: NS, name: '/lakehouses/lh-sales/tables/orders', field: 'amount' },
                ],
              },
            },
          },
        },
      },
    ],
  };
}

describe('datasetUri', () => {
  it('joins the Spark abfss namespace + path name into one lowercase URI', () => {
    expect(datasetUri({ namespace: NS, name: '/lakehouses/LH/tables/Orders' }))
      .toBe(`${NS}/lakehouses/lh/tables/orders`);
  });

  it('uses name verbatim when it already carries a scheme', () => {
    expect(datasetUri({ namespace: 'ignored', name: 'abfss://x@y.dfs.core.windows.net/t' }))
      .toBe('abfss://x@y.dfs.core.windows.net/t');
  });
});

describe('parseRunEvent (schema validation)', () => {
  it('accepts the golden event', () => {
    const r = parseRunEvent(goldenRunEvent());
    expect(r.ok).toBe(true);
  });

  it.each([
    ['non-object body', [1, 2, 3]],
    ['bad eventType', { ...goldenRunEvent(), eventType: 'NOPE' }],
    ['missing runId', { ...goldenRunEvent(), run: {} }],
    ['missing job.name', { ...goldenRunEvent(), job: { namespace: 'loom' } }],
    ['dataset without name', { ...goldenRunEvent(), inputs: [{ namespace: NS }] }],
  ])('rejects %s', (_label, body) => {
    const r = parseRunEvent(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_event');
  });
});

describe('mapRunEventToEdges (golden)', () => {
  it('maps the columnLineage facet into per-input declared column mappings', () => {
    const parsed = parseRunEvent(goldenRunEvent());
    if (!parsed.ok) throw new Error('fixture must parse');
    const r = mapRunEventToEdges(parsed.event);
    if (!r.ok) throw new Error('fixture must map');
    // 2 inputs × 1 output = 2 edges.
    expect(r.edges).toHaveLength(2);

    const ordersEdge = r.edges.find((e) => e.fromUri.endsWith('/tables/orders'))!;
    expect(ordersEdge.toUri).toBe(`${NS}/lakehouses/lh-sales/tables/orders_enriched`);
    expect(ordersEdge.jobName).toBe('loom/notebook.sales_enrich');
    // Only the orders-owned columns ride the orders edge; every mapping is 'declared'.
    expect(ordersEdge.columnMappings).toEqual([
      { fromColumn: 'id', toColumn: 'order_id', transform: 'DIRECT:IDENTITY', confidence: 'declared' },
      { fromColumn: 'amount', toColumn: 'total_amount', confidence: 'declared' },
    ]);

    const customersEdge = r.edges.find((e) => e.fromUri.endsWith('/tables/customers'))!;
    expect(customersEdge.columnMappings).toEqual([
      // description wins over type:subtype as the transform label.
      { fromColumn: 'name', toColumn: 'customer_name', transform: 'UPPER(name)', confidence: 'declared' },
    ]);
  });

  it('produces zero edges for non-COMPLETE events (START/RUNNING/ABORT/FAIL)', () => {
    for (const eventType of ['START', 'RUNNING', 'ABORT', 'FAIL']) {
      const parsed = parseRunEvent({ ...goldenRunEvent(), eventType });
      if (!parsed.ok) throw new Error('fixture must parse');
      const r = mapRunEventToEdges(parsed.event);
      expect(r.ok && r.edges.length === 0, eventType).toBe(true);
    }
  });

  it('keeps table-grain edges (empty columnMappings) when no facet is present', () => {
    const ev = goldenRunEvent();
    delete (ev.outputs[0] as { facets?: unknown }).facets;
    const parsed = parseRunEvent(ev);
    if (!parsed.ok) throw new Error('fixture must parse');
    const r = mapRunEventToEdges(parsed.event);
    if (!r.ok) throw new Error('must map');
    expect(r.edges).toHaveLength(2);
    for (const e of r.edges) expect(e.columnMappings).toEqual([]);
  });

  it('rejects a dataset fan-out past the cap (413 class)', () => {
    const ev = goldenRunEvent();
    ev.inputs = Array.from({ length: OL_MAX_DATASETS + 1 }, (_, i) => ({ namespace: NS, name: `/t/${i}` }));
    const parsed = parseRunEvent(ev);
    if (!parsed.ok) throw new Error('fixture must parse');
    const r = mapRunEventToEdges(parsed.event);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('dataset_fanout');
  });

  it('rejects a columnMappings fan-out past the write-amplification cap', () => {
    const ev = goldenRunEvent();
    const fields: Record<string, unknown> = {};
    for (let i = 0; i <= OL_MAX_COLUMN_MAPPINGS; i++) {
      fields[`col_${i}`] = {
        inputFields: [{ namespace: NS, name: '/lakehouses/lh-sales/tables/orders', field: `src_${i}` }],
      };
    }
    (ev.outputs[0].facets as { columnLineage: { fields: unknown } }).columnLineage.fields = fields;
    const parsed = parseRunEvent(ev);
    if (!parsed.ok) throw new Error('fixture must parse');
    const r = mapRunEventToEdges(parsed.event);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('column_mapping_fanout');
  });
});
