/**
 * Mirrored-Database change feed → Event Hubs producer (rel-T90).
 *
 * The Azure-native equivalent of Fabric's "Mirrored database change feed"
 * Eventstream source — with NO Microsoft Fabric dependency
 * (no-fabric-dependency.md). A Loom mirrored database replicates its source
 * into a **managed Delta table** on ADLS Gen2 Bronze
 * (`mirrors/<workspaceId>/<mirrorId>/Tables/<table>`). This module turns that
 * Delta table's **change data feed** into a live Event Hubs producer:
 *
 *   1. PROVISION (`provisionMirrorCdf`): ensure the sink Event Hub exists (real
 *      ARM PUT), then submit a **Synapse Spark Livy batch** that reads each
 *      table's Delta CDF (`spark.read.format("delta").option("readChangeFeed",
 *      "true").option("startingVersion", N)`) — exactly the pattern in the
 *      Fabric/Databricks "Use change data feed with Delta tables" docs — and
 *      writes the change rows (data columns + `_change_type` / `_commit_version`
 *      / `_commit_timestamp`) as newline-delimited JSON to a Bronze staging
 *      folder. Real Spark job, no mock.
 *   2. DRAIN (`drainMirrorCdf`): read the staged JSON with the ADLS client and
 *      **produce every change row to the Event Hub** over the real HTTPS
 *      data-plane REST (`sendEvents`, Entra auth — works on a disableLocalAuth
 *      namespace). The Event Hub is the ingest endpoint the downstream ASA
 *      operators read.
 *
 * Honest infra gates (no-vaporware.md): LOOM_BRONZE_URL (the Delta source),
 * LOOM_SYNAPSE_WORKSPACE + a Spark pool (the CDF reader), and the Event Hubs
 * namespace (the sink). Each returns a precise, user-actionable message — the
 * full editor surface still renders.
 */

import { submitSparkBatchJob, type SparkBatchRequest } from './synapse-dev-client';
import {
  uploadFile, listPaths, downloadFile, resolveAbfssRoot, type PathEntry,
} from './adls-client';
import { eventhubsConfigGate, createEventHub } from './eventhubs-client';
import { readEventHubsDataConfig, sendEvents, type SendEvent } from './eventhubs-data-client';

const BRONZE = 'bronze' as const;
/** Bronze path the inline PySpark CDF-reader script is uploaded to before each run. */
const CDF_SCRIPT_PATH = 'scripts/mirror-cdf-reader.py';

export interface MirrorCdfTableSpec {
  /** Table identifier as recorded on the mirror (e.g. "dbo.Orders"). */
  name: string;
  /** abfss:// path to the table's managed Delta table (Bronze Tables root). */
  deltaPath: string;
}

export interface MirrorCdfGate {
  missing: string;
  message: string;
}

export interface MirrorCdfProvisionResult {
  ok: boolean;
  status: 'Submitted' | 'Gated' | 'Error';
  /** Event Hub entity that IS the ingest endpoint (downstream operators read it). */
  hub: string;
  fqdn?: string;
  /** Livy batch id of the CDF-reader job. */
  jobId?: number;
  /** abfss:// staging folder the Spark job writes change rows to. */
  stagePath?: string;
  tables: MirrorCdfTableSpec[];
  note: string;
  gate?: MirrorCdfGate;
  error?: string;
}

export interface MirrorCdfDrainResult {
  ok: boolean;
  status: 'Produced' | 'NoStagedFiles' | 'Gated' | 'Error';
  hub: string;
  produced: number;
  files: number;
  note: string;
  gate?: MirrorCdfGate;
  error?: string;
}

/** Synapse Spark pool that runs the CDF reader (same convention as other jobs). */
function cdfPool(): string {
  return (
    process.env.LOOM_OPEN_MIRROR_POOL ||
    process.env.LOOM_SYNAPSE_SPARK_POOL ||
    process.env.LOOM_SPARK_POOL ||
    'loompool'
  ).trim();
}

