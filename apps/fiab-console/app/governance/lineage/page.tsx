'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate } from '@/lib/components/purview-gate';
import { Body1, tokens } from '@fluentui/react-components';

export default function GovernanceLineagePage() {
  return (
    <GovernanceShell sectionTitle="Lineage">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        End-to-end column-grain lineage stitched across OneLake, Mirrored DBs, Synapse, ADF, Databricks, Power BI via Purview's lineage graph.
      </Body1>
      <PurviewGate
        surface="Lineage"
        backendRoute="/api/governance/lineage"
        envVar="LOOM_PURVIEW_ACCOUNT"
        bicepModule="platform/fiab/bicep/modules/governance/purview.bicep"
        purviewDeepLink="https://web.purview.azure.com/resource/lineage"
      />
    </GovernanceShell>
  );
}
