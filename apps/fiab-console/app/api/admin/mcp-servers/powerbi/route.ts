/**
 * Power BI remote MCP — connect / status / register endpoint.
 *
 *   GET  /api/admin/mcp-servers/powerbi
 *     → when LOOM_POWERBI_MCP_CLIENT_ID is set (opted in):
 *         { ok, configured:true, endpoint, clientId, transport, auth, resource,
 *           delegatedScopes, scopeUris, tenantSetting, entraAppRegDoc,
 *           tenantSettingDoc, preview, optIn, registered?, tokenReady, … }
 *     → when it is UNSET (the day-one default):
 *         { ok:true, configured:false, gate:{ message, envVar, endpointEnv,
 *           tenantSetting, delegatedScopes, entraAppRegDoc, tenantSettingDoc } }
 *       — an HONEST Fluent-MessageBar gate the panel renders, mirroring
 *         builtin/route.ts + bridge/route.ts exactly (no fabricated "connected").
 *     → with ?probe=1 (and configured + a cached per-user token): additionally
 *         performs a REAL Streamable-HTTP initialize→tools/list against the PBI
 *         MCP endpoint under the user's OBO token (no mock) and returns the live
 *         tool count / error.
 *
 *   POST /api/admin/mcp-servers/powerbi  (tenant-admin gated: admin.deploy-mcp)
 *     Registers the remote Power BI MCP as an McpServerConfig row
 *     (authMethod 'entra-obo', source 'remote-builtin', oboResource + oboScopes
 *     from REMOTE_BUILTIN_MCP) via saveMcpServer, so it flows through
 *     buildMcpShim untouched and its tools surface as mcp_powerbiremote_*.
 *     Idempotent: re-registering updates the existing row in place. NEVER accepts
 *     or stores a secret — the OBO path carries a per-user token minted at login
 *     and cached in the Cosmos pbi-user-token-store, never on this doc.
 *
 * RULE COMPLIANCE
 *  - no-fabric-dependency: this is the SOLE Power BI / Fabric host touched here
 *    and it is STRICTLY OPT-IN. Nothing is registered or called unless
 *    isPbiMcpConfigured() (LOOM_POWERBI_MCP_CLIENT_ID set). Loom's Azure-native
 *    semantic-model / report authoring stays the day-one DEFAULT.
 *  - no-vaporware: when configured, the optional probe + the runtime make a REAL
 *    JSON-RPC Streamable-HTTP call to the PBI endpoint with the user's OBO bearer
 *    + the real delegated scopes; when unconfigured, the response is an honest
 *    gate naming the exact env var + the Power BI tenant setting + the Entra app
 *    registration — never a silent failure, never a default-path Fabric call.
 *  - secrets: the entra-obo path has NO static secret to store; the per-user
 *    token never lands on the McpServerConfig doc (resolved at call time).
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
import { REMOTE_BUILTIN_MCP, isPbiMcpConfigured, pbiMcpScopeUris } from '@/lib/mcp/catalog';
import { getPbiUserToken } from '@/lib/azure/pbi-user-token-store';
import type { McpServerConfig, McpServerConfigDoc } from '@/lib/types/mcp-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Microsoft Learn references named in the honest gate (stable doc URLs). */
const ENTRA_APP_REG_DOC = 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app';
const TENANT_SETTING_DOC = 'https://learn.microsoft.com/power-bi/admin/service-admin-portal-about-tenant-settings';

/**
 * The honest opt-in config gate (shared by GET + POST). Names the exact env var,
 * the Power BI admin tenant setting, the Entra app registration, and the
 * delegated scopes required — per no-vaporware. The PBI-admin tenant setting is a
 * runtime grant that can't be probed from here, so it is surfaced as copy rather
 * than asserted; the first real Streamable-HTTP call reports a 403 if it is off.
 */
