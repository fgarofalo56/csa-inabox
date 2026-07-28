/**
 * M2 — copy-in ENGINE (server-only): realize a {@link CopyInPlan} as a REAL
 * Azure Data Factory Copy pipeline that lands each assessed source table into
 * ADLS Bronze, then materializes it as a managed Delta table in the target Loom
 * lakehouse/warehouse — the N7b/N7c mirror/CDC substrate run IN REVERSE
 * (external estate → Loom lake).
 *
 * NO SECOND ORCHESTRATOR: this reuses the SAME adf-client primitives the mirror
 * engine's ADF Copy path uses (upsertDataset / upsertPipeline / runPipeline /
 * listActivityRuns) — one delete-then-copy Copy activity per object in ONE
 * pipeline — and the SAME Synapse Livy path the Lakehouse "Load to Table" wizard
 * uses (buildLoadToTablePySpark → submitLivyBatch) for the Delta materialize.
 * It authors no new pipeline runner and reaches no new backend.
 *
 * PHASES:
 *   1. Copy   — ADF Copy: source table → Bronze Parquet under
 *               `migrations/<migrationId>/<db>.<schema>.<name>/`. Real ARM +
 *               real createRun. Row counts read back from the Copy activity
 *               output (`rowsRead`/`rowsCopied`).
 *   2. Delta  — (opt-in, gated) a Synapse Spark job reads each Bronze folder and
 *               writes a managed Delta table in the target lakehouse's `Tables/`
 *               so it appears in the Loom lakehouse editor and reads back with a
 *               real count. Gated honestly on LOOM_SYNAPSE_WORKSPACE + a pool.
 *
 * HONEST GATES (no-vaporware / no-fabric-dependency): the copy needs the env-
 * pinned ADF factory + a source ADF linked service + the ADLS sink linked
 * service. Snowflake is wired via the existing mirror Snowflake linked service;
 * Databricks-UC / Fabric / Power BI sources return an honest connector gate
 * naming the ADF linked service to provide (never a fabricated copy). A Fabric /
 * Power BI estate is only ever a migration SOURCE — the default path reaches no
 * Fabric/OneLake host.
 *
 * IL5 / sovereign: the copy runs IN-BOUNDARY — ADF in the deployment's VNet →
 * the deployment's own ADLS Bronze. SaaS-source connectors stay honest-gated
 * until their connection prerequisite (an ADF linked service) is provided.
 */
