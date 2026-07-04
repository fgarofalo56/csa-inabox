import { redirect } from 'next/navigation';

/**
 * /workloads — folded into the Workload hub.
 *
 * /workload-hub is the canonical Fabric-parity workload navigator (My
 * workloads / More workloads, real catalog-derived counts, per-workload
 * landing pages). The old /workloads listing already routed into
 * /workload-hub/[key], so it was a redundant second entry point. This page
 * preserves old bookmarks / links by bouncing to the hub.
 */
export default function WorkloadsRedirect() {
  redirect('/workload-hub');
}
