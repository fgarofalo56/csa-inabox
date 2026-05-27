'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate } from '@/lib/components/purview-gate';
import { Body1, tokens } from '@fluentui/react-components';

export default function GovernanceScansPage() {
  return (
    <GovernanceShell sectionTitle="Scans">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Source registrations and scan schedules — Azure SQL, ADLS, Synapse, Databricks UC, Snowflake, on-prem SAP/Oracle/SQL.
      </Body1>
      <PurviewGate
        surface="Scans"
        backendRoute="/api/governance/scans"
        envVar="LOOM_PURVIEW_ACCOUNT"
        bicepModule="platform/fiab/bicep/modules/governance/purview.bicep"
        purviewDeepLink="https://web.purview.azure.com/resource/sources"
      />
    </GovernanceShell>
  );
}
