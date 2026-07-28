'use client';

/**
 * FinopsHubTabs — the /admin/finops tab strip (IA-03, loom-apex Phase B).
 *
 * Per the hub-consolidation rule, every cost surface lives on ONE admin page:
 *   • Cockpit          — the C4 FinOps cockpit (forecast, anomaly feed + rules,
 *                        spend breakdown, real Azure Budgets CRUD).
 *   • Capacity & LCU   — the unified capacity + chargeback dashboard that used
 *                        to live at /admin/usage-chargeback.
 *   • Chargeback report— the per-domain chargeback report that used to live at
 *                        /admin/chargeback.
 *
 * The two folded routes still exist as redirect stubs (`/admin/usage-chargeback`
 * → `?tab=capacity`, `/admin/chargeback` → `?tab=chargeback`), so bookmarks,
 * gate-registry surface paths and Fix-it links keep resolving. Every pane was
 * MOVED verbatim — no surface lost a control.
 *
 * Deep-linkable via `?tab=<value>` exactly like HealthHubTabs.
 *
 * Kill-switch: `c4-finops-hub`. Default-ON. When an admin flips it OFF the
 * Cockpit tab is hidden and the hub opens on Capacity & LCU — i.e. the estate
 * reverts to precisely the two pre-C4 chargeback surfaces, in their new home,
 * with an honest MessageBar explaining why. Nothing becomes unreachable.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Tab, TabList, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Money24Regular, Gauge24Regular, Organization24Regular } from '@fluentui/react-icons';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import { FinopsCockpitPane } from '@/lib/components/admin/finops-cockpit-pane';
import { CapacityChargebackPane } from '@/lib/components/admin/capacity-chargeback-pane';
import { ChargebackReportPane } from '@/lib/components/admin/chargeback-report-pane';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  tabs: { marginBottom: tokens.spacingVerticalS },
});

export type FinopsHubTab = 'cockpit' | 'capacity' | 'chargeback';

/** Every value `?tab=` accepts — also the contract the redirect stubs target. */
export const FINOPS_HUB_TABS: readonly FinopsHubTab[] = ['cockpit', 'capacity', 'chargeback'] as const;

export function FinopsHubTabs() {
  const styles = useStyles();
  const cockpitEnabled = useRuntimeFlag('c4-finops-hub', true);
  const [tab, setTab] = useState<FinopsHubTab>('cockpit');

  // Deep link: /admin/finops?tab=capacity|chargeback|cockpit (client-only read —
  // no Suspense dance), the same pattern HealthHubTabs uses.
  useEffect(() => {
    try {
      const wanted = new URLSearchParams(window.location.search).get('tab');
      if (wanted && (FINOPS_HUB_TABS as readonly string[]).includes(wanted)) {
        setTab(wanted as FinopsHubTab);
      }
    } catch { /* no window (SSR) — default tab stands */ }
  }, []);

  // Kill-switch OFF: the cockpit tab disappears; never strand the user on it.
  useEffect(() => {
    if (!cockpitEnabled && tab === 'cockpit') setTab('capacity');
  }, [cockpitEnabled, tab]);

  return (
    <div className={styles.root}>
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as FinopsHubTab)}
        aria-label="FinOps sections"
      >
        {cockpitEnabled && <Tab value="cockpit" icon={<Money24Regular />}>Cockpit</Tab>}
        <Tab value="capacity" icon={<Gauge24Regular />}>Capacity &amp; LCU</Tab>
        <Tab value="chargeback" icon={<Organization24Regular />}>Chargeback report</Tab>
      </TabList>

      {!cockpitEnabled && (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>FinOps cockpit is turned off</MessageBarTitle>
            The <code>c4-finops-hub</code> runtime flag is OFF, so the forecast / anomaly /
            budgets cockpit is hidden. Capacity &amp; LCU and the Chargeback report are
            unaffected. Re-enable the cockpit on{' '}
            <Link href="/admin/runtime-flags">Runtime flags</Link>.
          </MessageBarBody>
        </MessageBar>
      )}

      {tab === 'cockpit' && cockpitEnabled && <FinopsCockpitPane />}
      {tab === 'capacity' && <CapacityChargebackPane />}
      {tab === 'chargeback' && <ChargebackReportPane />}
    </div>
  );
}
