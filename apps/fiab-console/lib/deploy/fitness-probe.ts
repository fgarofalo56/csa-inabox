/**
 * fitness-probe — the PRODUCTION PRODUCER for `evaluateFitness()`.
 *
 * ## The defect this closes (#3376 / #3342)
 *
 * `fitness.ts` is a complete, well-tested evaluator. Measured 2026-08-13 it had
 * **zero production callers**: `evaluateFitness` appeared only in its own unit
 * test. Nothing read a live resource and attached a verdict to a plan. Two
 * user-visible failures fell out of that one gap:
 *
 * 1. `planBlockers()` pushes `"<svc>: adoption has not been validated yet — run
 *    the validation step."` for every `adopt` decision carrying no `fitness`,
 *    and `setup-wizard.tsx` disables Next on any blocker. Because
 *    `recommendFor()` picks `adopt` whenever a candidate is found, that is the
 *    DEFAULT outcome on a brownfield tenant — and **the validation step it told
 *    the operator to run did not exist.** A dead end, not a gate.
 * 2. `docs/fiab/deployment/brownfield.md` therefore told the customer the
 *    checks were "yours to run by hand" and printed five `az` commands. That is
 *    `deploy-integrity.md` **R5.4** ("validate the chosen existing resource is
 *    actually usable ... and say precisely what is wrong when it is not")
 *    unimplemented, with the shortfall passed to the customer — and
 *    `auto-bind-by-default.md` §5, the platform asking a human to perform what
 *    it could perform itself.
 *
 * This module is that validation step.
 *
 * ## What it establishes, and what it deliberately does not
 *
 * Every value handed to `evaluateFitness` comes from an ARM read this module
 * actually performed. Nothing is inferred from the resource type, and nothing is
 * defaulted to a passing value. Where a read did not happen or did not return a
 * field, the property is left ABSENT — `fitness.ts` renders absence as the
 * `unknown` verdict with an honest `established` string, which is a different
 * fact from `false` and is never reported as `unusable` (deploy-integrity R7).
 *
 * Concretely, one control-plane `GET` per adopted resource resolves:
 *   C1 SKU, C2 region, C3 network posture           — for EVERY service
 *   C4 RBAC                                          — two more scoped reads
 *   adls.hns, adls.premiumPageBlob, adx.streamingIngestion,
 *   synapse.managedVnetPrivateEndpoint, eventhubs.throughputHeadroom,
 *   asa.jobStopped, cosmos.serverlessAutoscale, apim.vnetMode, maps.authMode,
 *   foundry.kind, purview.sameTenant
 * and one sub-resource `GET` on Cognitive Services resolves
 *   foundry.chatDeployment, foundry.embedDeployment.
 *
 * Those cover four of the five `az` commands `brownfield.md` asked the customer
 * to run by hand, plus the AOAI deployment list — all five.
 *
 * NOT resolved here, because they need a data plane this module does not hold a
 * token for at plan time: `purview.rootCollectionAdmin`, `purview.capacityUnits`,
 * `aisearch.indexHeadroom`, `databricks.metastoreAssignment`,
 * `cosmos.containerNameCollision`, `aml.computeQuota`. Those return `unknown`
 * with the exact remediation `fitness.ts` already writes for them. They are
 * NOT silently passed — a check that cannot fail is the defect class this whole
 * subsystem exists to avoid.
 *
 * ## Purity
 *
 * The mapping half (`subjectFromArm`, `networkPostureFromArm`, `apiVersionFor`,
 * `resourceScope`) is pure and unit-tested against captured ARM bodies. The IO
 * half takes an injectable transport, so the suite runs with no network.
 */

import { getServiceDef } from './adoption-catalog';
import {
  evaluateFitness,
  type FitnessContext,
  type FitnessResult,
  type FitnessSubject,
  type NetworkPosture,
} from './fitness';
import {
  armErrorMessage,
  liveTransport,
  type DiscoveryTransport,
  type HttpResult,
} from './discovery-scanner';
import { armBase } from '../azure/cloud-endpoints';
import { canGrantRolesAtScope, type ArmPermission } from '../setup/deploy-preflight';

/** Authorization control plane. Same version the rest of the console pins. */
export const AUTHZ_API_VERSION = '2022-04-01';

/** Per-resource read budget. A hung cross-sub ARM call becomes an honest unknown. */
export const PROBE_TIMEOUT_MS = 12_000;

