/**
 * Single Synapse notebook artifact on the deployment-default workspace. Backs
 * the heavy notebook-designer surface (Synapse Studio Develop hub → Notebooks
 * → open a notebook): returns the FULL IPYNB shape (cells[], metadata,
 * bigDataPool attachment) so the editor can render every cell.
 *
 *   GET    /api/synapse/notebooks/[name] → { ok, notebook: { name, properties } }
 *   PUT    /api/synapse/notebooks/[name] body { properties } → upsert full notebook
 *   DELETE /api/synapse/notebooks/[name] → delete
 *
 * Real Synapse dev-plane REST (api-version 2020-12-01) via the shared
 * synapse-artifacts-client. Honest 503 gate when LOOM_SYNAPSE_WORKSPACE unset.
 * No mocks.
 *
 * GET reads through listNotebooks() (the dev-plane GET /notebooks collection)
 * and selects the requested artifact — the collection list already carries the
 * full per-notebook properties (cells included), so a single round-trip returns
 * everything the designer needs.
 *
 * Learn (dev-plane artifact REST, list/PUT/DELETE):
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/notebook
 *
 * Authorization (#4619): PUT and DELETE write to (or remove from) the
 * DEPLOYMENT-DEFAULT Synapse workspace, which every Synapse notebook item
 * shares, and PUT also writes a backup blob into the shared silver container.
 * They are ITEM-SCOPED: the editor sends `?itemId=` for the notebook item it
 * is editing, and `authorizeNotebookWrite` requires a write role on that item
 * and a name bound to it (lib/notebook/synapse-notebook-binding). A tenant
 * admin may write any name; a non-admin with no `itemId` gets the `admin_only`
 * 403. The check runs after the name is validated and before the body is read.
 * GET stays session-scoped. Every verb refuses a name outside NAME_RE
 * (letters, digits, `_` — so no separator, dot segment, or control character
 * can reach the ADLS backup path or the dev-plane URL), and a malformed
 * percent-escape is a 400, not a thrown `URIError`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { authorizeNotebookWrite } from '@/lib/notebook/synapse-notebook-write';
import { NOTEBOOK_NAME_RE as NAME_RE } from '@/lib/notebook/synapse-notebook-binding';
import {
  synapseConfigGate, listNotebooks, upsertNotebook, deleteNotebook,
  type SynapseNotebook,
} from '@/lib/azure/synapse-artifacts-client';
import { uploadFile } from '@/lib/azure/adls-client';
import { logSafe } from '@/lib/util/log-safe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Best-effort .ipynb backup of the published notebook to ADLS silver, so the
 * notebook artifact is also durable in the Loom data lake (the no-fabric-
 * dependency "notebook persisted in Cosmos + ADLS" requirement). Non-fatal:
 * the Synapse publish is the source of truth, so an ADLS failure (silver not
 * provisioned, missing role) never blocks the save — it returns a status the
 * UI surfaces. Requires LOOM_SILVER_URL + the Console UAMI holding Storage
 * Blob Data Contributor on the DLZ data-lake account (the same access the
 * lakehouse provisioner uses; granted by the post-deploy bootstrap step
 * "Grant Console UAMI Storage Blob Data Contributor on DLZ"). Path:
 * loom/notebooks/<workspace>/<name>.ipynb
 */
async function adlsBackup(name: string, properties: SynapseNotebook['properties']):
  Promise<{ ok: true; path: string } | { ok: false; skipped?: boolean; error?: string }> {
  const ws = process.env.LOOM_SYNAPSE_WORKSPACE;
  if (!process.env.LOOM_SILVER_URL || !ws) {
    return { ok: false, skipped: true };
  }
  const path = `loom/notebooks/${ws}/${name}.ipynb`;
  try {
    const body = Buffer.from(JSON.stringify(properties, null, 2), 'utf-8');
    await uploadFile('silver', path, body, 'application/x-ipynb+json');
    return { ok: true, path: `silver/${path}` };
  } catch (e: any) {
    console.warn('[synapse-notebook] ADLS backup failed (non-fatal):', logSafe(e?.message || e));
    return { ok: false, error: e?.message || String(e) };
  }
}

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

/**
 * The notebook name from the route segment, or null when it is not a valid
 * notebook name (including a malformed percent-escape, which would otherwise
 * throw and surface as a 500).
 */
function notebookName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let name: string;
  try {
    name = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  return NAME_RE.test(name) ? name : null;
}

export const GET = withSession<{ name: string }>(async (_req: NextRequest, { params }) => {
  const g = gate(); if (g) return g;
  const name = notebookName(params.name);
  if (!name) return NextResponse.json({ ok: false, error: 'invalid notebook name' }, { status: 400 });
  try {
    const all = await listNotebooks();
    const nb = all.find((n) => n.name === name);
    if (!nb) return NextResponse.json({ ok: false, error: `notebook '${name}' not found` }, { status: 404 });
    return NextResponse.json({ ok: true, notebook: { name: nb.name, properties: nb.properties } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

// Item-scoped (see header): a refused caller never reaches `upsertNotebook`
// or `uploadFile`.
export const PUT = withSession<{ name: string }>(async (req: NextRequest, { params, session }) => {
  const g = gate(); if (g) return g;
  const name = notebookName(params.name);
  if (!name) return NextResponse.json({ ok: false, error: 'name must be 1-260 chars: letters, digits, _' }, { status: 400 });
  const denied = await authorizeNotebookWrite(session, name, req.nextUrl?.searchParams.get('itemId'));
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const properties = body?.properties as SynapseNotebook['properties'] | undefined;
  if (!properties || typeof properties !== 'object') {
    return NextResponse.json({ ok: false, error: 'properties is required' }, { status: 400 });
  }
  try {
    const saved = await upsertNotebook(name, { name, properties });
    const backup = await adlsBackup(name, properties);
    return NextResponse.json({ ok: true, notebook: { name: saved.name }, adlsBackup: backup });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

// Item-scoped, same check as PUT: a refused caller never reaches `deleteNotebook`.
export const DELETE = withSession<{ name: string }>(async (req: NextRequest, { params, session }) => {
  const g = gate(); if (g) return g;
  const name = notebookName(params.name);
  if (!name) return NextResponse.json({ ok: false, error: 'invalid notebook name' }, { status: 400 });
  const denied = await authorizeNotebookWrite(session, name, req.nextUrl?.searchParams.get('itemId'));
  if (denied) return denied;
  try {
    await deleteNotebook(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
