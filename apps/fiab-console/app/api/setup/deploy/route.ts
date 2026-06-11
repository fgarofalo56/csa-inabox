import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';

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
  vanityDomain?: string;
  /** Multi-sub: parallel arrays the bicep `[for]` loop consumes. */
  dlzSubscriptionIds?: string[];
  dlzDomainNames?: string[];
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shouldDispatchWorkflow(): boolean {
  return !!process.env.LOOM_GITHUB_ACTIONS_TOKEN;
}

/** The deployed Setup Orchestrator base URL, or '' when it isn't wired. */
function orchestratorUrl(): string {
  return (process.env.LOOM_SETUP_ORCHESTRATOR_URL || '').trim().replace(/\/+$/, '');
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  // Deploying a Data Landing Zone is an admin-tier action: it dispatches a
  // real subscription-scoped deployment. Gate on the `admin.deploy-dlz`
  // feature-permission (Admin role required) — tenant admins bypass; any other
  // principal must have been delegated this capability at /admin/permissions.
  const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
  if (gate) return gate;

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

  // Validate multi-sub spoke ids when present (parallel arrays the bicep loop reads).
  if (Array.isArray(body.dlzSubscriptionIds) && body.dlzSubscriptionIds.length) {
    const bad = body.dlzSubscriptionIds.filter((id) => !GUID_RE.test(id));
    if (bad.length) {
      return NextResponse.json(
        { ok: false, error: `dlzSubscriptionIds contains invalid GUID(s): ${bad.join(', ')}` },
        { status: 400 },
      );
    }
  }

  // ── Tier 1: the deployed Setup Orchestrator runs the real deployment ───────
  // When LOOM_SETUP_ORCHESTRATOR_URL is wired (the orchestrator Container App is
  // deployed by setup-orchestrator.bicep), POST the captured config to it. The
  // orchestrator runs `az deployment sub create` under its own identity (granted
  // Contributor on each target subscription by setup-orchestrator-rbac.bicep) and
  // returns a deploymentId to poll via /api/setup/deploy-status. Authenticated
  // with the shared internal token over the CAE-internal ingress (no public hop).
  const orchUrl = orchestratorUrl();
  if (orchUrl) {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const internalToken = (process.env.LOOM_INTERNAL_TOKEN || '').trim();
      if (internalToken) headers.authorization = `Bearer ${internalToken}`;
      const orchRes = await fetch(`${orchUrl}/deploy`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, region }),
      });
      const oj: any = await orchRes.json().catch(() => ({}));
      if (orchRes.ok && (oj.deploymentId || oj.id)) {
        return NextResponse.json(
          {
            ok: true,
            deploymentMode: 'orchestrator',
            deploymentId: oj.deploymentId || oj.id,
            statusUrl: `/api/setup/deploy-status?id=${encodeURIComponent(oj.deploymentId || oj.id)}`,
            message: 'Deployment accepted by the Setup Orchestrator.',
          },
          { status: 202 },
        );
      }
      if (orchRes.status === 401 || orchRes.status === 403) {
        // The signed-in user / orchestrator identity lacks rights — surface honestly.
        return NextResponse.json(
          {
            ok: false,
            error: 'forbidden',
            requiredRole: 'Contributor',
            remediation:
              (oj.error || oj.message || 'The Setup Orchestrator returned 403.') +
              ' Grant the orchestrator identity Contributor on each target subscription ' +
              '(setup-orchestrator-rbac.bicep), or confirm your account has rights to deploy.',
          },
          { status: 403 },
        );
      }
      console.error(`[setup/deploy] orchestrator returned ${orchRes.status}; falling back.`);
    } catch (e) {
      console.error('[setup/deploy] orchestrator call failed; falling back:', (e as Error).message);
    }
  }

  // Map the chosen boundary to its real .bicepparam (verified to exist in
  // platform/fiab/bicep/params/). No invented file names.
  const paramFileByBoundary: Record<string, string> = {
    Commercial: 'platform/fiab/bicep/params/commercial-full.bicepparam',
    GCC: 'platform/fiab/bicep/params/gcc.bicepparam',
    'GCC-High': 'platform/fiab/bicep/params/gcc-high.bicepparam',
    IL5: 'platform/fiab/bicep/params/il5.bicepparam',
  };
  if (shouldDispatchWorkflow()) {
    const workflowByBoundary: Record<string, string> = {
      Commercial: 'deploy-fiab-commercial.yml',
      GCC: 'deploy-fiab-gcc.yml',
      'GCC-High': 'deploy-fiab-gcch.yml',
      IL5: 'deploy-fiab-gcch.yml',
    };
    const workflowFile = workflowByBoundary[body.boundary!] || 'deploy-fiab-commercial.yml';
    const dispatchInputs: Record<string, string> = {
      run_mode: 'full',
      subscription: body.subscriptionId!,
      region: region,
      dlz_domain_name: body.domainName!,
      capacity_sku: body.capacitySku!,
      keep_resources: 'false',
    };
    if (body.vanityDomain) dispatchInputs.vanity_domain = body.vanityDomain;
    if ((body.boundary === 'GCC-High' || body.boundary === 'IL5') && body.mode === 'multi-sub') {
      dispatchInputs.deployment_mode = 'multi-sub';
    }
    try {
      const repoOwner = process.env.LOOM_GITHUB_REPO_OWNER || 'fgarofalo56';
      const repoName = process.env.LOOM_GITHUB_REPO_NAME || 'csa-inabox';
      const token = process.env.LOOM_GITHUB_ACTIONS_TOKEN!;
      const dispatchUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/${workflowFile}/dispatches`;
      const dispatchRes = await fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'main', inputs: dispatchInputs }),
      });
      if (dispatchRes.ok) {
        return NextResponse.json(
          {
            ok: true,
            deploymentMode: 'github-workflow-dispatch',
            workflowFile,
            inputs: dispatchInputs,
            // The wizard threads this back into /api/setup/workflow-run-status
            // so it streams THIS run's status, not a stale prior one.
            dispatchedAt: new Date().toISOString(),
            message: `Deployment queued on GitHub Actions (${workflowFile})`,
            monitorUrl: `https://github.com/${repoOwner}/${repoName}/actions/workflows/${workflowFile}`,
          },
          { status: 202 },
        );
      }
      console.error(`[setup/deploy] GitHub workflow dispatch failed (${dispatchRes.status})`);
    } catch (e) {
      console.error('[setup/deploy] GitHub workflow dispatch exception:', (e as Error).message);
    }
  }

  const paramFile = paramFileByBoundary[body.boundary!] || 'platform/fiab/bicep/params/commercial-full.bicepparam';

  // Multi-sub emits parallel arrays; single-sub emits the one domain.
  const isMulti = body.mode === 'multi-sub' && Array.isArray(body.dlzSubscriptionIds) && body.dlzSubscriptionIds.length > 0;
  const domainNames = isMulti
    ? (body.dlzDomainNames && body.dlzDomainNames.length ? body.dlzDomainNames : [body.domainName!])
    : [body.domainName!];
  const dlzParamLine = isMulti
    ? `  -p dlzSubscriptionIds="[${body.dlzSubscriptionIds!.map((s) => `'${s}'`).join(',')}]" ` +
      `dlzDomainNames="[${domainNames.map((d) => `'${d}'`).join(',')}]" capacitySku=${body.capacitySku}`
    : `  -p dlzDomainNames="['${body.domainName}']" capacitySku=${body.capacitySku}`;

  return NextResponse.json(
    {
      ok: false,
      error: shouldDispatchWorkflow()
        ? 'GitHub workflow dispatch failed (see remediation for manual fallback)'
        : 'Setup Orchestrator service is not deployed in this environment',
      remediation: {
        message:
          'The Setup Wizard captured a complete, valid deployment config but the browser-driven Setup Orchestrator is not deployed here yet (set LOOM_SETUP_ORCHESTRATOR_URL by deploying setup-orchestrator.bicep). Copy the command below — it is pre-filled with your selected subscription(s), region, and boundary — and run it locally:',
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
          dlzParamLine,
          `bash scripts/csa-loom/post-deploy-bootstrap.sh`,
        ],
        learnMoreUrl: '/learn?topic=setup-wizard',
        capturedConfig: body,
      },
    },
    { status: 503 },
  );
}
