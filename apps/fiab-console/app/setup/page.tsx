import { PageShell } from '@/lib/components/page-shell';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { SetupWizardPane } from '@/lib/panes/setup-wizard';
import { getTenantTopologySafe } from '@/lib/setup/tenant-topology';

export const dynamic = 'force-dynamic';

/**
 * The Deployment Planner — the ONE entry point for planning a CSA Loom
 * deployment, greenfield or brownfield.
 *
 * WHY THE REDIRECT IS GONE (deploy-integrity.md R4/R5; design §1.3).
 *
 * This page used to `redirect('/admin/landing-zones?from=setup')` the moment a
 * hub existed. The reasoning was sound for the hub-stamping step — a second
 * Console cannot be stamped into the same subscription. But the EFFECT was
 * that the only surface with scan-and-choose self-destructed on exactly the
 * estate that needs it: an operator with an existing hub could never reach the
 * multi-subscription analysis, the per-service adopt-or-deploy-new decision, or
 * the reviewable plan. Brownfield was unreachable from the product.
 *
 * The invariant is preserved where it belongs: `POST /api/setup/deploy` rejects
 * `topology='tenant'` when a hub already exists, and it always did — this
 * redirect was never the guard, only the thing that hid the wizard. What the
 * operator gets instead is an explicit RECONCILE posture: the planner opens,
 * says a hub was found, and points at the landing-zone surface for adding a
 * DLZ, while leaving the analysis and planning steps reachable.
 *
 * `scripts/ci/check-setup-entrypoints.mjs` fails the build if `redirect(`
 * reappears in this file.
 *
 * A Cosmos read error is non-fatal — the planner still renders, because the
 * deploy route remains the hard guard.
 */
export default async function SetupPage() {
  const state = await getTenantTopologySafe();
  const hubExists = !!state.exists;

  return (
    <PageShell
      title="Deployment planner"
      subtitle={
        hubExists
          ? 'A CSA Loom hub already exists in this tenant. Analyse your estate and plan a landing zone against it.'
          : 'Analyse what you already run in Azure, decide per service whether Loom reuses it or deploys new, then review the whole plan before anything runs.'
      }
    >
      {hubExists ? (
        <TeachingBanner
          surfaceKey="setup-wizard-reconcile"
          title="A hub already exists — this opens in reconcile mode"
          message="Loom found an existing hub for this tenant, so a second Console cannot be stamped into the same subscription. You can still run the estate analysis and build a plan here; to add a Data Landing Zone against the existing hub, use Setup & landing zones."
          learnMoreHref="/admin/landing-zones"
        />
      ) : (
        <TeachingBanner
          surfaceKey="setup-wizard"
          title="Greenfield and brownfield are the same walkthrough"
          message="You are never asked which one you have. Loom reads the subscriptions you allow, shows you exactly what it found and what it could not read, and asks per service whether to reuse an existing resource or deploy a new one. An empty subscription simply produces a plan where everything is new."
          learnMoreHref="https://learn.microsoft.com/azure/cloud-adoption-framework/ready/landing-zone/"
        />
      )}
      <SetupWizardPane />
    </PageShell>
  );
}
