'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  makeStyles, tokens, Tab, TabList, Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  Body1, Subtitle2, Caption1,
} from '@fluentui/react-components';
import {
  Globe24Regular, Apps24Regular, Box24Regular, Key24Regular, Tag24Regular,
  Server24Regular, ShieldTask24Regular, PersonBoard24Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { ApimServicePane } from '@/lib/components/admin/apim-service-pane';
import { ApimApisPane } from '@/lib/components/admin/apim-apis-pane';
import { ApimProductsPane } from '@/lib/components/admin/apim-products-pane';
import { ApimSubscriptionsPane } from '@/lib/components/admin/apim-subscriptions-pane';
import { ApimNamedValuesPane } from '@/lib/components/admin/apim-named-values-pane';
import { ApimBackendsPane } from '@/lib/components/admin/apim-backends-pane';
import { ApimPoliciesPane } from '@/lib/components/admin/apim-policies-pane';
import { ApimDeveloperPortalPane } from '@/lib/components/admin/apim-developer-portal-pane';

interface GateResponse {
  configured: boolean;
  apimName?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  reason?: string;
  hint?: string;
  bicepModule?: string;
}

const useStyles = makeStyles({
  // Modern lede: a Fluent icon + subtitle row over a constrained-width hint,
  // matching the icon-headed sections on the polished Health / Scaling pages.
  lede: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  ledeIcon: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontSize: '22px',
    boxShadow: tokens.shadow4,
  },
  ledeText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  ledeHint: { color: tokens.colorNeutralForeground2, lineHeight: 1.5, maxWidth: '760px' },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '200px',
  },
  gateBody: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
});

export default function ApiManagementPage() {
  const styles = useStyles();
  const [gate, setGate] = useState<GateResponse | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('service');

  useEffect(() => {
    // Resolve the APIM gate config. The spinner shows only while `gate === null`,
    // so EVERY path below must end with setGate/​setUnauth — otherwise the page
    // spins forever (the bug this fixes: it used to fetch the non-existent
    // /api/marketplace/_gate and only console.error on failure). A 6s timeout
    // guarantees the UI resolves even if the route hangs.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    clientFetch('/api/marketplace/gate', { signal: ctrl.signal, cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) { setUnauth(true); return; }
        const d = await r.json().catch(() => null);
        setGate(d && typeof d.configured === 'boolean'
          ? d
          : { configured: false, reason: 'Could not read APIM configuration.', hint: 'Verify the deployment env (LOOM_APIM_NAME / resource group / subscription).' });
      })
      .catch(() => {
        // Network error / abort / timeout — render the honest not-configured
        // state instead of an endless spinner.
        setGate({ configured: false, reason: 'APIM configuration check timed out or failed.', hint: 'Reload the page; if it persists, verify APIM is provisioned + the env vars are set.' });
      })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, []);

  if (unauth) return <AdminShell sectionTitle="API Management"><SignInRequired subject="APIM admin" /></AdminShell>;

  if (gate === null) {
    return (
      <AdminShell sectionTitle="API Management">
        <Section>
          <div className={styles.loading}>
            <Spinner label="Checking APIM configuration..." />
          </div>
        </Section>
      </AdminShell>
    );
  }

  if (!gate.configured) {
    return (
      <AdminShell sectionTitle="API Management">
        <div className={styles.lede}>
          <span className={styles.ledeIcon}><Globe24Regular /></span>
          <div className={styles.ledeText}>
            <Subtitle2>Azure API Management</Subtitle2>
            <Body1 className={styles.ledeHint}>
              APIM is not provisioned for this deployment. To enable the marketplace and admin
              dashboard, deploy APIM and wire the environment variables.
            </Body1>
          </div>
        </div>
        <MessageBar intent="warning">
          <MessageBarTitle>APIM not configured</MessageBarTitle>
          <MessageBarBody className={styles.gateBody}>
            {gate.reason} — {gate.hint}
          </MessageBarBody>
        </MessageBar>
      </AdminShell>
    );
  }

  return (
    <AdminShell sectionTitle="API Management">
      <div className={styles.lede}>
        <span className={styles.ledeIcon}><Globe24Regular /></span>
        <div className={styles.ledeText}>
          <Subtitle2>Marketplace gateway administration</Subtitle2>
          <Body1 className={styles.ledeHint}>
            Full APIM management: define APIs, organize into products, manage consumer subscriptions,
            set global/product/API policies, and configure named values and backends for the marketplace.
          </Body1>
          {gate.apimName && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Service: {gate.apimName}{gate.resourceGroup ? ` · ${gate.resourceGroup}` : ''}
            </Caption1>
          )}
        </div>
      </div>

      <Section>
        <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value as string)}>
          <Tab value="service" icon={<Server24Regular />}>Service &amp; SKU</Tab>
          <Tab value="apis" icon={<Apps24Regular />}>APIs</Tab>
          <Tab value="products" icon={<Box24Regular />}>Products</Tab>
          <Tab value="subscriptions" icon={<Key24Regular />}>Subscriptions</Tab>
          <Tab value="named-values" icon={<Tag24Regular />}>Named values</Tab>
          <Tab value="backends" icon={<Server24Regular />}>Backends</Tab>
          <Tab value="policies" icon={<ShieldTask24Regular />}>Policies</Tab>
          <Tab value="developer-portal" icon={<PersonBoard24Regular />}>Developer portal</Tab>
        </TabList>
      </Section>

      {activeTab === 'service' && <ApimServicePane />}
      {activeTab === 'apis' && <ApimApisPane />}
      {activeTab === 'products' && <ApimProductsPane />}
      {activeTab === 'subscriptions' && <ApimSubscriptionsPane />}
      {activeTab === 'named-values' && <ApimNamedValuesPane />}
      {activeTab === 'backends' && <ApimBackendsPane />}
      {activeTab === 'policies' && <ApimPoliciesPane />}
      {activeTab === 'developer-portal' && <ApimDeveloperPortalPane />}
    </AdminShell>
  );
}
