/**
 * /api/mdm/match/approve — steward approval of match candidate pairs.
 *
 * Approving a fuzzy candidate is an explicit stewardship action that forces the
 * two records into the SAME golden cluster on the next merge (the engine unions
 * approved pairs into the cluster key — see mdm-match-merge.buildGoldenRecordSql).
 * Pairs are persisted per model in Cosmos (mdm-crosswalk:<tenantId>). No Fabric /
 * partner-SaaS dependency.
 *
 * GET    ?modelId=        → { ok, pairs }       list approved pairs for a model
 * POST   { modelId, pairs:[{idA,idB}] }         approve (upsert) pairs → { ok, pairs }
 * DELETE ?modelId=&idA=&idB=                    revoke an approved pair → { ok, pairs }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listCrosswalk, approveCrosswalkPairs, removeCrosswalkPair } from '@/lib/azure/mdm-store';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const modelId = (req.nextUrl.searchParams.get('modelId') || '').trim();
  if (!modelId) return NextResponse.json({ ok: false, error: 'modelId is required' }, { status: 400 });
  try {
    const pairs = await listCrosswalk(s.claims.oid, modelId);
    return NextResponse.json({ ok: true, pairs });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const modelId = String(body?.modelId || '').trim();
  const rawPairs = Array.isArray(body?.pairs) ? body.pairs : [];
  if (!modelId) return NextResponse.json({ ok: false, error: 'modelId is required' }, { status: 400 });
  const pairs = rawPairs
    .map((p: any) => ({ idA: String(p?.idA || '').trim(), idB: String(p?.idB || '').trim() }))
    .filter((p: { idA: string; idB: string }) => p.idA && p.idB);
  if (!pairs.length) return NextResponse.json({ ok: false, error: 'at least one {idA,idB} pair is required' }, { status: 400 });
  try {
    const all = await approveCrosswalkPairs(s.claims.oid, modelId, pairs, s.claims.upn || s.claims.oid);
    return NextResponse.json({ ok: true, pairs: all, approved: pairs.length });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const modelId = (sp.get('modelId') || '').trim();
  const idA = (sp.get('idA') || '').trim();
  const idB = (sp.get('idB') || '').trim();
  if (!modelId || !idA || !idB) return NextResponse.json({ ok: false, error: 'modelId, idA, idB are required' }, { status: 400 });
  try {
    const pairs = await removeCrosswalkPair(s.claims.oid, modelId, idA, idB);
    return NextResponse.json({ ok: true, pairs });
  } catch (e: any) {
    return apiServerError(e);
  }
}
