'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate } from '@/lib/components/purview-gate';
import { Body1, tokens } from '@fluentui/react-components';

export default function GovernancePoliciesPage() {
  return (
    <GovernanceShell sectionTitle="Policies">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        DLP, dynamic data masking, row-level security and access policies — defined in Purview and enforced across registered sources.
      </Body1>
      <PurviewGate
        surface="Policies"
        backendRoute="/api/governance/policies"
        envVar="LOOM_PURVIEW_ACCOUNT"
        bicepModule="platform/fiab/bicep/modules/governance/purview.bicep"
        purviewDeepLink="https://web.purview.azure.com/resource/policies"
      />
    </GovernanceShell>
  );
}
