import { AdminShell } from '@/lib/components/admin-shell';
import { HealthPane } from '@/lib/components/admin/health-pane';

export default function AdminHealthPage() {
  return (
    <AdminShell
      sectionTitle="Health & self-audit"
      learn={{
        title: 'Health & self-audit',
        content: 'A self-review of the deployment across identity, data plane, Azure services, permissions, and security posture. Each check probes a real backend and reports pass / warn / fail, and fixable issues offer a one-click healer (admin-approved) that performs the remediation for you.',
        tips: [
          'Run the self-audit after a deploy or config change to confirm every plane is wired correctly.',
          'The one-click healer only runs with admin approval and targets issues Loom can safely fix.',
          'Failed checks name the exact env var, role, or resource to fix — treat them as your remediation list.',
        ],
      }}
    >
      <HealthPane />
    </AdminShell>
  );
}
