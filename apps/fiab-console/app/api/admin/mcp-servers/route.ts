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
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { listMcpServers, getMcpServer, saveMcpServer, deleteMcpServer } from '@/lib/azure/mcp-config-store';
import type { McpServerConfig, McpServerConfigDoc } from '@/lib/types/mcp-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Whitelist of persistable keys. */
const KEYS: (keyof McpServerConfig)[] = ['name', 'endpoint', 'authMethod', 'authValue', 'description', 'enabled'];

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

export async function GET() {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
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
    return NextResponse.json({ ok: true, servers: resources || [] });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const body = await req.json().catch(() => ({}));
  try {
    const config = sanitize(body.config);
    const doc = await saveMcpServer(tenantId, undefined, who, config);
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
    return NextResponse.json({ ok: true, server: doc });
  } catch (e: any) {
    return err(e?.message || String(e), 400);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const url = new URL(req.url);
  const serverId = url.searchParams.get('id') || url.pathname.split('/').pop();
  if (!serverId) return err('id required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const existing = await getMcpServer(tenantId, serverId);
    if (!existing) return err('not found', 404);
    const config = sanitize(body.config);
    const doc = await saveMcpServer(tenantId, serverId, who, config);
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
    return NextResponse.json({ ok: true, server: doc });
  } catch (e: any) {
    return err(e?.message || String(e), 400);
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const url = new URL(req.url);
  const serverId = url.searchParams.get('id') || url.pathname.split('/').pop();
  if (!serverId) return err('id required', 400);
  try {
    const existing = await getMcpServer(tenantId, serverId);
    if (!existing) return err('not found', 404);
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
    return err(e?.message || String(e), 500);
  }
}
