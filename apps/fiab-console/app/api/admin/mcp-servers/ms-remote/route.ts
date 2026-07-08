/**
 * Microsoft remote MCP family — connect / status / register endpoint.
 *
 * GENERALIZES app/api/admin/mcp-servers/powerbi/route.ts to the whole curated
 * Microsoft "remote built-in" MCP catalog (lib/mcp/catalog.ts
 * REMOTE_BUILTIN_MCP_CATALOG): all default-ON (opt-OUT) but honestly gated —
 * Microsoft Learn (no-auth, live day-one), the Entra-OBO servers (Azure
 * Resources/ARM, Microsoft Foundry,
 * Microsoft Graph / M365 / Teams / OneDrive-SharePoint, Sentinel, Admin Center,
 * Dataverse, and the projected-in Power BI entry), and GitHub (Key Vault PAT).
 * It is NOT a parallel system — every server registers as the SAME
 * McpServerConfig shape (source 'remote-builtin'), is reached by the SAME
 * mcp-client (resolveAuthHeader + threaded per-user `userToken`), and is
 * advertised by the SAME buildMcpShim as `mcp_<slug>_<tool>`.
 *
 *   GET  /api/admin/mcp-servers/ms-remote
 *     → { ok:true, servers:[ statusFor(entry) … ] } — every catalog entry's
 *       status (no probe; the panel renders cards and never hangs on load).
 *
 *   GET  /api/admin/mcp-servers/ms-remote?id=<entry-id>[&probe=1]
 *     → statusFor(entry):
 *        • configured  → { ok, configured:true, id, name, category, endpoint,
 *            transport, auth, oboResource?, scopeUris?, secretEnv?, tenantSetting?,
 *            enableEnv, endpointEnv, registered, serverId?, tokenReady, tokenNote? }
 *          (Microsoft Learn → configured:true, auth:'none', tokenReady:true).
 *        • unconfigured → { ok:true, configured:false, …, gate:{ message,
 *            enableEnv, endpointEnv, scopes?, oboResource?, secretEnv?,
 *            tenantSetting?, docs } } — an HONEST Fluent-MessageBar gate naming
 *          the exact env var / Key Vault secret / delegated scopes / tenant
 *          setting to provision (no-vaporware), mirroring the Power BI route.
 *        • with ?probe=1 (and configured): additionally runs a REAL Streamable-
 *          HTTP initialize→tools/list — NO auth for Learn, the user's per-resource
 *          OBO bearer for entra-obo servers, the Key Vault PAT for GitHub — and
 *          returns the live tool count / error (no mock).
 *
 *   POST /api/admin/mcp-servers/ms-remote  (tenant-admin gated: admin.deploy-mcp)
 *     Body: { id }. Registers the named remote built-in as an McpServerConfig row
 *     (authMethod from the descriptor — 'header' no-auth for Learn, 'entra-obo' +
 *     oboResource/oboScopes for the delegated servers, 'key-vault' + the secret
 *     NAME for GitHub; source 'remote-builtin', catalogId = entry id) via
 *     saveMcpServer, so it flows through buildMcpShim untouched. Idempotent:
 *     re-registering updates the existing row in place. NEVER accepts or stores a
 *     secret — the entra-obo path carries a per-user token resolved at call time,
 *     and the GitHub path stores only the Key Vault secret NAME, never the PAT.
 *
 * RULE COMPLIANCE
 *  - no-fabric-dependency: Microsoft Learn (auth 'none') is the SOLE default-on
 *    entry; every other server is STRICTLY OPT-IN and inert until its descriptor
 *    `configured()` is true. No api.fabric / api.powerbi host is reached on any
 *    default path — the Power BI entry is gated exactly as before
 *    (isPbiMcpConfigured via its `configured()`), and the Fabric/RTI servers live
 *    in the deployable catalog as explicit opt-ins, not here.
 *  - no-vaporware: when configured, the optional probe + the runtime make a REAL
 *    JSON-RPC Streamable-HTTP call to the resolved endpoint with the correct
 *    credential; when unconfigured, the response is an honest gate naming the
 *    exact env var + scopes + tenant setting — never a silent failure.
 *  - secrets: entra-obo has NO static secret to store (the per-user token never
 *    lands on the doc); GitHub stores only the Key Vault secret NAME.
 *
 * This is a BFF route (no JSX) — the Fluent v9 / Loom-token rendering happens in
 * the Connect-MCP admin panel that consumes this structured JSON.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { auditLogContainer, mcpServersContainer } from '@/lib/azure/cosmos-client';
import { saveMcpServer, updateMcpServerTestResult } from '@/lib/azure/mcp-config-store';
import { listMcpTools } from '@/lib/azure/mcp-client';
import { getUserOboToken } from '@/lib/azure/mcp-obo-token-store';
import {
  REMOTE_BUILTIN_MCP_CATALOG,
  msRemoteMcp,
  msRemoteMcpScopeUris,
  effectiveRemoteState,
  type RemoteBuiltinMcpEntry,
  type EffectiveRemoteState,
} from '@/lib/mcp/catalog';
import {
  getRemoteBuiltinOverrides,
  getRemoteBuiltinOverride,
} from '@/lib/azure/mcp-remote-config-store';
import type { McpServerConfig, McpServerConfigDoc } from '@/lib/types/mcp-config';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Shared Loom confidential client env used for every per-user OBO exchange. */
const OBO_CLIENT_ENV = 'LOOM_MSAL_CLIENT_ID';