/** Honest infra gate shared by provision + drain. Null = ready. */
function cdfGate(needSpark: boolean): MirrorCdfGate | null {
  const eh = eventhubsConfigGate();
  if (eh) {
    return {
      missing: eh.missing,
      message: `Event Hubs namespace not configured — set ${eh.missing} so the mirror change feed has a sink Event Hub to produce to.`,
    };
  }
  if (!process.env.LOOM_BRONZE_URL) {
    return {
      missing: 'LOOM_BRONZE_URL',
      message: 'ADLS Bronze not configured — set LOOM_BRONZE_URL so the mirror\'s managed Delta change feed can be read.',
    };
  }
  if (needSpark && !process.env.LOOM_SYNAPSE_WORKSPACE) {
    return {
      missing: 'LOOM_SYNAPSE_WORKSPACE',
      message:
        'Synapse workspace not configured — set LOOM_SYNAPSE_WORKSPACE (and a Spark pool via LOOM_SPARK_POOL) ' +
        'so the Delta change-data-feed reader batch can be submitted.',
    };
  }
  return null;
}

/** Sink Event Hub name for a mirror-cdf source on an eventstream (idempotent, EH-safe). */
export function mirrorCdfHubName(eventstreamId: string, nodeIdx: number): string {
  const slug = (eventstreamId || 'es').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `loom-mirrorcdf-${slug}-${Math.max(0, nodeIdx)}`.slice(0, 50);
}

/** Bronze staging folder (abfss) for one eventstream source's CDF rows. */
export function mirrorCdfStagePath(mirrorWorkspaceId: string, mirrorId: string, eventstreamId: string): string | null {
  return resolveAbfssRoot(BRONZE, `mirrors/${mirrorWorkspaceId}/${mirrorId}/_cdf_stage/${eventstreamId}`);
}

/** Resolve a table's managed Delta table abfss path under the mirror's Bronze Tables root. */
export function mirrorCdfDeltaPath(mirrorWorkspaceId: string, mirrorId: string, table: string): string | null {
  const folder = String(table || '').replace(/[/\\]+/g, '_').trim();
  return resolveAbfssRoot(BRONZE, `mirrors/${mirrorWorkspaceId}/${mirrorId}/Tables/${folder}`);
}

/**
 * PySpark CDF reader — for each mirror table, read the Delta change data feed
 * (readChangeFeed from `starting_version`) and write the flattened change rows
 * (data columns + `_change_type` / `_commit_version` / `_commit_timestamp` +
 * `__source_table`) to the Bronze staging folder as newline-delimited JSON.
 * If CDF isn't enabled on the table yet, it falls back to the current snapshot
 * as `insert` rows (so the producer still emits REAL data) and turns CDF on for
 * future changes. Uploaded to Bronze (idempotent) then run as a Livy batch.
 */
const CDF_READER_SCRIPT = `\
from pyspark.sql import SparkSession
from pyspark.sql.functions import lit, current_timestamp
import json, sys

stage_path   = sys.argv[1]   # abfss://bronze@<acct>/mirrors/<ws>/<mirror>/_cdf_stage/<esId>
start_version = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].strip() else 0
tables = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].strip() else []

spark = (SparkSession.builder
    .appName("loom-mirror-cdf-reader")
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
    .config("spark.sql.catalog.spark_catalog",
            "org.apache.spark.sql.delta.catalog.DeltaCatalog")
    .getOrCreate())

total = 0
for t in tables:
    name = t.get("name")
    delta_path = t.get("deltaPath")
    if not delta_path:
        continue
    try:
        df = (spark.read.format("delta")
              .option("readChangeFeed", "true")
              .option("startingVersion", start_version)
              .load(delta_path))
    except Exception:
        # CDF not enabled yet (or version out of range) → emit the current
        # snapshot as inserts and enable CDF so future changes are captured.
        try:
            spark.sql("ALTER TABLE delta.\`%s\` SET TBLPROPERTIES (delta.enableChangeDataFeed = true)" % delta_path)
        except Exception:
            pass
        df = (spark.read.format("delta").load(delta_path)
              .withColumn("_change_type", lit("insert"))
              .withColumn("_commit_version", lit(0))
              .withColumn("_commit_timestamp", current_timestamp()))
    df = df.withColumn("__source_table", lit(name))
    n = df.count()
    total += n
    (df.write.mode("append").json(stage_path))

print("LOOM_CDF_RESULT: rows=%d tables=%d stage=%s" % (total, len(tables), stage_path))
`;

