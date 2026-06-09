/**
 * F12 Git integration — workspace binding CRUD.
 *
 * GET    /api/admin/workspaces/[id]/git    → binding (secret stripped) + cloud caps
 * POST   /api/admin/workspaces/[id]/git    → connect: validate live, store PAT in
 *                                            Key Vault, upsert the Cosmos binding
 * DELETE /api/admin/workspaces/[id]/git    → disconnect: clear KV secret + binding
 *
 * Real backend per no-vaporware.md: POST probes the live ADO / GitHub REST with
 * the supplied PAT before saving (rejects bad creds), and the PAT lands in Key
 * Vault (never Cosmos). Azure DevOps is the default in every cloud; GitHub is
 * honestly gated off in GCC-High / IL5 via githubCloudGate().
 *
 * NOTE on the path: this lives under `/api/admin/.../git/*`. Front Door's default
 * OWASP ruleset 403s the `git` path segment, so front-door.bicep adds a narrow
 * custom Allow rule scoped to `/api/admin/workspaces/**/git`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { detectLoomCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  loadBinding, saveBinding, deleteBinding, toView,
  type GitProvider, type GitAuthMethod,
} from '@/lib/azure/git-binding-store';
import {
  adoListBranches, githubListBranches, githubCloudGate, githubAvailable,
  GitIntegrationError,
} from '@/lib/clients/git-integration-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

function fail(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return fail('unauthenticated', 401);
  if (!(await assertOwner(params.id, s.claims.oid))) return fail('workspace not found', 404);
  const binding = await loadBinding(params.id);
  return NextResponse.json({
    ok: true,
    git: binding ? toView(binding) : null,
    cloud: { boundary: detectLoomCloud(), label: cloudBoundaryLabel(), githubAvailable: githubAvailable() },
  });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return fail('unauthenticated', 401);
  if (!(await assertOwner(params.id, s.claims.oid))) return fail('workspace not found', 404);

  const body = await req.json().catch(() => ({}));
  const provider = String(body?.provider || '') as GitProvider;
  const authMethod = (String(body?.authMethod || 'pat') as GitAuthMethod);
  const branch = String(body?.branch || 'main').trim();
  const folder = String(body?.folder || 'loom-workspace').trim();
  const secret = String(body?.secret || body?.pat || body?.spnSecret || '');

  if (provider !== 'ado' && provider !== 'github') return fail('provider must be "ado" or "github"', 400);
  if (!secret) return fail('A Personal Access Token (or SPN secret) is required to connect.', 400);

  try {
    if (provider === 'github') {
      const gate = githubCloudGate();
      if (gate) return fail(gate.message, gate.status, { code: gate.code });
      const owner = String(body?.githubOwner || '').trim();
      const repo = String(body?.githubRepo || '').trim();
      if (!owner || !repo) return fail('githubOwner and githubRepo are required for GitHub.', 400);
      // Live connectivity probe — rejects a bad PAT before we persist anything.
      await githubListBranches(owner, repo, secret);
      const view = await saveBinding({
        workspaceId: params.id, provider, branch, folder, authMethod: 'pat',
        githubOwner: owner, githubRepo: repo, secret, connectedBy: s.claims.upn || s.claims.email || s.claims.oid,
      });
      return NextResponse.json({ ok: true, git: view });
    }

    // Azure DevOps
    const org = String(body?.adoOrg || '').trim();
    const project = String(body?.adoProject || '').trim();
    const repoId = String(body?.repoId || '').trim();
    const repoName = String(body?.repoName || '').trim();
    if (!org || !project || !repoId) return fail('adoOrg, adoProject and repoId are required for Azure DevOps.', 400);
    // Live connectivity probe.
    await adoListBranches(org, project, repoId, secret);
    const view = await saveBinding({
      workspaceId: params.id, provider, branch, folder, authMethod,
      adoOrg: org, adoProject: project, repoId, repoName,
      spnTenantId: authMethod === 'spn' ? String(body?.spnTenantId || '').trim() : undefined,
      spnClientId: authMethod === 'spn' ? String(body?.spnClientId || '').trim() : undefined,
      secret, connectedBy: s.claims.upn || s.claims.email || s.claims.oid,
    });
    return NextResponse.json({ ok: true, git: view });
  } catch (e: any) {
    if (e instanceof GitIntegrationError) return fail(e.message, e.status, { code: e.code });
    if (e?.status) return fail(e.message, e.status, { code: e.code, missing: e.missing });
    return fail(e?.message || 'Failed to connect', 500);
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return fail('unauthenticated', 401);
  if (!(await assertOwner(params.id, s.claims.oid))) return fail('workspace not found', 404);
  await deleteBinding(params.id);
  return NextResponse.json({ ok: true });
}
