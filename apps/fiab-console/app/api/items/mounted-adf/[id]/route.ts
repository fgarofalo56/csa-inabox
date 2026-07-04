/**
 * Mounted ADF detail. Resolves the Cosmos record, then calls ARM REST
 * against the referenced factory for live pipelines / triggers / runs.
 *
 * Returns:
 *   { ok: true, mount, pipelines: [...], triggers: [...], runs: [...] }
 *
 * If the UAMI lacks Data Factory Contributor on the referenced factory
 * the ARM call surfaces its 401/403 verbatim with a hint.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  listMountedFactoryPipelines, listMountedFactoryTriggers, listMountedFactoryRuns,
  type MountedFactoryRef,
} from '@/lib/azure/adf-client';
import { apiServerError, apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('mounted data factory not found', 404);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mounted-adf') return err('mounted data factory not found', 404);
    const state = (resource.state || {}) as Record<string, string>;
    const ref: MountedFactoryRef = {
      subscriptionId: state.subscriptionId,
      resourceGroup: state.resourceGroup,
      factoryName: state.factoryName,
    };
    if (!ref.subscriptionId || !ref.resourceGroup || !ref.factoryName) {
      return err('factory reference incomplete', 400, { code: 'NO_REF' });
    }

    const errors: Record<string, string> = {};
    const pipelines = await listMountedFactoryPipelines(ref).catch(e => { errors.pipelines = e?.message || String(e); return []; });
    const triggers = await listMountedFactoryTriggers(ref).catch(e => { errors.triggers = e?.message || String(e); return []; });
    const runs = await listMountedFactoryRuns(ref).catch(e => { errors.runs = e?.message || String(e); return []; });

    return NextResponse.json({
      ok: true,
      mount: {
        id: resource.id,
        displayName: resource.displayName,
        description: resource.description,
        ...ref,
      },
      pipelines,
      triggers,
      runs,
      ...(Object.keys(errors).length ? { partial: errors } : {}),
    });
  } catch (e: any) {
    if (e?.code === 404) return err('mounted data factory not found', 404);
    return apiServerError(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('mounted data factory not found', 404);
  try {
    const items = await itemsContainer();
    await items.item((await ctx.params).id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return apiServerError(e);
  }
}
