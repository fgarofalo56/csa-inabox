/**
 * RLS + OLS role authoring for a semantic model — Analysis-Services XMLA.
 *
 *   GET  /api/items/semantic-model/[id]/roles?workspaceId=…&catalog=…
 *        → { ok:true, roles } | { ok:false, gate } (501 when no engine configured)
 *
 *   PUT  /api/items/semantic-model/[id]/roles?workspaceId=…&catalog=…
 *        body { roles: AasRole[] }  → createOrReplace the model's role set
 *
 *   POST /api/items/semantic-model/[id]/roles?action=test&workspaceId=…&catalog=…
 *        body { roleName, effectiveUserName, daxQuery? }
 *        → { ok:true, rows, rowCount }  ← the test-as-role receipt
 *
 * Backend (Azure-native default, no Fabric workspace required):
 *   - LOOM_AAS_SERVER → Azure Analysis Services XMLA (SPN auth)
 *   - LOOM_POWERBI_XMLA_ENDPOINT → Power BI Premium / Fabric XMLA (opt-in, UAMI)
 *
 * Per no-vaporware.md: real XMLA TMSL is sent; when no engine is configured the
 * route returns a structured config-gate (not fabricated roles), and the editor
 * renders an honest MessageBar with the exact env var to set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getRoles,
  setRoles,
  testAsRole,
  aasConfigGate,
  validateRlsDax,
  AasError,
  type AasRole,
  type AasRoleTablePermission,
} from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[\w\-\s.]{1,128}$/;

function catalogFrom(req: NextRequest, id: string): string {
  return req.nextUrl.searchParams.get('catalog') || id;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = aasConfigGate();
  if (gate) return NextResponse.json({ ok: false, gate }, { status: 501 });

  const id = (await ctx.params).id;
  try {
    const roles = await getRoles(catalogFrom(req, id));
    return NextResponse.json({ ok: true, roles });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}

/** Validate + normalise an incoming role array; returns an error string or null. */
function validateRoles(roles: unknown): { error: string } | { roles: AasRole[] } {
  if (!Array.isArray(roles)) return { error: 'roles must be an array' };
  const out: AasRole[] = [];
  const seen = new Set<string>();
  for (const r of roles as any[]) {
    const name = (r?.name || '').trim();
    if (!NAME_RE.test(name)) return { error: `Invalid role name: "${name}"` };
    if (seen.has(name.toLowerCase())) return { error: `Duplicate role name: "${name}"` };
    seen.add(name.toLowerCase());
    if (r.modelPermission && r.modelPermission !== 'read') {
      return { error: `Role "${name}": Power BI/AAS XMLA supports only modelPermission "read".` };
    }
    const tablePermissions: AasRoleTablePermission[] = [];
    for (const tp of (r.tablePermissions || []) as any[]) {
      const tname = (tp?.name || '').trim();
      if (!tname) continue;
      if (tp.filterExpression && tp.filterExpression.trim()) {
        const v = validateRlsDax(tp.filterExpression);
        if (!v.ok) return { error: `Role "${name}" table "${tname}": ${v.error}` };
      }
      const mp = tp.metadataPermission;
      if (mp && mp !== 'read' && mp !== 'none') {
        return { error: `Role "${name}" table "${tname}": metadataPermission must be read|none` };
      }
      const columnPermissions = ((tp.columnPermissions || []) as any[])
        .filter((c) => (c?.name || '').trim())
        .map((c) => {
          const cmp = c.metadataPermission;
          return { name: String(c.name).trim(), metadataPermission: cmp === 'none' ? 'none' : 'read' as const };
        });
      tablePermissions.push({
        name: tname,
        filterExpression: tp.filterExpression?.trim() || undefined,
        metadataPermission: mp === 'none' ? 'none' : 'read',
        columnPermissions: columnPermissions.length ? columnPermissions : undefined,
      });
    }
    const members = ((r.members || []) as any[])
      .filter((m) => (m?.memberName || '').trim())
      .map((m) => ({ memberName: String(m.memberName).trim() }));
    out.push({ name, modelPermission: 'read', description: r.description?.trim() || undefined, tablePermissions, members });
  }
  return { roles: out };
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = aasConfigGate();
  if (gate) return NextResponse.json({ ok: false, gate }, { status: 501 });

  const id = (await ctx.params).id;
  const body = (await req.json().catch(() => ({}))) as { roles?: unknown };
  const v = validateRoles(body.roles);
  if ('error' in v) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });

  try {
    await setRoles(catalogFrom(req, id), v.roles);
    return NextResponse.json({ ok: true, roleCount: v.roles.length });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}

/** POST ?action=test — run a DAX probe impersonating a role (the receipt). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const action = req.nextUrl.searchParams.get('action');
  if (action !== 'test') {
    return NextResponse.json({ ok: false, error: 'unsupported action (use ?action=test)' }, { status: 400 });
  }
  const gate = aasConfigGate();
  if (gate) return NextResponse.json({ ok: false, gate }, { status: 501 });

  const id = (await ctx.params).id;
  const body = (await req.json().catch(() => ({}))) as {
    roleName?: string;
    effectiveUserName?: string;
    daxQuery?: string;
  };
  const roleName = (body.roleName || '').trim();
  const effectiveUserName = (body.effectiveUserName || '').trim();
  if (!roleName) return NextResponse.json({ ok: false, error: 'roleName is required' }, { status: 400 });
  if (!effectiveUserName) {
    return NextResponse.json(
      { ok: false, error: 'effectiveUserName (a real Entra UPN to impersonate) is required' },
      { status: 400 },
    );
  }
  const daxQuery = (body.daxQuery || '').trim();
  if (!daxQuery) return NextResponse.json({ ok: false, error: 'daxQuery is required' }, { status: 400 });

  try {
    const rows = await testAsRole(catalogFrom(req, id), daxQuery, { effectiveUserName, roles: roleName });
    return NextResponse.json({ ok: true, rows, rowCount: rows.length });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
