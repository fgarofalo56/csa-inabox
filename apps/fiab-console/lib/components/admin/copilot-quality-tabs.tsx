'use client';

/**
 * CopilotQualityTabs — the /admin/copilot-quality tab strip (E5 + SRCH1).
 * Per the hub-consolidation rule, Copilot answer quality and federated-search
 * relevance live on ONE page as two tabs (both scored by the same evaluator
 * machinery, both read from Cosmos loom-copilot-evals).
 */
import { useState } from 'react';
import { TabList, Tab, makeStyles, tokens } from '@fluentui/react-components';
import { TargetArrow24Regular, Search24Regular, Router24Regular } from '@fluentui/react-icons';
import { CopilotQualityPanel } from '@/lib/components/admin/copilot-quality-panel';
import { SearchQualityPanel } from '@/lib/components/admin/search-quality-panel';
import { TierRoutingPanel } from '@/lib/components/admin/tier-routing-panel';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  tabs: { marginBottom: tokens.spacingVerticalS },
});

type TabKey = 'answers' | 'search' | 'tier';

export function CopilotQualityTabs() {
  const styles = useStyles();
  const [tab, setTab] = useState<TabKey>('answers');
  return (
    <div className={styles.root}>
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as TabKey)}
      >
        <Tab value="answers" icon={<TargetArrow24Regular />}>Answer quality</Tab>
        <Tab value="search" icon={<Search24Regular />}>Search relevance</Tab>
        <Tab value="tier" icon={<Router24Regular />}>Tier routing</Tab>
      </TabList>
      {tab === 'answers' ? <CopilotQualityPanel /> : tab === 'search' ? <SearchQualityPanel /> : <TierRoutingPanel />}
    </div>
  );
}
