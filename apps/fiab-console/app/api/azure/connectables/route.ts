/**
 * GET /api/azure/connectables
 * ---------------------------
 * Cross-subscription "Add existing" discovery for /connections. Returns EVERY
 * connectable Azure resource (SQL, PostgreSQL, Storage/ADLS, Cosmos, Synapse,
 * Databricks, Event Hubs, Service Bus, Key Vault) the signed-in user can reach
 * — across ALL subscriptions their RBAC + ABAC grant them — in ONE multi-type
 * Azure Resource Graph query, so they can one-click import any as a Loom
 * Connection.
 *
 *   POST {ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01
 *        body { query: "resources | where type in~ (...) | join (subscription
 *               names) | project ...", options: { resultFormat:'objectArray',
 *               $top, $skipToken } }
 *
 * CREDENTIAL LADDER (response tagged `via`):
 *   1. via:'user' — the signed-in user's delegated ARM token (on-behalf-of,
 *      lib/azure/user-token-store). This is the task's "delegated token, NOT
 *      the UAMI": ARG honours the caller's own RBAC + ABAC condition
 *      assignments, so they see exactly the resources they're entitled to.
 *   2. via:'uami'  — the Loom UAMI ChainedTokenCredential ARM token fallback.
 *
 * `subscriptions` is intentionally omitted so ARG spans every subscription the
 * token's identity can read. Paging via `$skipToken` is followed so large
 * tenants are not truncated at the 1000-row page limit. When neither path sees
 * anything, returns an honest gate (code:'no_access') naming the exact one-time
 * admin actions — per .claude/rules/no-vaporware.md. Tokens are never logged or
 * returned to the browser. All hosts use cloud-endpoints suffix helpers so the
 * derived coordinates are correct in every sovereign cloud.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import {
  armBase, armScope, getSqlSuffix, synapseSqlSuffix,
} from '@/lib/azure/cloud-endpoints';
import {
  CONNECTABLE_ARM_TYPES, armTypeToConnType, normalizeHost, CONN_TYPE_AUTH_OPTIONS,
  type ConnectableResource,
} from '@/lib/azure/connectable-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ARM_SCOPE = armScope();
const ARG_URL = `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`;

interface ArgRow {
  id: string;
  name: string;
  type: string;
  kind?: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  subName?: string;
  host?: string;
  isHns?: string;
}

function sanitize(s: string): string {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function uamiCredential(): ChainedTokenCredential | DefaultAzureCredential {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID;
  return clientId
    ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId }), new DefaultAzureCredential())
    : new DefaultAzureCredential();
}

/**
 * The single multi-type ARG query. `type in~` is case-insensitive; the
 * leftouter join to ResourceContainers attaches each resource's subscription
 * display name. The coalesced `host` pulls the right endpoint field per type
 * (SQL/PG fqdn, Cosmos documentEndpoint, EH/SB serviceBusEndpoint, KV vaultUri,
 * Synapse serverless SQL, Databricks workspaceUrl, Storage dfs primaryEndpoint).
 */
function buildQuery(): string {
  const types = CONNECTABLE_ARM_TYPES.map((c) => `'${c.armType}'`).join(',');
  return [
    'resources',
    `| where type in~ (${types})`,
    '| extend host = tostring(coalesce(',
    '    properties.fullyQualifiedDomainName,',
    '    properties.documentEndpoint,',
    '    properties.serviceBusEndpoint,',
    '    properties.vaultUri,',
    '    properties.connectivityEndpoints.sqlOnDemand,',
    '    properties.connectivityEndpoints.sql,',
    '    properties.workspaceUrl,',
    '    properties.primaryEndpoints.dfs,',
    "    ''))",
    '| extend isHns = tostring(properties.isHnsEnabled)',
    '| join kind=leftouter (',
    '    ResourceContainers',
    "    | where type =~ 'microsoft.resources/subscriptions'",
    '    | project subscriptionId, subName = name',
    '  ) on subscriptionId',
    '| project id, name, type, kind, location, resourceGroup, subscriptionId, subName, host, isHns',
    '| order by name asc',
  ].join('\n');
}

/** Run the ARG query with a token, following $skipToken paging to completion. */
async function runArg(
  token: string,
): Promise<{ ok: true; rows: ArgRow[] } | { ok: false; status: number; error: string }> {
  const query = buildQuery();
  const rows: ArgRow[] = [];
  let skipToken: string | undefined;
  let guard = 0;
  // Page until ARG stops returning a $skipToken (bounded for safety).
  do {
    const options: Record<string, unknown> = { resultFormat: 'objectArray', $top: 1000 };
    if (skipToken) options.$skipToken = skipToken;
    let res: Response;
    try {
      res = await fetch(ARG_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, options }),
      });
    } catch (e: any) {
      return { ok: false, status: 502, error: sanitize(e?.message || String(e)) };
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j?.error?.message || j?.error?.code || text; } catch { /* non-JSON */ }
      return { ok: false, status: res.status, error: sanitize(msg) };
    }
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { return { ok: false, status: 502, error: 'Resource Graph returned a non-JSON body' }; }
    if (Array.isArray(body?.data)) rows.push(...body.data);
    skipToken = typeof body?.$skipToken === 'string' ? body.$skipToken : undefined;
  } while (skipToken && guard++ < 50);
  return { ok: true, rows };
}