/**
 * Provision the mirror-cdf producer: ensure the sink Event Hub + submit the
 * Synapse Spark CDF-reader batch. Returns the ingest endpoint (the hub), the
 * Livy batch id, and the staging path. Honest gate when infra is missing.
 */
export async function provisionMirrorCdf(args: {
  eventstreamId: string;
  nodeIdx: number;
  mirrorId: string;
  mirrorWorkspaceId: string;
  tables: string[];
  startingVersion?: number;
}): Promise<MirrorCdfProvisionResult> {
  const note =
    'Azure-native mirrored-database change feed (no Microsoft Fabric): a Synapse Spark batch reads the ' +
    "mirror's managed Delta change data feed and stages the change rows; \"Produce staged changes\" then " +
    'sends them to the Event Hub over the HTTPS data plane.';
  const hub = mirrorCdfHubName(args.eventstreamId, args.nodeIdx);

  const gate = cdfGate(true);
  if (gate) return { ok: false, status: 'Gated', hub, tables: [], note, gate };

  if (!args.mirrorId || !args.mirrorWorkspaceId) {
    return { ok: false, status: 'Error', hub, tables: [], note, error: 'Select a mirrored database first.' };
  }
  const tableNames = (args.tables || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!tableNames.length) {
    return { ok: false, status: 'Error', hub, tables: [], note, error: 'Select at least one mirror table to read the change feed from.' };
  }

  const stagePath = mirrorCdfStagePath(args.mirrorWorkspaceId, args.mirrorId, args.eventstreamId);
  if (!stagePath) {
    return { ok: false, status: 'Gated', hub, tables: [], note, gate: { missing: 'LOOM_BRONZE_URL', message: 'Could not resolve the Bronze staging abfss path — check LOOM_BRONZE_URL.' } };
  }

  const tableSpecs: MirrorCdfTableSpec[] = [];
  for (const name of tableNames) {
    const deltaPath = mirrorCdfDeltaPath(args.mirrorWorkspaceId, args.mirrorId, name);
    if (deltaPath) tableSpecs.push({ name, deltaPath });
  }
  if (!tableSpecs.length) {
    return { ok: false, status: 'Gated', hub, tables: [], note, gate: { missing: 'LOOM_BRONZE_URL', message: 'Could not resolve the mirror Delta abfss paths — check LOOM_BRONZE_URL.' } };
  }

  const fqdn = readEventHubsDataConfig().fullyQualifiedNamespace;

  // 1) Ensure the sink Event Hub (idempotent PUT) — this IS the ingest endpoint.
  await createEventHub({ name: hub, partitionCount: 4, messageRetentionInDays: 1 });

  // 2) Upload the CDF-reader script (idempotent) + submit the Spark batch.
  await uploadFile(BRONZE, CDF_SCRIPT_PATH, Buffer.from(CDF_READER_SCRIPT, 'utf-8'), 'text/x-python');
  const scriptAbfss = resolveAbfssRoot(BRONZE, CDF_SCRIPT_PATH);
  if (!scriptAbfss) {
    return { ok: false, status: 'Gated', hub, fqdn, tables: tableSpecs, note, gate: { missing: 'LOOM_BRONZE_URL', message: 'Could not resolve the CDF-reader script abfss path — check LOOM_BRONZE_URL.' } };
  }

  const job: SparkBatchRequest = {
    name: `loom-mirror-cdf-${args.mirrorId.slice(0, 8)}-${Date.now()}`,
    file: scriptAbfss,
    args: [stagePath, String(Math.max(0, args.startingVersion ?? 0)), JSON.stringify(tableSpecs)],
    conf: {
      'spark.sql.extensions': 'io.delta.sql.DeltaSparkSessionExtension',
      'spark.sql.catalog.spark_catalog': 'org.apache.spark.sql.delta.catalog.DeltaCatalog',
    },
    driverMemory: '4g', driverCores: 2,
    executorMemory: '4g', executorCores: 2, numExecutors: 2,
  };
  const batch = await submitSparkBatchJob(cdfPool(), job);
  return {
    ok: true, status: 'Submitted', hub, fqdn, jobId: batch.id, stagePath, tables: tableSpecs,
    note: note + ` CDF reader batch ${batch.id} submitted for ${tableSpecs.length} table(s).`,
  };
}

