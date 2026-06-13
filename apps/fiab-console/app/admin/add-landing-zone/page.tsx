import { AddLandingZoneWizardPane } from '@/lib/panes/add-landing-zone-wizard';
import { AdminShell } from '@/lib/components/admin-shell';

export const dynamic = 'force-dynamic';

export default function AddLandingZonePage() {
  return (
    <AdminShell sectionTitle="Add landing zone">
      <AddLandingZoneWizardPane />
    </AdminShell>
  );
}
