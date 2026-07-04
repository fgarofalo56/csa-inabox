/**
 * GET /api/admin/permissions/principals?q=<text>&kind=user|group
 *   → search Entra principals (users + groups) for the grant dialog.
 *
 * Auth: caller must hold admin.permissions::Contributor.
 *
 * Real REST: Microsoft Graph
 *   - /v1.0/users?$search="...&startsWith"
 *   - /v1.0/groups?$search="..."
 * via the Console UAMI's app-only token with Graph permissions
 * User.Read.All + Group.Read.All (granted out-of-band by the tenant admin
 * during bootstrap).
 *
 * When Graph permissions aren't granted yet, returns a structured
 * remediation payload so the UI displays the precise admin step.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = uamiArmCredential();

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function graphToken(): Promise<string> {
  const t = await credential.getToken('https://graph.microsoft.com/.default');
  if (!t?.token) throw new Error('Failed to acquire Graph token');
  return t.token;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  const gate = await enforceCapability(s, 'admin.permissions', 'Contributor');
  if (gate) return gate;

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  const kind = req.nextUrl.searchParams.get('kind') === 'group' ? 'group' : 'user';
  if (!q) return NextResponse.json({ ok: true, results: [] });

  let token: string;
  try {
    token = await graphToken();
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: 'graph_token_failed',
        remediation:
          'Console UAMI cannot acquire a Microsoft Graph token. Grant Graph application permissions User.Read.All + Group.Read.All to the UAMI and admin-consent them.',
      },
      { status: 503 },
    );
  }

  const endpoint = kind === 'group'
    ? `${GRAPH_BASE}/groups?$filter=startswith(displayName,'${encodeURIComponent(escapeSqlLiteral(q))}')&$top=20&$select=id,displayName,description,mail`
    : `${GRAPH_BASE}/users?$filter=startswith(displayName,'${encodeURIComponent(escapeSqlLiteral(q))}') or startswith(userPrincipalName,'${encodeURIComponent(escapeSqlLiteral(q))}')&$top=20&$select=id,displayName,userPrincipalName,mail`;

  const res = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) {
    return NextResponse.json(
      {
        ok: false,
        error: `graph_${res.status}`,
        remediation: kind === 'group'
          ? 'UAMI lacks Graph Group.Read.All permission. Run: az ad sp permission add --id <uami-objectid> --api 00000003-0000-0000-c000-000000000046 --api-permissions 5b567255-7703-4780-807c-7be8301ae99b=Role; then admin-consent.'
          : 'UAMI lacks Graph User.Read.All permission. Run: az ad sp permission add --id <uami-objectid> --api 00000003-0000-0000-c000-000000000046 --api-permissions df021288-bdef-4463-88db-98f22de89214=Role; then admin-consent.',
      },
      { status: 503 },
    );
  }
  if (!res.ok) {
    const t = await res.text();
    return NextResponse.json({ ok: false, error: `graph_${res.status}`, body: t.slice(0, 500) }, { status: 502 });
  }
  const json = await res.json();
  const results = (json?.value || []).map((p: any) => ({
    id: p.id,
    type: kind,
    displayName: p.displayName,
    upn: p.userPrincipalName,
    mail: p.mail,
    description: p.description,
  }));
  return NextResponse.json({ ok: true, results });
}
