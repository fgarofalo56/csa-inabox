/**
 * Phase 2 — Mirrored Database provisioner.
 *
 * Per .claude/rules/no-fabric-dependency.md a Loom mirrored database NEVER
 * requires a real Fabric workspace. It defaults to the Azure-native **ADF CDC /
 * copy** backend: a real Azure Data Factory pipeline copies the source tables
 * into the ADLS Gen2 **Bronze** layer as Parquet — the same Bronze the
 * Silver/Gold notebooks read — using the factory's managed identity for both
 * the source (Azure SQL) and the sink (ADLS). A Fabric Mirrored Database is an
 * opt-in alternative selected via LOOM_MIRROR_BACKEND=fabric + a bound
 * workspace; if fabric is selected but no workspace is bound, we transparently
 * fall back to ADF CDC — no Fabric gate.
 *
 * Honest Azure gates (not Fabric gates):
 *   - ADF workspace env vars unset (adfConfigGate)  → set LOOM_ADF_*.
 *   - ADLS Bronze account unset                     → set LOOM_ADLS_ACCOUNT.
 *   - source server/database missing on the bundle  → fix the mirror config.
 * The factory MI must be granted db_datareader on the source + Storage Blob
 * Data Contributor on the ADLS account — surfaced as a precise note.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database
 *   https://learn.microsoft.com/azure/data-factory/connector-azure-data-lake-storage
 */
import {
  adfConfigGate,
  upsertLinkedService,
  upsertDataset,
  upsertPipeline,
  runPipeline,
} from '@/lib/azure/adf-client';
import {
  listMirroredDatabases,
  createMirroredDatabase,
  startMirroredDatabase,
  getMirroringStatus,
  FabricError,
  fabricHint,
} from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';

/** ADF object name: letters/digits/_ only, ≤ 260; first char a letter. */
function adfName(s: string): string {
  let n = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 120);
  if (!/^[A-Za-z]/.test(n)) n = `t_${n}`;
  return n || 'loom_mirror';
}

function splitTable(t: string): { schema: string; table: string } {
  const parts = String(t).split('.');
  return parts.length > 1
    ? { schema: parts[0], table: parts.slice(1).join('.') }
    : { schema: 'dbo', table: parts[0] };
}

