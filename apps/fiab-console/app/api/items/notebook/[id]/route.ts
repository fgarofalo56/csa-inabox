/**
 * Notebook (Fabric) detail.
 * GET    /api/items/notebook/[id]?workspaceId=...                   — metadata + definition
 * PUT    /api/items/notebook/[id]?workspaceId=...                   — update definition (base64)
 *   body: { definition: { format?, parts: [{ path, payload, payloadType }] } }
 * DELETE /api/items/notebook/[id]?workspaceId=...
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getNotebook, getNotebookDefinition, updateNotebookDefinition, deleteNotebook, FabricError,
} from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof FabricError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint }, { status });
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [item, definition] = await Promise.all([
      getNotebook(workspaceId, ctx.params.id),
      getNotebookDefinition(workspaceId, ctx.params.id).catch(() => null),
    ]);
    return NextResponse.json({ ok: true, notebook: item, definition });
  } catch (e) { return err(e); }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  if (!body?.definition?.parts?.length) {
    return NextResponse.json({ ok: false, error: 'definition.parts required (base64 InlineBase64 payload)' }, { status: 400 });
  }
  try {
    const res = await updateNotebookDefinition(workspaceId, ctx.params.id, body.definition);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) { return err(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    await deleteNotebook(workspaceId, ctx.params.id);
    return NextResponse.json({ ok: true });
  } catch (e) { return err(e); }
}
