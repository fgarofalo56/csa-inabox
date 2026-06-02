/**
 * POST /api/dab/[id]/download
 *   body { config } → returns the canonical dab-config.json as a file download
 *   (Content-Disposition attachment). The exact artifact `dab start` consumes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../../items/_lib/item-crud';
import { emitDabConfigJson, type DabConfig } from '../../_lib/dab-config-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const config = body?.config as DabConfig | undefined;
  if (!config || typeof config !== 'object') return jerr('config is required', 400);

  const json = emitDabConfigJson(config);
  return new NextResponse(json, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="dab-config.json"',
    },
  });
}
