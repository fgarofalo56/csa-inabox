/**
 * Cross-subscription DLZ deploy pre-flight (item-4 fix).
 *
 * Live diagnosis (2026-06-16): a cross-subscription DLZ deploy failed opaquely
 * because the deploying identity (Console UAMI principalId
 * 41d32562-…) holds only **Reader + Cost/Monitoring Reader** on the target
 * subscription — enough to SEE it (it shows in the subscription dropdown and
 * Resource Graph returns its RGs) but NOT to run `az deployment sub create`
 * there, which needs **Contributor** (or Owner). The RPs were already
 * registered, so RP-registration was never the blocker — the missing
 * sub-scope write role was.
 *
 * This module turns that into a precise, honest gate BEFORE the deploy fires:
 *
 *   1. {@link checkSubscriptionDeployPermission} — ARM
 *      `GET {arm}/subscriptions/{sub}/providers/Microsoft.Authorization/permissions`
 *      returns the *caller's* effective `actions`/`notActions` at sub scope.
 *      {@link canDeployAtScope} evaluates whether they cover the deployment
 *      write actions (a wildcard, `Microsoft.Resources/*`, or
 *      `Microsoft.Resources/deployments/*`, net of notActions).
 *   2. {@link checkProvidersRegistered} — confirms the RPs a DLZ provisions are
 *      Registered on the target sub (so a half-registered sub gives a precise
 *      "register these RPs" gate, not a mid-deploy ARM 409).
 *
 * Both are Reader-only reads (the UAMI already has Reader), so the pre-flight
 * itself never needs elevated rights — it just predicts the deploy outcome.
 *
 * The pure evaluators ({@link canDeployAtScope}, {@link missingProviders},
 * {@link buildContributorGrantCommand}) are exported separately from the ARM
 * I/O so they can be unit-tested without a live subscription (no-vaporware:
 * the route still hits real ARM; the math is just verifiable in isolation).
 */

import { armBase } from '@/lib/azure/cloud-endpoints';

/** The control-plane actions an `az deployment sub create` needs at sub scope. */
const DEPLOY_WRITE_ACTIONS = [
  'Microsoft.Resources/deployments/write',
  'Microsoft.Resources/deployments/validate/action',
  'Microsoft.Resources/subscriptions/resourceGroups/write',
];

/**
 * The control-plane actions needed to MANAGE an already-deployed DLZ resource
 * group in place (run RG-scoped deployments + write resources inside it). This
 * is the bar for a DLZ being "attached/manageable" — distinct from
 * DEPLOY_WRITE_ACTIONS (which is the sub-scope bar for CREATING a brand-new DLZ
 * RG via `az deployment sub create`).
 *
 * Why this matters (multi-sub security model): the Console UAMI is granted
 * Contributor scoped to the **DLZ resource group**, NOT the whole subscription
 * — the DLZ sub holds many non-Loom workloads, so a sub-wide grant is an
 * over-reach we never do. A DLZ whose RG the UAMI can write is healthy even
 * though the UAMI has only Reader at the subscription scope. Checking only
 * sub-scope permission therefore false-flagged every RG-scoped-Contributor DLZ
 * as "needs re-attach / RBAC repair".
 *
 * Contributor (or Owner) at RG scope grants `*`/`Microsoft.Resources/*`
 * (minus the Authorization notActions), so both of these resolve to allowed;
 * Reader-only does not.
 */
const RG_MANAGE_ACTIONS = [
  'Microsoft.Resources/deployments/write',
  'Microsoft.Resources/deployments/validate/action',
];

/** RPs every Azure-native DLZ provisions (no-fabric-dependency — no Fabric RP). */
export const DLZ_REQUIRED_PROVIDERS = [
  'Microsoft.Storage', // ADLS Gen2 medallion lake
  'Microsoft.Kusto', // ADX (Real-Time / eventhouse) — default-on
  'Microsoft.DocumentDB', // Cosmos graph + vector
  'Microsoft.KeyVault',
  'Microsoft.ManagedIdentity',
  'Microsoft.Network', // private endpoints + DNS
] as const;

/** One ARM permission entry: the actions/notActions a role grants the caller. */
export interface ArmPermission {
  actions?: string[];
  notActions?: string[];
  dataActions?: string[];
  notDataActions?: string[];
}

/** Does a single action pattern (possibly wildcarded) cover the target action? */
function actionMatches(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  // ARM wildcards are '*'-glob within the slash-delimited action string.
  // Convert to a regex: escape regex specials, turn '*' into '.*'.
  const rx = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
    'i',
  );
  return rx.test(action);
}

