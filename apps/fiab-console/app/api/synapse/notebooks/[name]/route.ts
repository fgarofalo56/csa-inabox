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
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  synapseConfigGate, listNotebooks, upsertNotebook, deleteNotebook,
  type SynapseNotebook,
} from '@/lib/azure/synapse-artifacts-client';
import { uploadFile } from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

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
    console.warn('[synapse-notebook] ADLS backup failed (non-fatal):', e?.message || e);
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

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid notebook name' }, { status: 400 });
  try {
    const all = await listNotebooks();
    const nb = all.find((n) => n.name === name);
    if (!nb) return NextResponse.json({ ok: false, error: `notebook '${name}' not found` }, { status: 404 });
    return NextResponse.json({ ok: true, notebook: { name: nb.name, properties: nb.properties } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'name must be 1-260 chars: letters, digits, _' }, { status: 400 });
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
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = decodeURIComponent((await ctx.params).name).trim();
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid notebook name' }, { status: 400 });
  try {
    await deleteNotebook(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
