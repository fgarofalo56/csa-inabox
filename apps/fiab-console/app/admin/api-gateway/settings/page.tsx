'use client';

/**
 * /admin/api-gateway/settings — W1-4 owns the Environments and Findings tabs.
 * Later lanes add tabs (Runtime in W1-8) by extending TABS below; the hub shell
 * (W1-5) links here and must not rewrite this directory.
 */
import { useState } from 'react';
import { Tab, TabList, makeStyles, tokens } from '@fluentui/react-components';
import { AdminShell } from '@/lib/components/admin-shell';
import { EnvironmentsTab } from './environments-tab';
import { FindingsTab } from './findings-tab';
import { RuntimeTab } from './runtime-tab';

const TABS = [
  { id: 'environments', label: 'Environments' },
  { id: 'findings', label: 'Findings' },
  { id: 'runtime', label: 'Runtime' },
] as const;

const useStyles = makeStyles({
  body: { paddingTop: tokens.spacingVerticalL, minWidth: 0 },
});

export default function ApiGatewaySettingsPage() {
  const s = useStyles();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('environments');
  return (
    <AdminShell
      sectionTitle="API Gateway settings"
      learn={{
        title: 'Environments',
        content: 'Classify gateways, model endpoints and MCP servers by environment. One rule set decides which pairings are allowed, warned or blocked, so a development account cannot be published through a production gateway.',
        tips: [
          'Everything starts Unclassified; nothing is blocked on day one',
          'Production-class gateways only front production-class resources',
          'Azure environment tags are suggestions you confirm, never decisions',
        ],
      }}
    >
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        {TABS.map((t) => <Tab key={t.id} value={t.id}>{t.label}</Tab>)}
      </TabList>
      <div className={s.body}>
        {tab === 'environments' ? <EnvironmentsTab /> : tab === 'findings' ? <FindingsTab /> : <RuntimeTab />}
      </div>
    </AdminShell>
  );
}
