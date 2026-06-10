/**
 * Materialized Lake View — refresh engine (Azure-native, no Fabric).
 *
 * Shared by the install-time provisioner and the on-demand refresh route. A
 * refresh:
 *   1. Resolves the MLV's target medallion container + Delta path on the
 *      internal DLZ ADLS Gen2.
 *   2. Generates the PySpark driver (materialized-lake-view-model) and uploads
 *      it to ADLS under `_mlv/<viewName>/refresh.py` so both this engine and an
 *      ADF pipeline can submit it.
 *   3. Submits a Synapse Spark batch (Livy) that runs the driver to (re)write
 *      the managed Delta table — full refresh (the only mode PySpark MLVs
 *      support per Microsoft Learn).
 *
 * Returns a structured outcome with the live batch id + Delta location, or an
 * honest gate naming the exact env var / role that is missing (no mock data,
 * per .claude/rules/no-vaporware.md). Never reaches Fabric / OneLake hosts.
 */

import {
  KNOWN_CONTAINERS,
  uploadFile as adlsUploadFile,
  resolveAbfssRoot,
  type KnownContainer,
} from '@/lib/azure/adls-client';
import { defaultSparkPool } from '@/lib/azure/synapse-livy-client';
import { submitSparkBatchJob, type SparkBatchJob } from '@/lib/azure/synapse-dev-client';
import {
  buildRefreshPySpark,
  mlvDeltaPath,
  mlvFqn,
  safeSegment,
  validateMlvSpec,
  type MlvSpec,
} from '@/lib/azure/materialized-lake-view-model';

export type MlvRefreshOutcome =
  | {
      ok: true;
      batch: SparkBatchJob;
      deltaUrl: string;
      driverPath: string;
      container: KnownContainer;
      sparkPool: string;
      fqn: string;
    }
  | {
      ok: false;
      gate: true;
      code: string;
      error: string;
      remediation: string;
      link?: string;
    }
  | { ok: false; gate?: false; error: string };

/** Resolve the abfss Delta URL the MLV materializes to, honoring its container. */
export function resolveMlvDeltaUrl(spec: MlvSpec): string | null {
  const container = ((KNOWN_CONTAINERS as readonly string[]).includes(spec.container)
    ? spec.container
    : 'silver') as KnownContainer;
  return resolveAbfssRoot(container, `materialized-lake-views/${safeSegment(spec.viewName)}/${mlvDeltaPath(spec)}`);
}

/**
 * Run a full refresh of the MLV: upload the driver + submit the Spark batch.
 * `trigger` is recorded in the batch tags so ADF-orchestrated refreshes are
 * distinguishable from editor / install refreshes in Synapse monitoring.
 */
export async function refreshMaterializedLakeView(
  spec: MlvSpec,
  opts: { itemId: string; trigger: 'install' | 'editor' | 'adf-pipeline' | 'schedule' },
): Promise<MlvRefreshOutcome> {
  const problems = validateMlvSpec(spec);
  if (problems.length) {
    return { ok: false, error: `Invalid MLV definition: ${problems.join(' ')}` };
  }

  // Azure-native infra gate: a configured Synapse workspace + Spark pool are
  // required to run the refresh. Name the exact env var (no Fabric mention).
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return {
      ok: false,
      gate: true,
      code: 'synapse_not_configured',
      error:
        'Materialized lake view refresh needs a Synapse workspace to run the Spark batch.',
      remediation:
        'Set LOOM_SYNAPSE_WORKSPACE (and optionally LOOM_SYNAPSE_SPARK_POOL) to the ' +
        'Synapse workspace + Apache Spark pool deployed by ' +
        'platform/fiab/bicep/modules/landing-zone/synapse.bicep, and grant the Console ' +
        'UAMI the Synapse Administrator role so it can submit Livy batches. ' +
        'No Microsoft Fabric required.',
      link: 'https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-job-definitions',
    };
  }

  const container = ((KNOWN_CONTAINERS as readonly string[]).includes(spec.container)
    ? spec.container
    : 'silver') as KnownContainer;

  const deltaUrl = resolveMlvDeltaUrl(spec);
  if (!deltaUrl) {
    return {
      ok: false,
      gate: true,
      code: 'adls_not_configured',
      error: `The '${container}' DLZ ADLS Gen2 container is not configured — cannot materialize the Delta table.`,
      remediation:
        `Set LOOM_${container.toUpperCase()}_URL (and/or LOOM_SILVER_URL / LOOM_GOLD_URL) ` +
        'to the DLZ ADLS Gen2 container URLs the landing-zone Bicep deploy emits. No Microsoft Fabric required.',
      link: 'https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction',
    };
  }

  // 1. Generate + upload the PySpark refresh driver.
  const driver = buildRefreshPySpark(spec, deltaUrl);
  const driverRel = `_mlv/${safeSegment(spec.viewName)}/refresh.py`;
  try {
    await adlsUploadFile(container, driverRel, Buffer.from(driver, 'utf-8'), 'text/x-python');
  } catch (e: any) {
    if (e?.statusCode === 401 || e?.statusCode === 403) {
      return {
        ok: false,
        gate: true,
        code: 'adls_forbidden',
        error: `ADLS ${e.statusCode}: not authorized to write the refresh driver to '${container}'.`,
        remediation:
          'Grant the Console managed identity (LOOM_UAMI_CLIENT_ID) the Storage Blob Data ' +
          'Contributor role on the DLZ storage account / container.',
        link: 'https://learn.microsoft.com/azure/storage/blobs/assign-azure-role-data-access',
      };
    }
    return { ok: false, error: `Failed to upload MLV refresh driver: ${e?.message || String(e)}` };
  }

  const driverUrl = resolveAbfssRoot(container, driverRel);
  if (!driverUrl) {
    return { ok: false, error: 'Could not resolve the driver abfss URL after upload.' };
  }

  // 2. Submit the Synapse Spark batch that runs the driver.
  const sparkPool = defaultSparkPool();
  try {
    const batch = await submitSparkBatchJob(sparkPool, {
      name: `mlv-refresh-${safeSegment(spec.viewName)}-${Date.now()}`,
      file: driverUrl,
      conf: { 'spark.sql.sources.partitionOverwriteMode': 'dynamic' },
      tags: {
        loomItemType: 'materialized-lake-view',
        loomItemId: opts.itemId,
        loomMlv: mlvFqn(spec),
        loomTrigger: opts.trigger,
      },
    });
    return {
      ok: true,
      batch,
      deltaUrl,
      driverPath: driverRel,
      container,
      sparkPool,
      fqn: mlvFqn(spec),
    };
  } catch (e: any) {
    const msg = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\b401\b|\b403\b|forbidden|denied/i.test(msg)) {
      return {
        ok: false,
        gate: true,
        code: 'synapse_forbidden',
        error: `Synapse rejected the Spark batch submit (${msg.slice(0, 160)}).`,
        remediation:
          `Grant the Console UAMI the Synapse Administrator role on workspace ` +
          `'${process.env.LOOM_SYNAPSE_WORKSPACE}' and ensure the Apache Spark pool ` +
          `'${sparkPool}' exists (LOOM_SYNAPSE_SPARK_POOL). No Microsoft Fabric required.`,
        link: 'https://learn.microsoft.com/azure/synapse-analytics/security/how-to-grant-workspace-managed-identity-permissions',
      };
    }
    return { ok: false, error: `Spark batch submit failed: ${msg.slice(0, 300)}` };
  }
}