import {
  adfConfigGate, upsertDataset, upsertPipeline, runPipeline, listActivityRuns,
  type AdfDataset, type AdfPipeline,
} from '@/lib/azure/adf-client';
import { getAccountName, pathToHttpsUrl } from '@/lib/azure/adls-client';
import { dfsSuffix } from '@/lib/azure/cloud-endpoints';
import {
  listSparkPools, submitLivyBatch, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import { buildLoadToTablePySpark, parseLoadRowCount } from '@/lib/azure/load-to-table-codegen';
import type { MigrationSourceType } from './assessment';
import type { CopyInPlan, CopyObjectPlan } from './copy-plan';
import type { CopyObjectResult } from './copy-job-model';

/** Bronze landing container (the deployment's own ADLS Gen2). */
const BRONZE = 'bronze';

/** An honest connector/infra gate — the copy could not start. */
export interface CopyGate {
  missing: string;
  message: string;
}

export type CopyStartResult =
  | { ok: true; pipelineName: string; adfRunId: string; basePath: string; objects: CopyObjectResult[] }
  | { ok: false; gate: CopyGate };

/** ADF resource names allow [A-Za-z0-9_]; derive a stable, safe name. */
function adfSafe(s: string): string {
  const safe = String(s).replace(/[^A-Za-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Za-z]/.test(safe) ? safe.slice(0, 120) : `x_${safe}`.slice(0, 120);
}

/** Stable, safe ADF pipeline name for a migration's copy-in run. */
export function copyPipelineName(migrationId: string): string {
  const safe = (migrationId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'migrate';
  return `loom_copyin_${safe}`;
}

/** Is the ADLS Bronze landing zone configured? */
function bronzeConfigured(): boolean {
  if (!process.env.LOOM_BRONZE_URL) return false;
  try { getAccountName(); return true; } catch { return false; }
}

/** The pre-existing ADF AzureBlobFS (ADLS) linked service to bind, or null. */
function adlsLinkedService(): string | null {
  const v = process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE;
  return v && v.trim() ? v.trim() : null;
}

/**
 * The pre-existing ADF SOURCE linked service for a migration source, or null.
 * Snowflake reuses the mirror engine's Snowflake linked service (the ADF Copy
 * connector Loom already ships). Other sources have no default-path ADF Copy
 * connector wired yet → an honest connector gate names the prerequisite.
 */
function sourceLinkedService(sourceType: MigrationSourceType): string | null {
  if (sourceType === 'snowflake') {
    const v = process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE || process.env.LOOM_MIRROR_SOURCE_LINKED_SERVICE;
    return v && v.trim() ? v.trim() : null;
  }
  return null;
}

/** ADF Copy source `type` + dataset `type` for a supported migration source. */
function sourceDatasetTypes(sourceType: MigrationSourceType): { dataset: string; source: string } | null {
  if (sourceType === 'snowflake') return { dataset: 'SnowflakeTable', source: 'SnowflakeSource' };
  return null;
}

/**
 * Pre-flight gate for the copy. Returns an honest gate when a prerequisite is
 * missing (ADF factory, ADLS sink linked service, Bronze, or an unsupported
 * source that has no default-path ADF Copy connector), else null.
 */
export function copyGate(sourceType: MigrationSourceType): CopyGate | null {
  const adf = adfConfigGate();
  if (adf) {
    return {
      missing: adf.missing,
      message:
        'Copy-in runs on the env-pinned Azure Data Factory (no Microsoft Fabric): set LOOM_ADF_NAME (plus LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG) to the factory in the deployment VNet, then run the copy.',
    };
  }
  if (!bronzeConfigured()) {
    return {
      missing: 'LOOM_BRONZE_URL',
      message:
        'The Bronze landing zone is not configured. Set LOOM_BRONZE_URL to the deployment ADLS Gen2 Bronze container (platform/fiab/bicep/modules/landing-zone/storage*.bicep).',
    };
  }
  const adlsLs = adlsLinkedService();
  if (!adlsLs) {
    return {
      missing: 'LOOM_MIRROR_ADLS_LINKED_SERVICE',
      message:
        'The ADLS sink linked service is not set. Point LOOM_MIRROR_ADLS_LINKED_SERVICE at the AzureBlobFS linked service for the deployment Bronze account (the same one the mirror engine uses).',
    };
  }
  const supported = sourceDatasetTypes(sourceType) && sourceLinkedService(sourceType);
  if (!supported) {
    return {
      missing: sourceType === 'snowflake' ? 'LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE' : `adf-linked-service:${sourceType}`,
      message: sourceType === 'snowflake'
        ? 'Set LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE to a Snowflake ADF linked service (credential in Key Vault) so ADF can read the source tables.'
        : `Copy-in from ${sourceType} needs an ADF Copy linked service for that source, which is not wired on the default path yet. Snowflake sources copy today; ${sourceType} table copy-in is a disclosed follow-up (its assessment + code translation already work). Reach no Fabric/OneLake host on the default path.`,
    };
  }
  return null;
}

/** abfss:// Bronze root for a migration's copy-in. */
function bronzeAbfssRoot(migrationId: string): string {
  const account = getAccountName();
  return `abfss://${BRONZE}@${account}.${dfsSuffix()}/migrations/${migrationId}/`;
}

/** The Copy activity name backing one object (monitor maps run output → row). */
function copyActivityName(o: CopyObjectPlan): string {
  return adfSafe(`Copy_${o.landingSegment}`);
}

/**
 * PHASE 1 — author + run the ADF Copy pipeline for the plan. One delete-then-copy
 * activity pair per object; Parquet sink into `migrations/<migrationId>/<seg>/`.
 * Returns the pipeline name, run id, and per-object seed results (status running)
 * OR an honest gate. Real ARM (upsertDataset/upsertPipeline) + real createRun.
 */
export async function startCopyIn(
  plan: CopyInPlan,
  migrationId: string,
): Promise<CopyStartResult> {
  const gate = copyGate(plan.sourceType);
  if (gate) return { ok: false, gate };
  if (!plan.objects.length) {
    return { ok: false, gate: { missing: 'objects', message: 'No copyable table objects in this plan. Assess a source estate with at least one table first.' } };
  }

  const sourceLs = sourceLinkedService(plan.sourceType)!;
  const adlsLs = adlsLinkedService()!;
  const dsTypes = sourceDatasetTypes(plan.sourceType)!;
  const pipelineName = copyPipelineName(migrationId);
  const basePathSeg = `migrations/${migrationId}`;

  const activities: unknown[] = [];
  for (const o of plan.objects) {
    const srcDs = adfSafe(`${pipelineName}_s_${o.landingSegment}`);
    const sinkDs = adfSafe(`${pipelineName}_k_${o.landingSegment}`);
    const folderPath = `${basePathSeg}/${o.landingSegment}`;

    // Source dataset — the assessed table, via the source's ADF Copy connector.
    await upsertDataset(srcDs, {
      name: srcDs,
      properties: {
        type: dsTypes.dataset,
        linkedServiceName: { referenceName: sourceLs, type: 'LinkedServiceReference' },
        schema: [],
        typeProperties: { schema: o.source.schema || o.source.database || 'PUBLIC', table: o.source.name },
      },
    } as AdfDataset);
    // Sink dataset — Parquet in the Bronze migration folder.
    await upsertDataset(sinkDs, {
      name: sinkDs,
      properties: {
        type: 'Parquet',
        linkedServiceName: { referenceName: adlsLs, type: 'LinkedServiceReference' },
        typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: BRONZE, folderPath } },
      },
    } as AdfDataset);

    const delName = adfSafe(`Delete_${o.landingSegment}`);
    const copyName = copyActivityName(o);
    // Delete clears the folder so a re-run overwrites cleanly (no dup rows).
    activities.push({
      name: delName, type: 'Delete', dependsOn: [],
      typeProperties: {
        dataset: { referenceName: sinkDs, type: 'DatasetReference' },
        recursive: true, enableLogging: false,
        storeSettings: { type: 'AzureBlobFSReadSettings', recursive: true },
      },
    });
    // Copy — default (by-name) column mapping: no translator, ADF matches by name.
    activities.push({
      name: copyName, type: 'Copy',
      dependsOn: [{ activity: delName, dependencyConditions: ['Succeeded'] }],
      inputs: [{ referenceName: srcDs, type: 'DatasetReference' }],
      outputs: [{ referenceName: sinkDs, type: 'DatasetReference' }],
      typeProperties: {
        source: { type: dsTypes.source },
        sink: { type: 'ParquetSink', storeSettings: { type: 'AzureBlobFSWriteSettings' } },
        enableStaging: false,
      },
    });
  }

  const spec: AdfPipeline = {
    name: pipelineName,
    properties: {
      description: `Loom copy-in ${migrationId} (${plan.sourceType} → ADLS Bronze)`,
      activities,
      annotations: ['loom-migrate-copyin', migrationId],
      folder: { name: 'loom-migrations' },
    },
  };
  await upsertPipeline(pipelineName, spec);

  const run = await runPipeline(pipelineName);

  const objects: CopyObjectResult[] = plan.objects.map((o) => {
    const folderUrl = pathToHttpsUrl(BRONZE, `${basePathSeg}/${o.landingSegment}/`);
    const readBack = `SELECT TOP 100 * FROM OPENROWSET(BULK '${folderUrl}', FORMAT = 'PARQUET') AS rows`;
    return {
      source: o.landingSegment,
      targetTable: o.targetTable,
      targetKind: o.targetKind,
      status: 'running',
      rows: null,
      activityName: copyActivityName(o),
      landingPath: folderUrl,
      readBack,
      note: 'ADF Copy running: rows land as Parquet in Bronze; the count populates from the Copy activity output.',
    };
  });

  return { ok: true, pipelineName, adfRunId: run.runId, basePath: pathToHttpsUrl(BRONZE, `${basePathSeg}/`), objects };
}

/** Map an ADF Copy activity's output → rows copied (rowsCopied || rowsRead). */
function rowsFromActivityOutput(output: unknown): number | null {
  const o = (output || {}) as { rowsCopied?: unknown; rowsRead?: unknown };
  const n = Number(o.rowsCopied ?? o.rowsRead);
  return Number.isFinite(n) ? n : null;
}

/**
 * Refresh per-object copy status from the live ADF activity runs for a pipeline
 * run. Matches each object's Copy activity by name and folds in the real
 * rows-copied + Succeeded/Failed/InProgress state. Objects whose activity has
 * not yet reported stay as they were. Real ARM (listActivityRuns).
 */
export async function refreshCopyStatus(
  adfRunId: string,
  objects: CopyObjectResult[],
): Promise<CopyObjectResult[]> {
  let runs: Awaited<ReturnType<typeof listActivityRuns>> = [];
  try {
    runs = await listActivityRuns(adfRunId, 7);
  } catch {
    return objects; // transient — keep the last known state (no fake progress)
  }
  const byName = new Map(runs.filter((r) => r.activityType === 'Copy').map((r) => [r.activityName, r]));
  return objects.map((o) => {
    const run = byName.get(o.activityName);
    if (!run) return o;
    if (run.status === 'Succeeded') {
      return { ...o, status: 'succeeded', rows: rowsFromActivityOutput(run.output), note: 'Copied to Bronze (Parquet). Materialize as managed Delta to read it in the lakehouse editor.' };
    }
    if (run.status === 'Failed' || run.status === 'Cancelled') {
      return { ...o, status: 'failed', note: run.error?.message || `ADF Copy ${String(run.status).toLowerCase()}.` };
    }
    return { ...o, status: 'running' };
  });
}

/** Honest gate for the Phase-2 Delta materialize (Synapse Spark). */
export function materializeGate(): CopyGate | null {
  if (!bronzeConfigured()) {
    return { missing: 'LOOM_BRONZE_URL', message: 'The Bronze landing zone is not configured (LOOM_BRONZE_URL).' };
  }
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return {
      missing: 'LOOM_SYNAPSE_WORKSPACE',
      message:
        'Materializing the copied Parquet into managed Delta needs a Synapse workspace + Spark pool. Set LOOM_SYNAPSE_WORKSPACE and deploy a Spark pool (platform/fiab/bicep/modules/landing-zone/synapse.bicep, deploySparkPool=true). Until then the rows are queryable in Bronze via the Serverless read shown in the receipt.',
    };
  }
  return null;
}

