/**
 * GET /api/admin/domains/[id]/inventory
 *
 * Per-domain resource inventory: the live Azure resources tagged
 * `loom-domain:<id>` (the chargeback tag dlz-attach stamps), discovered via
 * Azure Resource Graph. Real ARG REST — no mocks (no-vaporware.md).
 *
 * The domain's bound subscription(s) scope the ARG search. When the domain has
 * no subscription bound yet (status `registered`), the inventory is empty and
 * the response says so. When the Console UAMI lacks Reader on the domain's
 * subscription, the route returns an honest gate naming the exact
 * `az role assignment create` grant.
 *
 * Sovereign-correct via cloud-endpoints (armBase/armScope) — works on
 * Commercial, GCC, and the USGov boundaries with no code change.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOrSeedDomains } from '@/lib/azure/domain-registry';
import { domainResourceInventory, InventoryError } from '@/lib/azure/topology-inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: 'domain id required' }, { status: 400 });

  try {
    const doc = await loadOrSeedDomains(tenantId, s.claims.upn || tenantId);
    const domain = doc.items.find((d) => d.id === id);
    if (!domain) return NextResponse.json({ ok: false, error: 'domain not found' }, { status: 404 });

    const subs = domain.subscriptionIds || [];
    if (subs.length === 0) {
      return NextResponse.json({
        ok: true,
        domainId: id,
        bound: false,
        subscriptionIds: [],
        resources: [],
        hint:
          'No Data Landing Zone is attached to this domain yet. Attach a subscription (Actions → Attach existing subscription) or run dlz-attach; resources tagged loom-domain:' +
          id +
          ' will then appear here.',
      });
    }

    try {
      const resources = await domainResourceInventory(id, subs);
      return NextResponse.json({
        ok: true,
        domainId: id,
        bound: true,
        subscriptionIds: subs,
        count: resources.length,
        resources,
      });
    } catch (e) {
      if (e instanceof InventoryError && (e.status === 403 || e.status === 401)) {
        return NextResponse.json(
          {
            ok: false,
            error: 'forbidden',
            domainId: id,
            subscriptionIds: subs,
            remediation:
              'The Console identity lacks Reader on this domain\'s subscription, so Azure Resource Graph returned no inventory. Grant it with: ' +
              subs
                .map(
                  (sub) =>
                    `az role assignment create --assignee <console-uami-objectId> --role Reader --scope /subscriptions/${sub}`,
                )
                .join(' ; '),
          },
          { status: 403 },
        );
      }
      throw e;
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
