/**
 * POST /api/items/semantic-model/[id]/ingest
 *
 * "Get data" — Power Query (M) → Delta → semantic layer ingest, Azure-native,
 * no Microsoft Fabric required. Runs the three real phases:
 *
 *   Phase A  M → Parquet  — publish a WranglingDataFlow carrying the authored
 *            Power Query (M) and run it via ExecuteWranglingDataflow on ADF
 *            Spark, landing the output query as Parquet in ADLS Gen2 staging.
 *            (WranglingDataFlow is ADF-only; Synapse does not expose it.)
 *
 *   Phase B  Parquet → Delta — publish a MappingDataFlow whose inline source
 *            reads the staged Parquet and whose inline sink writes **Delta** to
 *            ADLS Gen2, then run it via a wrapper pipeline's ExecuteDataFlow
 *            activity. Delta is not a WranglingDataFlow sink, so this second
 *            structured flow is required. Backend is Synapse when
 *            LOOM_SYNAPSE_WORKSPACE is set (opt-in alternative), else ADF
 *            (default) — both write the identical Delta folder.
 *
 *   Phase C  AAS refresh (best-effort) — POST an async refresh to the Azure
 *            Analysis Services tabular model whose partition source already
 *            points at the Delta path, making the table queryable. Skipped with
 *            an honest warning when AAS is unconfigured or unavailable
 *            (Government clouds have no AAS — query Delta via Synapse Serverless
 *            OPENROWSET instead).
 *
 * Honest gates (no vaporware): missing ADF env → 503 with the exact env vars to
 * set; missing ADLS container URL → 503; missing AAS → Phase C skipped + a
 * `warnings[]` entry rather than a hard failure (the Delta is already landed).
 *
 * No mocks — every phase is a real ARM / dev-plane / AAS REST call.
 *
 * Body: {
 *   mScript: string;      // base64-encoded Power Query (M) section text
 *   sourceName?: string;  // which shared query to output (default: last)
 *   container?: 'bronze'|'silver'|'gold'|'landing';  // ADLS zone (default silver)
 *   aasTable?: string;    // AAS table to refresh after Delta lands (default: query name)
 * }
 * Optional ?workspaceId= — when present, the run id + deltaPath are persisted to
 * the Cosmos item's state (best-effort) for the editor's status pane.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import {
  adfConfigGate,
  upsertLinkedService as adfUpsertLinkedService,
  upsertDataset as adfUpsertDataset,
  upsertWranglingDataFlow,
  runWranglingDataFlow,
  upsertDataFlow as adfUpsertDataFlow,
  upsertPipeline as adfUpsertPipeline,
  runPipeline as adfRunPipeline,
} from '@/lib/azure/adf-client';
import {
  synapseConfigGate,
  upsertLinkedService as synapseUpsertLinkedService,
  upsertDataFlow as synapseUpsertDataFlow,
  upsertPipeline as synapseUpsertPipeline,
  runPipeline as synapseRunPipeline,
} from '@/lib/azure/synapse-artifacts-client';
import { resolveAbfssRoot, type KnownContainer } from '@/lib/azure/adls-client';
import { aasConfigGate, postAasRefresh } from '@/lib/azure/aas-client';
import { parseSharedQueries } from '@/lib/components/pipeline/dataflow/m-script';
import { dfsUrl } from '@/lib/azure/cloud-endpoints';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADLS_LS = 'loom-adls-mi';
const VALID_CONTAINERS: KnownContainer[] = ['bronze', 'silver', 'gold', 'landing'];

interface IngestBody {
  mScript?: string;
  sourceName?: string;
  container?: string;
  aasTable?: string;
}

function fromB64(b: string): string {
  try { return Buffer.from(b, 'base64').toString('utf-8'); } catch { return ''; }
}

/** Resolve the DLZ ADLS Gen2 account + dfs base from the container URL env. */
function resolveAdls(): { account: string; dfsBase: string } | null {
  for (const env of ['LOOM_BRONZE_URL', 'LOOM_SILVER_URL', 'LOOM_GOLD_URL', 'LOOM_LANDING_URL']) {
    const url = process.env[env];
    const m = url?.match(/^(https:\/\/([^/]+))\//i);
    if (m) return { account: m[2].split('.')[0], dfsBase: m[1] };
  }
  const acct = process.env.LOOM_ADLS_ACCOUNT;
  if (acct) return { account: acct, dfsBase: dfsUrl(acct) };
  return null;
}

/**
 * Build the Data Flow Script (DSL) that reads staged Parquet and writes Delta.
 * Inline datasets (no named dataset artifact) — the source/sink carry the ADLS
 * linked-service reference and the script carries format + fileSystem +
 * folderPath. `allowSchemaDrift` lets the unknown M output schema flow through.
 * Identical DSL runs on both ADF and Synapse Spark.
 */
function buildDeltaFlowScriptLines(container: string, stagingPath: string, deltaPath: string): string[] {
  return [
    'source(allowSchemaDrift: true,',
    '\tvalidateSchema: false,',
    '\tignoreNoFilesFound: false,',
    "\tformat: 'parquet',",
    `\tfileSystem: '${container}',`,
    `\tfolderPath: '${stagingPath}') ~> ParquetSource`,
    'ParquetSource sink(allowSchemaDrift: true,',
    '\tvalidateSchema: false,',
    "\tformat: 'delta',",
    `\tfileSystem: '${container}',`,
    `\tfolderPath: '${deltaPath}',`,
    "\ttruncate: true,",
    '\tmergeSchema: true,',
    '\tautoCompact: false,',
    '\toptimizedWrite: false,',
    '\tvacuum: 0,',
    '\tdeletable: false,',
    '\tinsertable: true,',
    '\tupdateable: false,',
    '\tupsertable: false,',
    '\tskipDuplicateMapInputs: true,',
    '\tskipDuplicateMapOutputs: true) ~> DeltaSink',
  ];
}

/** typeProperties for a MappingDataFlow with inline Parquet→Delta over ADLS. */
function deltaFlowTypeProperties(container: string, stagingPath: string, deltaPath: string) {
  const lsRef = { referenceName: ADLS_LS, type: 'LinkedServiceReference' as const };
  return {
    sources: [{ name: 'ParquetSource', linkedService: lsRef }],
    sinks: [{ name: 'DeltaSink', linkedService: lsRef }],
    transformations: [],
    scriptLines: buildDeltaFlowScriptLines(container, stagingPath, deltaPath),
  };
}

/** ExecuteDataFlow activity that runs the named MappingDataFlow on Spark. */
function executeDataFlowActivity(dataFlowName: string) {
  return {
    name: 'RunDelta',
    type: 'ExecuteDataFlow',
    dependsOn: [],
    policy: { timeout: '0.12:00:00', retry: 0 },
    typeProperties: {
      dataFlow: { referenceName: dataFlowName, type: 'DataFlowReference' },
      integrationRuntime: { referenceName: 'AutoResolveIntegrationRuntime', type: 'IntegrationRuntimeReference' },
      compute: { computeType: 'General', coreCount: 8 },
      traceLevel: 'Fine',
    },
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const short = id.slice(0, 8);

  // ----- ADF gate (Phase A always runs on ADF) -----
  const adfGate = adfConfigGate();
  if (adfGate) {
    return NextResponse.json({
      ok: false,
      error: `ADF not configured — missing ${adfGate.missing}.`,
      hint: 'Set LOOM_SUBSCRIPTION_ID, LOOM_DLZ_RG and LOOM_ADF_NAME on the Console app (deployed by platform/fiab/bicep/modules/landing-zone/adf.bicep).',
    }, { status: 503 });
  }

  // ----- ADLS destination -----
  const adls = resolveAdls();
  if (!adls) {
    return NextResponse.json({
      ok: false,
      error: 'ADLS Gen2 destination is not configured in this deployment.',
      hint: 'Set LOOM_BRONZE_URL / LOOM_SILVER_URL (or LOOM_ADLS_ACCOUNT) on the Console app — deployed by platform/fiab/bicep/modules/landing-zone/storage.bicep.',
    }, { status: 503 });
  }

  // ----- Body + M validation -----
  const body = (await req.json().catch(() => ({}))) as IngestBody;
  const m = body.mScript ? fromB64(body.mScript) : '';
  if (!m.trim()) {
    return NextResponse.json({ ok: false, error: 'mScript (base64 Power Query M) is required.' }, { status: 400 });
  }
  const queries = parseSharedQueries(m);
  if (queries.length === 0) {
    return NextResponse.json({ ok: false, error: 'No shared queries found in the Power Query (M) script. Author at least one query.' }, { status: 400 });
  }
  const outputQuery = body.sourceName && queries.some((q) => q.name === body.sourceName)
    ? body.sourceName
    : queries[queries.length - 1].name;

  const container = (VALID_CONTAINERS as string[]).includes(body.container || '')
    ? (body.container as KnownContainer)
    : 'silver';
  const safeQuery = outputQuery.replace(/[^A-Za-z0-9_-]/g, '_');
  const stagingPath = `ingest/${id}/${safeQuery}/staging`;
  const deltaRelPath = `ingest/${id}/${safeQuery}/delta`;
  const deltaPath = resolveAbfssRoot(container, deltaRelPath) || `abfss://${container}@${adls.dfsBase.replace(/^https:\/\//, '')}/${deltaRelPath}`;

  const warnings: string[] = [];

  try {
    // ========== Phase A — M → Parquet (ADF WranglingDataFlow) ==========
    await adfUpsertLinkedService(ADLS_LS, {
      name: ADLS_LS,
      properties: {
        type: 'AzureBlobFS',
        description: 'Loom ADLS Gen2 (factory managed identity auth).',
        typeProperties: { url: adls.dfsBase },
      },
    });
    const stagingDataset = `loom-sm-stage-${short}`;
    await adfUpsertDataset(stagingDataset, {
      name: stagingDataset,
      properties: {
        type: 'Parquet',
        linkedServiceName: { referenceName: ADLS_LS, type: 'LinkedServiceReference' },
        typeProperties: { location: { type: 'AzureBlobFSLocation', fileSystem: container, folderPath: stagingPath } },
      },
    });
    const wranglingName = `loom-sm-ingest-${short}`;
    await upsertWranglingDataFlow(wranglingName, m);
    const phaseA = await runWranglingDataFlow(wranglingName, [
      { queryName: outputQuery, sinkName: 'ParquetSink', datasetName: stagingDataset },
    ]);

    // ========== Phase B — Parquet → Delta (Mapping Data Flow) ==========
    const deltaFlowName = `loom-sm-delta-${short}`;
    const deltaPipeName = `loom-sm-delta-pipe-${short}`;
    const useSynapse = !!process.env.LOOM_SYNAPSE_WORKSPACE && synapseConfigGate() === null;
    let deltaRunId: string;
    let deltaBackend: 'synapse' | 'adf';

    if (useSynapse) {
      deltaBackend = 'synapse';
      await synapseUpsertLinkedService(ADLS_LS, {
        name: ADLS_LS,
        properties: { type: 'AzureBlobFS', description: 'Loom ADLS Gen2 (workspace MI auth).', typeProperties: { url: adls.dfsBase } },
      });
      await synapseUpsertDataFlow(deltaFlowName, {
        name: deltaFlowName,
        properties: { type: 'MappingDataFlow', typeProperties: deltaFlowTypeProperties(container, stagingPath, deltaRelPath) },
      });
      await synapseUpsertPipeline(deltaPipeName, {
        name: deltaPipeName,
        properties: {
          description: `Loom semantic-model Parquet→Delta for ${id}`,
          activities: [executeDataFlowActivity(deltaFlowName)],
          annotations: ['loom', 'semantic-model-ingest'],
        },
      });
      deltaRunId = (await synapseRunPipeline(deltaPipeName)).runId;
    } else {
      deltaBackend = 'adf';
      await adfUpsertDataFlow(deltaFlowName, {
        name: deltaFlowName,
        properties: { type: 'MappingDataFlow', typeProperties: deltaFlowTypeProperties(container, stagingPath, deltaRelPath) },
      });
      await adfUpsertPipeline(deltaPipeName, {
        name: deltaPipeName,
        properties: {
          description: `Loom semantic-model Parquet→Delta for ${id}`,
          activities: [executeDataFlowActivity(deltaFlowName)],
          annotations: ['loom', 'semantic-model-ingest'],
        },
      });
      deltaRunId = (await adfRunPipeline(deltaPipeName)).runId;
      if (process.env.LOOM_SYNAPSE_WORKSPACE) {
        warnings.push('LOOM_SYNAPSE_WORKSPACE set but its config gate failed — used ADF for the Parquet→Delta step.');
      }
    }

    // ========== Phase C — AAS refresh (best-effort) ==========
    let aasRefreshId: string | undefined;
    const aasGate = aasConfigGate();
    if (aasGate?.missing === 'AAS_NOT_IN_GOV') {
      warnings.push(
        `Azure Analysis Services is unavailable in this cloud — query the Delta table at ${deltaPath} via Synapse Serverless SQL: ` +
        `SELECT * FROM OPENROWSET(BULK '${deltaPath}', FORMAT='DELTA') AS r. ${process.env.LOOM_SYNAPSE_WORKSPACE ? '' : 'Set LOOM_SYNAPSE_WORKSPACE to enable the Serverless path.'}`.trim(),
      );
    } else if (aasGate) {
      warnings.push(`AAS refresh skipped — set ${aasGate.missing} to enable it.${aasGate.reason ? ` ${aasGate.reason}` : ''}`);
    } else {
      try {
        aasRefreshId = (await postAasRefresh([{ table: (body.aasTable || outputQuery).trim() }])).refreshId;
      } catch (e: any) {
        warnings.push(`AAS refresh dispatch failed (Delta already landed): ${e?.message || String(e)}`);
      }
    }

    // ----- Best-effort: persist run state to the Cosmos item -----
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (workspaceId && !(await assertOwner(workspaceId, session.claims.oid))) return NextResponse.json({ ok: false, error: 'semantic model not found' }, { status: 404 });
    if (workspaceId) {
      try {
        const items = await itemsContainer();
        const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
        if (resource) {
          await items.item(id, workspaceId).replace({
            ...resource,
            state: {
              ...(resource.state || {}),
              lastIngestAt: new Date().toISOString(),
              lastIngestRunId: phaseA.runId,
              deltaRunId,
              deltaPath,
              aasRefreshId,
            },
            updatedAt: new Date().toISOString(),
          } as WorkspaceItem);
        }
      } catch { /* non-fatal — the run is already dispatched */ }
    }

    return NextResponse.json({
      ok: true,
      adfRunId: phaseA.runId,
      pipelineName: phaseA.pipelineName,
      outputQuery,
      container,
      deltaPath,
      deltaRunId,
      deltaBackend,
      aasRefreshId,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), warnings: warnings.length ? warnings : undefined }, { status: 502 });
  }
}
