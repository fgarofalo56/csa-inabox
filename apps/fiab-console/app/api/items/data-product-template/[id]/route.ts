/**
 * GET /api/items/data-product-template/[id] — return a single curated template by slug.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { CURATED_TEMPLATES } from '@/lib/catalog/data-product-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const t = CURATED_TEMPLATES.find((x) => x.slug === id);
  if (!t) return NextResponse.json({ ok: false, error: 'template not found' }, { status: 404 });
  return NextResponse.json({ ok: true, template: t });
}