/**
 * PHASE 2 (opt-in) — materialize the copied Bronze Parquet for one object into a
 * managed Delta table in the target lakehouse (`bronze` container `Tables/<t>`),
 * reusing the SAME Livy path as the Lakehouse "Load to Table" wizard. Returns
 * the updated result carrying the Delta row count, or an honest gate/note.
 */
export async function materializeDelta(
  obj: CopyObjectResult,
): Promise<CopyObjectResult> {
  const gate = materializeGate();
  if (gate) return { ...obj, note: gate.message };

  let account: string;
  try { account = getAccountName(); } catch { return { ...obj, note: 'ADLS account not resolvable (LOOM_BRONZE_URL).' }; }

  let poolName = '';
  try {
    const pools = await listSparkPools();
    poolName = pools[0]?.name || '';
  } catch (e) {
    return { ...obj, note: `Could not list Spark pools: ${(e as Error)?.message || e}` };
  }
  if (!poolName) return { ...obj, note: 'No Synapse Spark pool deployed (synapse.bicep, deploySparkPool=true). Bronze Parquet is still queryable via the Serverless read.' };

  // The Bronze Parquet was landed at migrations/<...>/<seg>/ — read it, write a
  // managed Delta table under the container's Tables/ folder.
  const relPath = (obj.landingPath || '').split(`/${BRONZE}/`).pop()?.replace(/^\/+|\/+$/g, '') || '';
  if (!relPath) return { ...obj, note: 'Bronze landing path unresolved; re-run the copy.' };

  let code: string;
  try {
    code = buildLoadToTablePySpark({
      container: BRONZE, account, path: relPath, tableName: obj.targetTable,
      writeMode: 'overwrite', format: 'parquet',
    });
  } catch (e) {
    return { ...obj, note: `Delta codegen failed: ${(e as Error)?.message || e}` };
  }

  let batch: Awaited<ReturnType<typeof submitLivyBatch>>;
  try {
    batch = await submitLivyBatch({ poolName, code, kind: 'pyspark', jobName: `loom-copyin-delta-${obj.targetTable}-${Date.now()}` });
  } catch (e) {
    return { ...obj, note: `Delta materialize submission failed: ${(e as Error)?.message || e}` };
  }

  const [sessIdStr, stmtIdStr] = batch.id.split('.');
  const sessionId = Number(sessIdStr), stmtId = Number(stmtIdStr);
  let rows: number | null = obj.rows;
  let note = 'Materialized as managed Delta in the lakehouse (Tables/).';
  if (Number.isFinite(sessionId) && Number.isFinite(stmtId)) {
    for (let i = 0; i < 40; i++) {
      let stmt: Awaited<ReturnType<typeof getLivyStatement>>;
      try { stmt = await getLivyStatement(poolName, sessionId, stmtId); } catch { await sleep(3000); continue; }
      if (stmt.state === 'available') {
        const out = (stmt.output || {}) as { status?: string; ename?: string; evalue?: string; data?: Record<string, string> };
        if (out.status === 'error') { note = `Delta materialize failed: ${out.ename || 'SparkError'}: ${out.evalue || ''}`.trim(); }
        else { const c = parseLoadRowCount(out.data?.['text/plain']); if (c != null) rows = c; }
        break;
      }
      if (stmt.state === 'error' || stmt.state === 'cancelled') { note = `Delta materialize statement ${stmt.state}.`; break; }
      await sleep(3000);
    }
  }
  const readBack = `SELECT COUNT(*) AS rows FROM OPENROWSET(BULK 'https://${account}.${dfsSuffix()}/${BRONZE}/Tables/${obj.targetTable}/', FORMAT = 'DELTA') AS d`;
  return { ...obj, status: 'succeeded', rows, readBack, note };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
