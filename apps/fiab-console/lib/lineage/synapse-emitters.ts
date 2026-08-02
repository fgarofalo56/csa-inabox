/**
 * LU-8 — OpenLineage emitters for **Synapse Spark jobs** and **Synapse / ADF
 * pipeline runs**, feeding Loom's unified-lineage store.
 *
 * ## Why this exists
 *
 * L2 shipped the openlineage-spark LISTENER ingest (`POST /api/lineage/
 * openlineage`) — full-fidelity, column-level, but only live once an operator
 * stages the listener jar onto a Spark pool (`scripts/csa-loom/
 * openlineage-pool-setup.sh`, gate `svc-openlineage`). Until then the merged
 * lineage graph shows only natively-captured edges: nothing at all from a
 * Synapse **pipeline** run (no producer existed), and nothing from a Spark
 * batch submitted through a `spark-job-definition`.
 *
 * These emitters close that hole from the Loom side, with no operator action:
 * Loom already KNOWS what it submitted (the batch request it built) and what
 * the pipeline moved (the ADF pipeline definition + the activity runs that
 * actually executed), so it can produce spec-valid OpenLineage `RunEvent`s
 * server-side and write them through the SAME L2 pipeline. When the listener
 * IS wired, its richer events land on the same nodes (identical canonical
 * dataset names — see `dataset-naming.ts`) and simply add column detail.
 *
 * ## Conformance
 *
 * Events are OpenLineage `RunEvent`s (spec **1.0.5** — the schemaURL pinned in
 * `lib/lineage/openlineage.ts`; naming per the OpenLineage "Naming" spec, docs
 * release 1.52.0): `eventType` / `eventTime` / `producer` / `schemaURL` /
 * `run{runId,facets}` / `job{namespace,name,facets}` / `inputs[]` / `outputs[]`
 * with `schema` + `columnLineage` dataset facets. They are importable by
 * Marquez / DataHub / OpenMetadata unchanged — interoperability is the point of
 * this item, so nothing here is a Loom-shaped payload.
 *
 * `run.runId` is a deterministic RFC-4122 **UUIDv5** over the producing run's
 * natural key (pipeline runId / Livy batch id), so re-harvesting a run yields
 * the SAME OpenLineage run rather than a duplicate in a downstream catalog.
 *
 * PURE — every function here is a total function of its arguments. All I/O
 * (ADF reads, item resolution, the Cosmos write) lives in
 * `synapse-lineage-harvest.ts`.
 */

import crypto from 'node:crypto';
import type { OpenLineageDatasetRef } from '@/lib/azure/openlineage-ingest';
import {
  LOOM_OL_PRODUCER,
  OL_RUNEVENT_SCHEMA_URL,
  type OpenLineageFullRunEvent,
  type RunLineageEventType,
} from '@/lib/lineage/openlineage';
import {
  adfLocationToStorageUri,
  parseStorageUri,
  sqlDataset,
  storageDataset,
  type AdfFileLocation,
} from '@/lib/lineage/dataset-naming';
import { SPARK_CONF_INPUTS, SPARK_CONF_OUTPUTS } from '@/lib/lineage/spark-conf-keys';

// ---------------------------------------------------------------------------
// Deterministic run ids
// ---------------------------------------------------------------------------

/** Fixed namespace UUID for Loom-emitted OpenLineage run ids (random, frozen). */
const LOOM_RUN_UUID_NAMESPACE = 'b7f0f4c6-1d3a-5f2e-9c41-6a1e0d5b8a72';

/**
 * RFC-4122 **UUIDv5** (SHA-1, name-based) of `key` under the Loom run
 * namespace. Deterministic: the same pipeline run / Livy batch always maps to
 * the same OpenLineage `run.runId`, which is what makes re-emitting idempotent
 * for downstream OL consumers (our own sink is already idempotent because the
 * thread-edge document id is derived from the endpoints + action).
 */
export function deterministicRunId(key: string): string {
  const ns = Buffer.from(LOOM_RUN_UUID_NAMESPACE.replace(/-/g, ''), 'hex');
  // SHA-1 here is NOT a security primitive and is not interchangeable: RFC 4122
  // §4.3 DEFINES a version-5 UUID as SHA-1 over (namespace || name), and this
  // value is an OpenLineage `run.runId` that downstream consumers (Marquez,
  // DataHub, OpenMetadata) must be able to recompute independently. Swapping the
  // digest would silently fork every previously-emitted run id — including the
  // frozen goldens this module is pinned against — while buying nothing: there
  // is no secret, no signature, and no collision-resistance requirement. Nothing
  // is authenticated or authorized by it.
  // codeql[js/weak-cryptographic-algorithm]
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(key, 'utf8')])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Shared event assembly
// ---------------------------------------------------------------------------

