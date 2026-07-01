/**
 * /api/admin/security/purview/domains
 *
 * GET  → list governance / business domains
 * POST → create a new domain { name, description?, type? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { listBusinessDomains, createBusinessDomain } from '@/lib/azure/purview-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const domains = await listBusinessDomains();
    return NextResponse.json({ ok: true, domains });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  if (!body?.name) {
    return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  }
  try {
    const domain = await createBusinessDomain({
      name: body.name,
      description: body.description,
      type: body.type,
    });
    return NextResponse.json({ ok: true, domain }, { status: 201 });
  } catch (e) { return handleSecurityError(e); }
}
