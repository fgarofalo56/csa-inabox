/**
 * POST /api/items/adf-pipeline/[id]/validate — validate a pipeline against
 * ADF's syntactic + reference checker.
 *
 * body: { definition?: { name?, properties } }
 *   - with a body → validate the in-memory payload (validatePipeline by value)
 *   - without     → validate the persisted pipeline
 *
 * Real ARM REST via adf-client.validatePipeline. Surfaces ADF's structured
 * error message verbatim so the editor can show exactly what's wrong.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { validatePipeline, type AdfPipeline } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const name = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  try {
    const spec: AdfPipeline | undefined = body?.definition?.properties
      ? { name: body.definition.name || name, properties: body.definition.properties }
      : undefined;
    const res = await validatePipeline(name, spec);
    if (!res.ok) {
      const msg = res.body?.error?.message || res.errorText || `validation failed (${res.status})`;
      return NextResponse.json({ ok: false, error: msg, status: res.status }, { status: 200 });
    }
    return NextResponse.json({ ok: true, validation: res.body });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
