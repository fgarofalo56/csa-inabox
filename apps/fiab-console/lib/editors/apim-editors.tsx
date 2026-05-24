'use client';

/**
 * APIM-related editors — surface Azure API Management 1:1 inside Loom
 * so users never have to context-switch to the APIM portal. APIM is
 * the API-first glue per the CSA reference architecture: every Loom
 * function, ML endpoint, GraphQL API, and data-product surface is
 * fronted through APIM for auth, rate limiting, observability, and
 * marketplace discovery.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Dropdown, Option, Textarea,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  monaco: {
    width: '100%', minHeight: 200,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  card: { padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 },
});

const API_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'API', actions: [{ label: 'Test' }, { label: 'Revisions' }, { label: 'Versions' }] },
    { label: 'Definition', actions: [{ label: 'Import OpenAPI' }, { label: 'Import GraphQL' }, { label: 'Edit OpenAPI' }] },
    { label: 'Policy', actions: [{ label: 'Inbound' }, { label: 'Backend' }, { label: 'Outbound' }, { label: 'On error' }] },
    { label: 'Subscriptions', actions: [{ label: 'Subscribers' }, { label: 'Quotas' }] },
  ]},
];

export function ApimApiEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<'design' | 'operations' | 'policy' | 'test' | 'monitor'>('design');
  return (
    <ItemEditorChrome item={item} id={id} ribbon={API_RIBBON} main={
      <>
        <div style={{ padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="design">Design</Tab>
            <Tab value="operations">Operations (12)</Tab>
            <Tab value="policy">Policy</Tab>
            <Tab value="test">Test console</Tab>
            <Tab value="monitor">Monitor</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          {tab === 'design' && (<>
            <div style={{ display: 'flex', gap: 12 }}>
              <Badge appearance="filled" color="brand">v2.1 · published</Badge>
              <Badge appearance="outline">Subscription key required</Badge>
              <Badge appearance="outline">JWT validated (Entra)</Badge>
            </div>
            <Subtitle2>Backends</Subtitle2>
            <div className={s.cardGrid}>
              {['fin-warehouse (Synapse SQL)', 'churn-model (Azure ML endpoint)', 'orders-graphql (GraphQL API)', 'silver_revenue (Loom Lakehouse SQL endpoint)'].map((b) =>
                <div key={b} className={s.card}>{b}</div>)}
            </div>
            <Subtitle2 style={{ marginTop: 12 }}>OpenAPI spec</Subtitle2>
            <textarea className={s.monaco} spellCheck={false} aria-label="OpenAPI"
              defaultValue={`openapi: 3.0.3\ninfo:\n  title: Orders API\n  version: 2.1.0\npaths:\n  /orders:\n    get:\n      summary: List orders for the calling customer\n      security:\n        - apiKey: []\n        - bearer: []\n      responses:\n        '200': { description: ok }\n`} />
          </>)}
          {tab === 'operations' && (
            <Table aria-label="Operations">
              <TableHeader><TableRow>
                <TableHeaderCell>Method</TableHeaderCell><TableHeaderCell>Path</TableHeaderCell>
                <TableHeaderCell>Backend</TableHeaderCell><TableHeaderCell>Auth</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {[
                  ['GET', '/orders', 'silver_revenue (Lakehouse)', 'JWT'],
                  ['GET', '/orders/{id}', 'silver_revenue (Lakehouse)', 'JWT'],
                  ['POST','/orders/score', 'churn-model (AML)', 'JWT + APIM key'],
                  ['POST','/etl/orders/refresh', 'orders-pipeline (ADF)', 'APIM key only'],
                ].map((r) => <TableRow key={r[1] + r[0]}>{r.map((c, i) => <TableCell key={i}>{c}</TableCell>)}</TableRow>)}
              </TableBody>
            </Table>
          )}
          {tab === 'policy' && (
            <textarea className={s.monaco} spellCheck={false} aria-label="Inbound policy"
              defaultValue={`<policies>\n  <inbound>\n    <base />\n    <validate-jwt header-name="Authorization" failed-validation-httpcode="401">\n      <openid-config url="https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" />\n    </validate-jwt>\n    <rate-limit calls="60" renewal-period="60" />\n    <cors><allowed-origins><origin>*</origin></allowed-origins></cors>\n  </inbound>\n  <backend><base /></backend>\n  <outbound><base /></outbound>\n  <on-error><base /></on-error>\n</policies>`} />
          )}
          {tab === 'test' && (
            <Body1>Interactive request console (subscription key + JWT prefilled from your session).</Body1>
          )}
          {tab === 'monitor' && (
            <Body1>Calls last 24 h: <b>112,402</b> · P95 latency: <b>140 ms</b> · Errors: <b>0.42%</b> · Throttled: <b>18</b></Body1>
          )}
        </div>
      </>
    } />
  );
}

const PRODUCT_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Product', actions: [{ label: 'Publish' }, { label: 'Unpublish' }, { label: 'Approval rules' }] },
    { label: 'APIs', actions: [{ label: '+ Add API' }, { label: 'Remove API' }] },
    { label: 'Subscriptions', actions: [{ label: 'Subscribers' }, { label: 'Quotas' }] },
  ]},
];
export function ApimProductEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={PRODUCT_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>Product · Customer 360</Subtitle2>
        <Body1>Bundles 4 APIs into one subscribable product surfaced in the developer portal + Loom marketplace.</Body1>
        <Subtitle2 style={{ marginTop: 8 }}>APIs included</Subtitle2>
        <div className={s.cardGrid}>
          {['Orders API v2.1', 'Customers API v1.4', 'Churn Predictions API v0.9', 'Loyalty Tier API v1.0'].map((a) => <div key={a} className={s.card}>{a}</div>)}
        </div>
        <Caption1>Subscribers: 12 internal apps · 3 partner tenants · Quotas: 10k req/day per subscription</Caption1>
      </div>
    } />
  );
}

const POLICY_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Edit', actions: [{ label: 'Inbound' }, { label: 'Backend' }, { label: 'Outbound' }, { label: 'On error' }] },
    { label: 'Validate', actions: [{ label: 'Lint' }, { label: 'Test' }] },
  ]},
];
export function ApimPolicyEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={POLICY_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>Policy XML</Subtitle2>
        <textarea className={s.monaco} spellCheck={false} aria-label="Policy XML"
          defaultValue={`<policies>\n  <inbound>\n    <base />\n    <set-backend-service base-url="@(context.Variables.GetValueOrDefault('backend'))" />\n    <validate-jwt header-name="Authorization" />\n    <rate-limit calls="120" renewal-period="60" />\n  </inbound>\n</policies>`} />
      </div>
    } />
  );
}

const DP_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Product', actions: [{ label: 'Publish to marketplace' }, { label: 'Request access' }] },
    { label: 'Contract', actions: [{ label: 'Semantic schema' }, { label: 'SLA' }, { label: 'Owner' }] },
  ]},
];
export function DataProductEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DP_RIBBON} main={
      <div className={s.pad}>
        <div style={{ display: 'flex', gap: 12 }}>
          <Badge appearance="filled" color="brand">Domain: Finance</Badge>
          <Badge appearance="outline">Owner: alice@contoso</Badge>
          <Badge appearance="outline" color="success">Certified</Badge>
        </div>
        <Subtitle2>Customer 360 — gold revenue + churn</Subtitle2>
        <Body1>Versioned data product. Backed by silver_revenue (Lakehouse) + churn-model (AML). Consumed via APIM API <code>orders-api/v2.1</code>. Subscribed by 12 internal apps.</Body1>
        <Subtitle2 style={{ marginTop: 8 }}>Bundle</Subtitle2>
        <div className={s.cardGrid}>
          {[
            'Dataset: silver_revenue (Delta)',
            'Semantic contract: orders.yaml (v2)',
            'APIM API: orders-api v2.1',
            'Access policy: tier ≥ Gold',
            'SLA: 99.9% · P95 < 200 ms',
            'Lineage: 6 upstream sources',
          ].map((b) => <div key={b} className={s.card}>{b}</div>)}
        </div>
      </div>
    } />
  );
}
