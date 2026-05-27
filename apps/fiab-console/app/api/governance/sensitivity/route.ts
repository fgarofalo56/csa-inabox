/**
 * GET /api/governance/sensitivity — distribution of sensitivity labels
 * across tenant assets, plus a list of currently labeled items.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STANDARD_LABELS = ['General', 'Internal', 'Confidential', 'Highly Confidential', 'Restricted'];

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();
    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId }).fetchAll();
    const wsIds = workspaces.map((w: any) => w.id);
    const wsName = new Map(workspaces.map((w: any) => [w.id, w.name]));
    if (!wsIds.length) return NextResponse.json({ ok: true, distribution: [], items: [], total: 0 });

    const { resources: items } = await itC.items.query({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
      parameters: [{ name: '@w', value: wsIds }],
    }).fetchAll();

    const dist = new Map<string, number>();
    const unlabeled: any[] = [];
    const labeledItems: any[] = [];
    for (const i of items) {
      const lbl = i.state?.sensitivityLabel as string | undefined;
      if (lbl) {
        dist.set(lbl, (dist.get(lbl) || 0) + 1);
        labeledItems.push({
          id: i.id, displayName: i.displayName, itemType: i.itemType,
          workspaceName: wsName.get(i.workspaceId), label: lbl,
        });
      } else {
        unlabeled.push(i);
      }
    }
    // Always include standard labels (even at zero) for full coverage view.
    const distribution = STANDARD_LABELS.map((label) => ({
      label, count: dist.get(label) || 0,
    }));
    // Append any non-standard label we found.
    for (const [k, c] of dist.entries()) {
      if (!STANDARD_LABELS.includes(k)) distribution.push({ label: k, count: c });
    }

    return NextResponse.json({
      ok: true,
      total: items.length,
      labeled: labeledItems.length,
      unlabeled: unlabeled.length,
      distribution,
      items: labeledItems,
      source: 'cosmos',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
