'use client';

/**
 * Health & Reliability hub — tab strip (loom-next-level hub consolidation).
 *
 * /admin/health is the ONE reliability hub: verification/monitoring surfaces
 * land as TABS here, never as orphan admin tiles. Tabs today:
 *   • Self-audit & services — the existing HealthPane + ServiceExercisePane.
 *   • Journeys (V1)         — the synthetic user-journey monitor runs.
 * Later items (DR drills DR4, SLO SLO1, Spark pools A10) add tabs the same way.
 *
 * Deep-linkable via ?tab=<value> (e.g. /admin/health?tab=journeys — the gate
 * registry's surface path for svc-synthetic-monitor).
 */

import { useEffect, useState } from 'react';
import { Tab, TabList, tokens } from '@fluentui/react-components';
import { ArrowTrendingLines24Regular, Beaker24Regular, Flash24Regular, HeartPulse24Regular, ShieldCheckmark24Regular } from '@fluentui/react-icons';
import { HealthPane } from '@/lib/components/admin/health-pane';
import { SecretHealthPane } from '@/lib/components/admin/secret-health-pane';
import { ServiceExercisePane } from '@/lib/components/admin/service-exercise-pane';
import { SloPane } from '@/lib/components/admin/slo-pane';
import { SparkPoolsPane } from '@/lib/components/admin/spark-pools-pane';
import { SyntheticJourneysPane } from '@/lib/components/admin/synthetic-journeys-pane';
import { DependencyChaosPane } from '@/lib/components/admin/dependency-chaos-pane';

type HubTab = 'audit' | 'journeys' | 'spark' | 'slo' | 'chaos';

export function HealthHubTabs({
  journeysEnabled,
  sparkEnabled,
  autorecoverEnabled,
  sloEnabled,
  chaosEnabled,
}: {
  journeysEnabled: boolean;
  sparkEnabled?: boolean;
  autorecoverEnabled?: boolean;
  sloEnabled?: boolean;
  chaosEnabled?: boolean;
}) {
  const [tab, setTab] = useState<HubTab>('audit');

  // Deep link: /admin/health?tab=journeys|spark|slo|chaos (client-only read — no Suspense dance).
  useEffect(() => {
    try {
      const wanted = new URLSearchParams(window.location.search).get('tab');
      if (wanted === 'journeys' && journeysEnabled) setTab('journeys');
      if (wanted === 'spark' && sparkEnabled) setTab('spark');
      if (wanted === 'slo' && sloEnabled) setTab('slo');
      if (wanted === 'chaos' && chaosEnabled) setTab('chaos');
    } catch { /* no window (SSR) — default tab stands */ }
  }, [journeysEnabled, sparkEnabled, sloEnabled, chaosEnabled]);

  return (
    <div style={{ minWidth: 0 }}>
      <TabList
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as HubTab)}
        style={{ marginBottom: tokens.spacingVerticalL }}
        aria-label="Health & Reliability sections"
      >
        <Tab value="audit" icon={<ShieldCheckmark24Regular />}>Self-audit &amp; services</Tab>
        {journeysEnabled && (
          <Tab value="journeys" icon={<HeartPulse24Regular />}>Journeys</Tab>
        )}
        {sparkEnabled && (
          <Tab value="spark" icon={<Flash24Regular />}>Spark pools</Tab>
        )}
        {sloEnabled && (
          <Tab value="slo" icon={<ArrowTrendingLines24Regular />}>SLO &amp; error budgets</Tab>
        )}
        {chaosEnabled && (
          <Tab value="chaos" icon={<Beaker24Regular />}>Dependency chaos</Tab>
        )}
      </TabList>
      {tab === 'audit' && (
        <>
          <SecretHealthPane />
          <ServiceExercisePane />
          <HealthPane />
        </>
      )}
      {tab === 'journeys' && journeysEnabled && <SyntheticJourneysPane />}
      {tab === 'spark' && sparkEnabled && <SparkPoolsPane autorecoverEnabled={autorecoverEnabled} />}
      {tab === 'slo' && sloEnabled && <SloPane />}
      {tab === 'chaos' && chaosEnabled && <DependencyChaosPane />}
    </div>
  );
}
