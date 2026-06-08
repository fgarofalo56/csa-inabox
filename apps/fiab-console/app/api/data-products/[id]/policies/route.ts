/**
 * GET /api/data-products/[id]/policies — permitted access purposes for a
 * data product, resolved across tenants for the consumer "Request access" flow.
 *
 * The owner defined these as `Access`-kind governance policies scoped to
 * `data-product:<id>`, stored in the `tenant-settings` container under
 * `policies:<ownerOid>`. A consumer (different oid) cannot see them via
 * GET /api/governance/policies (which scopes to the caller's own oid), so this
 * BFF route resolves the owning workspace's tenantId and returns the owner's
 * Access policies scoped to THIS product. The dialog populates its "Permitted
 * purpose" dropdown from this (no freeform input).
 *
 * Cosmos-only — no Fabric/Purview dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  itemsContainer,
  workspacesContainer,
  tenantSettingsContainer,
} from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface PermittedPurpose {
  id: string;
  name: string;
  rule?: string;
}

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    // 1. Load the data product to get its workspaceId.
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<Pick<WorkspaceItem, 'workspaceId'>>({
        query: 'SELECT c.workspaceId FROM c WHERE c.id = @id AND c.itemType = @t',
        parameters: [
          { name: '@id', value: id },
          { name: '@t', value: 'data-product' },
        ],
      })
      .fetchAll();
    if (!resources[0]) return NextResponse.json({ ok: false, error: 'Data product not found' }, { status: 404 });

    // 2. Resolve the owning workspace's tenantId (cross-partition by id; PK = /tenantId).
    const ws = await workspacesContainer();
    const { resources: wsRes } = await ws.items
      .query<{ tenantId: string }>({
        query: 'SELECT c.tenantId FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: resources[0].workspaceId }],
      })
      .fetchAll();
    const ownerTenantId = wsRes[0]?.tenantId;
    if (!ownerTenantId) return NextResponse.json({ ok: true, policies: [] });

    // 3. Load the owner's policies doc from tenant-settings.
    const ts = await tenantSettingsContainer();
    let policiesDoc: any;
    try {
      const { resource } = await ts.item(`policies:${ownerTenantId}`, ownerTenantId).read();
      policiesDoc = resource;
    } catch (e: any) {
      if (e?.code === 404) return NextResponse.json({ ok: true, policies: [] });
      throw e;
    }

    const all: any[] = Array.isArray(policiesDoc?.items) ? policiesDoc.items : [];
    const scopeKey = `data-product:${id}`;
    const policies: PermittedPurpose[] = all
      .filter((p: any) => p?.kind === 'Access' && p?.scope === scopeKey && p?.enabled !== false)
      .map((p: any) => ({ id: String(p.id), name: String(p.name), rule: p.rule }));

    return NextResponse.json({ ok: true, policies });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