/** A dataset plus the optional column set / column lineage it carries. */
export interface EmitDataset {
  ref: OpenLineageDatasetRef;
  columns?: string[];
}

/** One output-column ← input-column mapping declared by the producing run. */
export interface EmitColumnMapping {
  toColumn: string;
  fromColumn: string;
  /** The input dataset the source column belongs to. */
  from: OpenLineageDatasetRef;
  transform?: string;
}

export interface BuildEventInput {
  eventType: RunLineageEventType;
  eventTime: string;
  runId: string;
  jobNamespace: string;
  jobName: string;
  /** OpenLineage `jobType` facet — BATCH/STREAMING + the integration label. */
  integration: string;
  jobType: string;
  inputs: EmitDataset[];
  outputs: EmitDataset[];
  columnMappings?: EmitColumnMapping[];
  /** Extra `run` facet fields (run status, duration, activity name…). */
  runFacet?: Record<string, unknown>;
}

function schemaFacet(columns: string[]): Record<string, unknown> {
  return {
    _producer: LOOM_OL_PRODUCER,
    _schemaURL: 'https://openlineage.io/spec/facets/1-0-1/SchemaDatasetFacet.json',
    fields: columns.map((c) => ({ name: c })),
  };
}

function toDatasetRef(d: EmitDataset): OpenLineageDatasetRef {
  const facets: Record<string, unknown> = {};
  if (d.columns && d.columns.length) facets.schema = schemaFacet(d.columns);
  return {
    namespace: d.ref.namespace,
    name: d.ref.name,
    ...(Object.keys(facets).length ? { facets } : {}),
  };
}

/**
 * Assemble a spec-valid RunEvent. The `columnLineage` facet rides the OUTPUT
 * dataset, keyed by output column, with `inputFields[]` naming the input
 * dataset by the SAME `{namespace,name}` split used in `inputs[]` — that
 * identity match is what `mapRunEventToEdges` needs to attach a mapping to the
 * right input→output edge.
 */
export function buildEvent(input: BuildEventInput): OpenLineageFullRunEvent {
  const outputs = input.outputs.map(toDatasetRef) as Array<
    OpenLineageDatasetRef & { facets?: Record<string, unknown> }
  >;
  const outByKey = new Map<string, (typeof outputs)[number]>();
  outputs.forEach((o) => outByKey.set(`${o.namespace}|${o.name}`, o));

  for (const m of input.columnMappings || []) {
    // A mapping with no explicit output target rides the first output.
    const target = outputs[0];
    if (!target) continue;
    target.facets = target.facets || {};
    const facet =
      (target.facets.columnLineage as { fields?: Record<string, unknown> } | undefined) || {
        _producer: LOOM_OL_PRODUCER,
        _schemaURL: 'https://openlineage.io/spec/facets/1-0-1/ColumnLineageDatasetFacet.json',
        fields: {} as Record<string, unknown>,
      };
    const fields = (facet.fields || {}) as Record<string, { inputFields: unknown[] }>;
    const entry = fields[m.toColumn] || { inputFields: [] };
    entry.inputFields.push({
      namespace: m.from.namespace,
      name: m.from.name,
      field: m.fromColumn,
      ...(m.transform
        ? { transformations: [{ type: 'DIRECT', subtype: 'TRANSFORMATION', description: m.transform }] }
        : {}),
    });
    fields[m.toColumn] = entry;
    facet.fields = fields;
    target.facets.columnLineage = facet;
  }

  return {
    eventType: input.eventType,
    eventTime: input.eventTime,
    producer: LOOM_OL_PRODUCER,
    schemaURL: OL_RUNEVENT_SCHEMA_URL,
    run: {
      runId: input.runId,
      facets: {
        loomRun: {
          _producer: LOOM_OL_PRODUCER,
          _schemaURL: 'https://openlineage.io/spec/facets/1-0-0/RunFacet.json',
          ...(input.runFacet || {}),
        },
      },
    },
    job: {
      namespace: input.jobNamespace,
      name: input.jobName,
      facets: {
        jobType: {
          _producer: LOOM_OL_PRODUCER,
          _schemaURL: 'https://openlineage.io/spec/facets/2-0-2/JobTypeJobFacet.json',
          processingType: 'BATCH',
          integration: input.integration,
          jobType: input.jobType,
        },
      },
    },
    inputs: input.inputs.map(toDatasetRef),
    outputs: outputs as OpenLineageDatasetRef[],
  };
}

