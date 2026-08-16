/**
 * GET /api/azure/resources?type=<armResourceType>[&kind=<kind>][&select=properties.<path>]
 * ---------------------------------------------------------------------------
 * Cross-subscription, user-RBAC Azure resource lister. Returns every resource
 * of the requested ARM type (optionally narrowed by `kind`) across ALL
 * subscriptions the calling identity can read — in ONE query — via Azure
 * Resource Graph, optionally PROJECTING one `properties.<path>` field into a
 * `value` column so a single call yields both the ARM id and the derived
 * endpoint the caller actually needs (cluster URI, vault URI, workspace URL…).
 *
 *   POST {ARM}/providers/Microsoft.ResourceGraph/resources
 *        ?api-version=2021-03-01
 *   body { query: "<table> | where type =~ '<type>' [| where kind =~ '<kind>']
 *                  | project id,name,type,kind,location,resourceGroup,
 *                            subscriptionId[,value=tostring(<path>)]
 *                  | order by name asc",
 *          options: { resultFormat: 'objectArray', $top, $skipToken } }
 *
 * `subscriptions` is intentionally omitted so ARG scopes the query to every
 * subscription the token's identity has access to (per-identity RBAC).
 *
 * ── WHY THE PROJECTION LIVES HERE AND NOT ON /api/admin/gates/[id]/options ──
 * The gate-options route resolves the SAME `properties.<path>` loaders
 * (lib/gates/registry/types.ts `L`) — but by doing a per-resource ARM GET, so
 * it slices to the FIRST 15 resources and is scoped to LOOM_SUBSCRIPTION_ID +
 * LOOM_DLZ_SUBSCRIPTION_ID. Resource Graph returns the `properties` bag INLINE,
 * so the same answer costs ONE request, has no row cap, and spans every
 * subscription the caller can read. A picker fed by the options route silently
 * shows 15 of 40 clusters; this one does not.
 *
 * ── WHAT RESOURCE GRAPH CANNOT SERVE (handled or DECLINED — never a silent []) ──
 *   resourcecontainers  subscriptions / resource groups / management groups are
 *                       NOT rows in `resources`. They are rows in
 *                       `resourcecontainers`, and this route hard-coded
 *                       `resources` — so the ADF "Target resource group" picker
 *                       (lib/editors/pipeline-create-factory-form.tsx, which
 *                       asks for Microsoft.Resources/subscriptions/resourceGroups)
 *                       has been returning an EMPTY list, and the picker then
 *                       DISABLED itself. TABLE_FOR_TYPE fixes that.
 *   subnets             not rows at all — a subnet is an element of a VNet's
 *                       `properties.subnets` array. Served with `mv-expand`.
 *   functions in a site individual functions inside a Microsoft.Web/sites are a
 *                       child of the site's own ARM/data plane, invisible to
 *                       ARG. DECLINED with `code:'unsupported_type'` naming the
 *                       real source.
 *   billing scopes      Microsoft.Billing / Consumption / CostManagement scopes
 *                       come from their own APIs, not ARG. DECLINED the same
 *                       way.
 *
 * CREDENTIAL LADDER (first that yields a token wins; response is tagged `via`):
 *   1. via:'user' — the signed-in user's cached ARM token (lib/azure/
 *      user-token-store). This gives the USER's RBAC: they see exactly the subs
 *      and resources they're entitled to. Requires the Loom app registration to
 *      have the delegated `<ARM>/user_impersonation`
 *      scope admin-consented (captured at login).
 *   2. via:'uami'  — the Loom UAMI ChainedTokenCredential ARM token (same
 *      pattern as adf-client.ts / foundry-cs-client.ts). Sees whatever the UAMI
 *      is granted (e.g. Reader at a management-group / tenant-root scope).
 *
 * When neither yields any resource AND the user path was unavailable, returns an
 * honest gate (ok:false, code:'no_access') naming the exact one-time admin
 * actions — per .claude/rules/no-vaporware.md. Tokens are never logged and never
 * returned to the browser.
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { PagingBudget, PAGE_DEADLINE } from '@/lib/azure/paging-budget';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The three other routes this PR adds all declare 30. This one — the route
 * EVERY adopting picker calls, and the only one that walks up to ten sequential
 * ARG pages — did not, so it inherited the platform default and had no ceiling
 * of its own. Combined with a bare global `fetch` (no timeout), one slow ARG
 * page could hold a picker open indefinitely.
 */
export const maxDuration = 30;

const ARM_SCOPE = armScope();
const ARG_URL = `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`;

