/**
 * Service-level Indexers collection for the AI Search navigator.
 *
 *   GET    /api/ai-search/indexers              → { ok, indexers:[{name,targetIndexName,dataSourceName,skillsetName}] }
 *   POST   /api/ai-search/indexers
 *            body { name, dataSourceName, targetIndexName, skillsetName? }  → create-or-update (PUT /indexers/{name})
 *            body { action:'run'|'reset'|'status', indexer }                → lifecycle / status
 *   DELETE /api/ai-search/indexers?name=N        → delete
 *
 * Honest 503 gate when LOOM_AI_SEARCH_SERVICE is unset. Real AI Search REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listIndexers, createIndexer, deleteIndexer, runIndexer, resetIndexer, getIndexerStatus,
  getIndexer, updateIndexerSchedule, validateScheduleInterval,
  searchConfigGate, SearchNotDeployedError, SearchDataError,
} from '@/lib/azure/search-index-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = searchConfigGate();
  if (g) return NextResponse.json({ ok: false, code: 'not_configured', error: `Azure AI Search not configured: set ${g.missing}.`, missing: g.missing }, { status: 503 });
  return null;
}
function fail(e: any) {
  if (e instanceof SearchNotDeployedError) {
    return NextResponse.json({ ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_AI_SEARCH_SERVICE', notDeployed: true }, { status: 503 });
  }
  const status = e instanceof SearchDataError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try { return NextResponse.json({ ok: true, indexers: await listIndexers() }); }
  catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));

  // lifecycle + schedule actions
  if (body?.action) {
    const indexer = typeof body?.indexer === 'string' ? body.indexer.trim() : '';
    if (!indexer) return NextResponse.json({ ok: false, error: 'indexer name required' }, { status: 400 });
    if (!['run', 'reset', 'status', 'get', 'setSchedule'].includes(body.action)) {
      return NextResponse.json({ ok: false, error: "action must be 'run', 'reset', 'status', 'get' or 'setSchedule'" }, { status: 400 });
    }
    try {
      if (body.action === 'run') { await runIndexer(indexer); return NextResponse.json({ ok: true, action: 'run', indexer }); }
      if (body.action === 'reset') { await resetIndexer(indexer); return NextResponse.json({ ok: true, action: 'reset', indexer }); }
      if (body.action === 'get') {
        const def = await getIndexer(indexer);
        if (!def) return NextResponse.json({ ok: false, error: `indexer ${indexer} not found` }, { status: 404 });
        return NextResponse.json({ ok: true, action: 'get', indexer, definition: def });
      }
      if (body.action === 'setSchedule') {
        // schedule:null → remove recurrence; schedule:{interval,startTime} → set it.
        const sched = body?.schedule ?? null;
        if (sched && sched.interval) {
          const err = validateScheduleInterval(String(sched.interval));
          if (err) return NextResponse.json({ ok: false, error: err }, { status: 400 });
        }
        const disabled = typeof body?.disabled === 'boolean' ? body.disabled : undefined;
        const def = await updateIndexerSchedule(
          indexer,
          sched && sched.interval ? { interval: String(sched.interval).toUpperCase(), startTime: sched.startTime || undefined } : null,
          disabled,
        );
        return NextResponse.json({ ok: true, action: 'setSchedule', indexer, definition: def });
      }
      const status = await getIndexerStatus(indexer);
      return NextResponse.json({ ok: true, action: 'status', indexer, status });
    } catch (e: any) { return fail(e); }
  }

  // create-or-update
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const dataSourceName = typeof body?.dataSourceName === 'string' ? body.dataSourceName.trim() : '';
  const targetIndexName = typeof body?.targetIndexName === 'string' ? body.targetIndexName.trim() : '';
  if (!name || !dataSourceName || !targetIndexName) {
    return NextResponse.json({ ok: false, error: 'name, dataSourceName and targetIndexName are required' }, { status: 400 });
  }
  // Optional schedule on create — validate the interval up front.
  let schedule: { interval: string; startTime?: string } | undefined;
  if (body?.schedule && body.schedule.interval) {
    const err = validateScheduleInterval(String(body.schedule.interval));
    if (err) return NextResponse.json({ ok: false, error: err }, { status: 400 });
    schedule = { interval: String(body.schedule.interval).toUpperCase(), startTime: body.schedule.startTime || undefined };
  }
  try {
    const indexer = await createIndexer({
      name, dataSourceName, targetIndexName,
      ...(body?.skillsetName ? { skillsetName: String(body.skillsetName).trim() } : {}),
      ...(schedule ? { schedule } : {}),
      ...(typeof body?.disabled === 'boolean' ? { disabled: body.disabled } : {}),
    });
    return NextResponse.json({ ok: true, indexer });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try { await deleteIndexer(name); return NextResponse.json({ ok: true }); }
  catch (e: any) { return fail(e); }
}
