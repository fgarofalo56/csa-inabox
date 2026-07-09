/**
 * Azure AI Search SERVICE-ADMINISTRATION endpoint (AIF-17).
 *
 *   GET  /api/ai-search/service            → { ok, service, adminKeys, queryKeys, stats }
 *   POST /api/ai-search/service
 *          body { action:'regenerateAdminKey', keyKind:'primary'|'secondary' }
 *          body { action:'createQueryKey', name }
 *          body { action:'deleteQueryKey', key }
 *          body { action:'setPublicNetworkAccess', enabled:boolean }
 *          body { action:'setSemanticTier', tier:'disabled'|'free'|'standard' }
 *
 * Keys/networking/semantic are ARM (Search Service Contributor); stats is the
 * data-plane servicestats call. Honest 503 when ARM env (LOOM_AI_SEARCH_SUB /
 * _RG / _SERVICE) is unset. Real ARM + Monitor REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import {
  getServiceProperties, listAdminKeys, listQueryKeys,
  regenerateAdminKey, createQueryKey, deleteQueryKey,
  setPublicNetworkAccess, setSemanticTier, getServiceStatistics,
  scaleService,
  SearchAdminError,
} from '@/lib/azure/aisearch-admin';
import { readSearchConfig, SearchNotConfiguredError } from '@/lib/azure/aisearch-client';

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
  const status = e instanceof SearchAdminError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // Service administration (keys / scale / networking / semantic tier) is
  // tenant-admin / domain-admin only — the same DLZ-pane gate the sibling
  // /api/admin/scaling/* routes use. A getSession-only gate would let any
  // authenticated user read admin keys + rescale the shared service.
  const denied = await denyIfNoDlzAccess(session, 'scaling');
  if (denied) return denied;
  try {
    const cfg = readSearchConfig();
    const [service, adminKeys, queryKeys, stats] = await Promise.all([
      getServiceProperties(cfg),
      listAdminKeys(cfg).catch((e) => ({ error: e?.message || String(e) })),
      listQueryKeys(cfg).catch((e) => ({ error: e?.message || String(e) })),
      getServiceStatistics().catch((e) => ({ error: e?.message || String(e) })),
    ]);
    return NextResponse.json({ ok: true, service, adminKeys, queryKeys, stats });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(session, 'scaling');
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  try {
    const cfg = readSearchConfig();
    switch (action) {
      case 'regenerateAdminKey': {
        const keyKind = body?.keyKind === 'secondary' ? 'secondary' : 'primary';
        const keys = await regenerateAdminKey(keyKind, cfg);
        return NextResponse.json({ ok: true, action, keyKind, adminKeys: keys });
      }
      case 'createQueryKey': {
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
        const key = await createQueryKey(name, cfg);
        return NextResponse.json({ ok: true, action, queryKey: key });
      }
      case 'deleteQueryKey': {
        const key = typeof body?.key === 'string' ? body.key : '';
        if (!key) return NextResponse.json({ ok: false, error: 'key is required' }, { status: 400 });
        await deleteQueryKey(key, cfg);
        return NextResponse.json({ ok: true, action });
      }
      case 'setPublicNetworkAccess': {
        if (typeof body?.enabled !== 'boolean') return NextResponse.json({ ok: false, error: 'enabled (boolean) is required' }, { status: 400 });
        const service = await setPublicNetworkAccess(body.enabled, cfg);
        return NextResponse.json({ ok: true, action, service });
      }
      case 'setSemanticTier': {
        const tier = body?.tier;
        if (!['disabled', 'free', 'standard'].includes(tier)) return NextResponse.json({ ok: false, error: "tier must be 'disabled', 'free' or 'standard'" }, { status: 400 });
        const service = await setSemanticTier(tier, cfg);
        return NextResponse.json({ ok: true, action, service });
      }
      case 'scale': {
        // Replica/partition scaling only — the SKU tier is immutable in place.
        const replicaCount = typeof body?.replicaCount === 'number' ? body.replicaCount : undefined;
        const partitionCount = typeof body?.partitionCount === 'number' ? body.partitionCount : undefined;
        const service = await scaleService({ replicaCount, partitionCount }, cfg);
        return NextResponse.json({ ok: true, action, service });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown action '${action}'` }, { status: 400 });
    }
  } catch (e: any) { return fail(e); }
}
