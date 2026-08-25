/**
 * mirror-adf-copy — the ADF **Copy** runtime for `mirrored-database`.
 *
 * The no-Fabric backend for sources that authenticate with their own runtime
 * and that ADF reads through its Copy connector (Snowflake today; BigQuery and
 * Oracle extend here). Split out of `mirror-engine.ts` when that file crossed
 * its 1700-LOC ceiling; the seam is the one the engine already marked with its
 * own banner comment, so this module is that section unchanged plus its imports.
 *
 * The engine dispatches INTO here, so nothing here may value-import the engine:
 * the four shared primitives live in `mirror-adf-shared.ts` and the types come
 * through `import type`, which TypeScript erases. That keeps the edge one-way.
 */
import {
  adfCdcConfigGate, upsertDataset, upsertPipeline, runPipeline, upsertTrigger, startTrigger,
} from './adf-client';
import { pathToHttpsUrl } from './adls-client';
import { BRONZE, MAX_TABLES, adfSafeName, mirrorAdlsLinkedService } from './mirror-adf-shared';
// The Snowflake backend: auto-binds its ADF linked service from the mirror's
// Loom Connection and enumerates the source through the same runtime that
// replicates it, so the table list can never disagree with what Copy can read.
import { resolveSnowflakeLinkedService, snowflakeDatasetKind, listSnowflakeTables } from './snowflake-adf';
import type { MirrorSource, MirrorTableSpec, MirrorTableResult, MirrorRunResult } from './mirror-engine';

// ============================================================
// ADF Copy runtime path (opt-in) — the no-Fabric backend for sources that
// authenticate with their own runtime and that ADF reads via its Copy connector
// (Snowflake today; BigQuery / Oracle extend later). Each selected table gets a
// **delete-then-copy** full-refresh pipeline (Delete activity clears the Bronze
// folder, Copy lands fresh Parquet) and, unless syncMode='snapshot', a schedule
// trigger that re-runs the pipeline on a cadence. Real ARM (upsertDataset +
// upsertPipeline + runPipeline + upsertTrigger/startTrigger). No Microsoft Fabric.
//   https://learn.microsoft.com/azure/data-factory/connector-snowflake
//   https://learn.microsoft.com/azure/data-factory/connector-azure-data-lake-storage
// ============================================================

/**
 * Snowflake source linked service to bind.
 *
 * An operator MAY pin their own with `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE`
 * (brownfield estates have hand-tuned linked services with private endpoints we
 * must not clobber). When they have not, the platform builds one from the
 * mirror's Loom connection — see `snowflake-adf.resolveSnowflakeLinkedService`.
 * The env var is an OVERRIDE, never a prerequisite: requiring it was an
 * `auto-bind-by-default.md` §5 violation, since Loom holds every value the
 * linked service needs.
 */
function mirrorSnowflakeLinkedService(): string | null {
  const v = process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE || process.env.LOOM_MIRROR_SOURCE_LINKED_SERVICE;
  return v && v.trim() ? v.trim() : null;
}

/**
 * Is the ADF Copy path usable? The factory + the ADLS sink are genuine infra
 * prerequisites (deployed by bicep). The SOURCE linked service is no longer one
 * — it is auto-bound from the connection at Start.
 */
export function adfCopyConfigured(): boolean {
  return !!process.env.LOOM_ADF_NAME
    && !adfCdcConfigGate()
    && !!mirrorAdlsLinkedService();
}


