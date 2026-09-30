/**
 * Notebooks on the deployment-default Synapse workspace. Backs the "Notebooks"
 * group in the Workspace Resources navigator (the Synapse Studio Develop hub →
 * Notebooks surface) and the Synapse notebook editor's Create button.
 *
 *   GET    /api/synapse/notebooks                     → { ok, notebooks: [{name, language, pool}] }
 *   POST   /api/synapse/notebooks                     body { name, properties?, itemId? } → upsert (empty PySpark if omitted)
 *   DELETE /api/synapse/notebooks?name=NAME[&itemId=] → delete
 *
 * Workspace is the env-pinned default; honest 503 gate when LOOM_SYNAPSE_WORKSPACE
 * isn't set. Real Synapse dev-plane REST (api-version 2020-12-01). No mocks.
 *
 * Authorization (#4619): GET is session-scoped. POST and DELETE write to the
 * workspace every Synapse notebook item shares, so they are ITEM-SCOPED by
 * `authorizeNotebookWrite`: a tenant admin may write any valid name; anyone
 * else must send the `itemId` of a `synapse-notebook` item they can write
 * (POST: in the body or as `?itemId=`; DELETE: as `?itemId=`) and may write
 * only a name bound to it. Both refuse a name outside NOTEBOOK_NAME_RE with a
 * 400 before any authorization lookup.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { authorizeNotebookWrite } from '@/lib/notebook/synapse-notebook-write';
import { NOTEBOOK_NAME_RE as NAME_RE } from '@/lib/notebook/synapse-notebook-binding';
import {
  synapseConfigGate, listNotebooks, upsertNotebook, deleteNotebook, emptyNotebookProperties,
  type SynapseNotebook,
} from '@/lib/azure/synapse-artifacts-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export const GET = withSession(async () => {
  const g = gate(); if (g) return g;
  try {
    const notebooks = (await listNotebooks()).map((n) => ({
      name: n.name,
      language: (n.properties?.metadata as any)?.language_info?.name
        || (n.properties?.metadata as any)?.kernelspec?.language
        || 'python',
      pool: n.properties?.bigDataPool?.referenceName,
    }));
    return NextResponse.json({ ok: true, notebooks });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const POST = withSession(async (req: NextRequest, { session }) => {
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'name must be 1-260 chars: letters, digits, _' }, { status: 400 });
  const itemId = typeof body?.itemId === 'string' ? body.itemId : req.nextUrl.searchParams.get('itemId');
  const denied = await authorizeNotebookWrite(session, name, itemId);
  if (denied) return denied;
  const properties = (body?.properties as SynapseNotebook['properties']) || emptyNotebookProperties();
  try {
    const saved = await upsertNotebook(name, { name, properties });
    return NextResponse.json({ ok: true, notebook: { name: saved.name } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const DELETE = withSession(async (req: NextRequest, { session }) => {
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'name must be 1-260 chars: letters, digits, _' }, { status: 400 });
  const denied = await authorizeNotebookWrite(session, name, req.nextUrl.searchParams.get('itemId'));
  if (denied) return denied;
  try {
    await deleteNotebook(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
