/**
 * Open mirroring (push model) — Azure-native, no Microsoft Fabric.
 *
 * An external producer pushes Parquet into the ADLS `landing` container at
 * `<mirrorId>/<table>/*.parquet`; this route triggers a Synapse Spark Livy
 * batch that merges the new Parquet into a managed Delta table under Bronze.
 *
 * POST /api/items/mirrored-database/[id]/open-mirror?workspaceId=...
 *   body: { tableName?: string, mergeSchedule?: MergeSchedule, keyColumns?: string[] }
 *   → run a Parquet→Delta merge now (returns the Livy batch job id + the
 *     SELECT COUNT(*) over the managed Delta table for the receipt). Also
 *     persists mergeSchedule / keyColumns when supplied.
 *
 * GET /api/items/mirrored-database/[id]/open-mirror?workspaceId=...&action=config|status|sas
 *   action=config (default) → landing/Delta paths, schedule, key columns, last merge
 *   action=status           → refresh the last Livy batch job state (getSparkBatchJob)
 *   action=sas              → honest gate explaining the producer-credential options
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  runOpenMirrorMerge, openMirrorLandingAbfss, openMirrorDeltaAbfss,
  openMirrorOpenrowset, MERGE_SCHEDULE_OPTIONS, type MergeSchedule,
} from '@/lib/azure/mirror-engine';
import { getSparkBatchJob } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Uploading the script + submitting the Livy batch can take a little while.
export const maxDuration = 300;



/** Sanitize a table name to a safe path segment (mirrors the POST handler). */
function safeTable(name: unknown): string {
  return String(name || 'default').replace(/[^A-Za-z0-9_-]/g, '_') || 'default';
}

