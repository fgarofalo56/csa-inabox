/**
 * POST /api/items/data-pipeline/practice-seed
 * body: { workspaceId: string }
 *
 * Backs the data-pipeline editor's "Practice with sample data" landing card.
 * Real end-to-end, no mocks (per .claude/rules/no-vaporware.md):
 *
 *   1. Uploads a real sample sales CSV to landing/samples/loom-sales-2026.csv
 *      on the ADLS Gen2 account named by LOOM_SAMPLE_ADLS.
 *   2. Upserts an ADF linked service (AzureBlobFS, factory MSI auth — no key),
 *      a DelimitedText source dataset, and a Parquet sink dataset.
 *   3. Upserts an idempotent copy pipeline (loom_practice_copy) and runs it via
 *      ADF createRun (real run GUID).
 *   4. Upserts a Cosmos data-pipeline workspace item bound to that ADF pipeline
 *      so the editor can navigate to it and the Output pane surfaces the run.
 *
 * Honest gates (no-vaporware): if LOOM_SAMPLE_ADLS is unset, or ADF isn't
 * configured, we 503 with the exact env var / role to provision — the card
 * never fakes success. This is an Azure-native path: it does NOT require a
 * Microsoft Fabric workspace (per .claude/rules/no-fabric-dependency.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { getServiceClientFor } from '@/lib/azure/adls-client';
import {
  upsertLinkedService, upsertDataset, upsertPipeline, runPipeline, adfConfigGate,
} from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

/**
 * Storage DFS endpoint suffix. Commercial + GCC use the commercial suffix;
 * GCC-High / IL5 use the usgovcloudapi suffix. Derived from AZURE_CLOUD so the
 * ADF linked-service URL is correct per cloud.
 */
function dfsSuffix(): string {
  return process.env.AZURE_CLOUD === 'AzureUSGovernment'
    ? 'dfs.core.usgovcloudapi.net'
    : 'dfs.core.windows.net';
}

const SAMPLE_CSV = [
  'OrderId,Date,Region,Product,Qty,Revenue',
  'ORD-001,2026-01-03,West,Loom Widget,100,5000.00',
  'ORD-002,2026-01-04,East,Loom Gadget,50,2500.00',
  'ORD-003,2026-01-05,Central,Loom Service,200,10000.00',
  'ORD-004,2026-01-06,West,Loom Widget,75,3750.00',
  'ORD-005,2026-01-07,GovCloud,Loom IL5 Pack,25,8750.00',
  'ORD-006,2026-01-08,East,Loom Gadget,120,6000.00',
  'ORD-007,2026-01-09,West,Loom Service,300,15000.00',
  'ORD-008,2026-01-10,Central,Loom Widget,60,3000.00',
  'ORD-009,2026-01-11,GovCloud,Loom IL5 Pack,10,3500.00',
  'ORD-010,2026-01-12,East,Loom Service,80,4000.00',
  'ORD-011,2026-01-13,West,Loom Gadget,45,2250.00',
  'ORD-012,2026-01-14,Central,Loom Widget,150,7500.00',
  'ORD-013,2026-01-15,GovCloud,Loom IL5 Pack,30,10500.00',
  'ORD-014,2026-01-16,East,Loom Widget,90,4500.00',
  'ORD-015,2026-01-17,West,Loom Service,110,5500.00',
  'ORD-016,2026-01-18,Central,Loom Gadget,65,3250.00',
  'ORD-017,2026-01-19,GovCloud,Loom IL5 Pack,15,5250.00',
  'ORD-018,2026-01-20,East,Loom Service,70,3500.00',
  'ORD-019,2026-01-21,West,Loom Widget,130,6500.00',
  'ORD-020,2026-01-22,Central,Loom Gadget,85,4250.00',
].join('\n');

// Stable resource names — every upsert is idempotent so re-clicking the card
// updates rather than duplicates.
const LS_NAME = 'LS_Loom_ADLS_Sample';
const SRC_DS = 'DS_Loom_Sample_CSV';
const SINK_DS = 'DS_Loom_Sample_Bronze';
const ADF_PIPELINE = 'loom_practice_copy';

