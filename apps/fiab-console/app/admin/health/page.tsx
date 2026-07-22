import { AdminShell } from '@/lib/components/admin-shell';
import { HealthPane } from '@/lib/components/admin/health-pane';
import { SecretHealthPane } from '@/lib/components/admin/secret-health-pane';
import { ServiceExercisePane } from '@/lib/components/admin/service-exercise-pane';

export default function AdminHealthPage() {
  return (
    <AdminShell
      sectionTitle="Health & self-audit"
      learn={{
        title: 'Health & self-audit',
        content: 'A self-review of the deployment across identity, data plane, Azure services, permissions, and security posture. Each check probes a real backend and reports pass / warn / fail, and fixable issues offer a one-click healer (admin-approved) that performs the remediation for you. The Exercise services panel goes one level deeper: it runs a tiny real operation through every backend data path (a live Spark session, SELECT 1 over TDS, print 1 over KQL, and more) so a configured-but-broken backend is caught here, not by the first user.',
        tips: [
          'Run the self-audit after a deploy or config change to confirm every plane is wired correctly.',
          'The one-click healer only runs with admin approval and targets issues Loom can safely fix.',
          'Failed checks name the exact env var, role, or resource to fix — treat them as your remediation list.',
          'Exercise services executes a real end-to-end operation per backend — a green self-audit with a red exercise means the resource exists but cannot do work (e.g. a faulted Spark pool).',
          'Secret & credential health tracks the MSAL app secrets + tracked Key Vault credentials with days-to-expiry — rotate anything red or amber via the secret-rotation runbook before it breaks sign-in.',
        ],
      }}
    >
      <SecretHealthPane />
      <ServiceExercisePane />
      <HealthPane />
    </AdminShell>
  );
}
