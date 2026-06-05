/**
 * POST /api/dab/[id]/preview/rest
 *   body { restBasePath, entityPath, pkSegment?, select?, filter?, orderby?,
 *          first?, after?, role? }
 *   → server-side proxy of a real DAB REST read against the configured runtime
 *     (X-MS-API-ROLE honored). Returns { status, body, url }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../../../items/_lib/item-crud';
import { dabRuntimeGate, proxyRest } from '../../../_lib/dab-runtime';

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
  const restBasePath = String(body.restBasePath || '/api');
  const entityPath = String(body.entityPath || '');
  if (!entityPath) return jerr('entityPath is required', 400);
  try {
    const result = await proxyRest(restBasePath, {
      entityPath: entityPath.startsWith('/') ? entityPath : `/${entityPath}`,
      pkSegment: body.pkSegment ? String(body.pkSegment) : undefined,
      select: body.select ? String(body.select) : undefined,
      filter: body.filter ? String(body.filter) : undefined,
      orderby: body.orderby ? String(body.orderby) : undefined,
      first: body.first !== undefined ? Number(body.first) : undefined,
      after: body.after ? String(body.after) : undefined,
      role: body.role ? String(body.role) : undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