/**
 * ARM api-version per adoption-catalog `armType`.
 *
 * PINNED, never guessed. A type absent from this map is NOT probed with a
 * plausible-looking version — `apiVersionFor` returns null and the caller
 * records "no pinned api-version" as the observation, so the resulting verdict
 * is `unknown` rather than a read that silently 400s and reads as "absent".
 *
 * Keys are lower-case to match `AdoptableServiceDef.armType`.
 */
export const ARM_API_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'microsoft.purview/accounts': '2021-12-01',
  'microsoft.search/searchservices': '2023-11-01',
  'microsoft.cognitiveservices/accounts': '2023-05-01',
  'microsoft.kusto/clusters': '2023-08-15',
  'microsoft.synapse/workspaces': '2021-06-01',
  'microsoft.databricks/workspaces': '2023-02-01',
  'microsoft.datafactory/factories': '2018-06-01',
  'microsoft.eventhub/namespaces': '2021-11-01',
  'microsoft.streamanalytics/streamingjobs': '2020-03-01',
  'microsoft.documentdb/databaseaccounts': '2023-11-15',
  'microsoft.apimanagement/service': '2022-08-01',
  'microsoft.maps/accounts': '2021-02-01',
  'microsoft.storage/storageaccounts': '2023-05-01',
  'microsoft.dbforpostgresql/flexibleservers': '2022-12-01',
  'microsoft.machinelearningservices/workspaces': '2023-10-01',
  'microsoft.keyvault/vaults': '2023-02-01',
  'microsoft.operationalinsights/workspaces': '2022-10-01',
  'microsoft.sql/servers': '2021-11-01',
  'microsoft.containerregistry/registries': '2023-07-01',
  'microsoft.network/virtualnetworks': '2023-09-01',
  // Foundational / network types the catalog carries as create-only or
  // attach-in-place. They are pinned for the same reason as the rest: the
  // suite's embedded control fails the build when a catalog ARM type has no
  // version, so a service cannot be added to the catalog and silently become
  // un-probeable.
  'microsoft.app/managedenvironments': '2024-03-01',
  'microsoft.network/azurefirewalls': '2023-09-01',
  'microsoft.network/firewallpolicies': '2023-09-01',
  'microsoft.network/privatednszones': '2020-06-01',
});

/** PURE. The pinned api-version for an ARM type, or null when none is pinned. */
export function apiVersionFor(armType: string | undefined | null): string | null {
  if (!armType) return null;
  return ARM_API_VERSIONS[armType.toLowerCase()] ?? null;
}

