'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  makeStyles, tokens, Tab, TabList, Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  Body1,
} from '@fluentui/react-components';
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
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55, marginBottom: tokens.spacingVerticalL },
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
    fetch('/api/marketplace/gate', { signal: ctrl.signal, cache: 'no-store' })
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
        <Section><Spinner label="Checking APIM configuration..." /></Section>
      </AdminShell>
    );
  }

  if (!gate.configured) {
    return (
      <AdminShell sectionTitle="API Management">
        <Body1 className={styles.intro}>
          Azure API Management is not provisioned for this deployment. To enable the marketplace and admin
          dashboard, deploy APIM and wire the environment variables.
        </Body1>
        <MessageBar intent="warning">
          <MessageBarTitle>APIM not configured</MessageBarTitle>
          <MessageBarBody>
            {gate.reason} — {gate.hint}
          </MessageBarBody>
        </MessageBar>
      </AdminShell>
    );
  }

  return (
    <AdminShell sectionTitle="API Management">
      <Body1 className={styles.intro}>
        Full APIM management: define APIs, organize into products, manage consumer subscriptions,
        set global/product/API policies, and configure named values and backends for the marketplace.
      </Body1>
      
      <Section>
        <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value as string)}>
          <Tab value="service">Service & SKU</Tab>
          <Tab value="apis">APIs</Tab>
          <Tab value="products">Products</Tab>
          <Tab value="subscriptions">Subscriptions</Tab>
          <Tab value="named-values">Named values</Tab>
          <Tab value="backends">Backends</Tab>
          <Tab value="policies">Policies</Tab>
          <Tab value="developer-portal">Developer portal</Tab>
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
