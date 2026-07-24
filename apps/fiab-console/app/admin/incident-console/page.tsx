import { AdminShell } from '@/lib/components/admin-shell';
import { IncidentConsole } from '@/lib/panes/incident-console';

export const dynamic = 'force-dynamic';

/**
 * /admin/incident-console — N17 OpenLineage-backed observability incident console.
 *
 * Per-table freshness/volume/schema-drift monitors + the incident lifecycle
 * (open→acknowledged→resolved, every state change audited) + a downstream-impact
 * panel rendered from the unified lineage graph. Consumes N7d data-quality
 * findings; incident alerts route through the one shared action group (O1). All
 * real backends (no-vaporware); Azure-native (no Fabric); IL5-safe (collector +
 * console + anomaly detection fully in-boundary). FLAG0: the pane's routes gate
 * on the n17-incident-console runtime flag and render a guided turned-off state.
 */
export default function IncidentConsolePage() {
  return (
    <AdminShell
      sectionTitle="Incident console"
      learn={{
        title: 'Observability incident console',
        content:
          'Monte-Carlo-style data observability on the vendor-neutral OpenLineage standard. Per-table monitors grade freshness (data age vs SLA), volume (row-count anomalies), and schema drift (added/removed columns) — baselines reuse the anomaly detector, so no external ML and the whole loop runs in-boundary (IL5-safe). A tripped monitor — or a consumed N7d data-quality finding — opens an incident with an audited timeline (open→acknowledged→resolved) and a downstream-impact panel computed from the unified lineage graph. Incident alerts route through the one shared action group.',
        tips: [
          'Add monitors on the Monitors tab; freshness needs an SLA in minutes, schema-drift compares the column set to the prior observation.',
          'Click "Consume findings" to fold open N7d data-quality findings into incidents (grouped by item + check).',
          'Every acknowledge / resolve / reopen / note is audited — the timeline is the record.',
          'The downstream-impact panel shows who breaks if this table is stale or wrong — resolved from real lineage.',
          'Export lineage to Marquez/DataHub/OpenMetadata via GET /api/lineage/openlineage/export.',
        ],
      }}
    >
      <IncidentConsole />
    </AdminShell>
  );
}