/** ADF Copy pipeline name — stable + safe ([A-Za-z0-9_], first char a letter). */
function adfCopyName(mirrorId: string): string {
  const safe = (mirrorId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'mirror';
  return `loom_copy_${safe}`;
}

/** Refresh cadence → ADF schedule-trigger recurrence. 'on-demand' = no trigger. */
function copyRecurrence(cadence: string): { frequency: string; interval: number } | null {
  switch (cadence) {
    case '15min': return { frequency: 'Minute', interval: 15 };
    case '1h': return { frequency: 'Hour', interval: 1 };
    case '4h': return { frequency: 'Hour', interval: 4 };
    case 'daily': return { frequency: 'Day', interval: 1 };
    default: return null; // 'on-demand'
  }
}

/**
 * What each sync mode ACTUALLY produces on the ADF Copy runtime.
 *
 * The three modes have to be observably different or the selector is decoration.
 * On this backend they are three different sets of ADF artifacts:
 *
 *   snapshot    → the pipeline runs ONCE. No trigger is registered at all.
 *   incremental → a ScheduleTrigger at the deployment cadence
 *                 (LOOM_MIRROR_COPY_CADENCE, default 1h).
 *   continuous  → a TumblingWindowTrigger at the 15-minute floor with
 *                 maxConcurrency 1, so windows queue rather than overlap.
 *
 * HONESTY NOTE (deploy-integrity.md R7): on this backend `incremental` means
 * "re-copied on a schedule", not row-level change capture — the ADF Snowflake
 * connector has no CDC source, so each run is a delete-then-copy full refresh.
 * Snowflake CHANGES/stream-based row-level deltas are a disclosed follow-up, and
 * the wizard's per-source note says exactly this rather than implying more.
 */
export type CopyTriggerPlan =
  | { kind: 'none'; reason: string }
  | { kind: 'schedule'; cadence: string; recurrence: { frequency: string; interval: number } }
  | { kind: 'tumbling'; cadence: string; recurrence: { frequency: string; interval: number } };

export function planCopyTrigger(
  syncMode: MirrorSource['syncMode'],
  cadence: string,
): CopyTriggerPlan {
  if (syncMode === 'snapshot') {
    return { kind: 'none', reason: 'One-time full load (sync mode: snapshot); no ongoing trigger was registered.' };
  }
  if (syncMode === 'continuous') {
    return { kind: 'tumbling', cadence: '15min', recurrence: { frequency: 'Minute', interval: 15 } };
  }
  const recurrence = copyRecurrence(cadence);
  if (!recurrence) {
    return { kind: 'none', reason: `One-time full load (LOOM_MIRROR_COPY_CADENCE=${cadence} means on-demand); no ongoing trigger was registered.` };
  }
  return { kind: 'schedule', cadence, recurrence };
}


/**
 * Provision + run an ADF Copy pipeline that lands each selected table as Parquet
 * in ADLS Bronze (delete-then-copy full refresh), and — unless syncMode is
 * 'snapshot' — register a schedule trigger that re-runs the copy on a cadence
 * (LOOM_MIRROR_COPY_CADENCE, default '1h'). Returns a MirrorRunResult carrying the
 * pipeline name (the ADF run-id receipt) + per-table Parquet landing paths. The
 * Snowflake source + AzureBlobFS sink are pre-existing ADF linked services bound
 * by env var. Real ARM calls; failures surface verbatim (no fake success).
 */
export async function runMirrorAdfCopy(
  mirrorId: string, workspaceId: string, src: MirrorSource, tableSpecs: MirrorTableSpec[], note: string,
): Promise<MirrorRunResult> {
  const adlsLs = mirrorAdlsLinkedService();
  const adfGate = adfCdcConfigGate();
  if (adfGate || !adlsLs) {
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', engine: 'adf-copy', tables: [],
      gate: {
        missing: adfGate?.missing || 'LOOM_MIRROR_ADLS_LINKED_SERVICE',
        message:
          'Snowflake mirroring runs on an ADF Copy runtime (no Microsoft Fabric). This deployment is missing the ' +
          'factory or the ADLS sink linked service, both of which platform/fiab/bicep deploys: ' +
          `${adfGate?.missing || 'LOOM_MIRROR_ADLS_LINKED_SERVICE'}. The Snowflake source linked service is NOT a ` +
          "prerequisite — Loom builds it from the mirror's connection.",
      },
      note,
    };
  }

  // ── Auto-bind the Snowflake linked service (auto-bind-by-default.md §5) ────
  // Built from the mirror's Loom Connection, named after it, and re-upserted on
  // every Start so a linked service deleted or edited out-of-band self-heals.
  const bound = await resolveSnowflakeLinkedService(src.tenantId || '', src.connectionId);
  if ('gate' in bound) {
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', engine: 'adf-copy', tables: [],
      gate: { missing: bound.gate.missing, message: bound.gate.message },
      note,
    };
  }
  const sourceLs = bound.binding.linkedServiceName;
  // A pinned linked service may be the LEGACY V1 connector; read its type rather
  // than assuming, because a V2 dataset on a V1 linked service is rejected.
  const kind = await snowflakeDatasetKind(sourceLs);

  // ── Resolve WHICH tables replicate, and honour the Iceberg toggle ──────────
  // No explicit subset means "mirror everything", which on this backend requires
  // a real enumeration — a Copy pipeline needs a dataset per table. This is also
  // where `includeIcebergTables` becomes load-bearing: Snowflake-managed Iceberg
  // tables are excluded unless the mirror asked for them.
  let specs = tableSpecs;
  let tableNote = '';
  // Null when no enumeration ran (an explicit subset was pinned) or the probe
  // could not be read — never conflated with "the role sees zero schemas".
  let visibleSchemas: number | null = null;
  if (!specs.length) {
    const listed = await listSnowflakeTables(src.tenantId || '', src.connectionId, src.database);
    if ('gate' in listed) {
      return {
        ok: false, status: 'Gated', backend: 'azure-native-cdc', engine: 'adf-copy', tables: [],
        gate: { missing: listed.gate.missing, message: listed.gate.message },
        note,
      };
    }
    const all = listed.tables;
    visibleSchemas = listed.visibleSchemas;
    const kept = src.includeIcebergTables ? all : all.filter((t) => !t.isIceberg);
    const dropped = all.length - kept.length;
    specs = kept.slice(0, MAX_TABLES).map((t) => ({ schema: t.schema, table: t.table }));
    if (!listed.icebergKnown) {
      tableNote = ` Enumerated ${all.length} tables (this Snowflake edition does not expose IS_ICEBERG, so no table could be classified as Iceberg).`;
    } else if (src.includeIcebergTables) {
      const ice = all.filter((t) => t.isIceberg).length;
      tableNote = ` Enumerated ${all.length} tables, including ${ice} Snowflake-managed Iceberg table${ice === 1 ? '' : 's'}.`;
    } else {
      tableNote = ` Enumerated ${all.length} tables${dropped ? `; excluded ${dropped} Snowflake-managed Iceberg table${dropped === 1 ? '' : 's'} (turn on "Include Iceberg tables" to mirror them)` : ''}.`;
    }
  }
  if (!specs.length) {
    // Zero tables has TWO causes and they send the operator to different
    // places. The visibility probe (see snowflake-adf) distinguishes them, so
    // this names the one that actually happened instead of guessing.
    const noVisibility = visibleSchemas === 0;
    const base = noVisibility
      ? `The connection's role cannot see ANY schema in Snowflake database ${src.database}, so no table list could be built. ` +
        'This is a grants problem, not an empty database: grant the role USAGE on the database and its schemas, and SELECT on the tables to mirror.'
      : `No tables were found in Snowflake database ${src.database}` +
        (visibleSchemas === null
          ? ' (Loom could not determine whether the role can see its schemas, so a missing grant is still possible).'
          : ` across the ${visibleSchemas} schema(s) the role can see.`);
    return {
      ok: false, status: 'Gated', backend: 'azure-native-cdc', engine: 'adf-copy', tables: [],
      gate: {
        missing: noVisibility ? 'snowflake-grants' : 'tables',
        message: src.includeIcebergTables || noVisibility
          ? base
          : `${base} If its tables are Snowflake-managed Iceberg tables, turn on "Include Iceberg tables" on the mirror.`,
      },
      note,
    };
  }
  const tableSpecsResolved = specs;


  const pipelineName = adfCopyName(mirrorId);
  const basePath = `mirrors/${workspaceId}/${mirrorId}`;
  const cadence = (process.env.LOOM_MIRROR_COPY_CADENCE || '1h').trim();
  const triggerPlan = planCopyTrigger(src.syncMode, cadence);

  // One source dataset + one Parquet sink dataset + a delete-then-copy activity
  // pair per selected table. Datasets named off the pipeline + table (safe).
  const activities: unknown[] = [];
  try {
    for (const t of tableSpecsResolved) {
      const srcDs = adfSafeName(`${pipelineName}_s_${t.schema}_${t.table}`);
      const sinkDs = adfSafeName(`${pipelineName}_k_${t.schema}_${t.table}`);
      const folderPath = `${basePath}/${t.schema}.${t.table}`;
      await upsertDataset(srcDs, {
        name: srcDs,
        properties: {
          type: kind.dataset,
          linkedServiceName: { referenceName: sourceLs, type: 'LinkedServiceReference' },
          schema: [],
          typeProperties: { schema: t.schema, table: t.table },
        },
      } as any);

      await upsertDataset(sinkDs, {
        name: sinkDs,
        properties: {
          type: 'Parquet',
          linkedServiceName: { referenceName: adlsLs, type: 'LinkedServiceReference' },
          typeProperties: {
            location: { type: 'AzureBlobFSLocation', fileSystem: BRONZE, folderPath },
          },
        },
      } as any);
      const delName = adfSafeName(`Delete_${t.schema}_${t.table}`);
      const copyName = adfSafeName(`Copy_${t.schema}_${t.table}`);
      // Delete clears the folder so each full-refresh run overwrites (no dup rows).
      activities.push({
        name: delName,
        type: 'Delete',
        dependsOn: [],
        typeProperties: {
          dataset: { referenceName: sinkDs, type: 'DatasetReference' },
          recursive: true,
          enableLogging: false,
          storeSettings: { type: 'AzureBlobFSReadSettings', recursive: true },
        },
      });
      activities.push({
        name: copyName,
        type: 'Copy',
        dependsOn: [{ activity: delName, dependencyConditions: ['Succeeded'] }],
        inputs: [{ referenceName: srcDs, type: 'DatasetReference' }],
        outputs: [{ referenceName: sinkDs, type: 'DatasetReference' }],
        typeProperties: {
          source: { type: kind.source, exportSettings: { type: 'SnowflakeExportCopyCommand' } },

          sink: { type: 'ParquetSink', storeSettings: { type: 'AzureBlobFSWriteSettings' } },
          enableStaging: false,
        },
      });
    }

    await upsertPipeline(pipelineName, {
      name: pipelineName,
      properties: { activities, annotations: ['loom-mirror', mirrorId], folder: { name: 'loom-mirrors' } },
    } as any);
  } catch (e: any) {
    return {
      ok: false, status: 'Error', backend: 'azure-native-cdc', engine: 'adf-copy', cdcName: pipelineName, tables: [],
      basePath: pathToHttpsUrl(BRONZE, `${basePath}/`), note,
      error: `ADF Copy pipeline authoring failed: ${e?.message || String(e)}`,
    };
  }

  // Fire the initial full load. Auth-to-source/sink failures are surfaced verbatim.
  try {
    await runPipeline(pipelineName);
  } catch (e: any) {
    return {
      ok: false, status: 'Error', backend: 'azure-native-cdc', engine: 'adf-copy', cdcName: pipelineName, tables: [],
      basePath: pathToHttpsUrl(BRONZE, `${basePath}/`), note,
      error: `ADF Copy initial run failed: ${e?.message || String(e)}`,
    };
  }

  // Register + start the ongoing trigger. Which trigger — and whether there is
  // one at all — is what makes the three sync modes observably different in the
  // factory (see planCopyTrigger). Best-effort: a trigger failure does not fail
  // the initial load, and the reason is stated rather than swallowed.
  let triggerNote = '';
  if (triggerPlan.kind === 'none') {
    triggerNote = ` ${triggerPlan.reason}`;
  } else {
    const triggerName = adfSafeName(`${pipelineName}_trg`);
    const startTime = new Date().toISOString();
    try {
      if (triggerPlan.kind === 'tumbling') {
        // Continuous → a tumbling window at the 15-minute floor. maxConcurrency 1
        // makes windows queue instead of overlapping, so a slow full refresh can
        // never stack copies on top of each other.
        await upsertTrigger(triggerName, {
          name: triggerName,
          properties: {
            type: 'TumblingWindowTrigger',
            pipeline: { pipelineReference: { referenceName: pipelineName, type: 'PipelineReference' } },
            typeProperties: {
              frequency: triggerPlan.recurrence.frequency,
              interval: triggerPlan.recurrence.interval,
              startTime,
              maxConcurrency: 1,
              retryPolicy: { count: 2, intervalInSeconds: 60 },
            },
          },
        } as any);
      } else {
        await upsertTrigger(triggerName, {
          name: triggerName,
          properties: {
            type: 'ScheduleTrigger',
            pipelines: [{ pipelineReference: { referenceName: pipelineName, type: 'PipelineReference' } }],
            typeProperties: { recurrence: { ...triggerPlan.recurrence, startTime, timeZone: 'UTC' } },
          },
        } as any);
      }
      await startTrigger(triggerName);
      triggerNote = triggerPlan.kind === 'tumbling'
        ? ` Continuous sync: tumbling-window trigger ${triggerName} every ${triggerPlan.cadence} (max 1 concurrent window).`
        : ` Incremental sync: schedule trigger ${triggerName} re-copies every ${triggerPlan.cadence}.`;
    } catch (e: any) {
      triggerNote = ` Initial load ran; the ongoing ${triggerPlan.kind === 'tumbling' ? 'tumbling-window' : 'schedule'} trigger could not be started (${e?.message || String(e)}) — re-run Start or grant the Console UAMI Data Factory Contributor.`;
    }
  }

  const credNote = bound.binding.credential === 'key-vault-reference'
    ? ' Credential read by the factory from Key Vault by reference (never copied into the linked service).'
    : bound.binding.credential === 'inline-secure-string'
      ? ' Credential stored in the linked service as an encrypted SecureString (no Key Vault linked service is bound in this deployment).'
      : '';
  const adfNote =
    'Azure-native mirror via ADF Copy runtime (no Microsoft Fabric): each selected Snowflake table is ' +
    `delete-then-copied as Parquet into ADLS Bronze. Pipeline: ${pipelineName}. ` +
    `Snowflake linked service: ${sourceLs}.${credNote}${tableNote}${triggerNote}`;
  const lastSync = new Date().toISOString();
  const tables: MirrorTableResult[] = tableSpecsResolved.map((t) => {

    const folderUrl = pathToHttpsUrl(BRONZE, `${basePath}/${t.schema}.${t.table}/`);
    const openrowset = `SELECT TOP 100 * FROM OPENROWSET(BULK '${folderUrl}', FORMAT = 'PARQUET') AS rows`;
    return {
      schema: t.schema, table: t.table, status: 'replicated', mode: 'snapshot',
      rows: 0, bytes: 0, truncated: false, lastSync, path: folderUrl, openrowset,
      note: 'ADF Copy: full load running. Row/byte metrics populate in the ADF monitor.',
    };
  });

  return {
    ok: true, status: 'Running', backend: 'azure-native-cdc', engine: 'adf-copy', cdcName: pipelineName, tables,
    basePath: pathToHttpsUrl(BRONZE, `${basePath}/`), note: adfNote,
  };
}