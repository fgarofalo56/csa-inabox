/**
 * R2 — migrate-route-toolkit codemod unit tests.
 *
 * Verifies the AST transform migrates the enumerated hand-rolled prologues
 * (P1 session-only / P2 owner / P3 tenant-admin / P4 DLZ) onto the route
 * toolkit with byte-identical business logic, and SKIPS (never guesses) every
 * shape outside the allowlist: streaming handlers, non-canonical 401 bodies,
 * route-ctx used beyond `await ctx.params`, already-migrated handlers.
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore — plain .mjs codemod module (no type declarations)
import { transformSource } from '../../../../../scripts/codemods/migrate-route-toolkit.mjs';

const HEADER = `import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
`;

describe('migrate-route-toolkit codemod', () => {
  it('P1: session-only NextResponse.json 401 → withSession, business body byte-identical', () => {
    const business = `  const data = await loadThings(session.claims.oid);
  return NextResponse.json({ ok: true, data });`;
    const src = `${HEADER}
export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
${business}
}
`;
    const { out, migrated, skipped } = transformSource(src);
    expect(migrated).toEqual(['GET']);
    expect(skipped).toEqual([]);
    expect(out).toContain(`export const GET = withSession(async (_req, { session }) => `);
    expect(out).toContain(`import { withSession } from '@/lib/api/route-toolkit';`);
    // guard lines gone, business logic byte-identical
    expect(out).not.toContain('getSession()');
    expect(out).not.toContain("status: 401");
    expect(out).toContain(business);
    expect(out).toContain('});');
    // the now-unused getSession import is pruned
    expect(out).not.toContain("from '@/lib/auth/session'");
  });

  it('P1: apiUnauthorized() variant + aliased import + (await ctx.params).id rewrite', () => {
    const src = `import { NextResponse } from 'next/server';
import { getSession as getAuthSession } from '@/lib/auth/session';
import { apiUnauthorized } from '@/lib/api/respond';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = getAuthSession();
  if (!auth) return apiUnauthorized();
  const id = (await ctx.params).id;
  const oid = auth.claims.oid;
  return NextResponse.json({ ok: true, id, oid });
}
`;
    const { out, migrated } = transformSource(src);
    expect(migrated).toEqual(['DELETE']);
    expect(out).toContain(
      'export const DELETE = withSession<{ id: string }>(async (_req: Request, { session: auth, params }) => ',
    );
    expect(out).toContain('const id = params.id;');
    expect(out).toContain('const oid = auth.claims.oid;');
    expect(out).not.toContain('getAuthSession');
  });

  it('P1: destructured `{ params }` ctx shape needs no body rewrite (await passthrough)', () => {
    const src = `${HEADER}
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  return NextResponse.json({ ok: true, id });
}
`;
    const { out, migrated } = transformSource(src);
    expect(migrated).toEqual(['GET']);
    expect(out).toContain(
      'export const GET = withSession<{ id: string }>(async (_req: Request, { params }) => ',
    );
    // body untouched — awaiting the already-resolved params is a no-op
    expect(out).toContain('const { id } = await params;');
  });

  it('P3: requireTenantAdmin (401-optional — identical envelope) → withTenantAdmin', () => {
    const src = `${HEADER}import { requireTenantAdmin } from '@/lib/auth/feature-gate';

export async function PUT(req: Request) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const body = await req.json();
  return NextResponse.json({ ok: true, body, who: s!.claims.oid });
}
`;
    const { out, migrated } = transformSource(src);
    expect(migrated).toEqual(['PUT']);
    expect(out).toContain('export const PUT = withTenantAdmin(async (req: Request, { session: s }) => ');
    expect(out).not.toContain('requireTenantAdmin(s)');
    expect(out).toContain('const body = await req.json();');
  });

  it('P4: denyIfNoDlzAccess literal pane → withDlzAccess', () => {
    const src = `${HEADER}import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await denyIfNoDlzAccess(session, 'scaling');
  if (denied) return denied;
  return NextResponse.json({ ok: true });
}
`;
    const { out, migrated } = transformSource(src);
    expect(migrated).toEqual(['GET']);
    expect(out).toContain("export const GET = withDlzAccess('scaling', async () => ");
    expect(out).not.toContain('denyIfNoDlzAccess');
  });

  it('P2: loadOwnedItem literal type + 404 guard → withWorkspaceOwner', () => {
    const src = `${HEADER}import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const item = await loadOwnedItem(id, 'agent-flow', s.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, name: item.name });
}
`;
    const { out, migrated } = transformSource(src);
    expect(migrated).toEqual(['GET']);
    expect(out).toContain(
      "export const GET = withWorkspaceOwner<{ id: string }>('agent-flow', async (_req: Request, { item, params }) => ",
    );
    expect(out).toContain('const { id } = params;');
    expect(out).not.toContain('loadOwnedItem(');
    expect(out).toContain('return NextResponse.json({ ok: true, name: item.name });');
  });

  it('SKIPS streaming/SSE handlers', () => {
    const src = `${HEADER}
export async function POST() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const stream = new ReadableStream({ start() {} });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
`;
    const { out, migrated, skipped } = transformSource(src);
    expect(migrated).toEqual([]);
    expect(out).toBe(src);
    expect(skipped[0].reason).toMatch(/streaming/);
  });

  it('SKIPS non-canonical 401 bodies (different envelope would change behavior)', () => {
    const src = `${HEADER}
export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true });
}
`;
    const { out, migrated, skipped } = transformSource(src);
    expect(migrated).toEqual([]);
    expect(out).toBe(src);
    expect(skipped[0].reason).toMatch(/without the exact 401 guard/);
  });

  it('SKIPS when the route ctx escapes beyond `await ctx.params`', () => {
    const src = `${HEADER}
declare function helper(c: unknown): void;
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  helper(ctx);
  return NextResponse.json({ ok: true });
}
`;
    const { migrated, skipped } = transformSource(src);
    expect(migrated).toEqual([]);
    expect(skipped[0].reason).toMatch(/route-ctx used beyond/);
  });

  it('never re-migrates a handler already on the toolkit', () => {
    const src = `import { withSession } from '@/lib/api/route-toolkit';
import { getSession } from '@/lib/auth/session';

export const GET = withSession(async () => new Response('ok'));

export async function POST() {
  const s = getSession();
  if (!s) return new Response('no', { status: 401 });
  return new Response('ok');
}
`;
    // POST's 401 body is non-canonical → skipped; GET is a const (not a target).
    const { migrated } = transformSource(src);
    expect(migrated).toEqual([]);
  });

  it('keeps runtime/dynamic exports and gate() helpers byte-identical', () => {
    const src = `${HEADER}import { backendGateResponse } from '@/lib/api/gate-envelope';

function gate() { return backendGateResponse('svc-adx'); }

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate();
  if (g) return g;
  return NextResponse.json({ ok: true });
}
`;
    const { out, migrated } = transformSource(src);
    expect(migrated).toEqual(['GET']);
    expect(out).toContain("export const runtime = 'nodejs';");
    expect(out).toContain("export const dynamic = 'force-dynamic';");
    expect(out).toContain("function gate() { return backendGateResponse('svc-adx'); }");
    expect(out).toContain('const g = gate();');
  });
});
