import { PageShell } from '@/lib/components/page-shell';
import { ActivatorPane } from '@/lib/panes/activator';

/**
 * Workspace-level Activator hub — the cross-workspace overview of every
 * Activator rule (Rules / Objects / Action history), with live enable/disable
 * and delete. Distinct from /activator, which lists Activator *items* in the
 * tenant. Every panel reads live from Azure Monitor scheduled-query alert rules
 * (persisted on the Cosmos activator item) — Azure-native by DEFAULT, with a
 * Fabric Reflex backend opt-in only (LOOM_ACTIVATOR_BACKEND=fabric). No real
 * Microsoft Fabric workspace is required.
 */
export default function ActivatorHubPage() {
  return (
    <PageShell
      title="Activator"
      subtitle="Cross-workspace view of every Activator rule — enable/disable and delete rules that round-trip to Azure Monitor scheduled-query alerts, see the source tables they watch, and review fired/resolved alert instances. Azure-native by default; no Microsoft Fabric required."
    >
      <ActivatorPane />
    </PageShell>
  );
}