function openMirrorPoolName(): string {
  return (
    process.env.LOOM_OPEN_MIRROR_POOL ||
    process.env.LOOM_SYNAPSE_SPARK_POOL ||
    process.env.LOOM_SPARK_POOL ||
    'loompool'
  ).trim();
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const action = req.nextUrl.searchParams.get('action') || 'config';
  const tableName = safeTable(req.nextUrl.searchParams.get('tableName') || 'default');

  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mirrored-database') return apiError('mirrored database not found', 404);

    const state = (resource.state || {}) as Record<string, any>;
    const om = (state.openMirror || {}) as Record<string, any>;
    const mirrorId = resource.id;

    if (action === 'sas') {
      // User-delegation SAS minting needs the Console UAMI to hold "Storage Blob
      // Delegator" on the DLZ storage account (getUserDelegationKey). It holds
      // Storage Blob Data Contributor (data plane) + constrained RBAC Admin, not
      // the delegator role. Emit an honest gate with both the SAS path and the
      // simpler RBAC path so the producer can be wired up either way.
      return NextResponse.json({
        ok: false,
        gate: {
          missing: 'Storage Blob Delegator role',
          message:
            'User-delegation SAS minting requires the Console UAMI to hold "Storage Blob Delegator" on the DLZ ' +
            'storage account. Grant it with: az role assignment create --role "Storage Blob Delegator" ' +
            '--assignee <UAMI_PRINCIPAL_ID> --scope <storageAccountResourceId>.',
          workaround:
            'Recommended: use RBAC instead — grant the producer principal "Storage Blob Data Contributor" scoped to ' +
            'the landing container (no SAS needed).',
        },
        landingPath: openMirrorLandingAbfss(mirrorId) || null,
      });
    }

    if (action === 'status') {
      const jobId = om.lastMergeJobId != null ? Number(om.lastMergeJobId) : null;
      if (jobId == null) {
        return NextResponse.json({ ok: true, status: 'NoJob', message: 'No merge job has been submitted yet.' });
      }
      if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
        return NextResponse.json({ ok: true, jobId, status: om.lastMergeStatus || 'Unknown', message: 'Synapse workspace not configured — cannot refresh live job state.' });
      }
      try {
        const job = await getSparkBatchJob(openMirrorPoolName(), jobId);
        const liveStatus = job.result || job.state || om.lastMergeStatus || 'Unknown';
        // Persist the refreshed terminal/running status back to Cosmos.
        if (liveStatus !== om.lastMergeStatus) {
          const nextState = { ...state, openMirror: { ...om, lastMergeStatus: liveStatus } };
          await items.item(mirrorId, workspaceId).replace({ ...resource, state: nextState, updatedAt: new Date().toISOString() });
        }
        return NextResponse.json({ ok: true, jobId, status: liveStatus, state: job.state, result: job.result, log: (job.log || []).slice(-12) });
      } catch (e: any) {
        return NextResponse.json({ ok: false, error: e?.message || String(e) });
      }
    }

    // Default: config card data.
    return NextResponse.json({
      ok: true,
      landingPath: openMirrorLandingAbfss(mirrorId) || '(LOOM_LANDING_URL not set)',
      deltaPath: openMirrorDeltaAbfss(workspaceId, mirrorId) || '(LOOM_BRONZE_URL not set)',
      tableName,
      mergeSchedule: (om.mergeSchedule as MergeSchedule) || 'on-demand',
      keyColumns: Array.isArray(om.keyColumns) ? om.keyColumns : [],
      lastMergeAt: om.lastMergeAt || null,
      lastMergeJobId: om.lastMergeJobId ?? null,
      lastMergeStatus: om.lastMergeStatus || null,
      lastMergeRows: om.lastMergeRows ?? null,
      lastMergeError: om.lastMergeError || null,
      scheduleOptions: MERGE_SCHEDULE_OPTIONS,
      openrowset: openMirrorOpenrowset(workspaceId, mirrorId, tableName),
    });
  } catch (e: any) {
    if (e?.code === 404) return apiError('mirrored database not found', 404);
    return apiError(e?.message || String(e), 500);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const body = await req.json().catch(() => ({} as any));
  const tableName = safeTable(body?.tableName);
  const mergeSchedule = (MERGE_SCHEDULE_OPTIONS as readonly string[]).includes(body?.mergeSchedule)
    ? (body.mergeSchedule as MergeSchedule)
    : undefined;
  const bodyKeyColumns = Array.isArray(body?.keyColumns)
    ? body.keyColumns.map((c: unknown) => String(c).trim()).filter(Boolean)
    : undefined;

  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'mirrored-database') return apiError('mirrored database not found', 404);
    if ((existing.state as any)?.sourceType !== 'GenericMirror') {
      return apiError('open mirroring is only available for the "Open mirroring" (GenericMirror) source', 400);
    }

    const state = (existing.state || {}) as Record<string, any>;
    const om = (state.openMirror || {}) as Record<string, any>;
    const keyColumns: string[] = bodyKeyColumns ?? (Array.isArray(om.keyColumns) ? om.keyColumns : []);
    const sinceIso = om.lastMergeAt as string | undefined;

    const run = await runOpenMirrorMerge(existing.id, workspaceId, tableName, keyColumns, sinceIso);

    // Persist config + result regardless of success/gate/failure.
    const nextOm: Record<string, any> = {
      ...om,
      keyColumns,
      mergeSchedule: mergeSchedule ?? om.mergeSchedule ?? 'on-demand',
      lastMergeAt: run.status === 'NoNewFiles' || run.status === 'Gated' ? om.lastMergeAt : new Date().toISOString(),
      lastMergeJobId: run.jobId ?? om.lastMergeJobId ?? null,
      lastMergeStatus: run.status,
      lastMergeError: run.error || null,
    };
    const next: WorkspaceItem = { ...existing, state: { ...state, openMirror: nextOm }, updatedAt: new Date().toISOString() };
    await items.item(existing.id, workspaceId).replace(next);

    if (run.status === 'Gated') {
      return NextResponse.json({ ok: false, status: run.status, gate: run.gate, note: run.note, landingPath: run.landingPath, deltaPath: run.deltaPath });
    }
    return NextResponse.json({
      ok: run.ok,
      status: run.status,
      jobId: run.jobId,
      landingPath: run.landingPath,
      deltaPath: run.deltaPath,
      filesFound: run.filesFound,
      keyColumns,
      note: run.note,
      // The acceptance receipt's SELECT COUNT(*) over the managed Delta table.
      openrowset: openMirrorOpenrowset(workspaceId, existing.id, tableName),
      error: run.error,
    });
  } catch (e: any) {
    if (e?.code === 404) return apiError('mirrored database not found', 404);
    return apiError(e?.message || String(e), 500);
  }
}
