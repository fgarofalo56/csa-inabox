import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { armScope } from '@/lib/azure/cloud-endpoints';
import {
  getTenantTopologySafe,
  HUB_COORDINATE_KEYS,
  type TenantTopology,
} from '@/lib/setup/tenant-topology';
import {
  checkSubscriptionDeployPermission,
  checkProvidersRegistered,
  buildContributorGrantCommand,
  buildProviderRegisterCommands,
} from '@/lib/setup/deploy-preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/setup/deploy — Setup Wizard "Deploy" step.
 *
 * Validates the captured config (most importantly a real **subscriptionId**
 * and region for `az deployment sub create`) then tries three tiers in order:
 *
 *   1. **Setup Orchestrator** — when LOOM_SETUP_ORCHESTRATOR_URL is wired
 *      (setup-orchestrator.bicep deployed), POST the config to the internal
 *      orchestrator, which submits a real subscription-scoped ARM deployment
 *      under its managed identity and returns a deployment_id to poll via
 *      /api/setup/deploy-status. The signed-in user's oid is forwarded as
 *      `x-loom-caller-oid` for the orchestrator's elevation path.
 *   2. **GitHub workflow dispatch** — when LOOM_GITHUB_ACTIONS_TOKEN is set,
 *      dispatch the boundary's deploy workflow (which runs the real deploy in
 *      CI) and return the run to stream.
 *   3. **Honest copy-paste gate (503)** — neither backend wired: return the
 *      exact `az deployment sub create` command pre-filled with the selected
 *      subscription(s), region, and boundary. The UI renders a Fluent
 *      MessageBar. No fake deploymentId, no simulated progress
 *      (per .claude/rules/no-vaporware.md).
 *
 * The orchestrator Container App is off by default (setupOrchestratorEnabled);
 * until its image + template are published the deploy uses tiers 2/3.
 */

interface SetupConfig {
  boundary?: string;
  mode?: string;
  /**
  /**
   * Explicit deployment topology (audit-t156/t157): 'single-sub' | 'tenant' |
   * 'dlz-attach'. Overrides `mode` in main.bicep. When set, it is threaded into
   * the workflow dispatch + the copy-paste `az deployment sub create` command so
   * the deploy provisions exactly that topology. 'tenant' = first-run install
   * (deploys the hub + DLZ); 'dlz-attach' = add one DLZ to the existing hub — the
   * value the /admin "Add landing zone" wizard and CI send. A second Console can
   * never be deployed from the UI. Empty = bicep derives it from `mode`.
   */
  topology?: string;
  domainName?: string;
  capacitySku?: string;
  subscriptionId?: string;
  subscriptionName?: string;
  /** dlz-attach: the NEW subscription the DLZ is provisioned into. */
  targetSubscriptionId?: string;
  location?: string;
  vanityDomain?: string;
  /** dlz-attach: named feature toggles forwarded to main.bicep (no free-form). */
  adxEnabled?: boolean;
  cosmosGraphVectorEnabled?: boolean;
  weaveOntologyEnabled?: boolean;
  databricksUnityCatalogEnabled?: boolean;
  databricksSqlWarehouseEnabled?: boolean;
  /**
   * Console metadata Cosmos (the serverless `loom` DB the BFF reads/writes).
   * Opt-out flag, default true → provision-new serverless. When the scan-and-
   * choose UI selects "use existing", set false (or leave true) + the
   * existingCosmos* coordinates so the hub provision is skipped and the Console
   * binds to the reused account. Disabling without an existing account is invalid
   * (the Console cannot run without a metadata store) — the wizard only offers
   * disable alongside an existing-account selection.
   */
  loomConsoleCosmosEnabled?: boolean;
  existingCosmosAccount?: string;
  existingCosmosRg?: string;
  existingCosmosSub?: string;
  /**
   * Org-visuals (Embed codes F22 + Organizational visuals F23) opt-out. Default
   * true → the org-visuals container grant + LOOM_ORG_VISUALS_URL env are wired.
   * false → those panes honest-gate (medallion lake unaffected). Threaded into
   * main.bicep's loomOrgVisualsEnabled param.
   */
  loomOrgVisualsEnabled?: boolean;
  /**
   * Storage scan "use-existing" choice: a pre-existing HNS (Data Lake) account
   * the deploy should reuse instead of provisioning a new one. The post-deploy
   * bootstrap / patch-navigator-env.sh wire LOOM_ORG_VISUALS_URL + medallion URLs
   * from it (EXISTING_LOOM_STORAGE_ACCOUNT). Empty = provision new.
   */
  existingLoomStorageAccount?: string;
  /**
   * Real-Time Intelligence (RTI) scan-and-choose. Each backend is ON by default
   * (opt-out) — set the *Enabled flag false to skip it, or set the matching
   * existing* name to REUSE a discovered resource instead of provisioning new.
   * Forwarded to main.bicep as named params (no free-form) so the wizard and the
   * CLI (byo-wizard.sh) write identical wiring.
   */
  loomEventHubEnabled?: boolean;
  existingEventHubNamespace?: string;
  loomStreamAnalyticsEnabled?: boolean;
  existingAsaJob?: string;
  existingAdxClusterName?: string;
  /** Multi-sub: parallel arrays the bicep `[for]` loop consumes. */
  dlzSubscriptionIds?: string[];
  dlzDomainNames?: string[];
  /**
   * Pre-deploy scan-and-choose decisions from the Setup Wizard's "Scan & choose"
   * step (the in-console twin of scripts/csa-loom/scan-and-deploy.sh). Keyed by
   * service key ('aisearch', 'purview', …). For 'use-existing' the chosen
   * instance is threaded as `existing<Svc>*` bicep params; 'new'/'disable' set
   * the `loom<Svc>Enabled` flag. Only services with a known bicep param mapping
   * (SERVICE_PARAM_MAP) emit `-p` lines — others are reused via the post-deploy
   * EXISTING_* env contract (grant-navigator-rbac.sh / patch-navigator-env.sh).
   */
  serviceChoices?: Record<string, { mode: 'new' | 'use-existing' | 'disable'; existing?: { name: string; rg: string; sub: string } }>;
}