// ── Azure-native DEFAULT: ADF CDC / copy → ADLS Bronze ──────────────────────
async function provisionAdfCdc(input: any, steps: string[]): Promise<ProvisionResult> {
  const gate = adfConfigGate();
  if (gate) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Azure Data Factory is not configured for this deployment.',
        remediation: `Set ${gate.missing} (LOOM_ADF_SUBSCRIPTION_ID / LOOM_ADF_RG / LOOM_ADF_FACTORY, or LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG) so the mirror can author the Bronze copy pipeline. No Microsoft Fabric required.`,
        link: 'https://learn.microsoft.com/azure/data-factory/quickstart-create-data-factory',
      },
      steps,
    };
  }

  const content = input.content as any;
  const src = content?.source || {};
  const server = String(src.server || '').trim();
  const database = String(src.database || '').trim();
  const tables: string[] = Array.isArray(src.tables) ? src.tables : [];
  const adlsAccount = input.target.adlsAccount || process.env.LOOM_ADLS_ACCOUNT;
  const bronzeContainer = process.env.LOOM_BRONZE_CONTAINER || input.target.adlsContainer || 'bronze';

  if (!server || !database) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Mirror source server / database is not set.',
        remediation: 'Set the source server FQDN + database on the mirrored-database item (the create wizard captures these). Then re-run install.',
        link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database',
      },
      steps,
    };
  }
  if (!adlsAccount) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No ADLS Gen2 account configured for the Bronze sink.',
        remediation: 'Set LOOM_ADLS_ACCOUNT (and optionally LOOM_BRONZE_CONTAINER, default "bronze") so the copy pipeline can land the source tables as Bronze Parquet. No Microsoft Fabric required.',
        link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-data-lake-storage',
      },
      steps,
    };
  }

  const base = adfName(input.displayName);
  const srcLs = `${base}_src_sql`;
  const sinkLs = `${base}_sink_adls`;
  const pipelineName = `${base}_to_bronze`;

  try {
    // 1. Source linked service — Azure SQL via the factory's managed identity.
    await upsertLinkedService(srcLs, {
      name: srcLs,
      properties: {
        type: 'AzureSqlDatabase',
        typeProperties: {
          server,
          database,
          authenticationType: 'SystemAssignedManagedIdentity',
        },
      },
    } as any);
    steps.push(`Linked service '${srcLs}' → ${server}/${database} (factory MI auth).`);

    // 2. Sink linked service — ADLS Gen2 via the factory's managed identity.
    await upsertLinkedService(sinkLs, {
      name: sinkLs,
      properties: {
        type: 'AzureBlobFS',
        typeProperties: { url: `https://${adlsAccount}.dfs.core.windows.net` },
      },
    } as any);
    steps.push(`Linked service '${sinkLs}' → ${adlsAccount}.dfs.core.windows.net (factory MI auth).`);

    // 3. One source+sink dataset + copy activity per mounted table.
    const useTables = tables.length ? tables : ['dbo.*'];
    const activities: any[] = [];
    let made = 0;
    for (const t of useTables) {
      if (t.endsWith('.*')) {
        steps.push(`Skipped wildcard '${t}' — list explicit tables on the mirror to copy them to Bronze.`);
        continue;
      }
      const { schema, table } = splitTable(t);
      const srcDs = adfName(`${base}_s_${schema}_${table}`);
      const sinkDs = adfName(`${base}_k_${schema}_${table}`);
      await upsertDataset(srcDs, {
        name: srcDs,
        properties: {
          type: 'AzureSqlTable',
          linkedServiceName: { referenceName: srcLs, type: 'LinkedServiceReference' },
          schema: [],
          typeProperties: { schema, table },
        },
      } as any);
      await upsertDataset(sinkDs, {
        name: sinkDs,
        properties: {
          type: 'Parquet',
          linkedServiceName: { referenceName: sinkLs, type: 'LinkedServiceReference' },
          typeProperties: {
            location: {
              type: 'AzureBlobFSLocation',
              fileSystem: bronzeContainer,
              folderPath: `${database}/${schema}/${table}`,
            },
          },
        },
      } as any);
      activities.push({
        name: adfName(`Copy_${schema}_${table}`),
        type: 'Copy',
        inputs: [{ referenceName: srcDs, type: 'DatasetReference' }],
        outputs: [{ referenceName: sinkDs, type: 'DatasetReference' }],
        typeProperties: {
          source: { type: 'AzureSqlSource' },
          sink: { type: 'ParquetSink', storeSettings: { type: 'AzureBlobFSWriteSettings' } },
          enableStaging: false,
        },
      });
      made += 1;
    }

    if (activities.length === 0) {
      return {
        status: 'remediation',
        gate: {
          reason: 'No explicit source tables to copy to Bronze.',
          remediation: 'List the source tables (schema.table) on the mirrored-database item so the ADF copy pipeline can replicate them.',
          link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database',
        },
        steps,
      };
    }

    // 4. The Bronze-copy pipeline.
    await upsertPipeline(pipelineName, {
      name: pipelineName,
      properties: { activities, annotations: ['loom-mirror', input.appId] },
    } as any);
    steps.push(`Created ADF pipeline '${pipelineName}' with ${made} table copy activit${made === 1 ? 'y' : 'ies'} → ${adlsAccount}/${bronzeContainer}.`);

    // 5. Prove it's real — trigger an on-demand run (settle, don't block).
    let runId: string | undefined;
    try {
      const run = await runPipeline(pipelineName);
      runId = run.runId;
      steps.push(`Triggered Bronze copy run ${runId}.`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      // Auth-to-source/sink failures are an Azure RBAC gate, not a hard failure.
      if (/managed identity|login failed|not authorized|forbidden|permission|AADSTS|cannot open server/i.test(msg)) {
        return {
          status: 'remediation',
          resourceId: pipelineName,
          secondaryIds: { backend: 'adf-cdc', pipeline: pipelineName },
          gate: {
            reason: 'Bronze copy pipeline created, but its run could not authenticate to the source/sink.',
            remediation: `Grant the Data Factory's managed identity db_datareader on ${server}/${database} (CREATE USER [<factory>] FROM EXTERNAL PROVIDER; ALTER ROLE db_datareader ADD MEMBER [<factory>];) and "Storage Blob Data Contributor" on ${adlsAccount}. Then re-run: ${msg}`,
            link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database#managed-identity',
          },
          steps,
        };
      }
      steps.push(`Pipeline created; on-demand run deferred (${msg}).`);
    }

    const secondaryIds: Record<string, string> = { backend: 'adf-cdc', pipeline: pipelineName, bronze: `${adlsAccount}/${bronzeContainer}` };
    if (runId) secondaryIds.lastRunId = runId;
    return { status: 'created', resourceId: pipelineName, secondaryIds, steps };
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/401|403|not authorized|forbidden|permission/i.test(msg)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Azure Data Factory authoring not authorized: ${msg}`,
          remediation: 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the "Data Factory Contributor" role on the factory so it can author linked services / datasets / pipelines.',
          link: 'https://learn.microsoft.com/azure/data-factory/concepts-roles-permissions',
        },
        steps,
      };
    }
    return { status: 'failed', error: msg, steps };
  }
}

/** Map the bundle's source.kind to a Fabric SourceType (opt-in path only). */
function fabricSourceType(kind: string | undefined): string {
  switch (kind) {
    case 'azure-sql': return 'AzureSqlDatabase';
    case 'snowflake': return 'Snowflake';
    case 'cosmos': return 'CosmosDb';
    case 'bigquery': return 'GenericMirror';
    default: return 'AzureSqlDatabase';
  }
}

function buildMirroringDefinition(content: any, connectionId: string): { parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }> } {
  const src = content?.source || {};
  const tables: string[] = Array.isArray(src.tables) ? src.tables : [];
  const mountedTables = tables.map((t) => {
    const { schema, table } = splitTable(t);
    return { source: { typeProperties: { schemaName: schema, tableName: table } } };
  });
  const mirroring = {
    properties: {
      source: {
        type: fabricSourceType(src.kind),
        typeProperties: {
          connection: connectionId,
          ...(src.database && fabricSourceType(src.kind) !== 'AzureSqlDatabase' ? { database: src.database } : {}),
        },
      },
      target: { type: 'MountedRelationalDatabase', typeProperties: { defaultSchema: 'dbo', format: 'Delta' } },
      ...(mountedTables.length ? { mountedTables } : {}),
    },
  };
  return { parts: [{ path: 'mirroring.json', payload: Buffer.from(JSON.stringify(mirroring), 'utf-8').toString('base64'), payloadType: 'InlineBase64' }] };
}

// ── Fabric Mirroring backend (opt-in: LOOM_MIRROR_BACKEND=fabric + bound ws) ─
async function provisionFabricMirror(input: any, steps: string[], ws: string): Promise<ProvisionResult> {
  steps.push(`Fabric workspace: ${ws}`);
  const content = input.content as any;
  const connectionId = process.env.LOOM_MIRROR_SOURCE_CONNECTION_ID;
  if (!connectionId) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Fabric mirroring requires a pre-created data-source connection GUID.',
        remediation: 'Create a Fabric data-source connection to the source server and set LOOM_MIRROR_SOURCE_CONNECTION_ID — or use the Azure-native ADF CDC backend (LOOM_MIRROR_BACKEND=adf-cdc, the default).',
        link: 'https://learn.microsoft.com/fabric/mirroring/mirrored-database-rest-api#create-mirrored-database',
      },
      steps,
    };
  }
  const definition = buildMirroringDefinition(content, connectionId);
  steps.push(`Built mirroring.json (${(content?.source?.tables?.length || 0)} mounted table(s), source ${fabricSourceType(content?.source?.kind)}).`);
  try {
    const existing = await listMirroredDatabases(ws);
    const match = existing.find((m) => (m.displayName || '').toLowerCase() === input.displayName.toLowerCase());
    let mirrorId = match?.id;
    let baseStatus: ProvisionResult['status'] = 'exists';
    if (mirrorId) {
      steps.push(`Found existing mirrored database ${mirrorId}; reusing.`);
    } else {
      const created = await createMirroredDatabase(ws, { displayName: input.displayName, description: `Installed from ${input.appId}`, definition });
      mirrorId = (created as any)?.id;
      if (!mirrorId) {
        const after = await listMirroredDatabases(ws);
        mirrorId = after.find((m) => (m.displayName || '').toLowerCase() === input.displayName.toLowerCase())?.id;
      }
      steps.push(`Created mirrored database ${mirrorId || '(id pending — long-running create)'}.`);
      baseStatus = 'created';
    }
    if (!mirrorId) {
      steps.push('Mirrored database id not yet resolvable; start-mirroring deferred to next pass.');
      return { status: baseStatus, secondaryIds: { backend: 'fabric', fabricWorkspaceId: ws }, steps };
    }
    try {
      await startMirroredDatabase(ws, mirrorId);
      steps.push('startMirroring accepted (replication initializing).');
    } catch (e: any) {
      if (e instanceof FabricError && (e.status === 400 || e.status === 409)) {
        steps.push(`startMirroring: ${e.message} (treated as already-started).`);
      } else { throw e; }
    }
    let mirroringStatus: string | undefined;
    try { const st = await getMirroringStatus(ws, mirrorId); mirroringStatus = st?.status; if (mirroringStatus) steps.push(`Mirroring status: ${mirroringStatus}.`); } catch { /* not yet queryable */ }
    const secondaryIds: Record<string, string> = { backend: 'fabric', fabricWorkspaceId: ws };
    if (mirroringStatus) secondaryIds.mirroringStatus = mirroringStatus;
    return { status: baseStatus, resourceId: mirrorId, secondaryIds, steps };
  } catch (e: any) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: { reason: `Fabric ${e.status}: ${e.message}`, remediation: fabricHint(e.status) || 'Add the Console UAMI to this Fabric workspace as a Contributor.', link: `https://app.fabric.microsoft.com/groups/${ws}/settings` },
        steps,
      };
    }
    return { status: 'failed', error: e?.message || String(e), steps };
  }
}

export const mirroredDatabaseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  const backend = input.target.mirrorBackend || 'adf-cdc';

  if (backend === 'fabric' && ws) {
    steps.push('Provisioning mirror on the Fabric Mirroring backend (opt-in).');
    return provisionFabricMirror(input, steps, ws);
  }
  if (backend === 'fabric' && !ws) {
    steps.push('LOOM_MIRROR_BACKEND=fabric but no Fabric workspace bound — falling back to the Azure-native ADF CDC backend.');
  } else {
    steps.push('Provisioning mirror on the Azure-native ADF CDC → ADLS Bronze backend.');
  }
  return provisionAdfCdc(input, steps);
};