/** Split an array into fixed-size chunks. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Drain the Spark-staged CDF rows to the Event Hub over the HTTPS data plane.
 * Reads every newline-delimited JSON file the reader wrote and sends each row
 * as an event (batched). Real Event Hubs produce — no mock.
 */
export async function drainMirrorCdf(args: {
  eventstreamId: string;
  nodeIdx: number;
  mirrorId: string;
  mirrorWorkspaceId: string;
  maxRows?: number;
}): Promise<MirrorCdfDrainResult> {
  const note = 'Producing the mirror\'s staged Delta change rows to the Event Hub (real HTTPS data-plane REST).';
  const hub = mirrorCdfHubName(args.eventstreamId, args.nodeIdx);

  const gate = cdfGate(false);
  if (gate) return { ok: false, status: 'Gated', hub, produced: 0, files: 0, note, gate };
  if (!args.mirrorId || !args.mirrorWorkspaceId) {
    return { ok: false, status: 'Error', hub, produced: 0, files: 0, note, error: 'Select a mirrored database first.' };
  }

  const stagePrefix = `mirrors/${args.mirrorWorkspaceId}/${args.mirrorId}/_cdf_stage/${args.eventstreamId}`;
  let entries: PathEntry[];
  try {
    entries = await listPaths(BRONZE, stagePrefix, 500);
  } catch (e: any) {
    return { ok: false, status: 'Error', hub, produced: 0, files: 0, note, error: `Listing the staging folder failed: ${e?.message || String(e)}` };
  }
  const jsonFiles = entries.filter((e) => !e.isDirectory && e.name.toLowerCase().endsWith('.json'));
  if (!jsonFiles.length) {
    return {
      ok: true, status: 'NoStagedFiles', hub, produced: 0, files: 0,
      note: note + ' No staged change files yet — run "Provision endpoint" and wait for the Spark CDF reader batch to finish, then produce.',
    };
  }

  const cap = Math.max(1, Math.min(5000, args.maxRows ?? 2000));
  const rows: SendEvent[] = [];
  for (const f of jsonFiles) {
    if (rows.length >= cap) break;
    const { body } = await downloadFile(BRONZE, f.name);
    const text = body.toString('utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push({ body: JSON.parse(trimmed) as Record<string, unknown> });
      } catch { /* skip a malformed line */ }
      if (rows.length >= cap) break;
    }
  }
  if (!rows.length) {
    return { ok: true, status: 'NoStagedFiles', hub, produced: 0, files: jsonFiles.length, note: note + ' Staged files held no change rows.' };
  }

  let produced = 0;
  for (const batch of chunk(rows, 100)) {
    const out = await sendEvents(hub, batch);
    produced += out.sent;
  }
  return {
    ok: true, status: 'Produced', hub, produced, files: jsonFiles.length,
    note: note + ` Produced ${produced} change row(s) from ${jsonFiles.length} staged file(s).`,
  };
}
