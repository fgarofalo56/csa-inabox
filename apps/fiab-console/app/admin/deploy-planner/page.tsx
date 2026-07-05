import { AdminShell } from '@/lib/components/admin-shell';
import { DeploymentPlannerView } from '@/lib/components/deploy-planner/deploy-planner-view';

export const dynamic = 'force-dynamic';

export default function DeployPlannerPage() {
  return (
    <AdminShell
      sectionTitle="Deployment planner"
      learn={{
        title: 'Deployment planner',
        content: 'Visually plan what deploys to which subscription and business domain, then generate the bicepparam file that drives az deployment. Model your target topology in the UI — which engines, landing zones, and domains go where — and export deployment parameters instead of hand-editing bicep.',
        tips: [
          'Map engines and workloads to subscriptions and domains before you generate the parameter file.',
          'The generated bicepparam feeds the same az deployment sub create path used for a real install.',
          'Use it to preview and right-size a deployment without touching the Azure portal.',
        ],
      }}
    >
      <DeploymentPlannerView />
    </AdminShell>
  );
}
