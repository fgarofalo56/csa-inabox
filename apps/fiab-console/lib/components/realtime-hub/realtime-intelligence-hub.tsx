'use client';

/**
 * RealTimeIntelligenceHub — the single, consolidated Real-Time Intelligence
 * surface. Merges what used to be four separate top-level rail destinations
 * into one tabbed hub:
 *
 *   Streams           RealTimeHubView    (deployed eventstreams + KQL tables)
 *   Discover sources  RtiHubView         (raw Azure sources via Resource Graph)
 *   Activator         ActivatorPane      (Azure Monitor scheduled-query rules)
 *   Business events   BusinessEventsView (governed Event Hubs / Event Grid signals)
 *
 * Each tab renders the EXISTING view body unchanged — every real backend call
 * (Resource Graph, Azure Monitor, Event Hubs, KQL) is preserved. Nothing is
 * rebuilt; this component only composes them under one Fluent TabList.
 *
 * The active tab is reflected in the ?tab= query param so links (and the
 * legacy /activator, /activator-hub, /business-events, /rti-hub redirects)
 * deep-link straight to a section and are shareable / bookmarkable.
 */

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Tab, TabList, makeStyles, tokens } from '@fluentui/react-components';
import {
  Flash20Regular, DataUsage20Regular, Alert20Regular, Send20Regular,
} from '@fluentui/react-icons';
import { RealTimeHubView } from './realtime-hub-view';
import { RtiHubView } from './rti-hub-view';
import { BusinessEventsView } from '../business-events/business-events-view';
import { ActivatorPane } from '@/lib/panes/activator';

const useStyles = makeStyles({
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginBottom: tokens.spacingVerticalL },
  body: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 },
});

const TABS = ['streams', 'sources', 'activator', 'events'] as const;
type TabId = (typeof TABS)[number];

export function RealTimeIntelligenceHub() {
  const s = useStyles();
  const router = useRouter();
  const params = useSearchParams();
  const initial = (params.get('tab') || 'streams') as TabId;
  const [tab, setTab] = useState<TabId>(TABS.includes(initial) ? initial : 'streams');

  // Keep the URL in sync so a tab is shareable / bookmarkable.
  useEffect(() => {
    const cur = params.get('tab');
    if (cur !== tab) {
      const sp = new URLSearchParams(Array.from(params.entries()));
      sp.set('tab', tab);
      router.replace(`/realtime-hub?${sp.toString()}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className={s.body}>
      <TabList className={s.tabs} selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabId)} size="large">
        <Tab value="streams" icon={<Flash20Regular />}>Streams</Tab>
        <Tab value="sources" icon={<DataUsage20Regular />}>Discover sources</Tab>
        <Tab value="activator" icon={<Alert20Regular />}>Activator</Tab>
        <Tab value="events" icon={<Send20Regular />}>Business events</Tab>
      </TabList>

      {tab === 'streams' && <RealTimeHubView />}
      {tab === 'sources' && <RtiHubView />}
      {tab === 'activator' && <ActivatorPane />}
      {tab === 'events' && <BusinessEventsView />}
    </div>
  );
}
