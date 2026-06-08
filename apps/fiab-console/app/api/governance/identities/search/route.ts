/**
 * GET /api/governance/identities/search
 *
 * Reusable identity picker backend — search Entra users / groups / service
 * principals and expand a group's transitive (nested) membership. Powers the
 * <IdentityPicker> component used wherever Loom needs to pick a principal
 * (RBAC grants, access policies, ownership, sharing).
 *
 * Auth: caller must hold admin.permissions::Reader.
 *
 * Real REST: Microsoft Graph (no mock principal list) via the Console UAMI's
 * app-only token:
 *   GET /v1.0/users|groups|servicePrincipals?$search=...   (ConsistencyLevel: eventual)
 *   GET /v1.0/groups/{id}/transitiveMembers
 *
 * Query params:
 *   ?q=<text>                search query (min 2 chars; shorter → empty list)
 *   ?kind=user|group|spn|all default 'all'
 *   ?expand=<groupId>        expand a group's transitive members (q ignored)
 *   ?top=<n>                 max results (default 20, max 50)
 *
 * Responses:
 *   { ok: true, results: IdentityHit[] }                                   200
 *   { ok: false, error: 'not_configured', hint }                          503
 *   { ok: false, error: 'graph_403', remediation, hint }                  503
 *   { ok: false, error: 'graph_<N>', body }                              502
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import {
  searchAll,
  searchUsers,
  searchGroups,
  searchServicePrincipals,
  getGroupTransitiveMembers,
  GraphIdentityNotConfiguredError,
  GraphIdentityError,
  type IdentityHit,
} from '@/lib/azure/graph-identity-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notConfiguredResponse(e: GraphIdentityNotConfiguredError) {
  return NextResponse.json(
    { ok: false, error: 'not_configured', message: e.message, hint: e.hint },
    { status: 503 },
  );
}

function graphErrorResponse(e: GraphIdentityError) {
  if (e.status === 401 || e.status === 403) {
    return NextResponse.json(
      {
        ok: false,
        error: `graph_${e.status}`,
        remediation:
          'Console UAMI lacks the Microsoft Graph application permissions to search the directory. ' +
          'Grant User.Read.All (df021288-bdef-4463-88db-98f22de89214), ' +
          'Group.Read.All (5b567255-7703-4780-807c-7be8301ae99b) and ' +
          'Application.Read.All (9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30) — run ' +
          'scripts/csa-loom/grant-identity-graph-approles.sh, then a Tenant Admin grants admin consent.',
        // Re-use the not-configured hint shape so the picker renders the same
        // honest gate (named grants) on a 403 as it does when the env is unset.
        hint: {
          missingEnvVar: 'Graph admin consent',
          bicepModule: 'platform/fiab/bicep/modules/admin-plane/identity-graph-rbac.bicep',
          bicepStatus: 'Grants are applied out-of-band (AppRoles cannot be granted via ARM).',
          rolesRequired: [
            { name: 'User.Read.All', appRoleId: 'df021288-bdef-4463-88db-98f22de89214', scope: 'Microsoft Graph', reason: 'Search users.' },
            { name: 'Group.Read.All', appRoleId: '5b567255-7703-4780-807c-7be8301ae99b', scope: 'Microsoft Graph', reason: 'Search groups + transitive members.' },
            { name: 'Application.Read.All', appRoleId: '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30', scope: 'Microsoft Graph', reason: 'Search service principals.' },
          ],
          followUp: 'Run scripts/csa-loom/grant-identity-graph-approles.sh then grant admin consent in Entra → Enterprise applications → Console UAMI → Permissions.',
        },
        endpoint: e.endpoint,
      },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { ok: false, error: `graph_${e.status}`, body: typeof e.body === 'string' ? e.body.slice(0, 500) : e.message, endpoint: e.endpoint },
    { status: 502 },
  );
}

export async function GET(req: NextRequest) {
  const s = getSession();
  const gate = await enforceCapability(s, 'admin.permissions', 'Reader');
  if (gate) return gate;

  const sp = req.nextUrl.searchParams;
  const expand = (sp.get('expand') || '').trim();
  const q = (sp.get('q') || '').trim();
  const kind = (sp.get('kind') || 'all').toLowerCase();
  const topRaw = parseInt(sp.get('top') || '20', 10);
  const top = Number.isFinite(topRaw) && topRaw > 0 ? Math.min(topRaw, 50) : 20;

  try {
    let results: IdentityHit[];
    if (expand) {
      // Group transitive-member expansion — flatten nested groups.
      results = await getGroupTransitiveMembers(expand, Math.min(Math.max(top, 50), 200));
    } else {
      // Avoid hammering Graph on every keystroke before a usable query.
      if (q.length < 2) return NextResponse.json({ ok: true, results: [] });
      if (kind === 'user') results = await searchUsers(q, top);
      else if (kind === 'group') results = await searchGroups(q, top);
      else if (kind === 'spn') results = await searchServicePrincipals(q, top);
      else results = await searchAll(q, Math.max(4, Math.floor(top / 3)));
    }
    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    if (e instanceof GraphIdentityNotConfiguredError) return notConfiguredResponse(e);
    if (e instanceof GraphIdentityError) return graphErrorResponse(e);
    return NextResponse.json(
      { ok: false, error: 'unexpected', message: e?.message || String(e) },
      { status: 500 },
    );
  }
}