/** Is `action` granted by `perms` (covered by an action pattern, not excluded by a notAction)? */
function isActionAllowed(perms: ArmPermission[], action: string): boolean {
  let allowed = false;
  for (const p of perms) {
    if ((p.actions || []).some((a) => actionMatches(a, action))) allowed = true;
  }
  if (!allowed) return false;
  // notActions subtract — if any notAction pattern matches, the action is denied.
  for (const p of perms) {
    if ((p.notActions || []).some((a) => actionMatches(a, action))) return false;
  }
  return true;
}

/**
 * PURE: given the caller's ARM permission entries at subscription scope, can
 * they run a subscription-scoped deployment? True only when EVERY deploy write
 * action is allowed (covered + not excluded). Reader (read-only actions) → false;
 * Contributor / Owner (full actions minus auth notActions) → true.
 */
export function canDeployAtScope(perms: ArmPermission[]): boolean {
  if (!perms || perms.length === 0) return false;
  return DEPLOY_WRITE_ACTIONS.every((a) => isActionAllowed(perms, a));
}

/**
 * PURE: given the caller's ARM permission entries at RESOURCE-GROUP scope, can
 * they manage that RG in place (RG-scoped deployments + resource writes)? This
 * is the bar for a DLZ being "attached/manageable" with RG-scoped Contributor
 * — see RG_MANAGE_ACTIONS. Reader → false; Contributor/Owner at RG scope → true.
 */
export function canManageResourceGroup(perms: ArmPermission[]): boolean {
  if (!perms || perms.length === 0) return false;
  return RG_MANAGE_ACTIONS.every((a) => isActionAllowed(perms, a));
}

/** PURE: which of the required RPs are NOT in the Registered set. */
export function missingProviders(
  registered: Record<string, string | undefined>,
  required: readonly string[] = DLZ_REQUIRED_PROVIDERS,
): string[] {
  return required.filter((ns) => (registered[ns] || '').toLowerCase() !== 'registered');
}

/** PURE: the exact "az role assignment create" an operator runs to fix the gate. */
export function buildContributorGrantCommand(opts: {
  subscriptionId: string;
  principalObjectId?: string;
  principalType?: 'ServicePrincipal' | 'User' | 'Group';
  isGov?: boolean;
}): string {
  const assignee = opts.principalObjectId || '<deploying-identity-object-id>';
  const ptype = opts.principalType || 'ServicePrincipal';
  const cont = ' \\'; // line-continuation suffix kept off the template grammar
  const lines = [
    'az role assignment create' + cont,
    '  --assignee-object-id ' + assignee + cont,
    '  --assignee-principal-type ' + ptype + cont,
    '  --role Contributor' + cont,
    '  --scope /subscriptions/' + opts.subscriptionId,
  ];
  return (opts.isGov ? 'az cloud set --name AzureUSGovernment\n' : '') + lines.join('\n');
}

