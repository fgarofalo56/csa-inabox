/**
 * OpenLineage → Loom column-lineage mapper (loom-next-level L2).
 *
 * PURE, SDK-free translation of an OpenLineage `RunEvent` (as emitted by the
 * openlineage-spark listener on a Synapse Spark pool) into the L1 column model:
 * `RecordEdgeInput.columnMappings` rows (`confidence:'declared'`) keyed by the
 * physical dataset URIs the event names. The BFF ingest route
 * (`app/api/lineage/openlineage/route.ts`) owns EVERYTHING impure — auth,
 * workspace scoping, rate/size caps, Cosmos item resolution, and the
 * `recordThreadEdge` write — so this module stays fully unit-testable against
 * golden RunEvent fixtures (openlineage-ingest.test.ts).
 *
 * OpenLineage grounding (spec 1.x / openlineage-spark):
 *   - RunEvent: { eventType, eventTime, run.runId, job{namespace,name},
 *     inputs[], outputs[] } where each dataset is { namespace, name, facets }.
 *     For abfss datasets the Spark integration emits
 *     namespace = 'abfss://<container>@<account>.dfs.<suffix>' and
 *     name = '/<path>' — the physical URI is their join.
 *   - Column lineage rides the OUTPUT dataset's `columnLineage` facet:
 *     facets.columnLineage.fields.<outputColumn>.inputFields[] =
 *     { namespace, name, field, transformations?[] }.
 *
 * Security redesign (rev 2, SRE F2) — the caps enforced HERE are the pure half
 * of the binding limits: dataset fan-out and columnMappings fan-out per event
 * (Cosmos-write-amplification guard). The byte cap + rate limit + auth live in
 * the route.
 */

import type { ThreadColumnMapping } from '@/lib/thread/thread-edges';

// ── Binding caps (rev-2 security redesign #3) ───────────────────────────────
/** Body-size cap for one POSTed RunEvent — mirrors the eventhouse ingest
 *  route's explicit MAX_FILE_BYTES (5 MB). Enforced by the route (413). */
export const OL_MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Max datasets (inputs + outputs) one RunEvent may name. */
export const OL_MAX_DATASETS = 50;
/** Max column→column mappings one RunEvent may fan out to (write-amp guard). */
export const OL_MAX_COLUMN_MAPPINGS = 500;

const OL_EVENT_TYPES = new Set(['START', 'RUNNING', 'COMPLETE', 'ABORT', 'FAIL', 'OTHER']);

export interface OpenLineageDatasetRef {
  namespace: string;
  name: string;
  facets?: Record<string, unknown>;
}

export interface OpenLineageRunEvent {
  eventType: string;
  eventTime?: string;
  run: { runId: string };
  job: { namespace?: string; name: string };
  inputs: OpenLineageDatasetRef[];
  outputs: OpenLineageDatasetRef[];
}

/** One physical input→output dataset edge derived from a RunEvent, carrying
 *  the L1 column mappings declared by the `columnLineage` facet. */
export interface MappedOpenLineageEdge {
  /** Canonical physical URI of the input dataset (e.g. abfss://…). */
  fromUri: string;
  /** Canonical physical URI of the output dataset. */
  toUri: string;
  /** The Spark job that produced the edge (namespace/name). */
  jobName: string;
  runId: string;
  columnMappings: ThreadColumnMapping[];
}

export type ParseResult =
  | { ok: true; event: OpenLineageRunEvent }
  | { ok: false; error: string; code: 'invalid_event' };

export type MapResult =
  | { ok: true; edges: MappedOpenLineageEdge[] }
  | { ok: false; error: string; code: 'dataset_fanout' | 'column_mapping_fanout' };

/**
 * Join an OpenLineage dataset { namespace, name } into ONE canonical physical
 * URI. The Spark integration splits abfss URIs as namespace = scheme+authority
 * and name = path; other producers put the whole URI in `name`. Lowercased so
 * the result feeds `unified-lineage.normalizeIdentity` (`path:` keys are
 * lowercase) and prefix-matching is case-stable.
 */
export function datasetUri(ds: OpenLineageDatasetRef): string {
  const ns = String(ds.namespace || '').trim().replace(/\/+$/, '');
  const name = String(ds.name || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) return name.toLowerCase();
  if (!ns) return name.toLowerCase();
  return `${ns}/${name.replace(/^\/+/, '')}`.toLowerCase();
}

/** Compress an OpenLineage `transformations[]` entry into the L1 `transform`
 *  string (e.g. "DIRECT:IDENTITY"). Absent/empty → undefined (1:1 implied). */
function transformLabel(t: unknown): string | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const o = t as { type?: unknown; subtype?: unknown; description?: unknown };
  const desc = typeof o.description === 'string' && o.description.trim() ? o.description.trim() : '';
  const type = typeof o.type === 'string' ? o.type.trim() : '';
  const sub = typeof o.subtype === 'string' ? o.subtype.trim() : '';
  const kind = [type, sub].filter(Boolean).join(':');
  const label = desc || kind;
  return label ? label.slice(0, 200) : undefined;
}

