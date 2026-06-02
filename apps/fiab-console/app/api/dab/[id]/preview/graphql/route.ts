/**
 * POST /api/dab/[id]/preview/graphql
 *   body { graphqlPath?, query, variables?, role? }
 *   → server-side proxy of a real DAB GraphQL request against the runtime.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../../../items/_lib/item-crud';
import { dabRuntimeGate, proxyGraphql } from '../../../_lib/dab-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const gate = dabRuntimeGate();
  if (gate) {
    return NextResponse.json({ ok: false, gate, error: `DAB runtime not provisioned: set ${gate.missing}.` }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const query = String(body.query || '');
  if (!query.trim()) return jerr('query is required', 400);
  try {
    const result = await proxyGraphql(
      String(body.graphqlPath || '/graphql'),
      query,
      body.variables && typeof body.variables === 'object' ? body.variables : undefined,
      body.role ? String(body.role) : undefined,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