// ── Descriptor → runtime mapping helpers (single-sourced from the catalog) ─────

/**
 * Map a descriptor's auth model onto McpServerConfig.authMethod:
 *  - 'none'      → 'header' with an EMPTY authValue (resolveAuthHeader returns ''
 *    so NO Authorization header is sent — the no-auth path Microsoft Learn needs,
 *    and the exact form syntheticDefaultOnServers uses for the day-one Learn row).
 *  - 'entra-obo' / 'key-vault' → passed straight through.
 */
function authMethodFor(entry: RemoteBuiltinMcpEntry): McpServerConfig['authMethod'] {
  return entry.auth === 'none' ? 'header' : entry.auth;
}

/**
 * Resolve the concrete OBO resource (audience) for an entra-obo entry. Uses the
 * descriptor's `oboResource` when set; for a per-org server (oboResource '', e.g.
 * Dataverse) derives it from the configured endpoint's origin — matching
 * msRemoteMcpScopeUris() so the registered audience, the scope URIs, and the
 * per-user token lookup all agree. '' for non-OBO entries or when unresolvable.
 */
function resolveOboResource(entry: RemoteBuiltinMcpEntry, endpoint?: string): string {
  if (entry.auth !== 'entra-obo') return '';
  if (entry.oboResource && entry.oboResource.trim()) return entry.oboResource.trim();
  const ep = endpoint?.trim() || entry.endpoint;
  try {
    return ep ? new URL(ep).origin : '';
  } catch {
    return '';
  }
}

/** Turn the descriptor's attribution (e.g. 'github.com/microsoft/mcp') into a URL. */
function attributionUrl(attribution: string): string {
  const a = (attribution || '').trim();
  if (!a) return '';
  return /^https?:\/\//i.test(a) ? a : `https://${a}`;
}

/**
 * The honest config gate for a default-on-but-unconfigured entry (shared by GET +
 * POST). Names the exact endpoint override, delegated scopes / OBO resource (for
 * entra-obo), Key Vault secret env (for GitHub), and any admin tenant setting —
 * per no-vaporware. `entry.gate` is the descriptor's human copy; the structured
 * fields let the panel render a precise MessageBar + remediation.
 */
function gateFor(entry: RemoteBuiltinMcpEntry, eff: EffectiveRemoteState): Record<string, unknown> {
  const g: Record<string, unknown> = {
    message: entry.gate,
    enableEnv: entry.enableEnv,
    endpointEnv: entry.endpointEnv,
    attribution: entry.attribution,
    docs: attributionUrl(entry.attribution),
    // Honest remaining prerequisites the admin STILL can't set inline (e.g. the
    // shared OBO confidential client) after applying any override.
    missing: eff.missing,
  };
  if (entry.auth === 'entra-obo') {
    g.scopes = msRemoteMcpScopeUris(entry.id);
    g.oboResource = resolveOboResource(entry) || undefined;
    g.oboClientEnv = OBO_CLIENT_ENV;
  } else if (entry.auth === 'key-vault') {
    g.secretEnv = entry.secretRefEnv;
  }
  if (entry.tenantSetting) g.tenantSetting = entry.tenantSetting;
  return g;
}