/** ARG's own per-page maximum. */
const ARG_PAGE_SIZE = 1000;
/**
 * Pages followed before the answer is reported `truncated`. 10 × 1000 = 10,000
 * resources of ONE type across every readable subscription — an order of
 * magnitude past any real picker — and the ceiling is REPORTED rather than
 * silently applied. This is a bound, not the 15-row cap the gate-options route
 * applies to the same loaders.
 */
const ARG_MAX_PAGES = 10;

export interface AzureResourceRow {
  id: string;
  name: string;
  type: string;
  kind?: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  /** Present only when `select=properties.<path>` was requested. Empty string
   *  when Resource Graph returned no value for that path on this row — the
   *  caller must treat that as UNRESOLVED, never as a valid endpoint. */
  value?: string;
}

/** Strip any HTML/tags and collapse whitespace so error text is safe to render. */
function sanitize(s: string): string {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/** UAMI → DefaultAzureCredential chain (matches adf-client / foundry-cs-client). */
function uamiCredential() {
  return uamiArmCredential();
}

/**
 * KQL is single-quote delimited; ARM resource types and kinds are a constrained
 * alphabet (letters, digits, dot, slash, dash, underscore, space). Reject
 * anything else rather than trying to escape — prevents query injection and
 * keeps the ARG query well-formed.
 */
function isSafeArgLiteral(v: string): boolean {
  return /^[A-Za-z0-9._/\- ]{1,128}$/.test(v);
}

/**
 * `select` is spliced into the query as a KQL PATH EXPRESSION, not a string
 * literal, so quoting cannot contain it — it is restricted to
 * `properties.<identifier>(.<identifier>)*`, which has no way to close a token
 * or start a new statement. Anything else is rejected.
 */
const SELECT_RE = /^properties(\.[A-Za-z_][A-Za-z0-9_]*){1,8}$/;

export function isSafeSelectPath(v: string): boolean {
  return v.length <= 160 && SELECT_RE.test(v);
}

/** Lower-cased ARM types that live in `resourcecontainers`, not `resources`. */
const RESOURCE_CONTAINER_TYPES = new Set([
  'microsoft.resources/subscriptions',
  'microsoft.resources/subscriptions/resourcegroups',
  'microsoft.management/managementgroups',
]);

/** A subnet is an element of a VNet's properties.subnets array — mv-expand. */
const SUBNET_TYPE = 'microsoft.network/virtualnetworks/subnets';

/**
 * Types Resource Graph structurally cannot enumerate, with the real source of
 * truth for each. Declining EXPLICITLY is the point: an empty list from a query
 * that could never have matched reads to the caller as "you have none", and a
 * picker then renders "No resources found" over infrastructure that exists.
 */
const UNSUPPORTED_TYPES = new Map<string, string>([
  [
    'microsoft.web/sites/functions',
    'Individual functions are children of a Microsoft.Web/sites resource and are not rows in Resource Graph. ' +
      'List the site with type=Microsoft.Web/sites, then read its functions from the site itself ' +
      '(ARM: {siteId}/functions?api-version=2023-12-01).',
  ],
  [
    'microsoft.billing/billingaccounts',
    'Billing scopes are served by the Billing API (/providers/Microsoft.Billing/billingAccounts), not by Resource Graph. ' +
      'Use the cost-management surfaces (LOOM_BILLING_SCOPE) rather than this route.',
  ],
  [
    'microsoft.billing/billingprofiles',
    'Billing scopes are served by the Billing API (/providers/Microsoft.Billing/billingAccounts/*/billingProfiles), not by Resource Graph.',
  ],
  [
    'microsoft.billing/invoicesections',
    'Billing scopes are served by the Billing API (/providers/Microsoft.Billing/**/invoiceSections), not by Resource Graph.',
  ],
  [
    'microsoft.consumption/budgets',
    'Consumption budgets are served by the Consumption API (/providers/Microsoft.Consumption/budgets), not by Resource Graph.',
  ],
  [
    'microsoft.costmanagement/scopes',
    'Cost Management scopes are served by the Cost Management API, not by Resource Graph.',
  ],
]);

/** Which ARG table answers this type. */
export function tableForType(type: string): 'resources' | 'resourcecontainers' {
  return RESOURCE_CONTAINER_TYPES.has(type.toLowerCase()) ? 'resourcecontainers' : 'resources';
}

/** The decline reason for a type ARG cannot serve, or null when it can. */
export function unsupportedReason(type: string): string | null {
  return UNSUPPORTED_TYPES.get(type.toLowerCase()) ?? null;
}

/**
 * Build the ARG query.
 *
 * Three shapes, because three different things are being asked for:
 *   - `resources`           the normal case;
 *   - `resourcecontainers`  subscriptions / RGs / management groups, whose rows
 *     do not all carry every column — `column_ifexists` keeps the projection
 *     valid instead of failing the whole query on a missing `kind`;
 *   - subnets               mv-expand over the VNet's properties.subnets, with
 *     the select path re-based onto the expanded element.
 */
export function buildQuery(type: string, kind: string | undefined, select?: string, name?: string): string {
  const isSubnet = type.toLowerCase() === SUBNET_TYPE;
  if (isSubnet) {
    // The select path is read RELATIVE TO THE SUBNET, e.g.
    // properties.addressPrefix → subnet.properties.addressPrefix.
    const valueExpr = select ? `, value=tostring(subnet.${select})` : '';
    return (
      "resources | where type =~ 'microsoft.network/virtualnetworks'" +
      ' | mv-expand subnet = properties.subnets' +
      ' | project id=tostring(subnet.id),' +
      " name=strcat(name, '/', tostring(subnet.name))," +
      " type='Microsoft.Network/virtualNetworks/subnets'," +
      " kind=''," +
      ' location, resourceGroup, subscriptionId' +
      valueExpr +
      ' | order by name asc'
    );
  }

  const table = tableForType(type);
  const valueExpr = select ? `, value=tostring(${select})` : '';
  let q = `${table} | where type =~ '${type}'`;
  if (kind) q += ` | where kind =~ '${kind}'`;
  // NAME NARROWING. Some ARM types are far too broad to offer whole: every Loom
  // deployment's Container Apps environment holds the console, the runner, the
  // DuckDB app and the catalog, so an unfiltered `Microsoft.App/containerApps`
  // query renders a "Catalog endpoint" list containing every app in the tenant.
  // The resources Loom itself deploys carry DETERMINISTIC names (the Loom Unity
  // bicep module pins `param name string = 'loom-unity'`), so a source can name
  // the one it means. Same `=~` case-insensitive comparison as `kind`, same
  // literal validation.
  if (name) q += ` | where name =~ '${name}'`;
  if (table === 'resourcecontainers') {
    q +=
      ' | project id,name,type,' +
      "kind=tostring(column_ifexists('kind','')), " +
      "location=tostring(column_ifexists('location','')), " +
      "resourceGroup=tostring(column_ifexists('resourceGroup','')), " +
      'subscriptionId' +
      valueExpr;
  } else {
    q += ` | project id,name,type,kind,location,resourceGroup,subscriptionId${valueExpr}`;
  }
  return `${q} | order by name asc`;
}

/**
 * Run the ARG query with a single bearer token, following `$skipToken` so a
 * tenant with more than one page of a given type is not silently truncated at
 * ARG's 1,000-row default. Returns the parsed rows on success, or an error
 * descriptor (status + sanitized message) on failure.
 *
 * ONE request per PAGE — never per resource. That is the whole reason the
 * `properties.<path>` projection lives on this route rather than on the
 * gate-options route, which does a per-resource GET and therefore caps at 15.
 *
 * PAGED UNDER A WALL-CLOCK BUDGET, like the Key Vault sibling in this same PR.
 * This previously used the raw global `fetch` with NO timeout and no ceiling
 * beyond a page count, so ten slow ARG pages could each hang for as long as the
 * platform allowed. `PagingBudget` bounds the whole walk and `fetchWithTimeout`
 * bounds each page; a breach keeps the rows already read (a partial picker
 * still works) and reports the answer as partial rather than as complete.
 */
async function runArg(
  token: string,
  query: string,
): Promise<{ ok: true; rows: AzureResourceRow[]; truncated: boolean } | { ok: false; status: number; error: string }> {
  const rows: AzureResourceRow[] = [];
  let skipToken: string | undefined;
  const budget = new PagingBudget(`azure resource graph ${query.slice(0, 60)}`, { maxPages: ARG_MAX_PAGES });

  while (budget.claimPage()) {
    let res: Response | typeof PAGE_DEADLINE;
    const body = JSON.stringify({
      query,
      options: {
        resultFormat: 'objectArray',
        $top: ARG_PAGE_SIZE,
        ...(skipToken ? { $skipToken: skipToken } : {}),
      },
    });
    try {
      res = await budget.runPage(async (timeoutMs) =>
        fetchWithTimeout(
          ARG_URL,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body,
            cache: 'no-store',
          },
          timeoutMs,
        ));
    } catch (e: any) {
      return { ok: false, status: 502, error: sanitize(e?.message || String(e)) };
    }
    // Deadline reached mid-walk: keep what we have and report it partial. A
    // hard failure here would blank a picker that already has usable rows.
    if (res === PAGE_DEADLINE) break;

    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j?.error?.message || j?.error?.code || text;
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, status: res.status, error: sanitize(msg) };
    }
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, status: 502, error: 'Resource Graph returned a non-JSON body' };
    }
    if (Array.isArray(parsed?.data)) rows.push(...(parsed.data as AzureResourceRow[]));
    skipToken = typeof parsed?.$skipToken === 'string' && parsed.$skipToken ? parsed.$skipToken : undefined;
    if (!skipToken) break;
  }
  budget.warnIfTruncated(rows.length);

  return { ok: true, rows, truncated: !!skipToken || !!budget.truncatedBy };
}

