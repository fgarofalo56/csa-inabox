'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate } from '@/lib/components/purview-gate';
import { Body1, tokens } from '@fluentui/react-components';

export default function GovernanceClassificationsPage() {
  return (
    <GovernanceShell sectionTitle="Classifications">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        System-defined plus custom classifiers (PII, financial, secrets, etc) applied by Purview scans across registered sources.
      </Body1>
      <PurviewGate
        surface="Classifications"
        backendRoute="/api/governance/classifications"
        envVar="LOOM_PURVIEW_ACCOUNT"
        bicepModule="platform/fiab/bicep/modules/governance/purview.bicep"
        purviewDeepLink="https://web.purview.azure.com/resource/classifications"
      />
    </GovernanceShell>
  );
}
