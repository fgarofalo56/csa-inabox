import { AdminShell } from '@/lib/components/admin-shell';
import { ModelFabricPanel } from '@/lib/components/admin/model-fabric-panel';

export const dynamic = 'force-dynamic';

export default function AdminModelFabricPage() {
  return (
    <AdminShell
      sectionTitle="Model Fabric"
      learn={{
        title: 'Closed-Loop Model Fabric — auto promote/demote from live eval',
        content:
          'A self-optimizing loop that fuses the tier-router (routing), agent evals + red-team (quality/safety), model serving (traffic-split) and the Copilot latency SLO (observability) into automatic promote/demote decisions. It promotes the live-eval winner and demotes regressions across serving traffic-splits and the reasoning tier — in Auto-apply it actuates the real Azure ML traffic-split + reasoning-tier deployment; in Propose-only it shows what it would do. Every action is audited. All signals are real Azure OpenAI / Cosmos / Azure ML data — no Fabric dependency.',
        tips: [
          'Propose-only (default) computes decisions but changes nothing until you run it',
          'Auto-apply promotes the eval winner + demotes regressions on every run',
          'Hysteresis (cooldown + margin + min-sample) stops the loop from flapping',
          'The loop pauses actuation while the Copilot latency SLO is breaching',
          'Every promote/demote is written to the audit log',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments',
      }}
    >
      <ModelFabricPanel />
    </AdminShell>
  );
}