// ---------------------------------------------------------------------------
// Synapse / ADF pipeline runs
// ---------------------------------------------------------------------------

/** A resolved ADF dataset: its definition plus the account url of its linked service. */
export interface ResolvedAdfDataset {
  name: string;
  /** `.properties.type`, e.g. `DelimitedText` / `Parquet` / `AzureSqlDWTable`. */
  type?: string;
  location?: AdfFileLocation;
  /** `https://acct.dfs.<suffix>` (AzureBlobFS.url / AzureBlobStorage.serviceEndpoint). */
  linkedServiceUrl?: string;
  /** SQL: the server host from the linked service (when it is a literal, not a KV ref). */
  sqlServer?: string;
  sqlDatabase?: string;
  sqlSchema?: string;
  sqlTable?: string;
  /** Declared column names (dataset `schema[]` / `structure[]`). */
  columns?: string[];
}

/** One Copy activity's resolved source/sink + declared column translator. */
export interface CopyActivityLineage {
  activityName: string;
  activityType: string;
  source?: ResolvedAdfDataset;
  sink?: ResolvedAdfDataset;
  /** `typeProperties.translator.mappings[]` → declared column mappings. */
  columnMappings?: Array<{ fromColumn: string; toColumn: string }>;
  status?: string;
}

export interface PipelineRunLineageInput {
  /** ADF/Synapse factory or workspace name (the job namespace authority). */
  factoryName: string;
  pipelineName: string;
  /** The ADF pipeline run id (a GUID) — the natural key for the OL run id. */
  runId: string;
  runStatus?: string;
  runEnd?: string;
  activities: CopyActivityLineage[];
}

/**
 * Turn a resolved ADF dataset into its canonical OpenLineage dataset ref, or
 * null when it names no resolvable physical asset (an un-anchored file location
 * or a table with no name). Null is honest: no node beats a node that joins to
 * nothing.
 */
export function adfDatasetRef(ds: ResolvedAdfDataset | undefined): OpenLineageDatasetRef | null {
  if (!ds) return null;
  if (ds.sqlTable) {
    const ref = sqlDataset({
      server: ds.sqlServer,
      database: ds.sqlDatabase,
      schema: ds.sqlSchema,
      table: ds.sqlTable,
    });
    return ref.name ? ref : null;
  }
  const uri = adfLocationToStorageUri(ds.location, ds.linkedServiceUrl);
  if (!uri) return null;
  return storageDataset(uri);
}

/**
 * Build ONE OpenLineage RunEvent per lineage-bearing activity of a pipeline
 * run. A pipeline is a DAG of activities, and OpenLineage models each unit of
 * work as its own job — emitting per activity (job name
 * `<pipeline>.<activity>`) preserves which step moved which data, exactly as
 * the Airflow/ADF OL integrations do, instead of collapsing a 12-activity
 * pipeline into one opaque edge.
 *
 * Only **Succeeded** activities are emitted as `COMPLETE`; anything else is
 * emitted as `FAIL`/`ABORT` (which `mapRunEventToEdges` deliberately drops) so
 * a failed copy never stamps lineage that did not happen.
 */
