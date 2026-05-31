import { AdminShell } from '@/lib/components/admin-shell';
import { DeploymentPlannerView } from '@/lib/components/deploy-planner/deploy-planner-view';

export const dynamic = 'force-dynamic';

export default function DeployPlannerPage() {
  return (
    <AdminShell sectionTitle="Deployment planner">
      <DeploymentPlannerView />
    </AdminShell>
  );
}