/** The coordinate of the resource being validated. */
export interface AdoptTarget {
  name: string;
  rg: string;
  sub: string;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RG_RE = /^[\w.()-]{1,90}$/;
const NAME_RE = /^[\w.()-]{1,260}$/;

/** PURE. True when the coordinate is well-formed enough to build a scope from. */
export function targetIsWellFormed(t: AdoptTarget | undefined | null): boolean {
  return !!t && GUID_RE.test(t.sub || '') && RG_RE.test(t.rg || '') && NAME_RE.test(t.name || '');
}

/**
 * PURE. The ARM scope for an adopted resource.
 *
 * Returns the id WITHOUT the ARM host. Callers must never render or log the
 * result in full — `redactArmId` exists for that — but the scope is required
 * verbatim for the authorization reads.
 */
export function resourceScope(armType: string, t: AdoptTarget): string {
  return `/subscriptions/${t.sub}/resourceGroups/${t.rg}/providers/${armType}/${t.name}`;
}

/**
 * PURE. Map an ARM `properties` bag onto the fitness network vocabulary.
 *
 * `attach-preflight.deriveNetworkPosture` answers the same question in the day-2
 * attach vocabulary (`service-endpoint`); fitness spells the same state
 * `public-restricted`. The precedence is kept identical on purpose so a
 * resource's posture at day-0 validation and at day-2 attach can never disagree
 * — only the label differs.
 *
 * `unknown` is a real answer. A resource whose RP exposes neither field is NOT
 * assumed public.
 */
export function networkPostureFromArm(properties: unknown): NetworkPosture {
  if (!properties || typeof properties !== 'object') return 'unknown';
  const p = properties as Record<string, any>;
  const pna = String(p.publicNetworkAccess ?? '').toLowerCase();
  const acl = String(
    p.networkAcls?.defaultAction ?? p.networkRuleSet?.defaultAction ?? '',
  ).toLowerCase();

  if (pna === 'disabled') return 'private-endpoint';
  if (acl === 'deny') return 'public-restricted';
  if (pna === 'enabled') return 'public';
  // Neither field present. An existing private-endpoint connection is evidence.
  const peCount = Array.isArray(p.privateEndpointConnections)
    ? p.privateEndpointConnections.length
    : 0;
  if (peCount > 0) return 'private-endpoint';
  return 'unknown';
}

/**
 * PURE. Extract the family-check properties this service's checks read, from a
 * control-plane ARM body.
 *
 * A key is set ONLY when the body genuinely carried it. `undefined` means "not
 * read", which `fitness.ts` renders as `unknown` — deliberately distinct from a
 * real `false`. Adding a key here with a defaulted value would convert a check
 * that cannot be evaluated into one that silently passes.
 */
export function familyPropertiesFromArm(
  serviceKey: string,
  body: Record<string, any>,
): Record<string, unknown> {
  const p = (body?.properties ?? {}) as Record<string, any>;
  const sku = (body?.sku ?? {}) as Record<string, any>;
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== null) out[k] = v;
  };

  switch (serviceKey) {
    case 'storage-adls':
      // The create-time-only ADLS Gen2 flag. `false` here is a REAL answer and
      // must reach the check as false, not as absent — hence the explicit
      // typeof test rather than the truthiness `set` helper.
      if (typeof p.isHnsEnabled === 'boolean') out.isHnsEnabled = p.isHnsEnabled;
      set('skuName', sku.name);
      break;
    case 'adx':
      if (typeof p.enableStreamingIngest === 'boolean') {
        out.enableStreamingIngest = p.enableStreamingIngest;
      }
      break;
    case 'synapse':
      // Synapse exposes the managed VNet as `properties.managedVirtualNetwork`
      // (the string 'default' when on, absent when off).
      if (p.managedVirtualNetwork !== undefined) {
        out.managedVnet = String(p.managedVirtualNetwork ?? '') !== '';
      }
      break;
    case 'eventhubs':
      // Throughput units live on the SKU capacity for a Standard namespace.
      set('throughputUnits', sku.capacity);
      break;
    case 'streamanalytics':
      set('jobState', p.jobState);
      break;
    case 'cosmos':
      if (Array.isArray(p.capabilities)) {
        out.capabilities = p.capabilities.map((c: any) => c?.name ?? c);
      }
      break;
    case 'apim':
      set('virtualNetworkType', p.virtualNetworkType);
      break;
    case 'maps':
      if (typeof p.disableLocalAuth === 'boolean') out.disableLocalAuth = p.disableLocalAuth;
      break;
    default:
      break;
  }
  return out;
}

/**
 * PURE. Build the `FitnessSubject` from a control-plane ARM body.
 *
 * `location`, `sku` and `kind` are only set when the body carried them. The
 * absence of any of them is what makes `checkSku` / `checkRegion` return
 * `unknown` instead of a confident pass.
 */
export function subjectFromArm(
  serviceKey: string,
  target: AdoptTarget,
  body: Record<string, any>,
): FitnessSubject {
  const sku = (body?.sku ?? {}) as Record<string, any>;
  const subject: FitnessSubject = {
    serviceKey,
    name: target.name,
    resourceGroup: target.rg,
    subscriptionId: target.sub,
    networkPosture: networkPostureFromArm(body?.properties),
    properties: familyPropertiesFromArm(serviceKey, body),
  };
  if (body?.location) subject.location = String(body.location);
  if (sku.name || sku.tier || sku.capacity !== undefined) {
    subject.sku = {
      ...(sku.name ? { name: String(sku.name) } : {}),
      ...(sku.tier ? { tier: String(sku.tier) } : {}),
      ...(sku.capacity !== undefined ? { capacity: Number(sku.capacity) } : {}),
    };
  }
  if (body?.kind) subject.kind = String(body.kind);
  // The tenant a resource lives in, as ARM reports it on the resource's own
  // identity block. Only `purview.sameTenant` consumes it, and only when the
  // read genuinely produced a value.
  const tid = body?.identity?.tenantId ?? body?.properties?.tenantId;
  if (tid) subject.tenantId = String(tid);
  return subject;
}

