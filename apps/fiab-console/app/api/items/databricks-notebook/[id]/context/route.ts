/**
 * Execution-context lifecycle for the interactive Databricks notebook.
 *
 * POST   /api/items/databricks-notebook/[id]/context
 *        body { clusterId?, language, workspaceId? } -> { ok, contextId, clusterId }
 *        Creates a REPL execution context on the cluster (api/1.2/contexts/create).
 *        State (vars/imports/temp views) persists across cell runs in this context.
 *        `contextId` is an OPAQUE HANDLE bound to this item — not a raw
 *        Databricks context id.
 *
 * DELETE /api/items/databricks-notebook/[id]/context
 *        body { clusterId?, contextId, workspaceId? } -> { ok }
 *        Tears the context down (api/1.2/contexts/destroy). Best-effort.
 *
 * SECURITY (#2988). Both handlers shipped with `[id]` decorative (no `ctx.params`
 * accepted) and only a bare `getSession()`, so any signed-in user could create
 * REPL contexts on — and destroy another tenant's REPL contexts on — any cluster
 * in the shared Databricks workspace. A live context is not inert: it holds
 * variables, imports, temp views, and any credentials a previous command
 * materialised in it, so handing out or accepting raw context ids is a
 * cross-tenant state pivot. Both handlers now authorize the caller against the
 * item (WRITE-scoped — creating and destroying compute state are mutations) and
 * bind both coordinates. See `../../_lib/notebook-exec-scope.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  createExecutionContext,
  destroyExecutionContext,
  type CommandLanguage,
} from '@/lib/azure/databricks-client';
import {
  authorizeNotebookItem,
  mintExecContextHandle,
  resolveAuthorizedClusterId,
  verifyExecContextHandle,
} from '../../_lib/notebook-exec-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LANGS: CommandLanguage[] = ['python', 'sql', 'scala', 'r'];

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  const { denied } = await authorizeNotebookItem(
    id,
    body?.workspaceId ?? req.nextUrl.searchParams.get('workspaceId'),
  );
  if (denied) return denied;

  const language = (body?.language || 'python').toString().toLowerCase() as CommandLanguage;
  if (!LANGS.includes(language)) {
    return NextResponse.json({ ok: false, error: `invalid language: ${language}` }, { status: 400 });
  }

  const cluster = await resolveAuthorizedClusterId(body?.clusterId, { autoStart: true });
  if (!cluster.ok) {
    return NextResponse.json(
      { ok: false, error: cluster.error, ...(cluster.remediation ? { remediation: cluster.remediation } : {}) },
      { status: cluster.status },
    );
  }
  const clusterId = cluster.clusterId;

  try {
    const created = await createExecutionContext(clusterId, language);
    return NextResponse.json({
      ok: true,
      contextId: mintExecContextHandle({ itemId: id, clusterId, language }, created.id),
      clusterId,
    });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : e?.status === 404 ? 404 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  const { denied } = await authorizeNotebookItem(
    id,
    body?.workspaceId ?? req.nextUrl.searchParams.get('workspaceId'),
  );
  if (denied) return denied;

  const language = (body?.language || 'python').toString().toLowerCase() as CommandLanguage;
  if (!LANGS.includes(language)) {
    return NextResponse.json({ ok: false, error: `invalid language: ${language}` }, { status: 400 });
  }
  if (!body?.contextId) {
    return NextResponse.json({ ok: false, error: 'contextId is required' }, { status: 400 });
  }

  const cluster = await resolveAuthorizedClusterId(body?.clusterId, { autoStart: false });
  if (!cluster.ok) {
    return NextResponse.json(
      { ok: false, error: cluster.error, ...(cluster.remediation ? { remediation: cluster.remediation } : {}) },
      { status: cluster.status },
    );
  }
  const clusterId = cluster.clusterId;

  // Destroying is a mutation on live compute state, so the handle must verify
  // against THIS item's scope — otherwise an authorized caller could tear down
  // another tenant's REPL context by naming its id.
  const contextId = verifyExecContextHandle({ itemId: id, clusterId, language }, body.contextId);
  if (!contextId) {
    return NextResponse.json(
      { ok: false, error: 'contextId is not a valid execution context for this notebook.' },
      { status: 403 },
    );
  }

  try {
    await destroyExecutionContext(clusterId, contextId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