export function pipelineRunEvents(input: PipelineRunLineageInput): OpenLineageFullRunEvent[] {
  const events: OpenLineageFullRunEvent[] = [];
  for (const act of input.activities) {
    const from = adfDatasetRef(act.source);
    const to = adfDatasetRef(act.sink);
    if (!from || !to) continue;
    const status = (act.status || input.runStatus || '').toLowerCase();
    const eventType: RunLineageEventType =
      status === 'succeeded' ? 'COMPLETE' : status === 'cancelled' || status === 'skipped' ? 'ABORT' : 'FAIL';
    events.push(
      buildEvent({
        eventType,
        eventTime: input.runEnd || new Date().toISOString(),
        runId: deterministicRunId(`adf:${input.factoryName}:${input.runId}:${act.activityName}`),
        jobNamespace: `adf://${input.factoryName.toLowerCase()}`,
        jobName: `${input.pipelineName}.${act.activityName}`.slice(0, 512),
        integration: 'SYNAPSE_PIPELINE',
        jobType: act.activityType?.toUpperCase() || 'COPY',
        inputs: [{ ref: from, ...(act.source?.columns?.length ? { columns: act.source.columns } : {}) }],
        outputs: [{ ref: to, ...(act.sink?.columns?.length ? { columns: act.sink.columns } : {}) }],
        columnMappings: (act.columnMappings || []).map((m) => ({
          toColumn: m.toColumn,
          fromColumn: m.fromColumn,
          from,
        })),
        runFacet: {
          adfPipelineRunId: input.runId,
          activityName: act.activityName,
          activityStatus: act.status || input.runStatus || 'Unknown',
        },
      }),
    );
  }
  return events;
}

/**
 * Extract the declared column mappings from an ADF Copy activity's
 * `typeProperties.translator` (TabularTranslator). Real ADF shape:
 *   `mappings: [{ source: { name | path | ordinal }, sink: { name | path } }]`
 * A mapping whose either side has no usable name is dropped (never guessed).
 */
export function translatorColumnMappings(
  translator: unknown,
): Array<{ fromColumn: string; toColumn: string }> {
  const t = translator as { mappings?: unknown } | undefined;
  if (!t || !Array.isArray(t.mappings)) return [];
  const out: Array<{ fromColumn: string; toColumn: string }> = [];
  for (const m of t.mappings) {
    const row = m as { source?: Record<string, unknown>; sink?: Record<string, unknown> } | undefined;
    const src = colName(row?.source);
    const snk = colName(row?.sink);
    if (src && snk) out.push({ fromColumn: src, toColumn: snk });
  }
  return out;
}

/** `{ name }` wins, else the leaf of a hierarchical `{ path }` (`$['a']['b']`). */
function colName(side: Record<string, unknown> | undefined): string {
  if (!side) return '';
  const name = typeof side.name === 'string' ? side.name.trim() : '';
  if (name) return name;
  const path = typeof side.path === 'string' ? side.path.trim() : '';
  if (!path) return '';
  const leaf = path.match(/\['([^']+)'\]\s*$/);
  return leaf ? leaf[1] : path.replace(/^\$\.?/, '');
}

// ---------------------------------------------------------------------------
// Synapse Spark batch jobs (spark-job-definition / Livy batch)
// ---------------------------------------------------------------------------

/** CLI flags a Spark job conventionally uses to name its input datasets. */
const INPUT_FLAGS = new Set(['--input', '--inputs', '--in', '--source', '--src', '--read', '--from', '-i']);
/** CLI flags a Spark job conventionally uses to name its output datasets. */
const OUTPUT_FLAGS = new Set(['--output', '--outputs', '--out', '--sink', '--dest', '--target', '--write', '--to', '-o']);

/**
 * Loom-namespaced Spark conf keys that DECLARE a job's datasets explicitly.
 *
 * Defined in the dependency-free `spark-conf-keys` leaf and re-exported here so
 * existing server-side callers keep their import path. The client half of the
 * #2625 Fix-it wizard imports the leaf DIRECTLY — importing it from this module
 * would pull this file's `openlineage` → … → `auth/session` (`next/headers`)
 * chain into the browser bundle and break `next build`.
 */
export { SPARK_CONF_INPUTS, SPARK_CONF_OUTPUTS };

export interface SparkBatchLineageInput {
  /** Synapse workspace name (job namespace authority). */
  workspaceName: string;
  poolName: string;
  /** Livy batch id — the natural key for the deterministic OL run id. */
  batchId: number | string;
  /** Job display name (the SJD item name / batch `name`). */
  jobName: string;
  /** Livy batch state: `success` | `dead` | `killed` | `running` | … */
  state?: string;
  args?: string[];
  conf?: Record<string, string>;
  eventTime?: string;
}

