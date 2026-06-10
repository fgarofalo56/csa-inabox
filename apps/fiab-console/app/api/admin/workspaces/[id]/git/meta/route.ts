/**
 * F12 Git integration — dependent-dropdown metadata (all GET, no WAF concern).
 *
 * GET /api/admin/workspaces/[id]/git/meta?action=...&...&pat=...
 *
 * Actions (chained by the connect wizard's dropdowns):
 *   - projects   (ADO)    &org=               → list org projects
 *   - repos      (ADO)    &org=&project=      → list project repos
 *   - branches   (ADO)    &org=&project=&repoId=    → list branches
 *   - gh-repos   (GitHub) &owner=             → list user/org repos
 *   - gh-branches(GitHub) &owner=&repo=       → list branches
 *
 * The PAT is supplied inline (`pat=`) while the user is filling the connect
 * wizard (no binding exists yet). When a binding already exists and no `pat` is
 * passed, the PAT is resolved from Key Vault via the stored binding's secretRef —
 * so the dropdowns keep working after connect without re-entering the token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { loadBinding, resolveSecret } from '@/lib/azure/git-binding-store';
import {
  adoListProjects, adoListRepos, adoListBranches,
  githubListRepos, githubListBranches, githubCloudGate,
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

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return fail('unauthenticated', 401);
  if (!(await assertOwner(params.id, s.claims.oid))) return fail('workspace not found', 404);

  const q = req.nextUrl.searchParams;
  const action = q.get('action') || '';
  const inlinePat = q.get('pat') || '';
  // GitHub Enterprise host (`<sub>.ghe.com` / GHES). Inline (connect wizard)
  // wins; otherwise it is resolved from the stored binding below. Blank =
  // public github.com.
  let githubHost = (q.get('githubHost') || '').trim();

  // Resolve the PAT: inline (connect wizard) wins, else from the stored binding.
  let pat = inlinePat;
  if (!pat || !githubHost) {
    const binding = await loadBinding(params.id);
    if (binding) {
      if (!pat) { try { pat = await resolveSecret(binding); } catch { /* fall through to 400 */ } }
      if (!githubHost) githubHost = binding.githubHost || '';
    }
  }
  if (!pat) return fail('A Personal Access Token is required to browse the repository.', 400, { code: 'no_pat' });

  try {
    switch (action) {
      case 'projects': {
        const org = q.get('org') || '';
        if (!org) return fail('org is required', 400);
        return NextResponse.json({ ok: true, projects: await adoListProjects(org, pat) });
      }
      case 'repos': {
        const org = q.get('org') || '';
        const project = q.get('project') || '';
        if (!org || !project) return fail('org and project are required', 400);
        return NextResponse.json({ ok: true, repos: await adoListRepos(org, project, pat) });
      }
      case 'branches': {
        const org = q.get('org') || '';
        const project = q.get('project') || '';
        const repoId = q.get('repoId') || '';
        if (!org || !project || !repoId) return fail('org, project and repoId are required', 400);
        return NextResponse.json({ ok: true, branches: await adoListBranches(org, project, repoId, pat) });
      }
      case 'gh-repos': {
        const gate = githubCloudGate();
        if (gate) return fail(gate.message, gate.status, { code: gate.code });
        return NextResponse.json({ ok: true, repos: await githubListRepos(q.get('owner') || '', pat, githubHost) });
      }
      case 'gh-branches': {
        const gate = githubCloudGate();
        if (gate) return fail(gate.message, gate.status, { code: gate.code });
        const owner = q.get('owner') || '';
        const repo = q.get('repo') || '';
        if (!owner || !repo) return fail('owner and repo are required', 400);
        return NextResponse.json({ ok: true, branches: await githubListBranches(owner, repo, pat, githubHost) });
      }
      default:
        return fail(`unknown action "${action}"`, 400);
    }
  } catch (e: any) {
    if (e instanceof GitIntegrationError) return fail(e.message, e.status, { code: e.code });
    return fail(e?.message || 'metadata lookup failed', 500);
  }
}
