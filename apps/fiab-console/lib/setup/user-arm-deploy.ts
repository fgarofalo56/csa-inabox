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
 * (there is no bicep compiler in the console image). Two sources are supported,
 * INLINE-first:
 *   • INLINE (preferred, durable, cloud-agnostic): the compiled
 *     `platform/fiab/bicep/main.json` is BUNDLED in the image under
 *     `deploy-templates/main.json` (~3.4 MB, under ARM's 4 MB inline limit) and
 *     submitted in the request body as `properties.template`. No storage
 *     account, no `templateLink`, no SAS — which is what Gov ARM requires (it
 *     cannot fetch a SAS'd Gov blob, and user-delegation SAS expires in ~7 days).
 *     See {@link resolveDlzTemplateInline}.
 *   • LINK (fallback): the same compiled template published to a reachable URI
 *     and named via {@link DLZ_TEMPLATE_ENV} (`LOOM_DLZ_TEMPLATE_URI`, optional
 *     SAS in `LOOM_DLZ_TEMPLATE_QUERY_STRING`), submitted as `properties.templateLink`.
 *     See {@link resolveDlzTemplateSource}.
 * {@link resolveDlzTemplate} combines the two — inline first, then the link —
 * and returns null only when NEITHER is available (→ the deploy route falls
 * through to its honest gate). Because the compiled template is bundled, inline
 * is effectively always available.
 *
 * The pure helpers ({@link buildDlzDeploymentParameters},
 * {@link resolveDlzTemplateSource}, {@link resolveDlzTemplateInline},
 * {@link resolveDlzTemplate}) are exported separately from the ARM I/O so they
 * can be unit-tested without a live subscription.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  /** Entra admin group → main.bicep `adminEntraGroupId` (Synapse/ADX admin grants). */
  adminEntraGroupId?: string;
  /** Chargeback cost center → main.bicep `costCenter` (resource tags). */
  costCenter?: string;
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
  // audit-t158: bind the operator's Entra admin group + cost center when supplied
  // so the DLZ's Synapse/ADX admin grants + resource tags use them (only emitted
  // when set, so bicep defaults are preserved otherwise).
  if (inp.adminEntraGroupId && inp.adminEntraGroupId.trim()) {
    p.adminEntraGroupId = { value: inp.adminEntraGroupId.trim() };
  }
  if (inp.costCenter && inp.costCenter.trim()) {
    p.costCenter = { value: inp.costCenter.trim() };
  }
  return p;
}

/** A resolved ARM `templateLink` source (uri + optional SAS query string). */
export interface DlzTemplateSource {
  templateLink: { uri: string; queryString?: string };
}

/** A resolved INLINE ARM template — the compiled main.json parsed to an object. */
export interface DlzTemplateInline {
  template: unknown;
}

/** Either an inline compiled template or a templateLink reference. */
export type DlzTemplateResolved = DlzTemplateInline | DlzTemplateSource;

/** Type guard: a resolved template source is the INLINE variant. */
export function isInlineTemplate(t: DlzTemplateResolved): t is DlzTemplateInline {
  return (t as DlzTemplateInline).template !== undefined;
}

/**
 * PURE (env-read): resolve the published compiled-template LINK source, or null
 * when {@link DLZ_TEMPLATE_ENV} is not configured. This is the FALLBACK behind
 * the bundled inline template (see {@link resolveDlzTemplateInline}) — a Gov ARM
 * cannot fetch a SAS'd Gov blob, so inline is preferred.
 */
export function resolveDlzTemplateSource(): DlzTemplateSource | null {
  const uri = (process.env[DLZ_TEMPLATE_ENV] || '').trim();
  if (!uri) return null;
  const queryString = (process.env.LOOM_DLZ_TEMPLATE_QUERY_STRING || '').trim();
  return { templateLink: queryString ? { uri, queryString } : { uri } };
}

/**
 * Module-level cache for the parsed inline template so the ~3.4 MB main.json is
 * read + JSON.parse'd only once per process. `undefined` = not yet attempted;
 * `null` = attempted and the file is not present in this image.
 */
let inlineTemplateCache: DlzTemplateInline | null | undefined;

/** Reset the inline-template cache (test-only). */
export function __resetInlineTemplateCache(): void {
  inlineTemplateCache = undefined;
}

/**
 * FS-read (cached): resolve the BUNDLED compiled ARM template
 * (`deploy-templates/main.json`, committed + COPY'd into the image next to
 * server.js) as an inline template object for `properties.template`, or null
 * when the file isn't present. Read + parsed ONCE (module-level cache). Tries
 * `<cwd>/deploy-templates/main.json` first (the standalone runtime cwd), then a
 * path relative to this module's directory as a fallback.
 */
export function resolveDlzTemplateInline(): DlzTemplateInline | null {
  if (inlineTemplateCache !== undefined) return inlineTemplateCache;
  const candidates: string[] = [path.join(process.cwd(), 'deploy-templates', 'main.json')];
  // __dirname is defined in CJS (Next standalone output + vitest) but not ESM —
  // guard so the fallback is only added when available.
  if (typeof __dirname !== 'undefined') {
    // lib/setup → ../../deploy-templates (repo/app root next to server.js).
    candidates.push(path.join(__dirname, '..', '..', 'deploy-templates', 'main.json'));
  }
  for (const file of candidates) {
    try {
      const raw = readFileSync(file, 'utf8');
      inlineTemplateCache = { template: JSON.parse(raw) };
      return inlineTemplateCache;
    } catch {
      // Not at this path — try the next candidate.
    }
  }
  inlineTemplateCache = null;
  return inlineTemplateCache;
}

/**
 * Resolve the template SOURCE for the DLZ deploy, PREFERRING the bundled inline
 * template (durable + cloud-agnostic — no storage/SAS) and falling back to the
 * published templateLink (`LOOM_DLZ_TEMPLATE_URI`). Returns null only when
 * NEITHER is available (→ the route's honest gate). Since the compiled template
 * is bundled in the image, inline is effectively always available.
 */
export function resolveDlzTemplate(): DlzTemplateResolved | null {
  const inline = resolveDlzTemplateInline();
  if (inline) return inline;
  return resolveDlzTemplateSource();
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
  /**
   * true when the early-return deadline elapsed before ARM answered the PUT and
   * the request was BACKGROUNDED — the deployment id is already known (it is the
   * pre-computed deployment name), so the route returns 202 immediately while the
   * ARM PUT finishes server-side. Poll `/api/setup/deploy-status?mode=user-arm`
   * for the live state.
   */
  pending?: boolean;
}

/**
 * LIVE: submit a subscription-scoped ARM deployment under the injected token.
 *
 *   PUT {arm}/subscriptions/{sub}/providers/Microsoft.Resources/deployments/{name}
 *   { location, properties: { mode: 'Incremental', templateLink, parameters } }
 *
 * ARM's deployment API is an async long-running operation — it ultimately returns
 * `201 { provisioningState: 'Accepted' }` and runs the deploy in the background.
 * BUT ARM only returns that 201 AFTER it synchronously ingests + preflight-
 * validates the whole template graph. For the full CSA Loom `main.json` fetched
 * via `templateLink` (hub + DLZ + every nested module) that validation phase can
 * run for MINUTES — long past Azure Front Door's origin-response timeout — so an
 * `await`ed PUT would hang the HTTP request until Front Door serves an HTML 504.
 *
 * Because the deployment NAME (== the poll id) is computed BEFORE the PUT, the
 * handler never needs the PUT's response to hand the client a pollable id. So we
 * race the PUT against a short `earlyReturnMs` deadline:
 *   • Fast case (ARM answers within the deadline — a 201, or a fast 4xx auth
 *     error): return synchronously, preserving the precise 401/403 grant gate.
 *   • Slow case (deadline wins): BACKGROUND the PUT and return `{ pending:true,
 *     deploymentId: name, provisioningState:'Submitting' }` immediately, so the
 *     HTTP request NEVER blocks past the deadline (→ no Front Door 504). The PUT
 *     is bounded by a safety `AbortController` (`maxPutMs`) so a stuck socket can
 *     never leak, yet is long enough that ARM's validation completes server-side.
 *
 * `getToken` / `fetchImpl` are injected so the route passes the user's delegated
 * ARM token (and tests pass stubs — no live subscription needed).
 */
export async function submitDlzDeployment(opts: {
  subscriptionId: string;
  region: string;
  parameters: ArmParameters;
  templateSource: DlzTemplateResolved;
  getToken: () => Promise<string>;
  deploymentName?: string;
  fetchImpl?: typeof fetch;
  /** Deadline (ms) after which a still-pending PUT is backgrounded + 202'd. Default 8000. */
  earlyReturnMs?: number;
  /** Safety abort (ms) bounding the (possibly backgrounded) PUT socket. Default 300000. */
  maxPutMs?: number;
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
      // INLINE-first: submit the bundled compiled template in the request body
      // (properties.template) when resolved inline; otherwise reference it via
      // properties.templateLink. Everything else (mode/parameters/race) is identical.
      ...(isInlineTemplate(templateSource)
        ? { template: templateSource.template }
        : { templateLink: templateSource.templateLink }),
      parameters,
    },
  };

  // Bound the PUT socket so a stuck/never-answering ARM call can't leak forever,
  // but keep it long (default 5 min) so ARM's synchronous validation still
  // completes in the background after we early-return.
  const controller = new AbortController();
  const abortTimer: any = setTimeout(() => controller.abort(), opts.maxPutMs ?? 300_000);
  if (typeof abortTimer?.unref === 'function') abortTimer.unref();

  const putPromise: Promise<SubmitDeploymentResult> = (async () => {
    try {
      const res = await doFetch(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
        cache: 'no-store',
        signal: controller.signal,
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
        return { ok: false, status: res.status, error: msg.slice(0, 400), deploymentName: name, deploymentId: name };
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
      return {
        ok: false,
        error: `ARM deployment request failed: ${e?.message ?? String(e)}`,
        deploymentName: name,
        deploymentId: name,
      };
    } finally {
      clearTimeout(abortTimer);
    }
  })();

  // Race the PUT against the early-return deadline.
  let earlyTimer: any;
  const deadline = new Promise<'timeout'>((resolve) => {
    earlyTimer = setTimeout(() => resolve('timeout'), opts.earlyReturnMs ?? 8000);
    if (typeof earlyTimer?.unref === 'function') earlyTimer.unref();
  });
  const winner = await Promise.race([putPromise, deadline]);
  clearTimeout(earlyTimer);
  if (winner !== 'timeout') return winner;

  // Deadline won — ARM is still validating the template. Background the PUT (log
  // its eventual outcome; a rejection is swallowed here so it never becomes an
  // unhandled rejection) and hand the client the already-known deployment id.
  void putPromise.then(
    (r) => {
      if (!r.ok) console.error(`[user-arm-deploy] backgrounded ARM PUT for ${name} failed: ${r.error}`);
    },
    (e) => console.error(`[user-arm-deploy] backgrounded ARM PUT for ${name} threw:`, e),
  );
  return {
    ok: true,
    pending: true,
    deploymentName: name,
    deploymentId: name,
    provisioningState: 'Submitting',
    status: 202,
  };
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
