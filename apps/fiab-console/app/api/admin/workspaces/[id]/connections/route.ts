/**
 * F16 Azure Connections — workspace-scoped ADLS Gen2 + Log Analytics bindings.
 *
 *   GET  /api/admin/workspaces/{id}/connections
 *        → { ok, connections: AzureConnection[] }
 *   POST /api/admin/workspaces/{id}/connections
 *        body { kind: 'adls-gen2' | 'log-analytics',
 *               storageAccountId?, containerName?, lawResourceId?, name? }
 *        → { ok, connection, roleGate? }
 *
 * Auth: minted session cookie (getSession). The caller's oid is the tenantId
 * recorded on each connection. The connect functions verify the Console UAMI
 * holds the required Contributor role and probe the real data plane before
 * recording 'connected'; a missing role is saved as 'role-missing' with a
 * roleGate so the pane renders an honest Fluent MessageBar (no Fabric needed).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAzureConnections,
  connectAdls,
  connectLogAnalytics,
  AzureConnectionError,
} from '@/lib/clients/azure-connections-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await props.params;
  try {
    const connections = await listAzureConnections(id);
    return NextResponse.json({ ok: true, connections });
  } catch (e: any) {
    const status = e instanceof AzureConnectionError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await props.params;
  const tenantId = s.claims.oid;
  const connectedBy = s.claims.name || s.claims.upn || s.claims.oid;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const kind = body?.kind;
  try {
    if (kind === 'adls-gen2') {
      if (!body?.storageAccountId) {
        return NextResponse.json({ ok: false, error: 'storageAccountId is required' }, { status: 400 });
      }
      const connection = await connectAdls(id, tenantId, {
        storageAccountId: String(body.storageAccountId),
        containerName: body.containerName ? String(body.containerName) : undefined,
        name: body.name ? String(body.name) : undefined,
        connectedBy,
      });
      return NextResponse.json({ ok: true, connection, roleGate: connection.roleGate });
    }
    if (kind === 'log-analytics') {
      if (!body?.lawResourceId) {
        return NextResponse.json({ ok: false, error: 'lawResourceId is required' }, { status: 400 });
      }
      const connection = await connectLogAnalytics(id, tenantId, {
        lawResourceId: String(body.lawResourceId),
        name: body.name ? String(body.name) : undefined,
        connectedBy,
      });
      return NextResponse.json({ ok: true, connection, roleGate: connection.roleGate });
    }
    return NextResponse.json({ ok: false, error: "kind must be 'adls-gen2' or 'log-analytics'" }, { status: 400 });
  } catch (e: any) {
    const status = e instanceof AzureConnectionError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
