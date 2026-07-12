/**
 * User-delegated (OBO) DLZ deployment — the DAY-ONE deploy/attach path.
 *
 * The Setup Wizard's "Deploy" / "Add landing zone → Attach" previously had only
 * three ways to actually run the subscription-scoped `az deployment sub create`:
 *   1. the Setup Orchestrator Container App (off by default), or
 *   2. a GitHub `workflow_dispatch` (needs LOOM_GITHUB_ACTIONS_TOKEN), or
 *   3. a 503 copy-paste `az` gate.
 * On a clean install NONE of those run, so clicking "Attach landing zone" never
 * submitted a deployment — it fell straight to the copy-paste gate. And every
 * server-side identity in those tiers is a NON-user principal (the orchestrator
 * MI / CI creds / the Console UAMI), which only holds rights on the Loom-owned
 * subscriptions — so an operator could never target a subscription they
 * personally own.
 *
 * This module adds the missing tier: submit the REAL subscription-scoped ARM
 * deployment straight from the BFF under the SIGNED-IN USER's delegated ARM
 * token ({@link getArmTokenPreferUser}). Because it authenticates as the user,
 * the operator can deploy/attach a Data Landing Zone into ANY subscription they
 * hold Contributor on — matching how the deploy pre-flight already checks their
 * rights. The dlz-attach parameters (topology + hub coordinates + feature
 * toggles) are threaded verbatim into `main.bicep`, so the landing-zone bicep
 * wires VNet peering / private DNS / RBAC / ABAC exactly as `az deployment sub
 * create` would (no-vaporware: this is the same template, same params).
 *
 * Template source: ARM REST needs a COMPILED template, not the `.bicep` source
 * (there is no bicep compiler in the console image). The compiled
 * `platform/fiab/bicep/main.json` is published to a reachable URI and named via
 * {@link DLZ_TEMPLATE_ENV} (`LOOM_DLZ_TEMPLATE_URI`, optional SAS in
 * `LOOM_DLZ_TEMPLATE_QUERY_STRING`). When it is unset, {@link resolveDlzTemplateSource}
 * returns null and the deploy route skips this tier and falls through to its
 * honest gate (which names the env var) — this is the documented one-time infra
 * step, not a fake success.
 *
 * The pure helpers ({@link buildDlzDeploymentParameters},
 * {@link resolveDlzTemplateSource}) are exported separately from the ARM I/O so
 * they can be unit-tested without a live subscription.
 */
import { armBase } from '@/lib/azure/cloud-endpoints';

/** Subscription-scoped deployments REST api-version (matches arm-deployments-client). */
const DEPLOYMENTS_API = '2021-04-01';

