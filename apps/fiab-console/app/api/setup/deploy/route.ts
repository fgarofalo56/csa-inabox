import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/setup/deploy — Setup Orchestrator gate.
 *
 * The Setup Wizard's "Deploy" step requires a real Setup Orchestrator
 * service (FastAPI in setup-orchestrator/) that kicks off `azd deploy`
 * and tracks progress in Cosmos. That service is NOT deployed in the
 * current Loom environment — per .claude/rules/no-vaporware.md this
 * route returns 503 with the exact remediation rather than a fake
 * deploymentId that animates a stub progress UI.
 *
 * Before reaching the orchestrator gate the route VALIDATES the wizard
 * captured the fields a `az deployment sub create` actually needs — most
 * importantly the **subscriptionId**. The old wizard never collected one,
 * so the deploy POSTed an incomplete config and failed opaquely. We now
 * return 400 with a precise list of what's missing instead.
 *
 * Until the Orchestrator service ships:
 *   - The Bicep parameters captured in the wizard are echoed back, and the
 *     remediation `az deployment sub create` command is templated with the
 *     **selected subscription id and region** so the user can copy-paste
 *     and run it directly.
 *   - The UI renders an honest Fluent MessageBar pointing at those commands.
 */

interface SetupConfig {
  boundary?: string;
  mode?: string;
  domainName?: string;
  capacitySku?: string;
  subscriptionId?: string;
  subscriptionName?: string;
  location?: string;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as SetupConfig;

  // ── Validate the deploy is actually deployable ───────────────────────────
  // The previous failure mode: deploy fired with no subscription, no region,
  // no domain — so it could never produce a working `az deployment sub create`.
  const missing: string[] = [];
  if (!body.subscriptionId) missing.push('subscriptionId (pick a target subscription)');
  if (!body.boundary) missing.push('boundary');
  if (!body.mode) missing.push('mode');
  if (!body.domainName) missing.push('domainName');
  if (!body.capacitySku) missing.push('capacitySku');

  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Deployment config incomplete — missing: ${missing.join(', ')}`,
        missing,
      },
      { status: 400 },
    );
  }

  if (!GUID_RE.test(body.subscriptionId!)) {
    return NextResponse.json(
      {
        ok: false,
        error: `subscriptionId is not a valid GUID: ${body.subscriptionId}`,
      },
      { status: 400 },
    );
  }

  const isGov = body.boundary === 'GCC-High' || body.boundary === 'IL5';
  const region = body.location || (isGov ? 'usgovvirginia' : 'eastus2');
  // Map the chosen boundary to its real .bicepparam (verified to exist in
  // platform/fiab/bicep/params/). No invented file names.
  const paramFileByBoundary: Record<string, string> = {
    Commercial: 'platform/fiab/bicep/params/commercial-full.bicepparam',
    GCC: 'platform/fiab/bicep/params/gcc.bicepparam',
    'GCC-High': 'platform/fiab/bicep/params/gcc-high.bicepparam',
    IL5: 'platform/fiab/bicep/params/il5.bicepparam',
  };
  const paramFile = paramFileByBoundary[body.boundary!] || 'platform/fiab/bicep/params/commercial-full.bicepparam';

  return NextResponse.json(
    {
      ok: false,
      error: 'Setup Orchestrator service is not deployed in this environment',
      remediation: {
        message:
          'The Setup Wizard captured a complete, valid deployment config but the browser-driven Setup Orchestrator is not deployed here yet. Copy the command below — it is pre-filled with your selected subscription, region, and boundary — and run it locally:',
        commands: [
          `az login${isGov ? ' --tenant <your-gov-tenant>' : ''}`,
          `az account set --subscription ${body.subscriptionId}`,
          ...(isGov ? ['az cloud set --name AzureUSGovernment'] : []),
          `az deployment sub create \\`,
          `  --subscription ${body.subscriptionId} \\`,
          `  -l ${region} \\`,
          `  -f platform/fiab/bicep/main.bicep \\`,
          `  -p ${paramFile} \\`,
          `  -p boundary=${body.boundary} deploymentMode=${body.mode} \\`,
          `  -p dlzDomainNames="['${body.domainName}']" capacitySku=${body.capacitySku}`,
          `bash scripts/csa-loom/post-deploy-bootstrap.sh`,
        ],
        learnMoreUrl: '/learn?topic=setup-wizard',
        capturedConfig: body,
      },
    },
    { status: 503 },
  );
}
