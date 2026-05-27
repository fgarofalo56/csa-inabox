'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate } from '@/lib/components/purview-gate';
import { Body1, tokens } from '@fluentui/react-components';

export default function GovernanceSensitivityPage() {
  return (
    <GovernanceShell sectionTitle="Sensitivity labels">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Microsoft Purview Information Protection labels — applied to assets, files, emails. Synced from the M365 compliance center.
      </Body1>
      <PurviewGate
        surface="Sensitivity labels"
        backendRoute="/api/governance/sensitivity"
        envVar="LOOM_PURVIEW_ACCOUNT"
        bicepModule="platform/fiab/bicep/modules/governance/purview.bicep"
        purviewDeepLink="https://compliance.microsoft.com/informationprotection"
      />
    </GovernanceShell>
  );
}
