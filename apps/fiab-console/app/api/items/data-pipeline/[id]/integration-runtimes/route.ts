/**
 * Integration runtimes for a data-pipeline item, scoped through its backing
 * Azure Data Factory (the Manage-hub "Integration runtimes" experience, in the
 * pipeline editor).
 *
 *   GET    /api/items/data-pipeline/[id]/integration-runtimes?workspaceId=...
 *            → { ok, runtimes: [{ name, type, description, state }] }
 *              Each IR is enriched with its live state via getStatus (best-effort).
 *
 *   POST   /api/items/data-pipeline/[id]/integration-runtimes?workspaceId=...
 *            body { name, properties }                → upsert (Managed | SelfHosted)
 *            body { name, action: 'start' | 'stop' }  → lifecycle (Self-Hosted / SSIS)
 *            body { name, action: 'authKeys' }        → return Self-Hosted install keys
 *
 *   DELETE /api/items/data-pipeline/[id]/integration-runtimes?workspaceId=...&name=NAME
 *            → delete the IR
 *
 * The IR is a child of the factory (factory-scoped, not pipeline-scoped) — this
 * route exists so the pipeline editor can manage IRs inline. It validates that
 * the [id] is a data-pipeline the caller's session can read (auth + ownership)
 * and then delegates to adf-client against the env-pinned default factory.
 * Honest 503 gate when LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME are
 * unset. Real ARM REST. No mocks (no-vaporware).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  adfConfigGate,
  listIntegrationRuntimes, getIntegrationRuntimeStatus, upsertIntegrationRuntime,
  startIntegrationRuntime, stopIntegrationRuntime, deleteIntegrationRuntime,
  listIntegrationRuntimeAuthKeys,
  type AdfIntegrationRuntime,
} from '@/lib/azure/adf-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

function gate() {
  const g = adfConfigGate();
  if (g) {
    return err(`Data Factory not configured: set ${g.missing}.`, 503, { code: 'not_configured', missing: g.missing });
  }
  return null;
}

/** Confirm [id] is a data-pipeline the caller can read in this workspace. */
async function assertPipeline(id: string, workspaceId: string): Promise<boolean> {
  const items = await itemsContainer();
  const { resource } = await items.item(id, workspaceId).read<WorkspaceItem>();
  return !!resource && resource.itemType === 'data-pipeline';
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('pipeline not found', 404);
  const g = gate(); if (g) return g;
  try {
    if (!(await assertPipeline((await ctx.params).id, workspaceId))) return err('pipeline not found', 404);
    const irs = await listIntegrationRuntimes();
    // Enrich with live state. A failing per-IR status probe must not blank the
    // whole list — leave state undefined and continue.
    const runtimes = await Promise.all(
      irs.map(async (ir) => {
        let state: string | undefined;
        try {
          const st = await getIntegrationRuntimeStatus(ir.name);
          state = st.properties?.state;
        } catch { /* leave state undefined */ }
        return { name: ir.name, type: ir.properties?.type, description: ir.properties?.description, state };
      }),
    );
    return NextResponse.json({ ok: true, runtimes });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('pipeline not found', 404);
  const g = gate(); if (g) return g;

  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return err('name is required', 400);
  if (!NAME_RE.test(name)) return err('name must be 1-260 chars: letters, digits, _', 400);

  try {
    if (!(await assertPipeline((await ctx.params).id, workspaceId))) return err('pipeline not found', 404);

    if (body.action === 'start') { await startIntegrationRuntime(name); return NextResponse.json({ ok: true, action: 'start' }); }
    if (body.action === 'stop')  { await stopIntegrationRuntime(name);  return NextResponse.json({ ok: true, action: 'stop' }); }
    if (body.action === 'authKeys') {
      const keys = await listIntegrationRuntimeAuthKeys(name);
      return NextResponse.json({ ok: true, authKeys: keys });
    }

    const properties = body?.properties as AdfIntegrationRuntime['properties'] | undefined;
    if (!properties || (properties.type !== 'Managed' && properties.type !== 'SelfHosted')) {
      return err("properties.type must be 'Managed' or 'SelfHosted'", 400);
    }
    const saved = await upsertIntegrationRuntime(name, { name, properties });
    return NextResponse.json({
      ok: true,
      runtime: { name: saved.name, type: saved.properties?.type, description: saved.properties?.description },
    });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('pipeline not found', 404);
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return err('name query param is required', 400);
  try {
    if (!(await assertPipeline((await ctx.params).id, workspaceId))) return err('pipeline not found', 404);
    await deleteIntegrationRuntime(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}