/**
 * Maps a scan-and-choose service key → its main.bicep params. `existing` is the
 * [name, rg, sub] param-name triple (null when main.bicep has no existing*
 * surface — those services are reused post-deploy via EXISTING_* env only).
 * `flag` is the `loom<Svc>Enabled`-style toggle (null for DLZ-provisioned
 * services with no provisioning toggle). Mirrors the CLI SERVICES table.
 */
const SERVICE_PARAM_MAP: Record<string, { existing: [string, string, string] | null; flag: string | null }> = {
  aisearch: { existing: ['existingAiSearchService', 'existingAiSearchRg', 'existingAiSearchSub'], flag: 'aiSearchEnabled' },
  apim: { existing: ['existingApimName', 'existingApimRg', 'existingApimSub'], flag: 'apimEnabled' },
  adx: { existing: ['existingAdxClusterName', 'existingAdxClusterRg', 'existingAdxClusterSub'], flag: 'adxEnabled' },
  foundry: { existing: ['existingFoundryAccountName', 'existingFoundryRg', 'existingFoundrySub'], flag: 'aiFoundryEnabled' },
  purview: { existing: ['existingPurviewAccount', 'existingPurviewRg', 'existingPurviewSub'], flag: 'purviewEnabled' },
  maps: { existing: null, flag: 'azureMapsEnabled' },
  synapse: { existing: ['existingSynapseWorkspace', 'existingSynapseRg', 'existingSynapseSub'], flag: null },
  cosmos: { existing: ['existingCosmosAccount', 'existingCosmosRg', 'existingCosmosSub'], flag: null },
  adf: { existing: ['existingAdfFactory', 'existingAdfRg', 'existingAdfSub'], flag: null },
  eventhubs: { existing: ['existingEventHubNamespace', 'existingEventHubRg', 'existingEventHubSub'], flag: null },
  databricks: { existing: ['existingDatabricksWorkspace', 'existingDatabricksRg', 'existingDatabricksSub'], flag: null },
  postgres: { existing: null, flag: 'postgresEnabled' },
  storage: { existing: null, flag: null },
  keyvault: { existing: null, flag: null },
};