/** The env var naming the published compiled ARM template for the DLZ deploy. */
export const DLZ_TEMPLATE_ENV = 'LOOM_DLZ_TEMPLATE_URI';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The captured deploy config this tier consumes (subset of the route's SetupConfig). */
export interface DlzDeployInputs {
  topology: 'tenant' | 'dlz-attach';
  boundary: string;
  location: string;
  capacitySku: string;
  domainName: string;
  /** 'single-sub' | 'multi-sub' — threaded to bicep's deploymentMode (tenant only). */
  deploymentMode?: string;
  /** dlz-attach: the NEW subscription the DLZ is provisioned into. */
  targetSubscriptionId?: string;
  /** tenant multi-sub: parallel spoke arrays the bicep `[for]` loop reads. */
  dlzSubscriptionIds?: string[];
  dlzDomainNames?: string[];
  /** dlz-attach: env-merged hub coordinates (keyed by the tenant-topology doc keys). */
  hubCoords?: Record<string, unknown>;
  /** Named main.bicep feature flags (adxEnabled, cosmosGraphVectorEnabled, …). */
  featureToggles?: Record<string, boolean>;
}

/**
 * Map a tenant-topology hub-coordinate key → its `main.bicep` param name for the
 * dlz-attach path. Only the keys main.bicep actually accepts as attach params are
 * mapped; the object-valued private-DNS map lands on `hubPrivateDnsZoneIdsAttach`.
 * (hubConsolePrincipalId gates the deploy-time RBAC grants; hubVnetId/hubLawId
 * drive VNet peering + LAW wiring; the ABAC/role modules key off these.)
 */
const HUB_COORD_PARAM: Record<string, string> = {
  hubVnetId: 'hubVnetId',
  hubLawId: 'hubLawId',
  hubAdxClusterRgName: 'hubAdxClusterRgName',
  hubCatalogEndpoint: 'hubCatalogEndpoint',
  hubConsolePrincipalId: 'hubConsolePrincipalId',
  hubPrivateDnsZoneIds: 'hubPrivateDnsZoneIdsAttach',
};

/** ARM deployment `parameters` map entry shape: `{ paramName: { value } }`. */
export type ArmParameters = Record<string, { value: unknown }>;

/**
 * PURE: build the ARM `parameters` object for `main.bicep` from the captured
 * deploy config. Mirrors the copy-paste `az deployment sub create -p …` the route
 * emits, so the in-product deploy provisions exactly the same topology. Only
 * defined values are emitted so bicep defaults are preserved for anything the
 * wizard didn't set.
 */
export function buildDlzDeploymentParameters(inp: DlzDeployInputs): ArmParameters {
  const p: ArmParameters = {
    topology: { value: inp.topology },
    boundary: { value: inp.boundary },
    location: { value: inp.location },
    capacitySku: { value: inp.capacitySku },
  };
  if (inp.deploymentMode) p.deploymentMode = { value: inp.deploymentMode };

  if (inp.topology === 'dlz-attach') {
    if (inp.targetSubscriptionId) p.targetSubscriptionId = { value: inp.targetSubscriptionId };
    p.attachDomainName = { value: inp.domainName };
    p.dlzDomainNames = { value: [inp.domainName] };
    // Hub coordinates → attach params (routing / DNS / RBAC / ABAC wiring).
    for (const [k, v] of Object.entries(inp.hubCoords ?? {})) {
      const paramName = HUB_COORD_PARAM[k];
      if (!paramName) continue;
      if (v === undefined || v === null || v === '') continue;
      // Skip an empty private-DNS object (bicep default is {}).
      if (paramName === 'hubPrivateDnsZoneIdsAttach' && typeof v === 'object' && Object.keys(v as object).length === 0) {
        continue;
      }
      p[paramName] = { value: v };
    }
  } else {
    // tenant (first-run) — single or multi-sub spoke arrays.
    if (inp.dlzSubscriptionIds?.length) p.dlzSubscriptionIds = { value: inp.dlzSubscriptionIds };
    p.dlzDomainNames = {
      value: inp.dlzDomainNames?.length ? inp.dlzDomainNames : [inp.domainName],
    };
  }

  for (const [k, v] of Object.entries(inp.featureToggles ?? {})) {
    if (typeof v === 'boolean') p[k] = { value: v };
  }
  return p;
}

/** A resolved ARM `templateLink` source (uri + optional SAS query string). */
export interface DlzTemplateSource {
  templateLink: { uri: string; queryString?: string };
}

/**
 * PURE (env-read): resolve the published compiled-template source, or null when
 * {@link DLZ_TEMPLATE_ENV} is not configured (→ the route falls through to its
 * honest copy-paste gate).
 */
export function resolveDlzTemplateSource(): DlzTemplateSource | null {
  const uri = (process.env[DLZ_TEMPLATE_ENV] || '').trim();
  if (!uri) return null;
  const queryString = (process.env.LOOM_DLZ_TEMPLATE_QUERY_STRING || '').trim();
  return { templateLink: queryString ? { uri, queryString } : { uri } };
}

/** Outcome of the live subscription-scoped deployment PUT. */
export interface SubmitDeploymentResult {
  ok: boolean;
  deploymentName?: string;
  deploymentId?: string;
  provisioningState?: string;
  correlationId?: string;
  /** HTTP status of the ARM PUT (for the route's 401/403 honest-gate branch). */
  status?: number;
  error?: string;
}

/**
 * LIVE: submit a subscription-scoped ARM deployment under the injected token.
 *
 *   PUT {arm}/subscriptions/{sub}/providers/Microsoft.Resources/deployments/{name}
 *   { location, properties: { mode: 'Incremental', templateLink, parameters } }
 *
 * ARM accepts the deployment and runs it asynchronously, returning
 * `provisioningState: 'Accepted'`; poll `/api/setup/deploy-status?mode=user-arm`
 * for progress. `getToken` is injected so the route passes the user's delegated
 * ARM token (and tests pass a stub — no live subscription needed).
 */
export async function submitDlzDeployment(opts: {
  subscriptionId: string;
  region: string;
  parameters: ArmParameters;
  templateSource: DlzTemplateSource;
  getToken: () => Promise<string>;
  deploymentName?: string;
  fetchImpl?: typeof fetch;
}): Promise<SubmitDeploymentResult> {
  const { subscriptionId, region, parameters, templateSource } = opts;
  if (!GUID_RE.test(subscriptionId)) {
    return { ok: false, error: `invalid subscriptionId: ${subscriptionId}` };
  }
  const name = opts.deploymentName || `loom-dlz-${Date.now()}`;
  let token: string;
  try {
    token = await opts.getToken();
  } catch (e: any) {
    return { ok: false, error: `token: ${e?.message ?? String(e)}` };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${armBase()}/subscriptions/${subscriptionId}/providers/Microsoft.Resources/deployments/${encodeURIComponent(
    name,
  )}?api-version=${DEPLOYMENTS_API}`;
  const requestBody = {
    location: region,
    properties: {
      mode: 'Incremental',
      templateLink: templateSource.templateLink,
      parameters,
    },
  };
  try {
    const res = await doFetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      cache: 'no-store',
    });
    const text = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* leave as text */
    }
    if (!res.ok) {
      const msg = (json?.error?.message || text || `ARM deployment PUT failed (${res.status})`).toString();
      return { ok: false, status: res.status, error: msg.slice(0, 400) };
    }
    const props = json?.properties || {};
    return {
      ok: true,
      deploymentName: name,
      deploymentId: name,
      provisioningState: props.provisioningState || 'Accepted',
      correlationId: props.correlationId,
      status: res.status,
    };
  } catch (e: any) {
    return { ok: false, error: `ARM deployment request failed: ${e?.message ?? String(e)}` };
  }
}

/**
 * LIVE: read the current state of a subscription-scoped deployment under the
 * injected token (for /api/setup/deploy-status?mode=user-arm). Maps ARM's
 * provisioningState to a coarse progress fraction for the wizard's progress bar.
 */
export async function readDlzDeploymentStatus(opts: {
  subscriptionId: string;
  deploymentName: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<{
  ok: boolean;
  provisioningState?: string;
  progress?: number;
  error?: string;
  status?: number;
}> {
  const { subscriptionId, deploymentName } = opts;
  if (!GUID_RE.test(subscriptionId)) return { ok: false, error: `invalid subscriptionId: ${subscriptionId}` };
  let token: string;
  try {
    token = await opts.getToken();
  } catch (e: any) {
    return { ok: false, error: `token: ${e?.message ?? String(e)}` };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${armBase()}/subscriptions/${subscriptionId}/providers/Microsoft.Resources/deployments/${encodeURIComponent(
    deploymentName,
  )}?api-version=${DEPLOYMENTS_API}`;
  try {
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
    });
    const text = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* leave as text */
    }
    if (!res.ok) {
      const msg = (json?.error?.message || text || `ARM deployment GET failed (${res.status})`).toString();
      return { ok: false, status: res.status, error: msg.slice(0, 400) };
    }
    const state = json?.properties?.provisioningState as string | undefined;
    return { ok: true, provisioningState: state, progress: progressForState(state) };
  } catch (e: any) {
    return { ok: false, error: `ARM deployment status request failed: ${e?.message ?? String(e)}` };
  }
}

/** PURE: coarse progress fraction for a provisioningState (wizard progress bar). */
export function progressForState(state?: string): number {
  switch ((state || '').toLowerCase()) {
    case 'succeeded':
      return 1;
    case 'failed':
    case 'canceled':
      return 1;
    case 'running':
      return 0.6;
    case 'accepted':
      return 0.2;
    default:
      return 0.1;
  }
}