/** Find the already-registered remote-builtin row for this tenant + catalog id. */
async function findRegistered(
  tenantId: string,
  catalogId: string,
): Promise<McpServerConfigDoc | null> {
  try {
    const c = await mcpServersContainer();
    const { resources } = await c.items
      .query<McpServerConfigDoc>({
        query:
          "SELECT * FROM c WHERE c.tenantId = @t AND c.source = 'remote-builtin' AND c.catalogId = @cid",
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@cid', value: catalogId },
        ],
      })
      .fetchAll();
    return resources?.[0] ?? null;
  } catch {
    return null;
  }
}

/** All registered remote-builtin rows for this tenant, keyed by catalogId. */
async function findAllRegistered(tenantId: string): Promise<Map<string, McpServerConfigDoc>> {
  const map = new Map<string, McpServerConfigDoc>();
  try {
    const c = await mcpServersContainer();
    const { resources } = await c.items
      .query<McpServerConfigDoc>({
        query: "SELECT * FROM c WHERE c.tenantId = @t AND c.source = 'remote-builtin'",
        parameters: [{ name: '@t', value: tenantId }],
      })
      .fetchAll();
    for (const r of resources || []) if (r.catalogId) map.set(r.catalogId, r);
  } catch {
    /* Cosmos unreachable — fall through to "nothing registered" (honest). */
  }
  return map;
}

/**
 * Build the per-server status object the panel renders. When `configured()` is
 * false this returns the honest gate (no token lookup, no probe). When true it
 * resolves per-user OBO token readiness (entra-obo) so the panel can show
 * Connected vs. "sign in again / consent" without faking an OK.
 */
async function statusFor(
  entry: RemoteBuiltinMcpEntry,
  oid: string,
  registered: McpServerConfigDoc | null,
  eff: EffectiveRemoteState,
): Promise<Record<string, unknown>> {
  const common = {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    desc: entry.desc,
    transport: entry.transport,
    auth: entry.auth,
    endpoint: eff.endpoint,
    endpointEnv: entry.endpointEnv,
    enableEnv: entry.enableEnv,
    defaultOn: entry.defaultOn,
    preview: entry.preview,
    optIn: entry.optIn,
    attribution: entry.attribution,
    docs: attributionUrl(entry.attribution),
    tenantSetting: entry.tenantSetting,
    // Inline-config facets the admin form binds to (no-freeform: typed, per the
    // descriptor's declared shape). `config` is the CURRENT effective config +
    // where it came from (deployment env vs admin override); `override` is the
    // persisted admin-set values (so the form pre-fills exactly what was saved).
    config: {
      // Which typed fields this server exposes for inline config.
      supportsEndpoint: !!entry.endpointEnv,
      supportsSecret: entry.auth === 'key-vault',
      secretEnv: entry.secretRefEnv,
      // Effective resolved values.
      enabled: eff.enabled,
      endpoint: eff.endpoint,
      secretName: eff.secretName,
      source: eff.source,       // 'env' | 'admin'
      envForced: eff.envForced, // deployment env force-on → cannot disable here
      missing: eff.missing,
    },
    override: (await getRemoteBuiltinOverride(oid, entry.id)) ?? null,
  };

  // Honest gate (no-fabric-dependency): a default-on server is advertised only
  // once the EFFECTIVE state (env + admin override) is configured. 200 +
  // configured:false + honest gate until then.
  if (!eff.configured) {
    return { ok: true, configured: false, ...common, gate: gateFor(entry, eff) };
  }

  // Per-credential readiness. Learn (none) + GitHub (key-vault) are "ready" once
  // configured — the credential (none / the KV secret) resolves at call time.
  // entra-obo readiness depends on a cached per-user delegated token for THIS
  // server's resource (same lookup buildMcpShim uses at chat time).
  let tokenReady = true;
  let tokenNote: string | undefined;
  let scopeUris: string[] | undefined;
  let oboResource: string | undefined;
  let secretEnv: string | undefined;

  if (entry.auth === 'entra-obo') {
    scopeUris = msRemoteMcpScopeUris(entry.id);
    oboResource = resolveOboResource(entry, eff.endpoint) || undefined;
    const userToken = oboResource ? await getUserOboToken(oid, oboResource) : null;
    tokenReady = !!userToken;
    if (!tokenReady) {
      tokenNote =
        `Sign in again and consent the ${entry.name} delegated scopes to enable per-user ` +
        `access; no delegated token for ${oboResource || 'this resource'} is cached for ` +
        'your account yet.';
    }
  } else if (entry.auth === 'key-vault') {
    secretEnv = entry.secretRefEnv;
  }

  return {
    ok: true,
    configured: true,
    ...common,
    scopeUris,
    oboResource,
    oboClientEnv: entry.auth === 'entra-obo' ? OBO_CLIENT_ENV : undefined,
    secretEnv,
    registered: !!registered,
    serverId: registered?.serverId,
    enabled: registered?.enabled,
    lastTestResult: registered?.lastTestResult,
    tokenReady,
    tokenNote,
  };
}