/**
 * PURE. Fold a Cognitive Services `/deployments` list into the two properties
 * `foundry.chatDeployment` / `foundry.embedDeployment` read.
 *
 * An empty list is a REAL answer (no deployments) and is reported as such; a
 * failed read leaves both absent, which reads as `unknown`.
 */
export function foundryDeploymentProps(deployments: any[]): Record<string, unknown> {
  const names = deployments
    .map((d) => String(d?.properties?.model?.name ?? d?.name ?? '').toLowerCase())
    .filter(Boolean);
  const chat = names.find((n) => n.includes('gpt') || n.includes('chat') || n.includes('o1') || n.includes('phi'));
  const embed = names.find((n) => n.includes('embed'));
  return {
    chatDeployment: chat ?? '',
    embedDeployment: embed ?? '',
  };
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/** What one adopted resource's validation produced. */
export interface AdoptionProbeResult {
  serviceKey: string;
  fitness: FitnessResult;
  /**
   * What the probe actually DID — the reads attempted and their outcomes. This
   * is the audit trail behind the verdict; a verdict may only assert what this
   * records (deploy-integrity R7).
   */
  established: string;
}

export interface ProbeContext {
  hubRegion: string;
  hubTenantId: string;
  /** Console UAMI object id, when this deployment knows it. */
  consolePrincipalId?: string;
}

/** Read a single ARM resource, returning the body or an honest failure string. */
async function armGetJson(
  transport: DiscoveryTransport,
  token: string,
  url: string,
): Promise<{ body: Record<string, any> | null; detail: string }> {
  let r: HttpResult;
  try {
    r = await transport.armGet(token, url, PROBE_TIMEOUT_MS);
  } catch (e: any) {
    return { body: null, detail: `the ARM read did not complete (${e?.message ?? String(e)})` };
  }
  if (r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object') {
    return { body: r.body as Record<string, any>, detail: `ARM GET returned ${r.status}` };
  }
  // NEVER convert a 403/404/timeout into "the field is absent" — that is the
  // class of error where "I could not reach it" became "it does not exist".
  return { body: null, detail: `ARM GET returned ${r.status}: ${armErrorMessage(r)}` };
}

/**
 * Establish the RBAC half of the context: does the Console identity already hold
 * the catalog role at this scope, and — if not — can the CALLER create the
 * assignment itself?
 *
 * Both answers are `'unknown'` unless a read established them. An unreadable
 * authorization surface is reported as unknown, never as a deny: a false deny
 * would send the operator to grant a role they already hold.
 */
export async function probeRbac(
  transport: DiscoveryTransport,
  token: string,
  scope: string,
  roleGuid: string | undefined,
  consolePrincipalId: string | undefined,
): Promise<{ rbac: FitnessContext['rbac']; detail: string }> {
  const details: string[] = [];
  let holdsRole: boolean | 'unknown' = 'unknown';
  let canGrant: boolean | 'unknown' = 'unknown';

  if (roleGuid && consolePrincipalId && GUID_RE.test(consolePrincipalId)) {
    const url =
      `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments` +
      `?api-version=${AUTHZ_API_VERSION}&$filter=${encodeURIComponent(`principalId eq '${consolePrincipalId}'`)}`;
    const { body, detail } = await armGetJson(transport, token, url);
    if (body && Array.isArray(body.value)) {
      holdsRole = body.value.some((a: any) =>
        String(a?.properties?.roleDefinitionId ?? '')
          .toLowerCase()
          .endsWith(roleGuid.toLowerCase()),
      );
      details.push(
        `roleAssignments at the resource scope filtered to the Console principal returned ${body.value.length} assignment(s)`,
      );
    } else {
      details.push(`the roleAssignments read did not return a readable result — ${detail}`);
    }
  } else if (!consolePrincipalId) {
    details.push(
      'the Console identity object id is not known to this Console (LOOM_CONSOLE_PRINCIPAL_ID unset), so no assignment could be looked up',
    );
  }

  // Only worth asking when we did not already establish the role is held.
  if (holdsRole !== true) {
    const url = `${armBase()}${scope}/providers/Microsoft.Authorization/permissions?api-version=${AUTHZ_API_VERSION}`;
    const { body, detail } = await armGetJson(transport, token, url);
    if (body && Array.isArray(body.value)) {
      canGrant = canGrantRolesAtScope(body.value as ArmPermission[]);
      details.push(
        `the caller's effective permissions at the resource scope were read (${body.value.length} entr(y|ies))`,
      );
    } else {
      details.push(`the permissions read did not return a readable result — ${detail}`);
    }
  }

  return { rbac: { holdsRole, canGrant }, detail: details.join('; ') };
}

/**
 * Validate ONE adopted resource against the live estate and attach a verdict.
 *
 * Never throws for an estate condition. Every failure to read becomes an
 * `unknown` verdict carrying what was observed, because a probe that threw
 * would be indistinguishable from one that found nothing wrong.
 */
export async function probeAdoption(
  serviceKey: string,
  target: AdoptTarget,
  ctx: ProbeContext,
  token: string,
  transport: DiscoveryTransport = liveTransport,
): Promise<AdoptionProbeResult> {
  const fitnessCtx: FitnessContext = {
    hubRegion: ctx.hubRegion,
    hubTenantId: ctx.hubTenantId,
    rbac: { holdsRole: 'unknown', canGrant: 'unknown' },
  };

  const def = getServiceDef(serviceKey);
  if (!def) {
    // evaluateFitness itself renders the unknown-service case honestly.
    return {
      serviceKey,
      fitness: evaluateFitness(
        { serviceKey, name: target.name, resourceGroup: target.rg, subscriptionId: target.sub },
        fitnessCtx,
      ),
      established: `'${serviceKey}' is not in the adoption catalog, so no ARM read was attempted`,
    };
  }

  const bare: FitnessSubject = {
    serviceKey,
    name: target.name,
    resourceGroup: target.rg,
    subscriptionId: target.sub,
  };

  if (!targetIsWellFormed(target)) {
    return {
      serviceKey,
      fitness: evaluateFitness(bare, fitnessCtx),
      established:
        'the adopt target was not a well-formed subscription/resource-group/name triple, so no ARM read was attempted',
    };
  }

  const apiVersion = apiVersionFor(def.armType);
  if (!apiVersion) {
    return {
      serviceKey,
      fitness: evaluateFitness(bare, fitnessCtx),
      established: `no pinned ARM api-version for '${def.armType}', so the resource was NOT read (a guessed version would 400 and read as an absent field)`,
    };
  }

  const scope = resourceScope(def.armType, target);
  const notes: string[] = [];

  const { body, detail } = await armGetJson(
    transport,
    token,
    `${armBase()}${scope}?api-version=${apiVersion}`,
  );
  notes.push(`${def.armType}@${apiVersion}: ${detail}`);

  if (!body) {
    // The resource could not be read at all. Everything downstream is unknown,
    // and says so — this is NOT rendered as "the resource is unusable".
    return { serviceKey, fitness: evaluateFitness(bare, fitnessCtx), established: notes.join(' | ') };
  }

  const subject = subjectFromArm(serviceKey, target, body);

  // Cognitive Services: the model deployments are a sub-resource, and they are
  // the answer to the `az cognitiveservices account deployment list` command
  // brownfield.md asked the customer to run.
  if (serviceKey === 'foundry') {
    const dep = await armGetJson(
      transport,
      token,
      `${armBase()}${scope}/deployments?api-version=${apiVersion}`,
    );
    if (dep.body && Array.isArray(dep.body.value)) {
      subject.properties = { ...(subject.properties ?? {}), ...foundryDeploymentProps(dep.body.value) };
      notes.push(`deployments: ${dep.body.value.length} returned`);
    } else {
      notes.push(`deployments: ${dep.detail}`);
    }
  }

  const { rbac, detail: rbacDetail } = await probeRbac(
    transport,
    token,
    scope,
    def.roleGuid,
    ctx.consolePrincipalId,
  );
  fitnessCtx.rbac = rbac;
  notes.push(`rbac: ${rbacDetail}`);

  return {
    serviceKey,
    fitness: evaluateFitness(subject, fitnessCtx),
    established: notes.join(' | '),
  };
}

/**
 * Validate every `adopt` decision in a plan.
 *
 * Runs the per-resource probes concurrently — each is independent, and a
 * brownfield plan can carry a dozen adoptions whose serial latency would push
 * the route past its budget.
 */
export async function probeAdoptions(
  adoptions: { serviceKey: string; target: AdoptTarget }[],
  ctx: ProbeContext,
  token: string,
  transport: DiscoveryTransport = liveTransport,
): Promise<AdoptionProbeResult[]> {
  return Promise.all(
    adoptions.map((a) => probeAdoption(a.serviceKey, a.target, ctx, token, transport)),
  );
}
