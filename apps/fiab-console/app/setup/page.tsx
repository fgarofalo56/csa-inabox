import { redirect } from 'next/navigation';
import { PageShell } from '@/lib/components/page-shell';
import { SetupWizardPane } from '@/lib/panes/setup-wizard';
import { getTenantTopologySafe } from '@/lib/setup/tenant-topology';

export const dynamic = 'force-dynamic';

/**
 * First-run Setup Wizard (audit-t157).
 *
 * This is the ONLY surface that can deploy the hub (topology='tenant'). Once a
 * hub exists, deploying a second Console is impossible — so we redirect to the
 * Setup & landing-zones surface (/admin/landing-zones), which manages this hub's
 * Data Landing Zones (overview + dlz-attach). The `?from=setup` flag tells that
 * page to show an explanatory banner so the redirect never reads as a broken
 * dead-end (it previously dumped the operator straight into the bare attach
 * form with no context). The server-side deploy route enforces the same
 * invariant (topology='tenant' is rejected when a hub already exists); this
 * redirect just makes the full first-run wizard unreachable after install. A
 * Cosmos read error is non-fatal — we still render the wizard (the deploy route
 * remains the hard guard).
 */
export default async function SetupPage() {
  const state = await getTenantTopologySafe();
  if (state.exists) {
    redirect('/admin/landing-zones?from=setup');
  }
  return (
    <PageShell title="Setup wizard" subtitle="Loom-specific tenant bootstrap — provision capacities, register the orchestrator, and seed the first workspace.">
      <SetupWizardPane />
    </PageShell>
  );
}
