'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate } from '@/lib/components/purview-gate';
import { Body1, tokens } from '@fluentui/react-components';

export default function GovernanceInsightsPage() {
  return (
    <GovernanceShell sectionTitle="Insights">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Tenant-wide governance KPIs — sensitive-data coverage, classification accuracy, scan freshness, policy drift.
      </Body1>
      <PurviewGate
        surface="Insights"
        backendRoute="/api/governance/insights"
        envVar="LOOM_PURVIEW_ACCOUNT"
        bicepModule="platform/fiab/bicep/modules/governance/purview.bicep"
        purviewDeepLink="https://web.purview.azure.com/resource/insights"
      />
    </GovernanceShell>
  );
}