const GATE_MESSAGE =
  'No Azure resources were returned across the subscriptions visible to Loom. ' +
  'This usually means one of two one-time admin actions is still pending: ' +
  '(1) Admin-consent the Loom app registration for the Azure Service Management ' +
  'delegated permission "user_impersonation" (' + armBase() + '/user_impersonation) ' +
  'so the picker can query with each user\'s own RBAC; and/or ' +
  '(2) Grant the Loom user-assigned managed identity (LOOM_UAMI_CLIENT_ID) the ' +
  '"Reader" role at the tenant root management group (scope /providers/Microsoft.Management/managementGroups/<tenantRootGroupId>) ' +
  'so the UAMI fallback can enumerate resources across every subscription. ' +
  'Once either is in place, resources you have access to will appear here.';

/** How many rows came back with no value for the requested `select` path. */
function countUnresolved(rows: AzureResourceRow[]): number {
  return rows.filter((r) => !r.value).length;
}

export const GET = withSession(async (req: NextRequest, { session }) => {
  const type = (req.nextUrl.searchParams.get('type') || '').trim();
  const kind = (req.nextUrl.searchParams.get('kind') || '').trim() || undefined;
  const name = (req.nextUrl.searchParams.get('name') || '').trim() || undefined;
  const select = (req.nextUrl.searchParams.get('select') || '').trim() || undefined;
  if (!type) {
    return apiError(
      'Missing required query param `type` (ARM resource type, e.g. Microsoft.DataFactory/factories).',
      400,
      { code: 'bad_request' },
    );
  }
  if (!isSafeArgLiteral(type) || (kind && !isSafeArgLiteral(kind)) || (name && !isSafeArgLiteral(name))) {
    return apiError('Invalid characters in `type`, `kind` or `name`.', 400, { code: 'bad_request' });
  }
  if (select && !isSafeSelectPath(select)) {
    return apiError(
      'Invalid `select` — it must be a Resource Graph property path of the form `properties.<field>[.<field>…]`.',
      400,
      { code: 'bad_request' },
    );
  }

  // A type Resource Graph cannot answer gets a REASON, not an empty list.
  const unsupported = unsupportedReason(type);
  if (unsupported) {
    return apiError(unsupported, 400, { code: 'unsupported_type', type });
  }

  const query = buildQuery(type, kind, select, name);

  // ---- (a) User ARM token (per-user RBAC) -------------------------------
  let userArgError: { status: number; error: string } | null = null;
  try {
    const userToken = await getUserArmToken(session.claims.oid);
    if (userToken) {
      const r = await runArg(userToken, query);
      if (r.ok) {
        return apiOk({
          resources: r.rows,
          via: 'user',
          ...(select ? { select, unresolved: countUnresolved(r.rows) } : {}),
          ...(r.truncated ? { truncated: true } : {}),
        });
      }
      // Auth/expiry on the user path: remember it, then fall through to UAMI.
      userArgError = { status: r.status, error: r.error };
    }
  } catch {
    // Ignore — fall through to UAMI.
  }

  // ---- (b) UAMI fallback -------------------------------------------------
  try {
    const tok = await uamiCredential().getToken(ARM_SCOPE);
    if (tok?.token) {
      const r = await runArg(tok.token, query);
      if (r.ok) {
        if (r.rows.length === 0 && userArgError) {
          // Both paths reachable but nothing visible → honest gate.
          return apiError(GATE_MESSAGE, 200, { code: 'no_access' });
        }
        return apiOk({
          resources: r.rows,
          via: 'uami',
          ...(select ? { select, unresolved: countUnresolved(r.rows) } : {}),
          ...(r.truncated ? { truncated: true } : {}),
        });
      }
      // UAMI ARG call itself failed (e.g. UAMI has no read scope anywhere).
      return apiError(`${GATE_MESSAGE} (Resource Graph error via UAMI: ${r.error})`, 200, { code: 'no_access' });
    }
  } catch (e: any) {
    return apiError(
      `${GATE_MESSAGE} (Could not acquire a UAMI ARM token: ${sanitize(e?.message || String(e))})`,
      200,
      { code: 'no_access' },
    );
  }

  // Neither path produced a usable token.
  return apiError(GATE_MESSAGE, 200, { code: 'no_access' });
});
