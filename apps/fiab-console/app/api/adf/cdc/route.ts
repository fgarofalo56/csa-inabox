/**
 * Change Data Capture (preview) on the deployment-default Data Factory. Backs
 * the "Change Data Capture (preview)" group in the Factory Resources navigator
 * and the AdfCdcEditor detail panel.
 *
 * The CDC resource is `Microsoft.DataFactory/factories/adfcdcs` — a pure Azure
 * Data Factory ARM resource (api-version 2018-06-01). It is NOT a Fabric
 * dependency: this works with LOOM_DEFAULT_FABRIC_WORKSPACE unset, against a
 * plain ADF in Commercial or Gov. Fabric Data Factory uses Copy Jobs instead;
 * we never touch Fabric here.
 *
 *   GET    /api/adf/cdc                         → { ok, cdcs: [{name, status, mode, sourceCount, targetCount}] }
 *   GET    /api/adf/cdc?name=NAME               → { ok, cdc: {name, status, mode, recurrence, sources[], targets[]} }
 *   GET    /api/adf/cdc?name=NAME&status=1      → { ok, status: string }   (live status poll)
 *   GET    /api/adf/cdc?name=NAME&preview=1[&entity=schema.table][&rows=N] → { ok, preview: {entity, entities[], columns[], rows[][], rowCount, truncated, deltaUrl} }
 *   POST   /api/adf/cdc   body { name, action:'start'|'stop'|'delete' }    → lifecycle
 *   POST   /api/adf/cdc   body { name, spec: AdfCdcSpec }                  → upsert
 *   DELETE /api/adf/cdc?name=NAME              → delete
 *
 * Factory is the env-pinned default; honest 503 gate when LOOM_SUBSCRIPTION_ID
 * / LOOM_DLZ_RG / LOOM_ADF_NAME aren't set. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  adfCdcConfigGate, listAdfCdcs, getAdfCdc, upsertAdfCdc,
  startAdfCdc, stopAdfCdc, deleteAdfCdc, statusAdfCdc, previewAdfCdcTarget,
  type AdfCdc, type AdfCdcSpec,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_-]{1,260}$/;

function gate() {
  const g = adfCdcConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Data Factory not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

/** Map the ARM CDC resource to the navigator's compact row shape. */
function summarize(c: AdfCdc) {
  const p = c.properties;
  return {
    name: c.name,
    status: p?.status || 'Unknown',
    mode: p?.policy?.mode || 'Continuous',
    sourceCount: (p?.sourceConnectionsInfo || []).reduce((n, s) => n + (s.sourceEntities?.length || 0), 0),
    targetCount: (p?.targetConnectionsInfo || []).reduce((n, t) => n + (t.targetEntities?.length || 0), 0),
  };
}

/** Full detail shape for the editor panel. */
function detail(c: AdfCdc) {
  const p = c.properties;
  return {
    name: c.name,
    status: p?.status || 'Unknown',
    description: p?.description || '',
    mode: p?.policy?.mode || 'Continuous',
    recurrence: p?.policy?.recurrence || null,
    folder: p?.folder?.name || '',
    sources: (p?.sourceConnectionsInfo || []).map((s) => ({
      linkedService: s.connection?.linkedService?.referenceName || '(inline)',
      connectorType: s.connection?.linkedServiceType || '—',
      entities: (s.sourceEntities || []).map((e) => e.name),
    })),
    targets: (p?.targetConnectionsInfo || []).map((t) => ({
      linkedService: t.connection?.linkedService?.referenceName || '(inline)',
      connectorType: t.connection?.linkedServiceType || '—',
      entities: (t.targetEntities || []).map((e) => e.name),
    })),
  };
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  const name = req.nextUrl.searchParams.get('name')?.trim();
  const wantStatus = req.nextUrl.searchParams.get('status');
  const wantPreview = req.nextUrl.searchParams.get('preview');

  try {
    if (name) {
      if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid name' }, { status: 400 });
      // Lightweight live-status poll (used by the editor while Running).
      if (wantStatus) {
        const status = await statusAdfCdc(name);
        return NextResponse.json({ ok: true, status });
      }
      // Change-data preview — read the rows the CDC resource landed in its
      // Delta target via Synapse Serverless OPENROWSET FORMAT='DELTA'.
      if (wantPreview) {
        const entity = req.nextUrl.searchParams.get('entity')?.trim() || undefined;
        if (entity && entity.length > 260) {
          return NextResponse.json({ ok: false, error: 'invalid entity' }, { status: 400 });
        }
        const rowsParam = Number(req.nextUrl.searchParams.get('rows'));
        const rowLimit = Number.isFinite(rowsParam) && rowsParam > 0 ? rowsParam : 100;
        const preview = await previewAdfCdcTarget(name, entity, rowLimit);
        return NextResponse.json({ ok: true, preview });
      }
      const c = await getAdfCdc(name);
      return NextResponse.json({ ok: true, cdc: detail(c) });
    }
    const cdcs = (await listAdfCdcs()).map(summarize);
    return NextResponse.json({ ok: true, cdcs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'name must be 1-260 chars: letters, digits, _ or -' }, { status: 400 });

  try {
    if (body.action === 'start')  { await startAdfCdc(name);  return NextResponse.json({ ok: true, action: 'start' }); }
    if (body.action === 'stop')   { await stopAdfCdc(name);   return NextResponse.json({ ok: true, action: 'stop' }); }
    if (body.action === 'delete') { await deleteAdfCdc(name); return NextResponse.json({ ok: true, action: 'delete' }); }

    // Upsert path — caller supplies a full AdfCdcSpec (built by the mirror
    // wizard / mirror-engine). The CDC resource is created Stopped; the
    // operator clicks Start once they've inspected source/target mapping.
    if (body.spec && typeof body.spec === 'object') {
      const saved = await upsertAdfCdc(name, body.spec as AdfCdcSpec);
      return NextResponse.json({ ok: true, cdc: summarize(saved) });
    }

    return NextResponse.json({ ok: false, error: 'provide action (start|stop|delete) or spec' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deleteAdfCdc(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
