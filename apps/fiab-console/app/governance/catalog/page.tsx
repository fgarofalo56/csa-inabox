'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate } from '@/lib/components/purview-gate';
import { Body1, tokens } from '@fluentui/react-components';

export default function GovernanceCatalogPage() {
  return (
    <GovernanceShell sectionTitle="Data catalog">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Single inventory across OneLake, Mirrored DBs, Synapse, Databricks Unity Catalog, ADLS, and registered on-prem sources — backed by Microsoft Purview scans.
      </Body1>
      <PurviewGate
        surface="Data catalog"
        backendRoute="/api/governance/catalog"
        envVar="LOOM_PURVIEW_ACCOUNT"
        bicepModule="platform/fiab/bicep/modules/governance/purview.bicep"
        purviewDeepLink="https://web.purview.azure.com/"
      />
    </GovernanceShell>
  );
}
