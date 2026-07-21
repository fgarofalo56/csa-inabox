'use client';

/**
 * WS-10.1 — /admin/autopilot  (LCU-Autopilot, self-driving platform, BTB-2)
 *
 * The admin surface for the self-driving FinOps loop: real LCU telemetry, the
 * policy-engine recommendations with $ impact, the propose⇄auto approval toggle,
 * per-recommendation approve (self-executing), and the action history. The pane
 * (`LcuAutopilotPane`) does the real work against /api/admin/autopilot.
 */
import { AdminShell } from '@/lib/components/admin-shell';
import { LcuAutopilotPane } from '@/lib/components/admin/lcu-autopilot-pane';

export default function AdminAutopilotPage() {
  return (
    <AdminShell
      sectionTitle="Autopilot"
      learn={{
        title: 'LCU-Autopilot — self-driving FinOps',
        content:
          'The autopilot reads real LCU telemetry (per-compute LCU + $ from the chargeback model, live Azure ' +
          'Monitor utilization) and the gate/self-audit signal, then a policy engine (with thresholds + ' +
          'hysteresis) recommends pausing idle compute, right-sizing the LCU capacity ceiling, or migrating ' +
          'workloads. In Propose mode it only surfaces recommendations; in Auto mode it actuates them for real — ' +
          'pausing an idle Synapse pool / ADX cluster (data survives) or rolling the capacity env-config to a new ' +
          'revision. Approving a single recommendation makes it self-execute even in Propose mode.',
        tips: [
          'Auto mode never actuates while a latency SLO is breaching.',
          'Every pause and capacity roll is audited to the SIEM stream + Cosmos audit trail.',
          'Recommendations respect a 6h per-target cooldown so the loop cannot flap.',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/cost-management-billing/costs/cost-mgt-best-practices',
      }}
    >
      <LcuAutopilotPane />
    </AdminShell>
  );
}
