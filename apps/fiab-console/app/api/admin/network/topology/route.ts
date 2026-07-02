/**
 * GET /api/admin/network/topology
 *
 * Returns a REAL resource-graph visual of the full CSA Loom network estate —
 * every vNet + subnet, vNet↔vNet peering, private endpoint (wired to its
 * subnet + labelled with its target), NSG, Azure Firewall, Bastion, Container
 * Apps managed environment, Application Gateway, internal Load Balancer, and
 * private DNS zone the Console identity can read — as graph `nodes` + `edges`
 * the React Flow canvas on /admin/network renders directly.
 *
 * Data source: Azure Resource Graph (one POST, Reader-only) scoped to
 * LOOM_SUBSCRIPTION_ID ∪ LOOM_EXTRA_SUBSCRIPTIONS. No mocks, no `return []`.
 *
 * Honest gates (no-vaporware):
 *   • No subscription configured  → ok:false + the exact env var to set.
 *   • ARG read denied (403)       → ok:false + the exact Reader role to grant.
 * Either way the page shows a warning MessageBar, not a blank canvas.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  getNetworkTopology, topologySubscriptionScope, TopologyGraphError,
} from '@/lib/azure/network-topology-graph';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // Estate-wide network topology (Resource Graph across the deployment's subs via
  // the Console UAMI) is not per-user data — restrict to tenant admins.
  const gate = requireTenantAdmin(session);
  if (gate) return gate;

  const subscriptions = topologySubscriptionScope();
  if (!subscriptions.length) {
    return NextResponse.json({
      ok: false,
      error: 'No subscription configured for the network topology query.',
      gate: {
        reason: 'config',
        remediation:
          'Set LOOM_SUBSCRIPTION_ID (and optionally LOOM_EXTRA_SUBSCRIPTIONS, comma-separated) on the ' +
          'Console container app so the topology can enumerate the network estate via Azure Resource Graph.',
      },
    }, { status: 200 });
  }

  try {
    const graph = await getNetworkTopology();
    return NextResponse.json({
      ok: true,
      ...graph,
    });
  } catch (e: any) {
    const status = e instanceof TopologyGraphError ? e.status : 502;
    const denied = status === 401 || status === 403;
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      gate: {
        reason: denied ? 'rbac' : 'error',
        remediation: denied
          ? 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Reader role on the subscription(s) ' +
            `[${subscriptions.join(', ')}] so Azure Resource Graph can read the network resources ` +
            '(Microsoft.Network/* read). Then reload.'
          : 'Azure Resource Graph returned an error. Confirm the Microsoft.ResourceGraph provider is ' +
            'registered and retry; if it persists, check the Console identity and cloud endpoint config.',
      },
    }, { status: denied ? 200 : status });
  }
}
