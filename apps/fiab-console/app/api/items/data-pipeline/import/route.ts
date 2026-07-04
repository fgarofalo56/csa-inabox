/**
 * POST /api/items/data-pipeline/import?workspaceId=...&displayName=...
 *
 * Real pipeline import from a .zip exported by Loom (or ADF Studio ARM
 * export). Accepts multipart/form-data with a single `file` field.
 *
 * Steps:
 *   1. Verify the workspace belongs to this tenant.
 *   2. Parse the ZIP, locate pipeline-content.json (or the first .json
 *      file matching { properties: { activities: [] } }).
 *   3. Validate: must be a valid pipeline spec.
 *   4. If ADF is configured, upsertPipeline to create the live ADF resource.
 *   5. Create a NEW Cosmos item (import never overwrites an existing one).
 *
 * No simulated success: every step either succeeds or returns a structured
 * error. The ADF gate is honest — when ADF env vars are missing the pipeline
 * is still saved to Loom (Cosmos) and the response carries a `gate` with the
 * exact missing env var, so the editor surfaces a precise MessageBar.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertPipeline, adfConfigGate } from '@/lib/azure/adf-client';
import { readZip } from '@/lib/azure/zip';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError, apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: object) {
  return apiError(error, status, extra);
}

/** Shape guard for a pipeline spec: must have properties.activities array. */
function isPipelineSpec(v: unknown): v is { name?: string; properties: { activities: unknown[] } } {
  if (!v || typeof v !== 'object') return false;
  const p = (v as any).properties;
  return !!p && typeof p === 'object' && Array.isArray(p.activities);
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);

  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);

  // Verify the workspace belongs to this tenant before touching anything.
  const wsContainer = await workspacesContainer();
  try {
    const { resource: ws } = await wsContainer.item(workspaceId, s.claims.oid).read<Workspace>();
    if (!ws || ws.tenantId !== s.claims.oid) return err('workspace not found', 404);
  } catch (e: any) {
    if (e?.code === 404) return err('workspace not found', 404);
    return apiServerError(e);
  }

  // Parse multipart/form-data
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err('Expected multipart/form-data with a "file" field', 400);
  }
  const file = form.get('file');
  if (!file || !(file instanceof Blob)) return err('"file" field is required', 400);

  const bytes = Buffer.from(await file.arrayBuffer());

  // Unzip
  let entries: Map<string, Buffer>;
  try {
    entries = readZip(bytes);
  } catch (e: any) {
    return err(`Invalid ZIP: ${e?.message || e}`, 400);
  }

  // Locate pipeline-content.json first, then any .json with the right shape.
  let pipelineJson: { name?: string; properties: { activities: unknown[] } } | null = null;
  const preferred = entries.get('pipeline-content.json');
  if (preferred) {
    try {
      const parsed = JSON.parse(preferred.toString('utf-8'));
      if (isPipelineSpec(parsed)) pipelineJson = parsed;
    } catch { /* fall through */ }
  }
  if (!pipelineJson) {
    for (const [name, buf] of entries) {
      if (!name.endsWith('.json') || name === 'manifest.json') continue;
      try {
        const parsed = JSON.parse(buf.toString('utf-8'));
        if (isPipelineSpec(parsed)) { pipelineJson = parsed; break; }
      } catch { /* skip */ }
    }
  }
  if (!pipelineJson) {
    return err('No valid pipeline-content.json found in the ZIP. ' +
      'Expected a file with { properties: { activities: [] } }.', 400);
  }

  // Derive display name: query param > manifest > JSON name > fallback
  const manifestBuf = entries.get('manifest.json');
  let displayName = req.nextUrl.searchParams.get('displayName')?.trim() || '';
  if (!displayName && manifestBuf) {
    try {
      const m = JSON.parse(manifestBuf.toString('utf-8'));
      if (typeof m?.displayName === 'string') displayName = m.displayName;
    } catch { /* ignore */ }
  }
  if (!displayName && typeof pipelineJson.name === 'string') {
    displayName = pipelineJson.name;
  }
  displayName = (displayName || 'Imported pipeline').trim().slice(0, 200);

  // Mint an ADF pipeline name
  const itemId = crypto.randomUUID();
  const adfName = `${displayName.replace(/[^A-Za-z0-9 _()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}_${itemId.replace(/[^A-Za-z0-9]/g, '').slice(-6)}`;

  // Push to ADF if configured (honest gate)
  const gate = adfConfigGate();
  let adfPublished = false;
  if (!gate) {
    try {
      await upsertPipeline(adfName, { name: adfName, properties: pipelineJson.properties as any });
      adfPublished = true;
    } catch (e: any) {
      return err(`ADF write failed: ${e?.message || e}`, 502);
    }
  }

  // Create the Cosmos item (always new)
  const now = new Date().toISOString();
  const item: WorkspaceItem = {
    id: itemId,
    workspaceId,
    itemType: 'data-pipeline',
    displayName,
    state: {
      definition: pipelineJson,
      ...(adfPublished ? { adfPipelineName: adfName } : {}),
    },
    createdBy: s.claims.upn || s.claims.email || s.claims.oid,
    createdAt: now,
    updatedAt: now,
  };
  const items = await itemsContainer();
  const { resource } = await items.items.create(item);

  return NextResponse.json({
    ok: true,
    pipeline: { id: resource?.id, displayName, adfPipelineName: adfPublished ? adfName : undefined },
    adfPublished,
    ...(gate ? {
      gate: {
        reason: `ADF not configured (missing ${gate.missing}) — pipeline saved to Loom only.`,
        remediation: 'Set LOOM_ADF_NAME, LOOM_DLZ_RG, LOOM_SUBSCRIPTION_ID and grant the Console UAMI Data Factory Contributor to publish.',
      },
    } : {}),
  });
}