/**
 * Run the REAL Streamable-HTTP handshake (initialize → tools/list) for a
 * configured entry under the correct credential. Persists the result on a
 * registered row (best-effort). Never throws — a 401/403 (scope/consent/tenant
 * setting still missing) surfaces honestly rather than failing the request.
 */
async function probeEntry(
  entry: RemoteBuiltinMcpEntry,
  oid: string,
  tenantId: string,
  registered: McpServerConfigDoc | null,
  eff: EffectiveRemoteState,
): Promise<Record<string, unknown>> {
  if (!eff.endpoint) {
    return {
      reachable: false,
      skipped: true,
      reason: `No endpoint resolved — set ${entry.endpointEnv} or configure it inline.`,
    };
  }

  let userToken: string | undefined;
  let authValue: string | undefined;
  const authMethod = authMethodFor(entry);

  if (entry.auth === 'entra-obo') {
    const resource = resolveOboResource(entry, eff.endpoint);
    userToken = (resource ? await getUserOboToken(oid, resource) : null) || undefined;
    if (!userToken) {
      return {
        reachable: false,
        skipped: true,
        reason:
          `Sign in again and consent the ${entry.name} delegated scopes — no delegated ` +
          'token is cached for your account yet.',
      };
    }
  } else if (entry.auth === 'key-vault') {
    // The Key Vault secret NAME (never the value); resolveAuthHeader fetches it.
    // Effective value: the admin override wins, else the descriptor's env var.
    authValue = eff.secretName;
  }

  try {
    const tools = await listMcpTools(eff.endpoint, authMethod, authValue, 8000, userToken);
    if (registered) {
      await updateMcpServerTestResult(tenantId, registered.serverId, {
        toolCount: tools.length,
      }).catch(() => {});
    }
    return { reachable: true, toolCount: tools.length, tools: tools.map((t) => t.name) };
  } catch (e: any) {
    const error = e?.message || String(e);
    if (registered) {
      await updateMcpServerTestResult(tenantId, registered.serverId, { error }).catch(() => {});
    }
    return { reachable: false, error };
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const oid = session.claims.oid;
  const id = req.nextUrl.searchParams.get('id');
  const overrides = await getRemoteBuiltinOverrides(oid);

  // No id → summarize the whole Microsoft remote MCP family (no probe; the panel
  // renders cards and never hangs on load).
  if (!id) {
    const registeredMap = await findAllRegistered(oid);
    const servers = await Promise.all(
      REMOTE_BUILTIN_MCP_CATALOG.map((entry) =>
        statusFor(
          entry,
          oid,
          registeredMap.get(entry.id) ?? null,
          effectiveRemoteState(entry, overrides[entry.id]),
        ),
      ),
    );
    return NextResponse.json({ ok: true, servers });
  }

  const entry = msRemoteMcp(id);
  if (!entry) {
    return NextResponse.json({ ok: false, error: `unknown remote MCP server: ${id}` }, { status: 404 });
  }

  const eff = effectiveRemoteState(entry, overrides[entry.id]);
  const registered = await findRegistered(oid, entry.id);
  const status = await statusFor(entry, oid, registered, eff);

  // Real connectivity probe (no-vaporware) — opt-in via ?probe=1. Only meaningful
  // when configured; the gate already explains an unconfigured server.
  if (req.nextUrl.searchParams.get('probe') === '1' && status.configured === true) {
    const probe = await probeEntry(entry, oid, oid, registered, eff);
    return NextResponse.json({ ...status, probe });
  }

  return NextResponse.json(status);
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Tenant-admin gated — same capability as deploying a catalog MCP server.
  const denied = await enforceCapability(session, 'admin.deploy-mcp', 'Admin');
  if (denied) return denied;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const entry = id ? msRemoteMcp(id) : undefined;
  if (!entry) {
    return NextResponse.json(
      { ok: false, error: `unknown remote MCP server: ${id || '(missing id)'}` },
      { status: 400 },
    );
  }

  const tenantId = session.claims.oid;
  const eff = effectiveRemoteState(entry, await getRemoteBuiltinOverride(tenantId, entry.id));

  // Honest gate (no-fabric-dependency): refuse to register a default-on server
  // that is not yet effectively configured (env + admin override). Never fake success.
  if (!eff.configured) {
    return NextResponse.json({ ok: false, configured: false, gate: gateFor(entry, eff) }, { status: 409 });
  }

  const who = session.claims.upn || session.claims.email || tenantId;

  // Build the McpServerConfig row straight from the descriptor + effective config.
  // No secret value is ever accepted or stored: entra-obo carries a per-user token
  // resolved at call time; key-vault stores only the Key Vault secret NAME.
  const config: McpServerConfig = {
    name: entry.name,
    endpoint: eff.endpoint,
    authMethod: authMethodFor(entry),
    description: entry.desc,
    enabled: true,
    source: 'remote-builtin',
    catalogId: entry.id,
  };
  if (entry.auth === 'entra-obo') {
    // oboResource is the concrete audience (descriptor value, or per-org endpoint
    // origin). oboResourceKey is intentionally left unset so the runtime token
    // store classifies by audience — routing the ARM / Azure SQL / Power BI
    // audiences to their existing login-cached sibling stores, others to the
    // generalized per-(user,resource) store (mcp-obo-token-store).
    config.oboResource = resolveOboResource(entry, eff.endpoint) || undefined;
    config.oboScopes = entry.oboScopes ? [...entry.oboScopes] : undefined;
  } else if (entry.auth === 'key-vault' && eff.secretName) {
    // Store the Key Vault secret NAME (admin override or env-named), never the PAT.
    config.authValue = eff.secretName;
  }

  try {
    // Idempotent: update the existing row in place if already registered.
    const existing = await findRegistered(tenantId, entry.id);
    const doc = await saveMcpServer(tenantId, existing?.serverId, who, config);

    // Real connectivity probe (no-vaporware) under the real credential. Never
    // throws — a 401/403 (consent/scope/tenant-setting still missing) is surfaced
    // honestly on the row rather than failing the registration.
    const probe = await probeEntry(entry, tenantId, tenantId, doc, eff);
    if (typeof probe.toolCount === 'number') {
      doc.lastTestResult = { at: new Date().toISOString(), toolCount: probe.toolCount as number };
    } else if (typeof probe.error === 'string') {
      doc.lastTestResult = { at: new Date().toISOString(), toolCount: 0, error: probe.error as string };
    }

    // Audit (best-effort).
    try {
      const audit = await auditLogContainer();
      await audit.items
        .create({
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemId: `mcp-server:${doc.serverId}`,
          tenantId,
          who,
          at: doc.updatedAt,
          kind: existing ? 'mcp-server.update' : 'mcp-server.connect-ms-remote',
          name: doc.name,
          source: 'remote-builtin',
          catalogId: entry.id,
        })
        .catch(() => {});
    } catch {
      /* audit is best-effort */
    }

    return NextResponse.json({ ok: true, configured: true, server: doc, probe });
  } catch (e: any) {
    return apiServerError(e);
  }
}