function pbiGate() {
  return {
    message:
      'The Power BI remote MCP server is OPT-IN and not configured in this deployment. ' +
      `Set ${REMOTE_BUILTIN_MCP.clientIdEnv} on the console to an Entra app (client) id whose ` +
      'registration requests the three delegated Power BI scopes ' +
      `(${REMOTE_BUILTIN_MCP.delegatedScopes.join(', ')}) on resource ${REMOTE_BUILTIN_MCP.resource}, ` +
      `and have a Power BI admin enable the tenant setting "${REMOTE_BUILTIN_MCP.tenantSetting}". ` +
      `Optionally override the endpoint with ${REMOTE_BUILTIN_MCP.endpointEnv} (default ${REMOTE_BUILTIN_MCP.defaultEndpoint}). ` +
      "Until then, Loom's Azure-native semantic-model + report authoring path is the default and fully functional.",
    envVar: REMOTE_BUILTIN_MCP.clientIdEnv,
    endpointEnv: REMOTE_BUILTIN_MCP.endpointEnv,
    tenantSetting: REMOTE_BUILTIN_MCP.tenantSetting,
    delegatedScopes: [...REMOTE_BUILTIN_MCP.delegatedScopes],
    resource: REMOTE_BUILTIN_MCP.resource,
    entraAppRegDoc: ENTRA_APP_REG_DOC,
    tenantSettingDoc: TENANT_SETTING_DOC,
  };
}

/** Find the already-registered remote-builtin PBI MCP row for this tenant (full
 *  doc incl. serverId), or null. Lets GET report Connected/serverId and POST
 *  update-in-place rather than creating duplicates. */
async function findRegistered(tenantId: string): Promise<McpServerConfigDoc | null> {
  try {
    const c = await mcpServersContainer();
    const { resources } = await c.items
      .query<McpServerConfigDoc>({
        query:
          "SELECT * FROM c WHERE c.tenantId = @t AND c.source = 'remote-builtin' AND c.catalogId = @cid",
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@cid', value: REMOTE_BUILTIN_MCP.id },
        ],
      })
      .fetchAll();
    return resources?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Opt-in gate (no-fabric-dependency): nothing Power BI exists until the env var
  // is set. Mirrors builtin/bridge GET — 200 + configured:false + honest gate.
  if (!isPbiMcpConfigured()) {
    return NextResponse.json({ ok: true, configured: false, gate: pbiGate() });
  }

  const tenantId = session.claims.oid;
  const registered = await findRegistered(tenantId);
  // Per-user OBO token readiness (captured at login when scopes were consented).
  const userToken = await getPbiUserToken(tenantId);
  const tokenReady = !!userToken;

  const base = {
    ok: true as const,
    configured: true as const,
    id: REMOTE_BUILTIN_MCP.id,
    name: REMOTE_BUILTIN_MCP.name,
    category: REMOTE_BUILTIN_MCP.category,
    endpoint: REMOTE_BUILTIN_MCP.endpoint,
    transport: REMOTE_BUILTIN_MCP.transport,
    auth: REMOTE_BUILTIN_MCP.auth,
    resource: REMOTE_BUILTIN_MCP.resource,
    // Client ids are public (non-secret) — safe to echo so the panel can confirm it.
    clientId: (process.env[REMOTE_BUILTIN_MCP.clientIdEnv] || '').trim(),
    delegatedScopes: [...REMOTE_BUILTIN_MCP.delegatedScopes],
    scopeUris: pbiMcpScopeUris(),
    tenantSetting: REMOTE_BUILTIN_MCP.tenantSetting,
    entraAppRegDoc: ENTRA_APP_REG_DOC,
    tenantSettingDoc: TENANT_SETTING_DOC,
    preview: REMOTE_BUILTIN_MCP.preview,
    optIn: REMOTE_BUILTIN_MCP.optIn,
    registered: !!registered,
    serverId: registered?.serverId,
    enabled: registered?.enabled,
    lastTestResult: registered?.lastTestResult,
    tokenReady,
    // Honest note when the user hasn't consented the PBI scopes yet — the OBO
    // token cache is empty so calls would 401; the panel shows this, not a fake OK.
    tokenNote: tokenReady
      ? undefined
      : 'Sign in again and consent the Power BI scopes to enable per-user access; ' +
        'no Power BI access token is cached for your account yet.',
  };

  // Real connectivity probe (no-vaporware) — opt-in via ?probe=1 so the status
  // panel never hangs on load. Requires a cached user token; runs the actual
  // initialize → tools/list handshake under the user's OBO bearer.
  if (req.nextUrl.searchParams.get('probe') === '1') {
    if (!userToken) {
      return NextResponse.json({ ...base, probe: { reachable: false, skipped: true, reason: base.tokenNote } });
    }
    try {
      const tools = await listMcpTools(REMOTE_BUILTIN_MCP.endpoint, 'entra-obo', undefined, 8000, userToken);
      if (registered) {
        await updateMcpServerTestResult(tenantId, registered.serverId, { toolCount: tools.length }).catch(() => {});
      }
      return NextResponse.json({
        ...base,
        probe: { reachable: true, toolCount: tools.length, tools: tools.map((t) => t.name) },
      });
    } catch (e: any) {
      const error = e?.message || String(e);
      if (registered) {
        await updateMcpServerTestResult(tenantId, registered.serverId, { error }).catch(() => {});
      }
      return NextResponse.json({ ...base, probe: { reachable: false, error } });
    }
  }

  return NextResponse.json(base);
}

