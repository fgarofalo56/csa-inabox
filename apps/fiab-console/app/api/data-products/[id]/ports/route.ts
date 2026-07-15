/**
 * GET /api/data-products/[id]/ports  (DP-8)
 *
 * The structured input/output/management ports for a data product, with each
 * INPUT port that references another data product (kind 'data-product' /
 * 'output-port') RESOLVED to that upstream's contract summary (version + column
 * count) so the designer can show the dependency's shape and DP-9 can propagate
 * breaking changes. Read-only, not ownership-gated (ports are part of the
 * discoverable product surface). Azure-native Cosmos; no Fabric dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { readPorts, portsSummary, type Port } from '@/lib/dataproducts/ports';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

async function findItem(itemId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [{ name: '@id', value: itemId }, { name: '@t', value: ITEM_TYPE }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

interface ResolvedInput extends Port {
  resolved?: { productName: string; contractVersion?: string; columnCount: number } | { error: string };
}

/** Resolve an input port that points at another data product to its contract. */
async function resolveInput(port: Port): Promise<ResolvedInput> {
  if ((port.kind !== 'data-product' && port.kind !== 'output-port') || !port.ref) return { ...port };
  try {
    // The ref for an output-port is `<productId>:<portId>`; take the product id.
    const productId = port.ref.split(':')[0];
    const upstream = await findItem(productId);
    if (!upstream) return { ...port, resolved: { error: 'Upstream product not found.' } };
    const st = (upstream.state || {}) as Record<string, unknown>;
    const contract = (st.contract && typeof st.contract === 'object' ? st.contract : {}) as Record<string, unknown>;
    const schema = Array.isArray(contract.schema) ? contract.schema : [];
    return {
      ...port,
      resolved: {
        productName: upstream.displayName,
        contractVersion: typeof contract.version === 'string' ? contract.version : undefined,
        columnCount: schema.length,
      },
    };
  } catch (e: any) {
    return { ...port, resolved: { error: e?.message || String(e) } };
  }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiError('Unauthorized', 401, { code: 'unauthorized' });
  try {
    const item = await findItem(id);
    if (!item) return apiError('Data product not found', 404, { code: 'not_found' });
    const model = readPorts(item.state as Record<string, unknown>);
    const input = await Promise.all(model.input.map(resolveInput));
    return NextResponse.json({
      ok: true,
      ports: { input, output: model.output, management: model.management },
      summary: portsSummary(model),
    });
  } catch (e: any) {
    return apiError(e?.message || 'Failed to read ports', 500, { code: 'cosmos_error' });
  }
}
