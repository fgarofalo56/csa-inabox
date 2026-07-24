/**
 * N17 — shared OpenLineage EMITTER (generalizes L2's Spark-only emission to
 * pipeline / notebook / code-report run completions) + OL 1.x export builder.
 *
 * BINDING vs WS-L L2 (no duplication): **L2 owns the OpenLineage Spark-listener
 * INGEST + the lineage store.** N17 does NOT rebuild ingest. This module:
 *   1. builds a spec-valid OpenLineage 1.x `RunEvent` from a Loom run, and
 *   2. persists its lineage through the SAME L2 pipeline — the pure L2 mapper
 *      (`mapRunEventToEdges`, which enforces the identical dataset +
 *      columnMappings fan-out caps) writing into the SAME sink L2 writes to
 *      (`recordThreadEdge` → the `thread-edges` lineage store the unified graph
 *      reads). No second ingest route, no second store — exactly the L2 write
 *      path, driven from an in-process run hook instead of an HTTP POST.
 *
 * The RunEvent this builds is ALSO the interop artifact: `buildRunEvent` output
 * is schema-shaped for OpenLineage 1.x (producer + schemaURL + run/job/inputs/
 * outputs facets) so `GET /api/lineage/openlineage/export` can serialize a
 * Marquez/DataHub/OpenMetadata-importable event stream from it.
 *
 * Azure-native (no Fabric): datasets are named by their Loom item identity or
 * physical ADLS/abfss URI — never a Fabric/OneLake host. IL5: pure build + an
 * in-boundary Cosmos write; no SaaS lineage catalog is ever contacted.
 */

import {
  mapRunEventToEdges,
  OL_MAX_DATASETS,
  type OpenLineageRunEvent,
  type MappedOpenLineageEdge,
} from '@/lib/azure/openlineage-ingest';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import type { SessionPayload } from '@/lib/auth/session';

/** OpenLineage producer URI stamped on every event Loom emits. */
export const LOOM_OL_PRODUCER = 'https://github.com/csa-loom/openlineage-emitter';
/** OpenLineage spec schemaURL (RunEvent) — pinned to the 1.x line. */
export const OL_RUNEVENT_SCHEMA_URL =
  'https://openlineage.io/spec/1-0-5/OpenLineage.json#/definitions/RunEvent';

export type RunLineageEventType = 'START' | 'RUNNING' | 'COMPLETE' | 'FAIL' | 'ABORT';
export type RunType = 'pipeline' | 'notebook' | 'code-report';

/** One dataset (input or output) referenced by a run. */
export interface RunDataset {
  /** Loom item id (the join key back to the thread-edge sink). */
  itemId: string;
  itemType: string;
  /** Display name (falls back to itemId). */
  name?: string;
  /** Physical URI (abfss://…) when known; else a `loom://items/…` URI is synthesized. */
  uri?: string;
  /** Column set (emitted as the dataset schema facet). */
  columns?: string[];
}

/** One declared output-column → input-column(s) mapping (the columnLineage facet). */
export interface RunColumnLineage {
  /** The output column this lineage explains. */
  toColumn: string;
  /** Which OUTPUT dataset the column belongs to (itemId); defaults to the first output. */
  outputItemId?: string;
  inputs: Array<{ inputItemId: string; column: string; transform?: string }>;
}

export interface EmitRunLineageInput {
  runType: RunType;
  runId: string;
  jobName: string;
  jobNamespace?: string;
  /** Defaults to COMPLETE (the only type that writes lineage — see mapRunEventToEdges). */
  eventType?: RunLineageEventType;
  eventTime?: string;
  inputs: RunDataset[];
  outputs: RunDataset[];
  columnLineage?: RunColumnLineage[];
}

// ── OL 1.x RunEvent (FULL shape, superset of the L2 minimal type) ─────────────

export interface OpenLineageFullDataset {
  namespace: string;
  name: string;
  facets?: Record<string, unknown>;
}
export interface OpenLineageFullRunEvent {
  eventType: RunLineageEventType;
  eventTime: string;
  producer: string;
  schemaURL: string;
  run: { runId: string; facets?: Record<string, unknown> };
  job: { namespace: string; name: string; facets?: Record<string, unknown> };
  inputs: OpenLineageFullDataset[];
  outputs: OpenLineageFullDataset[];
}

const LOOM_NAMESPACE = 'loom';