export async function POST(_req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Tenant-admin gated — same capability as deploying a catalog MCP server.
  const denied = await enforceCapability(session, 'admin.deploy-mcp', 'Admin');
  if (denied) return denied;

  // Opt-in gate (no-fabric-dependency): refuse to register a Fabric/Power BI host
  // unless explicitly opted in. Honest gate, never a silent or fake success.
  if (!isPbiMcpConfigured()) {
    return NextResponse.json({ ok: false, configured: false, gate: pbiGate() }, { status: 409 });
  }

  const tenantId = session.claims.oid;
  const who = session.claims.upn || session.claims.email || tenantId;

  // Build the McpServerConfig row straight from the catalog descriptor. No secret
  // is accepted or stored — entra-obo mints a per-user token at call time.
  const config: McpServerConfig = {
    name: REMOTE_BUILTIN_MCP.name,
    endpoint: REMOTE_BUILTIN_MCP.endpoint,
    authMethod: 'entra-obo',
    oboResource: REMOTE_BUILTIN_MCP.resource,
    oboScopes: [...REMOTE_BUILTIN_MCP.delegatedScopes],
    description:
      'Opt-in remote Power BI Model Context Protocol server (preview). Schema-aware query of ' +
      'semantic models + Copilot-powered DAX generation, read-only under the signed-in user\'s ' +
      'Power BI RBAC via Microsoft Entra On-Behalf-Of. Azure-native authoring stays the default.',
    enabled: true,
    source: 'remote-builtin',
    catalogId: REMOTE_BUILTIN_MCP.id,
  };

  try {
    // Idempotent: update the existing row in place if already registered.
    const existing = await findRegistered(tenantId);
    const doc = await saveMcpServer(tenantId, existing?.serverId, who, config);

    // Real connectivity probe (no-vaporware) when the user has a cached PBI token:
    // run the actual Streamable-HTTP handshake under their OBO bearer and persist
    // the result. Never throws — a 403 (tenant setting still off) is surfaced
    // honestly on the row rather than failing the registration.
    let probe: Record<string, unknown> = {};
    const userToken = await getPbiUserToken(tenantId);
    if (userToken) {
      try {
        const tools = await listMcpTools(REMOTE_BUILTIN_MCP.endpoint, 'entra-obo', undefined, 8000, userToken);
        await updateMcpServerTestResult(tenantId, doc.serverId, { toolCount: tools.length }).catch(() => {});
        probe = { reachable: true, toolCount: tools.length, tools: tools.map((t) => t.name) };
        doc.lastTestResult = { at: new Date().toISOString(), toolCount: tools.length };
      } catch (e: any) {
        const error = e?.message || String(e);
        await updateMcpServerTestResult(tenantId, doc.serverId, { error }).catch(() => {});
        probe = { reachable: false, error };
        doc.lastTestResult = { at: new Date().toISOString(), toolCount: 0, error };
      }
    } else {
      probe = {
        reachable: false,
        skipped: true,
        reason:
          'Registered. Sign in again and consent the Power BI scopes to enable per-user access — ' +
          'no Power BI access token is cached for your account yet.',
      };
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
          kind: existing ? 'mcp-server.update' : 'mcp-server.connect-powerbi',
          name: doc.name,
          source: 'remote-builtin',
          catalogId: REMOTE_BUILTIN_MCP.id,
        })
        .catch(() => {});
    } catch {
      /* audit is best-effort */
    }

    return NextResponse.json({ ok: true, configured: true, server: doc, probe });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