/**
 * Parse the datasets a Spark batch reads and writes from what Loom actually
 * submitted. Two REAL sources, in precedence order:
 *
 *  1. `spark.loom.lineage.inputs` / `.outputs` conf — an explicit, comma- or
 *     semicolon-separated declaration (what a Loom-authored job or an
 *     `environment` item sets when the job's IO isn't in argv).
 *  2. `--input` / `--output` style argv flags (`--input abfss://…` and
 *     `--input=abfss://…` both), the near-universal convention for Spark
 *     submits and the shape Loom's own content-bundle jobs use.
 *
 * Anything that is not a parseable Azure storage location is IGNORED — a bare
 * `--input customers` names nothing joinable, and inventing a node for it would
 * be exactly the fabricated-lineage failure this module exists to prevent.
 * When neither source yields both an input and an output, the caller emits
 * nothing (the listener path remains the higher-fidelity option).
 */
export function parseSparkDatasets(input: SparkBatchLineageInput): {
  inputs: OpenLineageDatasetRef[];
  outputs: OpenLineageDatasetRef[];
} {
  const inputs: string[] = [];
  const outputs: string[] = [];

  const pushDeclared = (raw: string | undefined, into: string[]) => {
    for (const part of String(raw || '').split(/[,;]/)) {
      const v = part.trim();
      if (v) into.push(v);
    }
  };
  pushDeclared(input.conf?.[SPARK_CONF_INPUTS], inputs);
  pushDeclared(input.conf?.[SPARK_CONF_OUTPUTS], outputs);

  const args = input.args || [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] || '').trim();
    if (!a) continue;
    const eq = a.indexOf('=');
    const flag = (eq > 0 ? a.slice(0, eq) : a).toLowerCase();
    const inline = eq > 0 ? a.slice(eq + 1) : '';
    const bucket = INPUT_FLAGS.has(flag) ? inputs : OUTPUT_FLAGS.has(flag) ? outputs : null;
    if (!bucket) continue;
    if (inline) pushDeclared(inline, bucket);
    else if (i + 1 < args.length) { pushDeclared(args[i + 1], bucket); i += 1; }
  }

  const toRefs = (list: string[]): OpenLineageDatasetRef[] => {
    const seen = new Set<string>();
    const out: OpenLineageDatasetRef[] = [];
    for (const v of list) {
      if (!parseStorageUri(v)) continue; // not a joinable physical dataset
      const ref = storageDataset(v);
      const k = `${ref.namespace}|${ref.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(ref);
    }
    return out;
  };
  return { inputs: toRefs(inputs), outputs: toRefs(outputs) };
}

/**
 * Build the RunEvent for one Synapse Spark batch. Returns null when the batch
 * declared no joinable input+output pair — emitting an edge-less event would be
 * noise, and a half-resolved one would be a lie.
 *
 * `eventType` follows the Livy batch state: only `success` is `COMPLETE`.
 */
export function sparkBatchRunEvent(input: SparkBatchLineageInput): OpenLineageFullRunEvent | null {
  const { inputs, outputs } = parseSparkDatasets(input);
  if (!inputs.length || !outputs.length) return null;
  const state = (input.state || '').toLowerCase();
  const eventType: RunLineageEventType =
    state === 'success' ? 'COMPLETE' : state === 'killed' ? 'ABORT' : state === 'dead' || state === 'error' ? 'FAIL' : 'RUNNING';
  return buildEvent({
    eventType,
    eventTime: input.eventTime || new Date().toISOString(),
    // The submit time is part of the natural key: Livy batch ids restart from 0
    // when a Synapse pool is recreated (loompool → loompool2 already happened in
    // this estate), so `workspace:pool:batchId` alone conflates two genuinely
    // different runs under ONE OpenLineage run id in every downstream catalog.
    runId: deterministicRunId(
      `synapse-spark:${input.workspaceName}:${input.poolName}:${input.batchId}:${input.eventTime || ''}`,
    ),
    // Mirrors the openlineage-spark listener's namespace convention so a
    // listener-emitted run and a Loom-emitted run for the same pool sort
    // together in a downstream catalog.
    jobNamespace: `synapse://${input.workspaceName.toLowerCase()}/sparkPools/${input.poolName.toLowerCase()}`,
    jobName: input.jobName.slice(0, 512),
    integration: 'SYNAPSE_SPARK',
    jobType: 'JOB',
    inputs: inputs.map((ref) => ({ ref })),
    outputs: outputs.map((ref) => ({ ref })),
    runFacet: { livyBatchId: String(input.batchId), sparkPool: input.poolName, batchState: input.state || 'unknown' },
  });
}
