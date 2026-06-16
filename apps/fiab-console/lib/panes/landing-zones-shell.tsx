'use client';

/**
 * Landing zones shell (item-1 + item-3) — the post-deploy home for managing
 * Data Landing Zones. Two tabs:
 *
 *   - Overview : see + manage every attached DLZ (LandingZonesOverviewPane).
 *   - Add a landing zone : the dlz-attach form (AddLandingZoneWizardPane).
 *
 * Why this exists: once a hub is deployed, the first-run Setup Wizard is
 * unreachable (a second Console can't be deployed), so /setup redirects here.
 * Previously that redirect dumped the operator straight into the bare attach
 * FORM with no context — it read like a broken/stuck state. This shell gives a
 * clear post-deploy landing surface (Overview first) plus an explanatory banner
 * when arrived via the Setup-Wizard redirect (?from=setup).
 */

import * as React from 'react';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  makeStyles, tokens,
  TabList, Tab, MessageBar, MessageBarBody, MessageBarTitle, Link,
} from '@fluentui/react-components';
import { LandingZonesOverviewPane } from './landing-zones-overview';
import { AddLandingZoneWizardPane } from './add-landing-zone-wizard';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  tabs: { marginBottom: tokens.spacingVerticalS },
});

type TabValue = 'overview' | 'attach';

export function LandingZonesShell(): React.ReactElement {
  const styles = useStyles();
  const search = useSearchParams();
  const fromSetup = search?.get('from') === 'setup';
  const initialTab: TabValue = search?.get('tab') === 'attach' ? 'attach' : 'overview';
  const [tab, setTab] = useState<TabValue>(initialTab);

  return (
    <div className={styles.root}>
      {fromSetup && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Your CSA Loom hub is already deployed</MessageBarTitle>
            The first-run Setup Wizard installs the hub (Console) once — a second Console can’t be
            deployed in this tenant. From here on, the Setup Wizard manages this hub’s Data Landing
            Zones: review the ones already attached in <b>Overview</b>, or attach a new one under{' '}
            <b>Add a landing zone</b>. <Link href="/learn?topic=setup-wizard">Learn more</Link>
          </MessageBarBody>
        </MessageBar>
      )}

      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as TabValue)}
      >
        <Tab value="overview">Overview</Tab>
        <Tab value="attach">Add a landing zone</Tab>
      </TabList>

      {tab === 'overview' ? (
        <LandingZonesOverviewPane onAttach={() => setTab('attach')} />
      ) : (
        <AddLandingZoneWizardPane />
      )}
    </div>
  );
}

export default LandingZonesShell;
