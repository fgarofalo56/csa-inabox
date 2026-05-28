/**
 * Event Schema Set list + create.
 *
 * Backed by Cosmos `event-schemas` partition under each item. No external
 * registry call today — Loom's eventstream wires use the Cosmos-stored
 * schemas to validate payloads, so the editor IS the source of truth.
 *
 * If a tenant later attaches an external registry (Confluent Schema
 * Registry, Apicurio), the editor MessageBar in the Versions tab links to
 * docs/fiab/event-schema-registry.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const { resources } = await items.items.query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'event-schema-set' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId,
      schemaSets: resources.map(r => ({
        id: r.id, displayName: r.displayName, description: r.description,
        subjectCount: ((r.state as any)?.subjects || []).length,
        compatibility: (r.state as any)?.compatibility || 'BACKWARD',
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      })),
    });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return err('displayName required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const now = new Date().toISOString();
    const item: WorkspaceItem = {
      id: crypto.randomUUID(), workspaceId, itemType: 'event-schema-set',
      displayName, description: body?.description,
      state: {
        subjects: Array.isArray(body?.subjects) ? body.subjects : [],
        compatibility: body?.compatibility || 'BACKWARD',
        format: body?.format || 'AVRO',
      },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now, updatedAt: now,
    };
    const { resource } = await items.items.create(item);
    return NextResponse.json({ ok: true, schemaSet: resource });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}
