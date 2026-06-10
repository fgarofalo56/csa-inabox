/**
 * Azure AI Search debug sessions (ARM management-plane child resource).
 *
 *   GET    /api/ai-search/debug-sessions               → { ok, sessions:[{name,indexerName,status,…}], portalUrl, storageConfigured }
 *   POST   /api/ai-search/debug-sessions
 *            body { name, indexerName, storageConnStr? } → create (PUT …/debugSessions/{name})
 *   DELETE /api/ai-search/debug-sessions?name=N          → delete
 *
 * A debug session traces one indexer + skillset enrichment run; the session
 * state is written to a blob container (ms-az-cognitive-search-debugsession) on
 * a storage account the search service's MSI can reach. The portal renders the
 * proprietary visual skill graph over that state — Loom manages the lifecycle
 * and deep-links to the portal to view the trace.
 *
 * Honest gates (per no-vaporware.md):
 *   - ARM not configured (LOOM_AI_SEARCH_SUB/RG/SERVICE) → 503 not_configured.
 *   - Storage connection string for the session state is required to CREATE a
 *     session: supply it in the request body, or set LOOM_AI_SEARCH_DEBUG_STORAGE_CONN.
 *   - In a PE-locked deployment a shared private link from the search service to
 *     storage is also required; we surface that caveat in the response/UI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDebugSessions, createDebugSession, deleteDebugSession,
  debugSessionsPortalUrl, readSearchConfig, SearchNotConfiguredError, SearchArmError,
} from '@/lib/azure/aisearch-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notConfigured(e: SearchNotConfiguredError) {
  return NextResponse.json({
    ok: false, code: 'not_configured', error: e.message, missing: e.missing,
    hint: `Set ${e.missing.join(', ')} on the Console Container App. Bicep: platform/fiab/bicep/modules/admin-plane/ai-search.bicep`,
  }, { status: 503 });
}

function fail(e: any) {
  if (e instanceof SearchNotConfiguredError) return notConfigured(e);
  const status = e instanceof SearchArmError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const cfg = readSearchConfig();
    const sessions = await listDebugSessions(cfg);
    return NextResponse.json({
      ok: true,
      sessions,
      portalUrl: debugSessionsPortalUrl(cfg),
      storageConfigured: !!process.env.LOOM_AI_SEARCH_DEBUG_STORAGE_CONN,
    });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const indexerName = typeof body?.indexerName === 'string' ? body.indexerName.trim() : '';
  const storageConnStr =
    (typeof body?.storageConnStr === 'string' && body.storageConnStr.trim()) ||
    process.env.LOOM_AI_SEARCH_DEBUG_STORAGE_CONN ||
    '';
  if (!name || !indexerName) {
    return NextResponse.json({ ok: false, error: 'name and indexerName are required' }, { status: 400 });
  }
  if (!storageConnStr) {
    return NextResponse.json({
      ok: false, code: 'storage_required',
      error: 'A storage account connection string is required to persist debug-session state. Provide it here, or set LOOM_AI_SEARCH_DEBUG_STORAGE_CONN on the Console Container App. The search service MSI also needs Storage Blob Data Contributor on that account (bicep: ai-search.bicep debugSessionStorageId).',
    }, { status: 400 });
  }
  try {
    const cfg = readSearchConfig();
    const created = await createDebugSession({ sessionName: name, indexerName, storageConnectionString: storageConnStr }, cfg);
    return NextResponse.json({
      ok: true,
      session: created,
      portalUrl: debugSessionsPortalUrl(cfg),
      note: 'In a private-endpoint-locked deployment, the debug session also requires a shared private link from the search service to the storage account and "executionEnvironment":"private" on the indexer.',
    });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try {
    await deleteDebugSession(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
}