/** Synthesize the canonical dataset URI for a Loom item (physical URI wins). */
export function datasetUriForItem(d: RunDataset): string {
  if (d.uri && /^[a-z][a-z0-9+.-]*:\/\//i.test(d.uri.trim())) return d.uri.trim();
  return `loom://items/${d.itemType}/${d.itemId}`;
}

function datasetRef(d: RunDataset): OpenLineageFullDataset {
  const uri = datasetUriForItem(d);
  const facets: Record<string, unknown> = {};
  if (d.columns && d.columns.length) {
    facets.schema = {
      _producer: LOOM_OL_PRODUCER,
      _schemaURL: 'https://openlineage.io/spec/facets/1-0-1/SchemaDatasetFacet.json',
      fields: d.columns.map((c) => ({ name: c })),
    };
  }
  // Carry the Loom item identity so an OL consumer (and our own re-import) can
  // resolve the dataset back to the item.
  facets.loomItem = {
    _producer: LOOM_OL_PRODUCER,
    _schemaURL: 'https://openlineage.io/spec/facets/1-0-0/DatasourceDatasetFacet.json',
    itemId: d.itemId,
    itemType: d.itemType,
    name: d.name || d.itemId,
  };
  return { namespace: LOOM_NAMESPACE, name: uri, ...(Object.keys(facets).length ? { facets } : {}) };
}

/**
 * Build a spec-valid OpenLineage 1.x RunEvent from a Loom run. PURE — no I/O.
 * The `columnLineage` facet rides the FIRST output (or the output named by
 * `outputItemId`), shaped exactly as the L2 mapper + Marquez expect.
 */
export function buildRunEvent(input: EmitRunLineageInput): OpenLineageFullRunEvent {
  const eventType = input.eventType || 'COMPLETE';
  const outputs = input.outputs.map(datasetRef);
  const outByItem = new Map<string, OpenLineageFullDataset>();
  input.outputs.forEach((o, i) => outByItem.set(o.itemId, outputs[i]));
  const inByItem = new Map<string, RunDataset>();
  for (const i of input.inputs) inByItem.set(i.itemId, i);

  // Attach the columnLineage facet to the owning output dataset.
  for (const cl of input.columnLineage || []) {
    const outItemId = cl.outputItemId || input.outputs[0]?.itemId;
    if (!outItemId) continue;
    const outRef = outByItem.get(outItemId);
    if (!outRef) continue;
    outRef.facets = outRef.facets || {};
    const facet = (outRef.facets.columnLineage as {
      _producer?: string; _schemaURL?: string; fields?: Record<string, unknown>;
    } | undefined) || {
      _producer: LOOM_OL_PRODUCER,
      _schemaURL: 'https://openlineage.io/spec/facets/1-0-1/ColumnLineageDatasetFacet.json',
      fields: {},
    };
    facet.fields = facet.fields || {};
    (facet.fields as Record<string, unknown>)[cl.toColumn] = {
      inputFields: cl.inputs
        .map((f) => {
          const src = inByItem.get(f.inputItemId);
          if (!src) return null;
          return {
            namespace: LOOM_NAMESPACE,
            name: datasetUriForItem(src),
            field: f.column,
            ...(f.transform
              ? { transformations: [{ type: 'DIRECT', subtype: 'TRANSFORMATION', description: f.transform }] }
              : {}),
          };
        })
        .filter(Boolean),
    };
    outRef.facets.columnLineage = facet;
  }

  return {
    eventType,
    eventTime: input.eventTime || new Date().toISOString(),
    producer: LOOM_OL_PRODUCER,
    schemaURL: OL_RUNEVENT_SCHEMA_URL,
    run: {
      runId: input.runId,
      facets: {
        loomRun: {
          _producer: LOOM_OL_PRODUCER,
          _schemaURL: 'https://openlineage.io/spec/facets/1-0-0/RunFacet.json',
          runType: input.runType,
        },
      },
    },
    job: {
      namespace: input.jobNamespace || LOOM_NAMESPACE,
      name: input.jobName,
      facets: {
        jobType: {
          _producer: LOOM_OL_PRODUCER,
          _schemaURL: 'https://openlineage.io/spec/facets/2-0-2/JobTypeJobFacet.json',
          processingType: 'BATCH',
          integration: 'LOOM',
          jobType: input.runType.toUpperCase(),
        },
      },
    },
    inputs: input.inputs.map(datasetRef),
    outputs,
  };
}

export interface EmitReceipt {
  ok: boolean;
  eventType: RunLineageEventType;
  /** Item→item edges written to the L2 sink. */
  written: number;
  skipped: number;
  error?: string;
  /** The event that was built (for the export/interop artifact). */
  event: OpenLineageFullRunEvent;
}

/**
 * Emit a run's lineage: build the OL RunEvent, then persist it through the L2
 * pipeline — `mapRunEventToEdges` (the SAME pure mapper + fan-out caps L2 uses)
 * → `recordThreadEdge` (the SAME lineage sink). Non-throwing: a lineage write
 * must never fail the run that produced it (recordThreadEdge is itself
 * best-effort; this wrapper also swallows).
 *
 * Only COMPLETE events write edges (the mapper drops START/RUNNING/ABORT/FAIL) —
 * a run that didn't finish must not stamp lineage.
 */
export async function emitRunLineage(session: SessionPayload, input: EmitRunLineageInput): Promise<EmitReceipt> {
  const event = buildRunEvent(input);
  const base: EmitReceipt = { ok: true, eventType: event.eventType, written: 0, skipped: 0, event };
  try {
    // Reuse L2's caps up front (dataset fan-out) — an oversized run is rejected
    // here exactly as the ingest route rejects an oversized Spark event.
    const datasetCount = input.inputs.length + input.outputs.length;
    if (datasetCount > OL_MAX_DATASETS) {
      return { ...base, ok: false, error: `run names ${datasetCount} datasets (> ${OL_MAX_DATASETS} cap)` };
    }

    // Item lookup keyed by the SAME datasetUri the L2 mapper produces.
    const byUri = new Map<string, RunDataset>();
    for (const d of [...input.inputs, ...input.outputs]) {
      byUri.set(datasetUriForItem(d).toLowerCase(), d);
    }

    const mapped = mapRunEventToEdges(event as unknown as OpenLineageRunEvent);
    if (!mapped.ok) return { ...base, ok: false, error: mapped.error };

    let written = 0;
    let skipped = 0;
    for (const edge of mapped.edges as MappedOpenLineageEdge[]) {
      const from = byUri.get(edge.fromUri);
      const to = byUri.get(edge.toUri);
      if (!from || !to || from.itemId === to.itemId) {
        skipped += 1;
        continue;
      }
      await recordThreadEdge(session, {
        fromItemId: from.itemId,
        fromType: from.itemType,
        fromName: from.name,
        toItemId: to.itemId,
        toType: to.itemType,
        toName: to.name,
        action: `openlineage-${input.runType}`,
        ...(edge.columnMappings.length ? { columnMappings: edge.columnMappings } : {}),
      });
      written += 1;
    }
    return { ...base, written, skipped };
  } catch (e) {
    return { ...base, ok: false, error: (e as Error)?.message || String(e) };
  }
}

// ── OL 1.x export from the merged unified-lineage graph ──────────────────────

/** Structural subset of the unified graph the export consumes. */
export interface ExportGraphNode {
  id: string;
  label?: string;
  type?: string;
  identity?: string;
  columns?: string[];
}
export interface ExportGraphEdge {
  from: string;
  to: string;
  type?: string;
  kind?: string;
}

/**
 * Serialize a merged lineage graph ({nodes, edges} from getUnifiedLineage) into
 * an OpenLineage 1.x event STREAM (one COMPLETE RunEvent per table→table edge)
 * — the shape Marquez / DataHub / OpenMetadata ingest. Column (`col:`) edges are
 * folded into their owning table edge's columnLineage facet, not emitted as
 * standalone datasets, so the export reads at the asset grain like a real
 * lineage catalog. Pure + deterministic.
 */
export function unifiedGraphToOpenLineageEvents(
  nodes: ExportGraphNode[],
  edges: ExportGraphEdge[],
  eventTime = new Date().toISOString(),
): OpenLineageFullRunEvent[] {
  const byId = new Map<string, ExportGraphNode>();
  for (const n of nodes || []) if (n && n.id) byId.set(n.id, n);

  const dsName = (id: string): string => {
    const n = byId.get(id);
    return n?.identity || id;
  };
  const dataset = (id: string): OpenLineageFullDataset => {
    const n = byId.get(id);
    const facets: Record<string, unknown> = {};
    if (n?.columns && n.columns.length) {
      facets.schema = {
        _producer: LOOM_OL_PRODUCER,
        _schemaURL: 'https://openlineage.io/spec/facets/1-0-1/SchemaDatasetFacet.json',
        fields: n.columns.map((c) => ({ name: c })),
      };
    }
    return { namespace: LOOM_NAMESPACE, name: dsName(id), ...(Object.keys(facets).length ? { facets } : {}) };
  };

  const events: OpenLineageFullRunEvent[] = [];
  let seq = 0;
  for (const e of edges || []) {
    if (!e || !e.from || !e.to || e.from === e.to) continue;
    if (e.from.startsWith('col:') || e.to.startsWith('col:')) continue; // column edges fold into tables
    seq += 1;
    events.push({
      eventType: 'COMPLETE',
      eventTime,
      producer: LOOM_OL_PRODUCER,
      schemaURL: OL_RUNEVENT_SCHEMA_URL,
      run: { runId: `export-${seq}` },
      job: {
        namespace: LOOM_NAMESPACE,
        name: `lineage-edge:${dsName(e.from)}->${dsName(e.to)}`.slice(0, 512),
      },
      inputs: [dataset(e.from)],
      outputs: [dataset(e.to)],
    });
  }
  return events;
}