/** Last `/databases/<db>` segment's parent server name, for SQL DB hosts. */
function sqlServerFromId(id: string): string | null {
  const m = /\/servers\/([^/]+)\/databases\//i.exec(id || '');
  return m ? m[1] : null;
}

/**
 * Map one ARG row to a ConnectableResource, deriving the bare host per type
 * using sovereign-cloud suffix helpers where the ARG endpoint field is absent
 * (SQL databases carry no FQDN — it is derived from the parent server name).
 */
function toConnectable(row: ArgRow): ConnectableResource | null {
  const connType = armTypeToConnType(row.type);
  if (!connType) return null;
  let host = normalizeHost(row.host);
  let database: string | undefined;

  switch (connType) {
    case 'azure-sql': {
      const server = sqlServerFromId(row.id);
      if (server) host = `${server}.${getSqlSuffix()}`;
      database = row.name;
      break;
    }
    case 'synapse-serverless':
      // Prefer the serverless (on-demand) endpoint already coalesced into host;
      // fall back to the conventional `<workspace>-ondemand` FQDN.
      if (!host) host = `${row.name}-ondemand.${synapseSqlSuffix()}`;
      break;
    case 'storage-adls':
      // Storage connections key off the bare account name (the builder's
      // "Account / host" field), not the full dfs URL.
      host = row.name;
      break;
    default:
      break;
  }

  // Pick the first (most preferred) auth method for this connection type.
  const suggestedAuth = (CONN_TYPE_AUTH_OPTIONS[connType]?.[0]) ?? 'entra-mi';

  return {
    armResourceId: row.id,
    name: row.name,
    armType: row.type,
    connType,
    host,
    database,
    subscriptionId: row.subscriptionId || '',
    subscriptionName: row.subName || undefined,
    resourceGroup: row.resourceGroup || '',
    location: row.location || undefined,
    suggestedAuth,
  };
}

const GATE_MESSAGE =
  'No connectable Azure resources were returned across the subscriptions visible to Loom. ' +
  'This usually means one of two one-time admin actions is still pending: ' +
  '(1) Admin-consent the Loom app registration for the Azure Service Management ' +
  'delegated permission "user_impersonation" (' + armBase() + '/user_impersonation) ' +
  'so "Add existing" can query with each user\'s own RBAC + ABAC; and/or ' +
  '(2) Grant the Loom user-assigned managed identity (LOOM_UAMI_CLIENT_ID) the ' +
  '"Reader" role at the tenant root management group so the UAMI fallback can ' +
  'enumerate resources. Once either is in place, resources you can access appear here.';

export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'unauthenticated', error: 'Not signed in.' }, { status: 401 });
  }

  const finalize = (rows: ArgRow[], via: 'user' | 'uami') => {
    const resources = rows
      .map(toConnectable)
      .filter((r): r is ConnectableResource => r !== null);
    return NextResponse.json({ ok: true, resources, via });
  };

  // ---- (a) User delegated ARM token (per-user RBAC + ABAC) ---------------
  let userArgError: { status: number; error: string } | null = null;
  try {
    const userToken = await getUserArmToken(session.claims.oid);
    if (userToken) {
      const r = await runArg(userToken);
      if (r.ok) return finalize(r.rows, 'user');
      userArgError = { status: r.status, error: r.error };
    }
  } catch {
    // fall through to UAMI
  }

  // ---- (b) UAMI fallback -------------------------------------------------
  try {
    const tok = await uamiCredential().getToken(ARM_SCOPE);
    if (tok?.token) {
      const r = await runArg(tok.token);
      if (r.ok) {
        if (r.rows.length === 0 && userArgError) {
          return NextResponse.json({ ok: false, code: 'no_access', error: GATE_MESSAGE }, { status: 200 });
        }
        return finalize(r.rows, 'uami');
      }
      return NextResponse.json(
        { ok: false, code: 'no_access', error: `${GATE_MESSAGE} (Resource Graph error via UAMI: ${r.error})` },
        { status: 200 },
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, code: 'no_access', error: `${GATE_MESSAGE} (Could not acquire a UAMI ARM token: ${sanitize(e?.message || String(e))})` },
      { status: 200 },
    );
  }

  return NextResponse.json({ ok: false, code: 'no_access', error: GATE_MESSAGE }, { status: 200 });
}
