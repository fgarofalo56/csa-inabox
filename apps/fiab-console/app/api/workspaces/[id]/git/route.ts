/**
 * Workspace Git integration.
 *
 * GET    /api/workspaces/[id]/git              → current Git binding (or null)
 * POST   /api/workspaces/[id]/git              → upsert binding {provider, repoUrl, branch, directory?, pat?}
 * DELETE /api/workspaces/[id]/git              → disconnect
 *
 * (PUT would be the conventional verb here, but Front Door's default WAF
 * profile rejects PUT on dynamic paths with a 403 — POST upsert is the
 * pragmatic choice.)
 *
 * Backed by Cosmos `workspace-git` (PK /workspaceId). Doc shape:
 *   { id: workspaceId, workspaceId, provider:'github'|'ado', repoUrl,
 *     branch, directory?, status, connectedBy, connectedAt }
 *
 * Per no-vaporware: this records the intent of the binding and surfaces
 * it back in the workspace settings drawer. The actual sync to / from
 * the repo is performed by the user via their existing Git tooling
 * (clone the repo, edit items, push) — Loom doesn't execute Git on the
 * user's behalf until a Functions/CA job lands for that in v3.4. The
 * binding itself is real state: items in the workspace are exported to
 * a deterministic JSON shape that's compatible with Fabric Git.
 *
 * The PAT, if provided, is NOT stored — only a hash. Loom never sends
 * the PAT anywhere; it's the user's responsibility to use their own
 * tooling against repoUrl/branch.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, workspaceGitContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROVIDERS = ['github', 'ado'] as const;
type Provider = (typeof PROVIDERS)[number];

async function assertOwner(workspaceId: string, tenantId: string) {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, tenantId).read<any>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwner(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const c = await workspaceGitContainer();
  try {
    const { resource } = await c.item(params.id, params.id).read<any>();
    return NextResponse.json({ ok: true, git: resource || null });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true, git: null });
    throw e;
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwner(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const provider = (body?.provider || '').toString() as Provider;
  const repoUrl = (body?.repoUrl || '').toString().trim();
  const branch = (body?.branch || 'main').toString().trim();
  const directory = body?.directory ? String(body.directory).trim() : undefined;
  if (!PROVIDERS.includes(provider))
    return NextResponse.json({ ok: false, error: `provider must be one of ${PROVIDERS.join(', ')}` }, { status: 400 });
  if (!repoUrl || !/^https?:\/\//i.test(repoUrl))
    return NextResponse.json({ ok: false, error: 'repoUrl must be a full https URL' }, { status: 400 });

  // PAT — hashed, never persisted in clear.
  const patHash = body?.pat
    ? crypto.createHash('sha256').update(String(body.pat)).digest('hex').slice(0, 16)
    : undefined;

  const c = await workspaceGitContainer();
  const doc = {
    id: params.id,
    workspaceId: params.id,
    provider,
    repoUrl,
    branch,
    directory,
    patHash,
    status: 'connected',
    connectedBy: s.claims.upn,
    connectedAt: new Date().toISOString(),
  };
  const { resource } = await c.items.upsert(doc);
  return NextResponse.json({ ok: true, git: resource }, { status: 200 });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwner(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  const c = await workspaceGitContainer();
  try { await c.item(params.id, params.id).delete(); }
  catch (e: any) { if (e?.code !== 404) throw e; }
  return NextResponse.json({ ok: true });
}
