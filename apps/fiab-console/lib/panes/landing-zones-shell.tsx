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
  Title3, Body1, Button,
} from '@fluentui/react-components';
import { PlugConnected24Regular } from '@fluentui/react-icons';
import { LandingZonesOverviewPane } from './landing-zones-overview';
import { AddLandingZoneWizardPane } from './add-landing-zone-wizard';
import { AttachServiceWizard } from '@/lib/components/landing-zones/attach-service-wizard';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  tabs: { marginBottom: tokens.spacingVerticalS },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalXXL,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: tokens.spacingVerticalM,
    maxWidth: '760px',
  },
  iconChip: {
    width: '48px', height: '48px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

type TabValue = 'overview' | 'attach' | 'attach-existing';

export function LandingZonesShell(): React.ReactElement {
  const styles = useStyles();
  const search = useSearchParams();
  const fromSetup = search?.get('from') === 'setup';
  const tabParam = search?.get('tab');
  const initialTab: TabValue =
    tabParam === 'attach' ? 'attach' : tabParam === 'attach-existing' ? 'attach-existing' : 'overview';
  const [tab, setTab] = useState<TabValue>(initialTab);
  const [attachOpen, setAttachOpen] = useState(false);

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
        <Tab value="attach-existing">Attach existing services</Tab>
      </TabList>

      {tab === 'overview' && <LandingZonesOverviewPane onAttach={() => setTab('attach')} />}
      {tab === 'attach' && <AddLandingZoneWizardPane />}
      {tab === 'attach-existing' && (
        <div className={styles.card}>
          <span className={styles.iconChip} aria-hidden><PlugConnected24Regular /></span>
          <Title3>Attach existing Azure services</Title3>
          <Body1 className={styles.hint}>
            Bring existing Azure services you already own into Loom without a greenfield deploy.
            Pick a target landing zone — the hub, any Data Landing Zone, or a lightweight logical
            landing zone (or create one on the spot) — then multi-select every service to attach.
            Attaching borrows the resource; it never creates or deletes it.
          </Body1>
          <Button appearance="primary" icon={<PlugConnected24Regular />} onClick={() => setAttachOpen(true)}>
            Attach existing services
          </Button>
        </div>
      )}

      {/* Un-scoped attach wizard — opens on its step-0 landing-zone selector. */}
      <AttachServiceWizard open={attachOpen} onClose={() => setAttachOpen(false)} />
    </div>
  );
}

export default LandingZonesShell;
