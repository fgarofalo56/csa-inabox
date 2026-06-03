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
    // Fetch APIM gate config from marketplace _gate endpoint
    fetch('/api/marketplace/_gate')
      .then((r) => {
        if (r.status === 401 || r.status === 403) { setUnauth(true); return null; }
        return r.json();
      })
      .then((d) => { if (d) setGate(d); })
      .catch((e) => console.error('Gate check failed:', e));
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
        </TabList>
      </Section>

      {activeTab === 'service' && <ApimServicePane />}
      {activeTab === 'apis' && <ApimApisPane />}
      {activeTab === 'products' && <ApimProductsPane />}
      {activeTab === 'subscriptions' && <ApimSubscriptionsPane />}
      {activeTab === 'named-values' && <ApimNamedValuesPane />}
      {activeTab === 'backends' && <ApimBackendsPane />}
      {activeTab === 'policies' && <ApimPoliciesPane />}
    </AdminShell>
  );
}
