'use client';

/**
 * CopilotQualityTabs — the /admin/copilot-quality tab strip (E5 + SRCH1 + E6 + N13).
 * Per the hub-consolidation rule, every Copilot-quality / LLMOps surface lives on
 * ONE page: answer quality, federated-search relevance, and tier routing (all
 * scored by the same evaluator machinery, all read from Cosmos
 * loom-copilot-evals), plus N13's prompt registry and token budgets — the two
 * planes WS-E did not cover. No orphan admin tile, no second admin page.
 */
import { useState } from 'react';
import { TabList, Tab, makeStyles, tokens } from '@fluentui/react-components';
import {
  TargetArrow24Regular, Search24Regular, Router24Regular,
  DocumentBulletList24Regular, Money24Regular,
} from '@fluentui/react-icons';
import { CopilotQualityPanel } from '@/lib/components/admin/copilot-quality-panel';
import { SearchQualityPanel } from '@/lib/components/admin/search-quality-panel';
import { TierRoutingPanel } from '@/lib/components/admin/tier-routing-panel';
import { PromptRegistryPanel } from '@/lib/components/admin/prompt-registry-panel';
import { TokenBudgetPanel } from '@/lib/components/admin/token-budget-panel';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  tabs: { marginBottom: tokens.spacingVerticalS },
});

type TabKey = 'answers' | 'search' | 'tier' | 'prompts' | 'budgets';

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
        <Tab value="prompts" icon={<DocumentBulletList24Regular />}>Prompts</Tab>
        <Tab value="budgets" icon={<Money24Regular />}>Budgets</Tab>
      </TabList>
      {tab === 'answers' ? <CopilotQualityPanel />
        : tab === 'search' ? <SearchQualityPanel />
          : tab === 'tier' ? <TierRoutingPanel />
            : tab === 'prompts' ? <PromptRegistryPanel />
              : <TokenBudgetPanel />}
    </div>
  );
}
