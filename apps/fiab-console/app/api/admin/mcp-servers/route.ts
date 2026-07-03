/**
 * GET  /api/admin/mcp-servers — list all MCP servers for the tenant
 *   → { ok, servers: McpServerConfigDoc[] }
 * POST /api/admin/mcp-servers — create a new MCP server
 *   → { ok, server: McpServerConfigDoc }
 * PUT  /api/admin/mcp-servers?id=<id> — update an MCP server
 *   → { ok, server: McpServerConfigDoc }
 * DELETE /api/admin/mcp-servers?id=<id> — delete an MCP server
 *   → { ok }
 *
 * All operations persist to the `mcp-servers` Cosmos container.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { listMcpServers, getMcpServer, saveMcpServer, deleteMcpServer, updateMcpServerTestResult } from '@/lib/azure/mcp-config-store';
import { listMcpTools } from '@/lib/azure/mcp-client';
import type { McpServerConfig, McpServerConfigDoc } from '@/lib/types/mcp-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



/** Public (no-secret) view of an MCP server doc — mirrors git-binding-store's
 * toView(): the raw bearer / API secret in `authValue` (authMethod 'header') is
 * NEVER returned to the browser. Callers get `hasAuthValue: boolean` instead.
 * `secretRefs` already holds only Key Vault secret NAMES (never values) so it
 * passes through untouched. Applied to every response body that carries a doc. */
type McpServerConfigView = Omit<McpServerConfigDoc, 'authValue'> & { hasAuthValue: boolean };
function toView(doc: McpServerConfigDoc): McpServerConfigView {
  const { authValue, ...rest } = doc;
  return { ...rest, hasAuthValue: !!authValue };
}

/** Whitelist of persistable string/bool keys. */
const KEYS: (keyof McpServerConfig)[] = ['name', 'endpoint', 'authMethod', 'authValue', 'description', 'enabled', 'catalogId'];

/** Copy a plain Record<string,string> (drops non-string members). */
function strMap(v: any): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitize(input: any): McpServerConfig {
  const out: McpServerConfig = {
    name: '',
    endpoint: '',
    authMethod: 'header',
    enabled: true,
  };
  for (const k of KEYS) {
    const v = input?.[k];
    if (k === 'enabled' && typeof v === 'boolean') {
      out.enabled = v;
    } else if (typeof v === 'string') {
      const t = v.trim();
      if (k === 'authMethod' && (t === 'header' || t === 'key-vault')) {
        (out as any)[k] = t;
      } else if (k !== 'authMethod') {
        (out as any)[k] = t === '' ? undefined : t;
      }
    }
  }
  // Catalog-deploy metadata (non-secret values + KV secret NAMES only — never
  // secret values). Passed through verbatim when present.
  const cv = strMap(input?.configValues);
  if (cv) out.configValues = cv;
  const sr = strMap(input?.secretRefs);
  if (sr) out.secretRefs = sr;
  if (!out.name || !out.endpoint) {
    throw new Error('name and endpoint are required');
  }
  try {
    new URL(out.endpoint);
  } catch {
    throw new Error('endpoint must be a valid HTTPS URL');
  }
  return out;
}

/**
 * Best-effort connectivity probe on save: run the real MCP handshake
 * (initialize → tools/list) and persist the result as `lastTestResult` so the
 * registered-servers table shows live tool counts + a "Tested" badge without a
 * separate manual click. Never throws — a server that's enabled but momentarily
 * unreachable is still registered; the persisted error explains why on the row.
 */
async function probeAndPersist(tenantId: string, doc: McpServerConfigDoc): Promise<McpServerConfigDoc> {
  if (!doc.enabled) return doc;
  try {
    const tools = await listMcpTools(doc.endpoint, doc.authMethod, doc.authValue, 5000);
    await updateMcpServerTestResult(tenantId, doc.serverId, { toolCount: tools.length });
    return { ...doc, lastTestResult: { at: new Date().toISOString(), toolCount: tools.length } };
  } catch (e: any) {
    const error = e?.message || String(e);
    await updateMcpServerTestResult(tenantId, doc.serverId, { error });
    return { ...doc, lastTestResult: { at: new Date().toISOString(), toolCount: 0, error } };
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  try {
    const servers = await listMcpServers(tenantId);
    // Fetch full docs with timestamps
    const c = await (await import('@/lib/azure/cosmos-client')).mcpServersContainer();
    const q = {
      query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.enabled = true ORDER BY c.name',
      parameters: [{ name: '@t', value: tenantId }],
    };
    const { resources } = await c.items.query<McpServerConfigDoc>(q).fetchAll();
    return NextResponse.json({ ok: true, servers: (resources || []).map(toView) });
  } catch (e: any) {
    return apiError(e?.message || String(e), 500);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const body = await req.json().catch(() => ({}));
  try {
    const config = sanitize(body.config);
    const saved = await saveMcpServer(tenantId, undefined, who, config);
    const doc = await probeAndPersist(tenantId, saved);
    // Audit
    try {
      const audit = await auditLogContainer();
      await audit.items.create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `mcp-server:${doc.serverId}`,
        tenantId,
        who,
        at: doc.createdAt,
        kind: 'mcp-server.create',
        name: config.name,
      }).catch(() => {});
    } catch { /* audit is best-effort */ }
    return NextResponse.json({ ok: true, server: toView(doc) });
  } catch (e: any) {
    return apiError(e?.message || String(e), 400);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const url = new URL(req.url);
  const serverId = url.searchParams.get('id') || url.pathname.split('/').pop();
  if (!serverId) return apiError('id required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const existing = await getMcpServer(tenantId, serverId);
    if (!existing) return apiError('not found', 404);
    const config = sanitize(body.config);
    // Carry forward catalog-deploy metadata when the edit (e.g. the manual form)
    // doesn't include it — so editing a deployed server never orphans its KV
    // secret references or catalog linkage.
    if (config.catalogId === undefined && existing.catalogId) config.catalogId = existing.catalogId;
    if (config.configValues === undefined && existing.configValues) config.configValues = existing.configValues;
    if (config.secretRefs === undefined && existing.secretRefs) config.secretRefs = existing.secretRefs;
    const saved = await saveMcpServer(tenantId, serverId, who, config);
    const doc = await probeAndPersist(tenantId, saved);
    // Audit
    try {
      const changed = (KEYS as string[]).filter((k) => (existing as any)[k] !== (config as any)[k]);
      if (changed.length > 0) {
        const audit = await auditLogContainer();
        await audit.items.create({
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemId: `mcp-server:${serverId}`,
          tenantId,
          who,
          at: doc.updatedAt,
          kind: 'mcp-server.update',
          changedKeys: changed,
        }).catch(() => {});
      }
    } catch { /* audit is best-effort */ }
    return NextResponse.json({ ok: true, server: toView(doc) });
  } catch (e: any) {
    return apiError(e?.message || String(e), 400);
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const url = new URL(req.url);
  const serverId = url.searchParams.get('id') || url.pathname.split('/').pop();
  if (!serverId) return apiError('id required', 400);
  try {
    const existing = await getMcpServer(tenantId, serverId);
    if (!existing) return apiError('not found', 404);
    await deleteMcpServer(tenantId, serverId);
    // Audit
    try {
      const audit = await auditLogContainer();
      await audit.items.create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `mcp-server:${serverId}`,
        tenantId,
        who,
        at: new Date().toISOString(),
        kind: 'mcp-server.delete',
        name: existing.name,
      }).catch(() => {});
    } catch { /* audit is best-effort */ }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return apiError(e?.message || String(e), 500);
  }
}