/** PURE: the `az provider register` lines for any missing RPs. */
export function buildProviderRegisterCommands(missing: string[], subscriptionId: string): string[] {
  return missing.map(
    (ns) => `az provider register --namespace ${ns} --subscription ${subscriptionId}`,
  );
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Outcome of the live ARM permission check. */
export interface DeployPermissionResult {
  /** true → the caller can run a sub-scoped deployment in the target sub. */
  canDeploy: boolean;
  /** Raw permission entries (for diagnostics); empty when the check failed. */
  permissions: ArmPermission[];
  /** Set when the ARM check itself errored (token/network/403) — NOT a deny. */
  error?: string;
}

/**
 * LIVE: ask ARM for the caller's effective permissions on the target sub and
 * decide whether a deployment would be authorized. `getToken` is injected so
 * the route passes its own credential (and tests pass a stub).
 *
 * A 403 on the permissions read itself is unusual (Reader can read it) but is
 * surfaced as `error` (not a silent deny) so the route can still fall through
 * to its honest copy-paste gate rather than wrongly blocking.
 */
export async function checkSubscriptionDeployPermission(
  subscriptionId: string,
  getToken: () => Promise<string>,
): Promise<DeployPermissionResult> {
  if (!GUID_RE.test(subscriptionId)) {
    return { canDeploy: false, permissions: [], error: `invalid subscriptionId: ${subscriptionId}` };
  }
  let token: string;
  try {
    token = await getToken();
  } catch (e: any) {
    return { canDeploy: false, permissions: [], error: `token: ${e?.message ?? String(e)}` };
  }
  try {
    // Permissions - List is a GET (per the Authorization REST API); POST returns
    // 405/404 and would be mis-read as a deny.
    const res = await fetch(
      `${armBase()}/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { canDeploy: false, permissions: [], error: `ARM permissions ${res.status}: ${t.slice(0, 200)}` };
    }
    const j: any = await res.json();
    const perms = (j?.value || []) as ArmPermission[];
    return { canDeploy: canDeployAtScope(perms), permissions: perms };
  } catch (e: any) {
    return { canDeploy: false, permissions: [], error: `ARM permissions request failed: ${e?.message ?? String(e)}` };
  }
}

/**
 * LIVE: ask ARM for the caller's effective permissions on a specific resource
 * group and decide whether they can MANAGE it in place (RG-scoped Contributor /
 * Owner). Used by the DLZ overview to treat an RG-scoped-Contributor DLZ as
 * attached even when the UAMI has only Reader at the subscription scope (the
 * intended least-privilege multi-sub model). Same permissions API as the
 * sub-scope check, just at RG scope.
 *
 * Returns `canManage:false` with `error` set when the check itself fails
 * (token/network/403) so the caller can decide conservatively without leaking
 * a deny it cannot prove.
 */
export async function checkResourceGroupManagePermission(
  subscriptionId: string,
  resourceGroup: string,
  getToken: () => Promise<string>,
): Promise<{ canManage: boolean; permissions: ArmPermission[]; error?: string }> {
  if (!GUID_RE.test(subscriptionId)) {
    return { canManage: false, permissions: [], error: `invalid subscriptionId: ${subscriptionId}` };
  }
  if (!resourceGroup || !/^[\w.()-]{1,90}$/.test(resourceGroup)) {
    return { canManage: false, permissions: [], error: `invalid resourceGroup: ${resourceGroup}` };
  }
  let token: string;
  try {
    token = await getToken();
  } catch (e: any) {
    return { canManage: false, permissions: [], error: `token: ${e?.message ?? String(e)}` };
  }
  try {
    // Permissions - List For Resource Group is a GET (per the Authorization REST
    // API). POST returns 405/404, which the caller would mis-read as "Reader-only"
    // and false-flag a verified RG-scoped-Contributor DLZ as needing RBAC repair.
    const res = await fetch(
      `${armBase()}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(
        resourceGroup,
      )}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { canManage: false, permissions: [], error: `ARM permissions ${res.status}: ${t.slice(0, 200)}` };
    }
    const j: any = await res.json();
    const perms = (j?.value || []) as ArmPermission[];
    return { canManage: canManageResourceGroup(perms), permissions: perms };
  } catch (e: any) {
    return { canManage: false, permissions: [], error: `ARM permissions request failed: ${e?.message ?? String(e)}` };
  }
}

/** Outcome of the RP-registration check. */
export interface ProvidersResult {
  /** RPs from {@link DLZ_REQUIRED_PROVIDERS} that are not Registered. */
  missing: string[];
  /** Set when the registration read itself errored. */
  error?: string;
}

/**
 * LIVE: read RP registration state for the required RPs on the target sub.
 * Best-effort — an error returns `{ missing: [], error }` so the deploy is not
 * blocked on a transient read failure (the ARM deploy itself will still 409 if
 * an RP is genuinely unregistered, but we predict it when we can).
 */
export async function checkProvidersRegistered(
  subscriptionId: string,
  getToken: () => Promise<string>,
  required: readonly string[] = DLZ_REQUIRED_PROVIDERS,
): Promise<ProvidersResult> {
  if (!GUID_RE.test(subscriptionId)) return { missing: [], error: `invalid subscriptionId: ${subscriptionId}` };
  let token: string;
  try {
    token = await getToken();
  } catch (e: any) {
    return { missing: [], error: `token: ${e?.message ?? String(e)}` };
  }
  try {
    const res = await fetch(
      `${armBase()}/subscriptions/${subscriptionId}/providers?api-version=2022-09-01&$select=namespace,registrationState`,
      { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { missing: [], error: `ARM providers ${res.status}: ${t.slice(0, 200)}` };
    }
    const j: any = await res.json();
    const state: Record<string, string> = {};
    for (const p of (j?.value || []) as any[]) {
      if (p?.namespace) state[p.namespace] = p.registrationState;
    }
    return { missing: missingProviders(state, required) };
  } catch (e: any) {
    return { missing: [], error: `ARM providers request failed: ${e?.message ?? String(e)}` };
  }
}
