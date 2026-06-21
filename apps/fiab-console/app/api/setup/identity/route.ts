/**
 * GET /api/setup/identity  +  POST /api/setup/identity
 *
 * The Setup Wizard's "Identity & Admin" step (deploy-readiness, GH #1383).
 *
 * GET — session-gated scan-and-recommend for the auth domain:
 *   • current MSAL wiring (LOOM_MSAL_CLIENT_ID present?, the configured app id);
 *   • best-effort discovery of existing "CSA Loom Console" Entra app
 *     registrations via Microsoft Graph (so the wizard can offer use-existing);
 *   • the recommended bootstrap admin = the signed-in user's oid (from the
 *     session claims — always available, no Graph call needed);
 *   • the current bootstrap admin oid/group from env.
 *
 * POST — records the operator's choice (existing / new / disable for the app
 *   registration; self / group for the bootstrap admin) and returns the exact
 *   apply path. Changing the Entra app registration + the Console env is a
 *   privileged Graph + Container-App operation the Console UAMI is not granted
 *   on the default path, so this returns an HONEST config-only result (per
 *   no-vaporware.md "honest config-only state"): the precise
 *   scripts/csa-loom/bootstrap-msal-app-reg.sh invocation + deploy params that
 *   realize the choice. No fake "applied" success.
 *
 * No secrets are ever returned (mirrors the env-config masking convention).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { graphBase } from '@/lib/auth/msal';
import { uamiArmCredential } from '@/lib/azure/arm-credential';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = uamiArmCredential();

interface DiscoveredApp {
  appId: string;
  displayName: string;
  redirectUris: string[];
}

/** Best-effort Graph discovery of existing Loom Console app registrations.
 * Returns [] (with reachable=false) when the UAMI lacks Application.Read.All —
 * the wizard then still offers provision-new / BYO without a hard error. */
async function discoverApps(): Promise<{ reachable: boolean; apps: DiscoveredApp[] }> {
  try {
    const graph = graphBase();
    const t = await credential.getToken(`${graph}/.default`);
    if (!t?.token) return { reachable: false, apps: [] };
    const url =
      `${graph}/v1.0/applications?$select=appId,displayName,web` +
      `&$filter=${encodeURIComponent("startswith(displayName,'CSA Loom Console')")}`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${t.token}` }, cache: 'no-store' });
    if (!r.ok) return { reachable: false, apps: [] };
    const j: any = await r.json().catch(() => null);
    const apps: DiscoveredApp[] = (j?.value || []).map((a: any) => ({
      appId: a.appId,
      displayName: a.displayName,
      redirectUris: a?.web?.redirectUris || [],
    }));
    return { reachable: true, apps };
  } catch {
    return { reachable: false, apps: [] };
  }
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const configuredClientId = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  const msalConfigured = !!configuredClientId && !!(process.env.LOOM_MSAL_CLIENT_SECRET || '').trim();
  const adminOid = (process.env.LOOM_TENANT_ADMIN_OID || '').trim();
  const adminGroupId = (process.env.LOOM_TENANT_ADMIN_GROUP_ID || '').trim();

  const { reachable, apps } = await discoverApps();

  return NextResponse.json({
    ok: true,
    msal: {
      configured: msalConfigured,
      configuredClientId: configuredClientId || undefined,
      tenantId: (process.env.AZURE_TENANT_ID || process.env.LOOM_MSAL_TENANT_ID || '').trim() || undefined,
      // Recommendation: provision-new when nothing is wired, else keep current.
      recommendation: msalConfigured ? 'existing' : 'new',
    },
    appRegistrations: { reachable, items: apps },
    bootstrapAdmin: {
      currentOid: adminOid || undefined,
      currentGroupId: adminGroupId && !adminGroupId.startsWith('<') ? adminGroupId : undefined,
      // Recommendation: the signed-in user is the safest first admin.
      recommendedOid: session.claims.oid,
      recommendedUpn: session.claims.upn,
      configured: !!adminOid || (!!adminGroupId && !adminGroupId.startsWith('<')),
    },
    session: { value: true },
  });
}

interface IdentityChoice {
  appRegistration?: { mode?: 'existing' | 'new' | 'disable'; existingClientId?: string; consoleHosts?: string };
  bootstrapAdmin?: { mode?: 'self' | 'group'; groupId?: string };
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as IdentityChoice;
  const appMode = body.appRegistration?.mode || 'new';
  const adminMode = body.bootstrapAdmin?.mode || 'self';
  const adminOid = adminMode === 'group' ? '' : session.claims.oid;
  const adminGroupId = adminMode === 'group' ? (body.bootstrapAdmin?.groupId || '').trim() : '';
  const consoleHosts = (body.appRegistration?.consoleHosts || '').trim();

  // Honest config-only result: emit the precise apply path. Changing the Entra
  // app registration + Console env requires Graph app-admin + Container-App
  // write that the Console UAMI is not granted by default, so we DO NOT fake an
  // "applied" success. The operator (or CI) runs the bootstrap script + deploy.
  const deployParams: Record<string, string> = {};
  if (appMode === 'disable') {
    deployParams.loomMsalClientId = "''";
    deployParams.loomMsalAppReg = "{ enabled: false }";
  } else if (appMode === 'existing') {
    deployParams.loomMsalClientId = `'${(body.appRegistration?.existingClientId || '').trim()}'`;
    deployParams.loomMsalAppReg = '{ enabled: true }';
  } else {
    deployParams.loomMsalAppReg = '{ enabled: true }';
  }
  if (adminOid) deployParams.loomTenantAdminOid = `'${adminOid}'`;
  if (adminGroupId) deployParams.loomTenantAdminGroupId = `'${adminGroupId}'`;

  const bootstrapCmd =
    appMode === 'disable'
      ? null
      : [
          'KEYVAULT_NAME=<kv-loom-*>',
          consoleHosts ? `CONSOLE_HOSTS='${consoleHosts}'` : null,
          appMode === 'existing'
            ? `EXISTING_CLIENT_ID='${(body.appRegistration?.existingClientId || '').trim()}'`
            : null,
          'CONSOLE_APP_NAME=loom-console CONSOLE_RG=<admin-rg>',
          'bash scripts/csa-loom/bootstrap-msal-app-reg.sh',
        ]
          .filter(Boolean)
          .join(' ');

  return NextResponse.json({
    ok: true,
    status: 'config-recorded',
    applied: false,
    appRegistration: { mode: appMode },
    bootstrapAdmin: { mode: adminMode, oid: adminOid || undefined, groupId: adminGroupId || undefined },
    apply: {
      deployParams,
      bootstrapScript: bootstrapCmd,
      note:
        'Provisioning the Entra app registration + setting the Console env is a ' +
        'privileged Graph + Container-App action. Run the bootstrapScript above ' +
        '(or re-deploy with the deployParams) to realize this choice; the ' +
        'push-button deploy + post-deploy bootstrap do this automatically.',
    },
  });
}
