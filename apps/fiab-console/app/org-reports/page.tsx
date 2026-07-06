'use client';

/**
 * /org-reports — Reports & analytics hub.
 *
 * The top-level, NON-admin surface for organizational reports and visuals — so a
 * colleague no longer has to be in the Admin portal to view them. Tabs:
 *
 *   Organization reports — the CoE report consumer gallery (any authenticated
 *     member). Reports render against the deployment's LIVE Azure estate.
 *   Usage · Copilot usage · Chargeback — the org-wide analytics dashboards,
 *     reused verbatim from the Admin portal (same real backends). These roll up
 *     tenant-wide activity / cost, so they stay tenant-admin-scoped: the tabs
 *     appear only for tenant admins, and the underlying APIs enforce their own
 *     403 gate. Every panel reads real data by default (Cosmos, Log Analytics,
 *     Cost Management, Azure Monitor) with an honest infra-gate when a backend
 *     is absent — no mock/sample rows. Azure-native: no Fabric / Power BI
 *     workspace required.
 */

import * as React from 'react';
import { TabList, Tab, makeStyles, tokens } from '@fluentui/react-components';
import {
  DocumentTable24Regular, DataHistogram24Regular, Bot24Regular, Money24Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { OrgReportsPane } from '@/lib/coe-library/org-reports-pane';
import { CopilotUsagePane } from '@/lib/components/admin/copilot-usage';
import { UsageMetricsPane } from '@/app/admin/usage/page';
import { ChargebackPane } from '@/app/admin/usage-chargeback/page';
import { useIsTenantAdmin } from '@/lib/components/session-context';

type TabKey = 'reports' | 'usage' | 'copilot' | 'chargeback';

const useStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalL },
  panel: { paddingTop: tokens.spacingVerticalM },
});

export default function OrgReportsHubPage(): React.ReactElement {
  const s = useStyles();
  const isAdmin = useIsTenantAdmin();
  const [tab, setTab] = React.useState<TabKey>('reports');

  return (
    <PageShell
      title="Reports"
      subtitle="Organizational reports and analytics — CoE reports plus usage, Copilot, and chargeback dashboards, all reading your live Azure estate."
    >
      <TabList
        className={s.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as TabKey)}
      >
        <Tab value="reports" icon={<DocumentTable24Regular />}>Organization reports</Tab>
        {isAdmin && <Tab value="usage" icon={<DataHistogram24Regular />}>Usage</Tab>}
        {isAdmin && <Tab value="copilot" icon={<Bot24Regular />}>Copilot usage</Tab>}
        {isAdmin && <Tab value="chargeback" icon={<Money24Regular />}>Chargeback</Tab>}
      </TabList>

      {/* Only the active tab mounts → each pane's live fetch fires lazily. */}
      <div className={s.panel}>
        {tab === 'reports' && <OrgReportsPane />}
        {tab === 'usage' && isAdmin && <UsageMetricsPane />}
        {tab === 'copilot' && isAdmin && <CopilotUsagePane />}
        {tab === 'chargeback' && isAdmin && <ChargebackPane />}
      </div>
    </PageShell>
  );
}
