'use client';

/**
 * /admin/finops — the ONE cost hub (IA-03, loom-apex Phase B).
 *
 * Three tabs, all real-backend, all Azure-native (no Fabric dependency):
 *   • Cockpit           — C4: Cost Management forecast, live cost-anomaly feed
 *                         + rules editor, per-scope spend breakdown, real Azure
 *                         Budgets CRUD.
 *   • Capacity & LCU    — the unified capacity + chargeback dashboard formerly
 *                         at /admin/usage-chargeback (Fabric Capacity Metrics
 *                         app 1:1).
 *   • Chargeback report — the per-domain chargeback report formerly at
 *                         /admin/chargeback (Fabric Chargeback app 1:1).
 *
 * Both folded routes remain as redirect stubs into the matching `?tab=` deep
 * link, so every existing bookmark / gate surface path keeps working.
 */
import { AdminShell } from '@/lib/components/admin-shell';
import { FinopsHubTabs } from '@/lib/components/admin/finops-hub-tabs';

export default function FinopsPage() {
  return (
    <AdminShell
      sectionTitle="FinOps & chargeback"
      learn={{
        title: 'FinOps & chargeback',
        content:
          'The one cost hub. Cockpit: real Cost Management forecast (Forecast API with honest method labeling), the C3 cost-anomaly feed + rules editor, per-scope spend breakdown, and real Azure Budgets create/update/delete. Capacity & LCU: real Cost Management spend joined to Azure Monitor utilization, normalized to one Loom Capacity Unit with a throttle/surge gauge — the Azure-native 1:1 of the Fabric Capacity Metrics app. Chargeback report: real spend attributed to governance domains through the loom-domain tag, with a stacked bar chart, CSV export and per-user drill-down — the 1:1 of the Fabric Chargeback app.',
        tips: [
          'Deep-link a tab with ?tab=cockpit | capacity | chargeback.',
          'The old /admin/usage-chargeback and /admin/chargeback links redirect straight to their tab.',
          'Every number is live Azure Cost Management / Azure Monitor data — an honest gate names the exact role or env var when a scope is missing.',
          'The c4-finops-hub runtime flag only hides the Cockpit tab; capacity and chargeback always stay available.',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/cost-management-billing/costs/overview-cost-management',
      }}
    >
      <FinopsHubTabs />
    </AdminShell>
  );
}
