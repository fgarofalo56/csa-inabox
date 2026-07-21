'use client';

/**
 * LoomMarketplace — the single, core marketplace surface for the tenant.
 *
 * Merges what used to be the separate "API marketplace" and "Data marketplace"
 * into one data-mesh-style exchange where users publish, share, and subscribe
 * to every product kind:
 *
 *   Discover        unified federated search across all kinds (UnifiedDiscover)
 *   Data products   DataProductsMarketplace (Azure AI Search + Cosmos)
 *   APIs            ApiMarketplace (Azure API Management)
 *   Data shares     DataShares (Databricks Unity Catalog Delta Sharing)
 *   My access       unified subscriptions + access requests
 *
 * Tab is reflected in the ?tab= query param so links (and the legacy
 * /api-marketplace redirect) deep-link straight to a section.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Tab, TabList, makeStyles, tokens } from '@fluentui/react-components';
import {
  Search20Regular, Database20Regular, Connector20Regular, Share20Regular, KeyReset20Regular,
  StoreMicrosoft20Regular,
} from '@fluentui/react-icons';
import { UnifiedDiscover } from './unified-discover';
import { LivingMarketplace } from './living-marketplace';
import { ApiMarketplace } from './api-marketplace';
import { DataShares } from './data-shares';
import { MyAccess } from './my-access';
import { DataProductsMarketplace } from '@/lib/editors/data-marketplace';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { LOOM_ACCENT } from '@/lib/components/shared/accent-tokens';

const useStyles = makeStyles({
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginBottom: tokens.spacingVerticalL },
  body: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 },
});

const TABS = ['discover', 'catalog', 'products', 'apis', 'shares', 'access'] as const;
type TabId = (typeof TABS)[number];

export function LoomMarketplace() {
  const s = useStyles();
  const router = useRouter();
  const params = useSearchParams();
  const initial = (params.get('tab') || 'discover') as TabId;
  const [tab, setTab] = useState<TabId>(TABS.includes(initial) ? initial : 'discover');

  // Keep the URL in sync so a tab is shareable / bookmarkable.
  useEffect(() => {
    const cur = params.get('tab');
    if (cur !== tab) {
      const sp = new URLSearchParams(Array.from(params.entries()));
      sp.set('tab', tab);
      router.replace(`/marketplace?${sp.toString()}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const goTab = useCallback((t: string) => { if (TABS.includes(t as TabId)) setTab(t as TabId); }, []);

  return (
    <div className={s.body}>
      <div style={{ marginBottom: tokens.spacingVerticalL }}>
        <TeachingBanner
          surfaceKey="marketplace-hub"
          icon={Search20Regular}
          accent={LOOM_ACCENT.violet}
          title="One exchange for every product kind"
          message="Discover, subscribe to, and publish data products, agents, MCP servers, apps, and ontologies — plus APIs and live Delta shares — from one data-mesh exchange. The Catalog tab unifies all five product kinds: publishing runs the platform gates as auto-certification, every subscription creates a real access grant, and usage meters to your tenant chargeback."
        />
      </div>
      <TabList className={s.tabs} selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabId)} size="large">
        <Tab value="discover" icon={<Search20Regular />}>Discover</Tab>
        <Tab value="catalog" icon={<StoreMicrosoft20Regular />}>Catalog</Tab>
        <Tab value="products" icon={<Database20Regular />}>Data products</Tab>
        <Tab value="apis" icon={<Connector20Regular />}>APIs</Tab>
        <Tab value="shares" icon={<Share20Regular />}>Data shares</Tab>
        <Tab value="access" icon={<KeyReset20Regular />}>My access</Tab>
      </TabList>

      {tab === 'discover' && <UnifiedDiscover onGoTab={goTab} />}
      {tab === 'catalog' && <LivingMarketplace />}
      {tab === 'products' && <DataProductsMarketplace />}
      {tab === 'apis' && <ApiMarketplace />}
      {tab === 'shares' && <DataShares />}
      {tab === 'access' && <MyAccess />}
    </div>
  );
}
