/**
 * Remote built-in MCP — inline config (per-tenant overrides).
 *
 *   GET  /api/admin/mcp-servers/ms-remote/config
 *     → { ok:true, overrides:{ [catalogId]: { enabled?, endpoint?, secretName? } } }
 *       The raw persisted admin overrides for this tenant (the ms-remote status
 *       route returns the merged/effective view; this is what the form pre-fills).
 *
 *   PUT  /api/admin/mcp-servers/ms-remote/config   (tenant-admin gated)
 *     Body: { id, enabled?, endpoint?, secretName? }
 *     → { ok:true, id, override, effective }
 *       Merges the typed patch into the named server's override and persists it to
 *       Cosmos (lib/azure/mcp-remote-config-store). This is what lets a tenant
 *       admin ENABLE + CONFIGURE an opt-in remote built-in MCP server INLINE — the
 *       enable toggle, the endpoint (for the not-yet-GA servers), and the GitHub
 *       Key Vault secret NAME — driven by the descriptor's declared shape, NOT a
 *       freeform JSON box (loom-no-freeform-config). Clearing every field REMOVES
 *       the override (the server reverts to pure deployment-env behaviour).
 *
 * RULE COMPLIANCE
 *  - no-vaporware: writes to the REAL Cosmos store; the returned `effective` is the
 *    merged env+override state the runtime keys off. Only NON-secret values are
 *    stored — the enable flag, the endpoint, and the Key Vault secret NAME (never a
 *    PAT / token value). The endpoint is SSRF-checked before it is persisted.
 *  - no-fabric-dependency: an override can only ADD capability the deployment env
 *    left off; a deployment env force-on always wins (surfaced as envForced). This
 *    never wires a Fabric/Power BI host onto a default path.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { assertMcpEgressAllowed } from '@/lib/azure/mcp-egress-guard';
import {
  getRemoteBuiltinOverrides,
  setRemoteBuiltinOverride,
  effectiveRemoteStateForTenant,
} from '@/lib/azure/mcp-remote-config-store';
import { msRemoteMcp, type RemoteBuiltinOverride } from '@/lib/mcp/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const overrides = await getRemoteBuiltinOverrides(session.claims.oid);
    return apiOk({ overrides });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const denied = requireTenantAdmin(session);
  if (denied) return denied;

  const tenantId = session.claims.oid;
  const who = session.claims.upn || session.claims.email || tenantId;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const entry = id ? msRemoteMcp(id) : undefined;
  if (!entry) {
    return apiError(`unknown remote MCP server: ${id || '(missing id)'}`, 400);
  }

  // Typed patch (no freeform JSON): only the three declared, non-secret fields.
  const patch: RemoteBuiltinOverride = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.endpoint === 'string') patch.endpoint = body.endpoint.trim();
  if (typeof body.secretName === 'string') patch.secretName = body.secretName.trim();

  // Reject fields the server does not accept — honest, not silently dropped.
  if (patch.endpoint && !entry.endpointEnv) {
    return apiError(`${entry.name} does not accept an endpoint override.`, 400);
  }
  if (patch.secretName !== undefined && entry.auth !== 'key-vault') {
    return apiError(`${entry.name} does not use a Key Vault secret (auth is ${entry.auth}).`, 400);
  }

  // SSRF-check a non-empty endpoint BEFORE it can be persisted (the runtime shim
  // + probe fetch it server-side). An empty endpoint clears the override field.
  if (patch.endpoint) {
    try {
      await assertMcpEgressAllowed(patch.endpoint);
    } catch (e: any) {
      return apiError(e?.message || 'endpoint not allowed', 400);
    }
  }

  try {
    const override = await setRemoteBuiltinOverride(tenantId, who, id, patch);
    const effective = await effectiveRemoteStateForTenant(tenantId, id);
    // Audit (best-effort) — record the enable/config change, never a secret value.
    try {
      const audit = await auditLogContainer();
      await audit.items
        .create({
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemId: `mcp-remote-config:${id}`,
          tenantId,
          who,
          at: new Date().toISOString(),
          kind: 'mcp-server.remote-config',
          catalogId: id,
          enabled: override?.enabled,
          hasEndpoint: !!override?.endpoint,
          hasSecretName: !!override?.secretName,
        })
        .catch(() => {});
    } catch {
      /* audit is best-effort */
    }
    return apiOk({ id, override: override ?? null, effective });
  } catch (e: any) {
    return apiError(e?.message || String(e), 400);
  }
}