/** Build the extra `-p` bicep param assignments for the chosen service wiring. */
function serviceChoiceParamLines(choices: SetupConfig['serviceChoices']): string[] {
  if (!choices) return [];
  const lines: string[] = [];
  for (const [svc, choice] of Object.entries(choices)) {
    const map = SERVICE_PARAM_MAP[svc];
    if (!map) continue;
    if (choice.mode === 'use-existing' && choice.existing && map.existing) {
      const [nameP, rgP, subP] = map.existing;
      lines.push(
        `  -p ${nameP}='${choice.existing.name}' ${rgP}='${choice.existing.rg}' ${subP}='${choice.existing.sub}' \\`,
      );
      if (map.flag) lines.push(`  -p ${map.flag}=true \\`);
    } else if (choice.mode === 'disable' && map.flag) {
      lines.push(`  -p ${map.flag}=false \\`);
    } else if (choice.mode === 'new' && map.flag) {
      // Everything-ON default: explicitly enable so the deploy provisions it.
      lines.push(`  -p ${map.flag}=true \\`);
    }
  }
  return lines;
}

const ALLOWED_TOPOLOGIES = new Set(['single-sub', 'tenant', 'dlz-attach']);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shouldDispatchWorkflow(): boolean {
  return !!process.env.LOOM_GITHUB_ACTIONS_TOKEN;
}

/** The deployed Setup Orchestrator base URL, or '' when it isn't wired. */
function orchestratorUrl(): string {
  return (process.env.LOOM_SETUP_ORCHESTRATOR_URL || '').trim().replace(/\/+$/, '');
}

// ── Pre-flight credential ──────────────────────────────────────────────────
// The deploy pre-flight (permission + RP-registration check on the TARGET sub)
// runs under the Console's own identity — the same chain existing-dlzs uses.
// These are Reader-only reads, so the check never needs more rights than the
// UAMI already has; it only PREDICTS whether the deploy (under the orchestrator
// identity, which is the SAME UAMI when no separate orchestrator is wired, or
// the operator's az credential for the copy-paste path) would be authorized.
const preflightCredential = uamiArmCredential();

