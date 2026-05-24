'use client';

/**
 * WorkloadHubPane — My / More workloads tabs per the inventory §2.5.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge,
  Tab, TabList,
  makeStyles, tokens,
} from '@fluentui/react-components';

const MY = [
  { n: 'Data Engineering', items: 'Lakehouse, Notebook, Spark job, Environment', pub: 'Microsoft' },
  { n: 'Data Factory',     items: 'Pipeline, Dataflow Gen2, Copy job, Mirrored DB, dbt, Mounted ADF', pub: 'Microsoft' },
  { n: 'Real-Time Intelligence', items: 'Eventhouse, KQL DB, Queryset, Dashboard, Eventstream, Activator', pub: 'Microsoft' },
  { n: 'Data Warehouse',   items: 'Warehouse, SQL analytics endpoint', pub: 'Microsoft' },
  { n: 'Databases',        items: 'SQL database', pub: 'Microsoft' },
  { n: 'Data Science',     items: 'ML model, ML experiment', pub: 'Microsoft' },
  { n: 'Fabric IQ',        items: 'Ontology, Plan, Graph, Maps, Data agent, Operations agent', pub: 'Microsoft', preview: true },
  { n: 'Power BI',         items: 'Semantic model, Report, Dashboard, Paginated, Scorecard', pub: 'Microsoft' },
  { n: 'APIs and functions', items: 'GraphQL API, User data function, Variable library', pub: 'Microsoft' },
];
const MORE = [
  { n: 'Esri ArcGIS', items: 'Geo-enrichment maps', pub: 'Esri' },
  { n: 'SAS Viya',    items: 'SAS notebooks, models', pub: 'SAS' },
  { n: 'Teradata AI Unlimited', items: 'In-database analytics', pub: 'Teradata' },
  { n: 'Striim SQL2Fabric',     items: 'On-prem SQL Server replication', pub: 'Striim' },
  { n: 'Statsig',     items: 'Warehouse-native experiments', pub: 'Statsig' },
];

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginTop: 12 },
  card: {
    padding: 14, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 6, backgroundColor: tokens.colorNeutralBackground1,
  },
});

export function WorkloadHubPane() {
  const s = useStyles();
  const [tab, setTab] = useState('my');
  return (
    <div>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
        <Tab value="my">My workloads ({MY.length})</Tab>
        <Tab value="more">More workloads ({MORE.length})</Tab>
      </TabList>
      <div className={s.grid}>
        {(tab === 'my' ? MY : MORE).map((w) => (
          <div key={w.n} className={s.card}>
            <Subtitle2>{w.n}</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>by {w.pub}</Caption1>
            <Body1 style={{ marginTop: 6 }}>{w.items}</Body1>
            {(w as { preview?: boolean }).preview && <Badge appearance="outline" color="warning" style={{ marginTop: 6 }}>Preview</Badge>}
          </div>
        ))}
      </div>
    </div>
  );
}