const COPY_ACTIVITY = {
  name: 'CopySampleCsvToBronze',
  type: 'Copy',
  dependsOn: [] as unknown[],
  typeProperties: {
    source: {
      type: 'DelimitedTextSource',
      storeSettings: { type: 'AzureBlobFSReadSettings', recursive: false },
      formatSettings: { type: 'DelimitedTextReadSettings' },
    },
    sink: {
      type: 'ParquetSink',
      storeSettings: { type: 'AzureBlobFSWriteSettings' },
      formatSettings: { type: 'ParquetWriteSettings' },
    },
    enableStaging: false,
    dataIntegrationUnits: 4,
    translator: {
      type: 'TabularTranslator',
      typeConversion: true,
      typeConversionSettings: { allowDataTruncation: true, treatBooleanAsNumber: false },
    },
  },
  inputs: [{ referenceName: SRC_DS, type: 'DatasetReference' }],
  outputs: [{ referenceName: SINK_DS, type: 'DatasetReference' }],
};

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);

  const body = await req.json().catch(() => ({} as any));
  const workspaceId = String(body?.workspaceId || '').trim();
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('not found', 404);

  // Honest gate 1 — ADLS sample account. No silent fallback to LOOM_ADLS_ACCOUNT:
  // seeding writes real bytes, so the operator must opt the account in explicitly.
  const adlsAccount = process.env.LOOM_SAMPLE_ADLS;
  if (!adlsAccount) {
    return NextResponse.json({
      ok: false,
      gate: {
        missing: 'LOOM_SAMPLE_ADLS',
        reason: 'ADLS Gen2 sample seeding is not configured for this deployment.',
        remediation:
          'Set LOOM_SAMPLE_ADLS=<storage-account-name> on the Console container app ' +
          '(typically the same value as LOOM_ADLS_ACCOUNT). The Console UAMI must hold ' +
          'Storage Blob Data Contributor on the account, and the ADF factory ' +
          'system-assigned identity must hold Storage Blob Data Contributor so the copy ' +
          'pipeline can read landing/ and write bronze/. No Microsoft Fabric required.',
      },
      error: 'LOOM_SAMPLE_ADLS not set — sample seeding disabled.',
    }, { status: 503 });
  }

  // Honest gate 2 — ADF factory.
  const adfGate = adfConfigGate();
  if (adfGate) {
    return NextResponse.json({
      ok: false,
      gate: {
        missing: adfGate.missing,
        reason: `Azure Data Factory is not configured in this deployment (missing ${adfGate.missing}).`,
        remediation:
          'Set LOOM_ADF_NAME, LOOM_DLZ_RG, and LOOM_SUBSCRIPTION_ID on the Console ' +
          'container app, and grant the Console UAMI the "Data Factory Contributor" role ' +
          'on the factory. No Microsoft Fabric required.',
      },
      error: `ADF not configured: missing ${adfGate.missing}`,
    }, { status: 503 });
  }

  const dfsUrl = `https://${adlsAccount}.${dfsSuffix()}`;

  try {
    // 1. Upload the sample CSV to landing/samples/loom-sales-2026.csv (real bytes).
    const svc = getServiceClientFor(adlsAccount);
    const fsClient = svc.getFileSystemClient('landing');
    const fileClient = fsClient.getFileClient('samples/loom-sales-2026.csv');
    const buf = Buffer.from(SAMPLE_CSV, 'utf-8');
    await fileClient.upload(buf, {
      pathHttpHeaders: { contentType: 'text/csv; charset=UTF-8' },
    });

    // 2. Linked service — AzureBlobFS, factory MSI auth (no accountKey).
    await upsertLinkedService(LS_NAME, {
      name: LS_NAME,
      properties: {
        type: 'AzureBlobFS',
        typeProperties: { url: dfsUrl },
        annotations: ['loom-practice-seed'],
        description: 'Auto-created by CSA Loom "Practice with sample data". Factory MSI auth.',
      },
    });

    // 3. Source dataset — DelimitedText over landing/samples/loom-sales-2026.csv.
    await upsertDataset(SRC_DS, {
      name: SRC_DS,
      properties: {
        type: 'DelimitedText',
        linkedServiceName: { referenceName: LS_NAME, type: 'LinkedServiceReference' },
        typeProperties: {
          location: {
            type: 'AzureBlobFSLocation',
            fileSystem: 'landing',
            folderPath: 'samples',
            fileName: 'loom-sales-2026.csv',
          },
          columnDelimiter: ',',
          firstRowAsHeader: true,
          encodingName: 'UTF-8',
        },
        annotations: ['loom-practice-seed'],
      },
    });

    // 4. Sink dataset — Parquet (snappy) into bronze/samples.
    await upsertDataset(SINK_DS, {
      name: SINK_DS,
      properties: {
        type: 'Parquet',
        linkedServiceName: { referenceName: LS_NAME, type: 'LinkedServiceReference' },
        typeProperties: {
          location: {
            type: 'AzureBlobFSLocation',
            fileSystem: 'bronze',
            folderPath: 'samples',
          },
          compressionCodec: 'snappy',
        },
        annotations: ['loom-practice-seed'],
      },
    });

    // 5. Copy pipeline — idempotent upsert.
    await upsertPipeline(ADF_PIPELINE, {
      name: ADF_PIPELINE,
      properties: {
        description:
          'CSA Loom practice pipeline — copies the sample sales CSV from ' +
          'landing/samples to bronze/samples (Parquet, snappy). Auto-generated.',
        activities: [COPY_ACTIVITY],
        parameters: {},
        variables: {},
        annotations: ['loom-practice-seed'],
      },
    });

    // 6. Run it (real ADF run GUID).
    const runRes = await runPipeline(ADF_PIPELINE, {});

    // 7. Upsert the Cosmos workspace item (find-or-create by adfPipelineName) so
    //    the editor can navigate to it and the Output pane queries the run.
    const items = await itemsContainer();
    const { resources } = await items.items.query<WorkspaceItem>({
      query: `SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t AND c.state.adfPipelineName = @n`,
      parameters: [
        { name: '@w', value: workspaceId },
        { name: '@t', value: 'data-pipeline' },
        { name: '@n', value: ADF_PIPELINE },
      ],
    }, { partitionKey: workspaceId }).fetchAll();

    const now = new Date().toISOString();
    const definition = { name: ADF_PIPELINE, properties: { activities: [COPY_ACTIVITY] } };
    let pipelineItemId: string;

    if (resources.length > 0) {
      const ex = resources[0];
      await items.item(ex.id, workspaceId).replace<WorkspaceItem>({
        ...ex,
        updatedAt: now,
        state: { ...(ex.state || {}), adfPipelineName: ADF_PIPELINE, definition },
      });
      pipelineItemId = ex.id;
    } else {
      const { resource } = await items.items.create<WorkspaceItem>({
        id: crypto.randomUUID(),
        workspaceId,
        itemType: 'data-pipeline',
        displayName: 'Practice: Sales CSV → Bronze (Parquet)',
        description: 'Auto-generated by the CSA Loom "Practice with sample data" card.',
        state: { adfPipelineName: ADF_PIPELINE, definition },
        createdBy: s.claims.upn || s.claims.email || s.claims.oid,
        createdAt: now,
        updatedAt: now,
      });
      pipelineItemId = resource!.id;
    }

    return NextResponse.json({
      ok: true,
      pipelineId: pipelineItemId,
      adfPipelineName: ADF_PIPELINE,
      runId: runRes.runId,
      adlsPath: `${dfsUrl}/landing/samples/loom-sales-2026.csv`,
      bytesWritten: buf.length,
    });
  } catch (e: any) {
    // Bubble the real Azure error (403/404/etc.) verbatim — no masked success.
    return err(e?.message || String(e), e?.statusCode === 404 ? 404 : 502);
  }
}