function isDatasetRef(d: unknown): d is OpenLineageDatasetRef {
  if (!d || typeof d !== 'object') return false;
  const o = d as { namespace?: unknown; name?: unknown };
  // namespace may be empty (whole URI in name) but both must be strings.
  return typeof o.name === 'string' && o.name.trim().length > 0
    && (o.namespace === undefined || typeof o.namespace === 'string');
}

/**
 * Schema-validate a decoded JSON body into an {@link OpenLineageRunEvent}.
 * Strict on the fields the mapper consumes (spec-shaped), tolerant of extra
 * facets. Enforces the dataset fan-out cap here so an oversized event is
 * rejected before any per-dataset work.
 */
export function parseRunEvent(raw: unknown): ParseResult {
  const bad = (error: string): ParseResult => ({ ok: false, error, code: 'invalid_event' });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('body must be a single OpenLineage RunEvent object');
  const o = raw as Record<string, unknown>;
  const eventType = String(o.eventType || '').toUpperCase();
  if (!OL_EVENT_TYPES.has(eventType)) return bad(`eventType must be one of ${[...OL_EVENT_TYPES].join('/')}`);
  const run = o.run as { runId?: unknown } | undefined;
  const runId = run && typeof run === 'object' ? String(run.runId || '').trim() : '';
  if (!runId || runId.length > 128) return bad('run.runId is required (max 128 chars)');
  const job = o.job as { namespace?: unknown; name?: unknown } | undefined;
  const jobName = job && typeof job === 'object' ? String(job.name || '').trim() : '';
  if (!jobName || jobName.length > 512) return bad('job.name is required (max 512 chars)');
  const inputs = Array.isArray(o.inputs) ? o.inputs : [];
  const outputs = Array.isArray(o.outputs) ? o.outputs : [];
  for (const d of [...inputs, ...outputs]) {
    if (!isDatasetRef(d)) return bad('every dataset needs a string `name` (and optional string `namespace`)');
  }
  return {
    ok: true,
    event: {
      eventType,
      eventTime: typeof o.eventTime === 'string' ? o.eventTime : undefined,
      run: { runId },
      job: { namespace: job && typeof job.namespace === 'string' ? job.namespace : undefined, name: jobName },
      inputs: inputs as OpenLineageDatasetRef[],
      outputs: outputs as OpenLineageDatasetRef[],
    },
  };
}

interface ColumnLineageFacet {
  fields?: Record<string, { inputFields?: Array<{
    namespace?: string; name?: string; field?: string; transformations?: unknown[];
  }> }>;
}

/**
 * Map a validated RunEvent into input→output dataset edges with declared
 * column mappings (L1 `confidence:'declared'`).
 *
 * Only terminal `COMPLETE` events produce edges — START/RUNNING are
 * acknowledged with zero edges (a run that never completed must not write
 * lineage), and ABORT/FAIL likewise (the write may not have happened).
 * Enforces {@link OL_MAX_DATASETS} + {@link OL_MAX_COLUMN_MAPPINGS}.
 */
export function mapRunEventToEdges(event: OpenLineageRunEvent): MapResult {
  if (event.eventType !== 'COMPLETE') return { ok: true, edges: [] };
  const datasetCount = event.inputs.length + event.outputs.length;
  if (datasetCount > OL_MAX_DATASETS) {
    return { ok: false, code: 'dataset_fanout', error: `RunEvent names ${datasetCount} datasets (> ${OL_MAX_DATASETS} cap)` };
  }
  const jobName = `${event.job.namespace ? `${event.job.namespace}/` : ''}${event.job.name}`;
  const edges: MappedOpenLineageEdge[] = [];
  let totalMappings = 0;

  for (const output of event.outputs) {
    const toUri = datasetUri(output);
    if (!toUri) continue;
    const facet = (output.facets as { columnLineage?: ColumnLineageFacet } | undefined)?.columnLineage;
    // Group the facet's inputFields by their OWNING input dataset URI so each
    // input→output edge only carries its own columns.
    const byInput = new Map<string, ThreadColumnMapping[]>();
    for (const [outCol, spec] of Object.entries(facet?.fields || {})) {
      if (!outCol || !spec || typeof spec !== 'object') continue;
      for (const f of spec.inputFields || []) {
        const field = typeof f?.field === 'string' ? f.field.trim() : '';
        if (!field) continue;
        const uri = datasetUri({ namespace: f.namespace || '', name: f.name || '' });
        if (!uri) continue;
        totalMappings += 1;
        if (totalMappings > OL_MAX_COLUMN_MAPPINGS) {
          return {
            ok: false, code: 'column_mapping_fanout',
            error: `RunEvent declares more than ${OL_MAX_COLUMN_MAPPINGS} column mappings (write-amplification cap)`,
          };
        }
        const transform = transformLabel((f.transformations || [])[0]);
        const list = byInput.get(uri) || [];
        list.push({
          fromColumn: field,
          toColumn: outCol,
          ...(transform ? { transform } : {}),
          confidence: 'declared',
        });
        byInput.set(uri, list);
      }
    }
    for (const input of event.inputs) {
      const fromUri = datasetUri(input);
      if (!fromUri || fromUri === toUri) continue;
      edges.push({
        fromUri,
        toUri,
        jobName,
        runId: event.run.runId,
        columnMappings: byInput.get(fromUri) || [],
      });
    }
  }
  return { ok: true, edges };
}