async function armTokenForPreflight(): Promise<string> {
  const t = await preflightCredential.getToken(armScope());
  if (!t?.token) throw new Error('Failed to acquire ARM token for deploy pre-flight');
  return t.token;
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

  // ── Topology guard (audit-t157) ──────────────────────────────────────────
  // Defense in depth behind the UI: the ONLY place a 'tenant' (first-run, hub-
  // deploying) install is allowed is when NO hub exists yet. Once a hub is
  // deployed every deploy MUST be 'dlz-attach' — it is impossible to stamp a
  // second Console from the UI or the API. The bicep enforces the same at the
  // template layer (the adminPlane module is gated on topology=='tenant').
  // Cast through the captured string; the runtime guard below rejects anything
  // outside the two-value union, so the narrow type is sound after the check.
  const topology = (body.topology ?? 'tenant') as 'tenant' | 'dlz-attach';
  if (topology !== 'tenant' && topology !== 'dlz-attach') {
    return NextResponse.json(
      { ok: false, error: `Unknown topology '${body.topology}'. Must be 'tenant' or 'dlz-attach'.` },
      { status: 400 },
    );
  }

  const topoState = await getTenantTopologySafe();
  if (topoState.error) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not read tenant topology to validate this deploy: ${topoState.error}`,
        hint: 'Confirm LOOM_COSMOS_ENDPOINT is set and the Console UAMI has Cosmos DB Data Reader.',
      },
      { status: 502 },
    );
  }

  let hubTopology: TenantTopology | null = topoState.topology;
  if (topology === 'tenant' && topoState.exists) {
    // A hub already exists — refuse to deploy a second Console.
    return NextResponse.json(
      {
        ok: false,
        error:
          'A CSA Loom hub (Console) is already deployed in this tenant. A second Console cannot be ' +
          'deployed. To add a Data Landing Zone, use the /admin → "Add landing zone" wizard ' +
          '(topology=dlz-attach), which attaches a DLZ to the existing hub.',
        existingHub: { hubSubscriptionId: hubTopology?.hubSubscriptionId, boundary: hubTopology?.boundary },
      },
      { status: 409 },
    );
  }
  if (topology === 'dlz-attach') {
    if (!topoState.exists || !hubTopology) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'No deployed hub was found to attach a Data Landing Zone to. Run the first-run Setup ' +
            'Wizard to install the Admin Plane (topology=tenant) before attaching landing zones.',
        },
        { status: 409 },
      );
    }
    // dlz-attach targets the NEW subscription; thread it through the validation,
    // orchestrator, dispatch, and copy-paste paths below as the subscriptionId.
    if (!body.targetSubscriptionId) {
      return NextResponse.json(
        { ok: false, error: 'dlz-attach requires targetSubscriptionId (the new DLZ subscription).' },
        { status: 400 },
      );
    }
    if (!GUID_RE.test(body.targetSubscriptionId)) {
      return NextResponse.json(
        { ok: false, error: `targetSubscriptionId is not a valid GUID: ${body.targetSubscriptionId}` },
        { status: 400 },
      );
    }
    body.subscriptionId = body.targetSubscriptionId;
    // Boundary / region are hub-defined (read-only in the wizard) — fall back to
    // the recorded hub values so the operator never re-types them.
    body.boundary = body.boundary || hubTopology.boundary;
    body.location = body.location || hubTopology.location;
    // Attach is single-DLZ in its own sub → multi-sub sizing, empty spoke arrays.
    body.mode = 'multi-sub';
  }

  // ── Validate the deploy is actually deployable ───────────────────────────
  // The previous failure mode: deploy fired with no subscription, no region,
  // no domain — so it could never produce a working `az deployment sub create`.
  const missing: string[] = [];
  if (!body.subscriptionId) missing.push('subscriptionId (pick a target subscription)');
  if (!body.boundary) missing.push('boundary');
  if (topology === 'tenant' && !body.mode) missing.push('mode');
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

  // ── Cross-subscription deploy pre-flight (item-4 fix) ─────────────────────
  // Before firing ANY deploy tier, confirm the deploying identity can actually
  // write to the target subscription. Live diagnosis showed cross-sub DLZ
  // deploys failing opaquely because the Console UAMI holds only Reader on the
  // target sub (enough to list it + see its RGs, NOT to run a sub-scoped
  // deployment). We check the caller's effective ARM permissions (Reader-only
  // read) and, when the write actions are missing, return a precise honest gate
  // with the exact `az role assignment create` — instead of a downstream 403 or
  // a copy-paste command the operator can't tell will fail. We also surface any
  // unregistered RPs so a half-prepared sub gets a clear "register these" hint.
  //
  // The check is skipped when LOOM_SKIP_DEPLOY_PREFLIGHT=1 (escape hatch for an
  // environment where the deploying identity differs from the Console UAMI and
  // the UAMI genuinely can't read permissions) — the downstream tiers remain
  // the hard guard. It's a prediction, not the authorization itself.
  const skipPreflight = process.env.LOOM_SKIP_DEPLOY_PREFLIGHT === '1';
  if (!skipPreflight && body.subscriptionId) {
    const perm = await checkSubscriptionDeployPermission(body.subscriptionId, armTokenForPreflight);
    // Only BLOCK on a definitive "cannot deploy" answer. A check error (token /
    // network / 403-on-read) is non-fatal — fall through to the deploy tiers,
    // which surface their own honest gate.
    if (!perm.error && !perm.canDeploy) {
      const principalObjectId = process.env.LOOM_CONSOLE_PRINCIPAL_ID || hubTopology?.hubConsolePrincipalId;
      const grant = buildContributorGrantCommand({
        subscriptionId: body.subscriptionId,
        principalObjectId,
        principalType: 'ServicePrincipal',
        isGov,
      });
      const providers = await checkProvidersRegistered(body.subscriptionId, armTokenForPreflight);
      const rpLines =
        providers.missing.length > 0
          ? '\n\nAlso register the resource providers this DLZ needs on the target subscription:\n' +
            buildProviderRegisterCommands(providers.missing, body.subscriptionId).join('\n')
          : '';
      return NextResponse.json(
        {
          ok: false,
          error: 'forbidden',
          requiredRole: 'Contributor',
          targetSubscriptionId: body.subscriptionId,
          missingProviders: providers.missing,
          remediation:
            `The deploying identity does not have permission to deploy a Data Landing Zone into ` +
            `subscription ${body.subscriptionId}. A subscription-scoped deployment requires the ` +
            `Contributor role (you have at most Reader there — enough to see it, not to deploy). ` +
            `Grant Contributor on the target subscription, then retry:\n\n${grant}${rpLines}`,
        },
        { status: 403 },
      );
    }
  }

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

  // audit-t156 — topology is an enum (loom-no-freeform-config); reject anything
  // else so the deploy can never submit a freeform topology string to bicep.
  if (body.topology && !ALLOWED_TOPOLOGIES.has(body.topology)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Invalid topology "${body.topology}". Must be one of: ${[...ALLOWED_TOPOLOGIES].join(', ')}.`,
      },
      { status: 400 },
    );
  }

  // Console metadata Cosmos guard — disabling the hub provision is ONLY honest
  // when reusing an existing account (the Console requires a metadata store; with
  // the provision off and no reuse, LOOM_COSMOS_ENDPOINT points at nothing and
  // all item/config CRUD fails). The wizard never offers bare disable, but defend
  // the API too (no-vaporware).
  if (body.loomConsoleCosmosEnabled === false && !body.existingCosmosAccount) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Cannot disable the Console metadata Cosmos without reusing an existing account. ' +
          'The Console requires a metadata store. Choose "provision new (serverless)" or supply existingCosmosAccount.',
      },
      { status: 400 },
    );
  }
  if (body.existingCosmosSub && !GUID_RE.test(body.existingCosmosSub)) {
    return NextResponse.json(
      { ok: false, error: `existingCosmosSub is not a valid GUID: ${body.existingCosmosSub}` },
      { status: 400 },
    );
  }

  // dlz-attach: forward the hub coordinates (from the tenant-topology doc) so
  // the orchestrator threads them into main.bicep's hub* params — the operator
  // never free-types Azure resource ids (loom-no-freeform-config). These are
  // Azure-native ids only; no Fabric handles (no-fabric-dependency).
  const hubCoords: Record<string, unknown> = {};
  if (topology === 'dlz-attach' && hubTopology) {
    for (const k of HUB_COORDINATE_KEYS) {
      const v = hubTopology[k];
      if (v !== undefined && v !== null) hubCoords[k] = v;
    }
  }
  const topologyPayload = { topology, ...(topology === 'dlz-attach' ? { targetSubscriptionId: body.targetSubscriptionId, ...hubCoords } : {}) };

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
      // The orchestrator's JIT/elevation path keys off the signed-in user's
      // object id — forward it as the header it reads (x-loom-caller-oid).
      if (session.claims?.oid) headers['x-loom-caller-oid'] = session.claims.oid;
      // The orchestrator FastAPI serves POST /api/setup/deploy (see
      // apps/fiab-setup-orchestrator/src/loom_setup_orchestrator/main.py).
      const orchRes = await fetch(`${orchUrl}/api/setup/deploy`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, ...topologyPayload, region }),
      });
      const oj: any = await orchRes.json().catch(() => ({}));
      // The orchestrator's DeployResponse is snake_case (deployment_id / stream_url).
      const deploymentId = oj.deployment_id || oj.deploymentId || oj.id;
      if (orchRes.ok && deploymentId) {
        return NextResponse.json(
          {
            ok: true,
            deploymentMode: 'orchestrator',
            deploymentId,
            streamUrl: oj.stream_url || oj.streamUrl,
            statusUrl: `/api/setup/deploy-status?id=${encodeURIComponent(deploymentId)}`,
            message: 'Deployment accepted by the Setup Orchestrator.',
          },
          { status: 202 },
        );
      }
      if (orchRes.status === 401 || orchRes.status === 403) {
        // The signed-in user / orchestrator identity lacks rights — surface honestly.
        // For dlz-attach the most common gate is the orchestrator identity not
        // holding Contributor on the NEW subscription; surface the exact command.
        const attachCmd =
          topology === 'dlz-attach' && body.targetSubscriptionId
            ? '\n\nGrant the orchestrator identity Contributor on the new subscription:\n' +
              (isGov ? 'az cloud set --name AzureUSGovernment\n' : '') +
              'az role assignment create \\\n' +
              '  --assignee-object-id <orchestrator-principal-object-id> \\\n' +
              '  --assignee-principal-type ServicePrincipal \\\n' +
              '  --role Contributor \\\n' +
              `  --scope /subscriptions/${body.targetSubscriptionId}`
            : ' Grant the orchestrator identity Contributor on each target subscription ' +
              '(setup-orchestrator-rbac.bicep), or confirm your account has rights to deploy.';
        return NextResponse.json(
          {
            ok: false,
            error: 'forbidden',
            requiredRole: 'Contributor',
            remediation: (oj.error || oj.message || 'The Setup Orchestrator returned 403.') + attachCmd,
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
      topology,
      subscription: body.subscriptionId!,
      region: region,
      dlz_domain_name: body.domainName!,
      capacity_sku: body.capacitySku!,
      keep_resources: 'false',
    };
    if (topology === 'dlz-attach' && body.targetSubscriptionId) {
      dispatchInputs.target_subscription = body.targetSubscriptionId;
    }
    if (body.vanityDomain) dispatchInputs.vanity_domain = body.vanityDomain;
    if ((body.boundary === 'GCC-High' || body.boundary === 'IL5') && body.mode === 'multi-sub') {
      dispatchInputs.deployment_mode = 'multi-sub';
    }
    // audit-t156 — forward the explicit topology so the workflow deploys exactly
    // that mode (the deploy-fiab-*.yml `topology` input threads it into bicep).
    if (body.topology) dispatchInputs.topology = body.topology;
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

  // Console metadata Cosmos scan-and-choose → named bicep params (no free-form).
  // Default (provision-new serverless) emits nothing — main.bicep's
  // loomConsoleCosmosEnabled defaults true. Reuse/disable emit the existing*
  // coordinates so the hub provision auto-skips and the Console binds to it.
  const consoleCosmosParam = (() => {
    if (body.existingCosmosAccount) {
      const parts = [
        `loomConsoleCosmosEnabled=${body.loomConsoleCosmosEnabled === false ? 'false' : 'true'}`,
        `existingCosmosAccount=${body.existingCosmosAccount}`,
      ];
      if (body.existingCosmosRg) parts.push(`existingCosmosRg=${body.existingCosmosRg}`);
      if (body.existingCosmosSub) parts.push(`existingCosmosSub=${body.existingCosmosSub}`);
      return `  -p ${parts.join(' ')} \\`;
    }
    return '';
  })();
  // RTI (Real-Time Intelligence) named overrides — only emitted when the user
  // deviated from the all-on default (disabled a backend, or chose to reuse an
  // existing one), so the default command stays clean. Maps each choice to the
  // SAME main.bicep param the CLI (byo-wizard.sh) writes (no free-form).
  const rtiParts: string[] = [];
  if (body.adxEnabled === false) rtiParts.push('adxEnabled=false');
  if (body.existingAdxClusterName) rtiParts.push(`existingAdxClusterName='${body.existingAdxClusterName}'`);
  if (body.loomEventHubEnabled === false) rtiParts.push('loomEventHubEnabled=false');
  if (body.existingEventHubNamespace) rtiParts.push(`existingEventHubNamespace='${body.existingEventHubNamespace}'`);
  if (body.loomStreamAnalyticsEnabled === false) rtiParts.push('loomStreamAnalyticsEnabled=false');
  if (body.existingAsaJob) rtiParts.push(`existingAsaJob='${body.existingAsaJob}'`);
  const rtiParamLine = rtiParts.length ? `  -p ${rtiParts.join(' ')} \\` : '';

  // dlz-attach: the manual command threads topology + the hub coordinates the
  // tenant-topology doc recorded (so no Azure id is free-typed). The orchestrator
  // path is strongly preferred — it fills the hub* params automatically.
  const hubParamLines =
    topology === 'dlz-attach' && hubTopology
      ? HUB_COORDINATE_KEYS.filter((k) => k !== 'hubPrivateDnsZoneIds' && (hubTopology as any)[k]).map(
          (k) => `  -p ${k}='${String((hubTopology as any)[k])}' \\`,
        )
      : [];
  // Org-visuals opt-out — only emit the param when explicitly disabled (default
  // true in bicep, so the happy path stays clean). The medallion lake is always
  // provisioned; this only governs the Embed codes / Org visuals grant + env.
  const orgVisualsParamLines =
    body.loomOrgVisualsEnabled === false ? ['  -p loomOrgVisualsEnabled=false \\'] : [];
  const commands =
    topology === 'dlz-attach'
      ? [
          `az login${isGov ? ' --tenant <your-gov-tenant>' : ''}`,
          `az account set --subscription ${body.targetSubscriptionId}`,
          ...(isGov ? ['az cloud set --name AzureUSGovernment'] : []),
          `# The orchestrator identity needs Contributor on the new subscription:`,
          `az role assignment create \\`,
          `  --assignee-object-id <orchestrator-principal-object-id> \\`,
          `  --assignee-principal-type ServicePrincipal \\`,
          `  --role Contributor \\`,
          `  --scope /subscriptions/${body.targetSubscriptionId}`,
          `az deployment sub create \\`,
          `  --subscription ${body.targetSubscriptionId} \\`,
          `  -l ${region} \\`,
          `  -f platform/fiab/bicep/main.bicep \\`,
          `  -p ${paramFile} \\`,
          `  -p topology=dlz-attach targetSubscriptionId=${body.targetSubscriptionId} attachDomainName=${body.domainName} \\`,
          `  -p boundary=${body.boundary} capacitySku=${body.capacitySku} \\`,
          ...orgVisualsParamLines,
          ...(rtiParamLine ? [rtiParamLine] : []),
          ...hubParamLines,
          `  # hubPrivateDnsZoneIds is an object — pass it from the tenant-topology doc`,
        ]
      : [
          `az login${isGov ? ' --tenant <your-gov-tenant>' : ''}`,
          `az account set --subscription ${body.subscriptionId}`,
          ...(isGov ? ['az cloud set --name AzureUSGovernment'] : []),
          `az deployment sub create \\`,
          `  --subscription ${body.subscriptionId} \\`,
          `  -l ${region} \\`,
          `  -f platform/fiab/bicep/main.bicep \\`,
          `  -p ${paramFile} \\`,
          `  -p topology=tenant boundary=${body.boundary} deploymentMode=${body.mode} \\`,
          ...(consoleCosmosParam ? [consoleCosmosParam] : []),
          ...orgVisualsParamLines,
          ...(rtiParamLine ? [rtiParamLine] : []),
          ...serviceChoiceParamLines(body.serviceChoices),
          dlzParamLine,
          `bash scripts/csa-loom/post-deploy-bootstrap.sh`,
        ];

  return NextResponse.json(
    {
      ok: false,
      error: shouldDispatchWorkflow()
        ? 'GitHub workflow dispatch failed (see remediation for manual fallback)'
        : 'Setup Orchestrator service is not deployed in this environment',
      remediation: {
        message:
          'The Setup Wizard captured a complete, valid deployment config but the browser-driven Setup Orchestrator is not deployed here yet (set LOOM_SETUP_ORCHESTRATOR_URL by deploying setup-orchestrator.bicep). Copy the command below — it is pre-filled with your selected subscription(s), region, and boundary — and run it locally:',
        commands,
        learnMoreUrl: '/learn?topic=setup-wizard',
        capturedConfig: body,
      },
    },
    { status: 503 },
  );
}
