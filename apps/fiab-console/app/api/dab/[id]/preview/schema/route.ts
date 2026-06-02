/**
 * GET /api/dab/[id]/preview/schema?restBasePath=/api
 *   → fetch the permission-aware OpenAPI v3 document the runtime generates
 *     (this exact doc is what the APIM publish step imports).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../../../items/_lib/item-crud';
import { dabRuntimeGate, fetchOpenApi } from '../../../_lib/dab-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const gate = dabRuntimeGate();
  if (gate) {
    return NextResponse.json({ ok: false, gate, error: `DAB runtime not provisioned: set ${gate.missing}.` }, { status: 503 });
  }
  const restBasePath = req.nextUrl.searchParams.get('restBasePath') || '/api';
  try {
    const result = await fetchOpenApi(restBasePath);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
