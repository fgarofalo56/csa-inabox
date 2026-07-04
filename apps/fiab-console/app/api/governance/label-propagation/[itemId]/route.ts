/**
 * GET /api/governance/label-propagation/[itemId]
 *
 * Per-item sensitivity-label propagation record (F15/F17). Computes the live
 * propagation status for ONE item over the caller's tenant lineage graph and
 * merges the last-run timestamp persisted by the label-propagation Function.
 *
 * Used by the semantic-model editor's "Sensitivity (inherited from upstream)"
 * read-only field (F17) and by any editor that wants to show the inherited
 * label + its upstream provenance without rendering the whole lineage canvas.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer, labelPropagationContainer } from '@/lib/azure/cosmos-client';
import { computePropagation } from '@/lib/governance/label-propagation';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REFERENCE_KEYS = [
  'lakehouseId', 'warehouseId', 'datasetId', 'datasourceId',
  'sourceItemId', 'targetItemId', 'sourceLakehouseId', 'sourceWarehouseId',
  'reportId', 'modelId', 'kqlDatabaseId', 'pipelineId',
];

export async function GET(_req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { itemId } = await params;
  if (!itemId) return NextResponse.json({ ok: false, error: 'itemId required' }, { status: 400 });

  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();
    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: s.claims.oid }],
    }, { partitionKey: s.claims.oid }).fetchAll();
    const wsIds = workspaces.map((w: any) => w.id);
    if (!wsIds.length) return NextResponse.json({ ok: true, found: false });

    const { resources: items } = await itC.items.query({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
      parameters: [{ name: '@w', value: wsIds }],
    }).fetchAll();

    const nameById = new Map<string, string>(items.map((i: any) => [i.id, i.displayName]));
    const nodeIds = new Set(items.map((i: any) => i.id));

    // Build edges identical to the lineage builder.
    const edges: Array<{ from: string; to: string }> = [];
    for (const it of items as any[]) {
      const st = (it.state || {}) as Record<string, unknown>;
      for (const k of REFERENCE_KEYS) {
        const v = st[k];
        if (typeof v === 'string' && v && nodeIds.has(v) && v !== it.id) edges.push({ from: v, to: it.id });
      }
      const attached = st.attachedSources as Array<{ id?: string }> | undefined;
      if (Array.isArray(attached)) for (const a of attached) if (a?.id && nodeIds.has(a.id) && a.id !== it.id) edges.push({ from: a.id, to: it.id });
    }

    const records = computePropagation(
      items.map((i: any) => ({ id: i.id, sensitivity: i.state?.sensitivityLabel })),
      edges,
    );
    const rec = records.find((r) => r.itemId === itemId);
    if (!rec) return NextResponse.json({ ok: true, found: false });

    // Last-run provenance from the Function's persisted state.
    let lastRunAt: string | null = null;
    try {
      const propC = await labelPropagationContainer();
      const { resource } = await propC.item(`prop:${itemId}`, s.claims.oid).read<{ runAt?: string }>();
      lastRunAt = resource?.runAt || null;
    } catch { /* no stored row yet — live status still returned */ }

    return NextResponse.json({
      ok: true,
      found: true,
      itemId,
      status: rec.status,
      currentLabel: rec.currentLabel,
      expectedLabel: rec.expectedLabel,
      upstream: rec.upstream.map((u) => ({ id: u.id, label: u.label, displayName: nameById.get(u.id) || u.id })),
      lastRunAt,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
