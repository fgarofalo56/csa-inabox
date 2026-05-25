'use client';

/**
 * RealTimeHubPane — source catalog grouped per the inventory §2.4.
 * Sections: Microsoft / Azure / External / Fabric events / Sample.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';

const SOURCES = [
  // Microsoft / Azure
  { n: 'Azure Event Hubs',       cat: 'Microsoft', preview: false },
  { n: 'Azure IoT Hub',          cat: 'Microsoft', preview: false },
  { n: 'Azure Service Bus',      cat: 'Microsoft', preview: true  },
  { n: 'Azure SQL DB CDC',       cat: 'Microsoft', preview: false },
  { n: 'PostgreSQL CDC',         cat: 'Microsoft', preview: false },
  { n: 'MySQL CDC',              cat: 'Microsoft', preview: false },
  { n: 'Cosmos DB CDC',          cat: 'Microsoft', preview: false },
  { n: 'SQL MI CDC',             cat: 'Microsoft', preview: false },
  { n: 'SQL Server on VM CDC',   cat: 'Microsoft', preview: false },
  { n: 'Azure Data Explorer',    cat: 'Microsoft', preview: false },
  { n: 'Event Grid Namespace',   cat: 'Microsoft', preview: false },
  { n: 'Blob Storage events',    cat: 'Microsoft', preview: false },
  // External
  { n: 'Google Cloud Pub/Sub',   cat: 'External',  preview: false },
  { n: 'Amazon Kinesis',         cat: 'External',  preview: false },
  { n: 'Confluent Cloud Kafka',  cat: 'External',  preview: false },
  { n: 'Apache Kafka',           cat: 'External',  preview: true  },
  { n: 'Amazon MSK',             cat: 'External',  preview: false },
  { n: 'MQTT',                   cat: 'External',  preview: true  },
  { n: 'Solace PubSub+',         cat: 'External',  preview: true  },
  { n: 'Real-time weather',      cat: 'External',  preview: false },
  // Fabric events
  { n: 'Fabric workspace events', cat: 'Fabric events', preview: false },
  { n: 'OneLake events',         cat: 'Fabric events', preview: false },
  { n: 'Job events',             cat: 'Fabric events', preview: false },
  { n: 'Capacity overview events', cat: 'Fabric events', preview: true },
  // Sample
  { n: 'Bicycles',               cat: 'Sample',    preview: false },
  { n: 'Yellow Taxi',            cat: 'Sample',    preview: false },
  { n: 'Stock Market',           cat: 'Sample',    preview: false },
  { n: 'Buses',                  cat: 'Sample',    preview: false },
];

const useStyles = makeStyles({
  bar: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  card: {
    padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 6, cursor: 'pointer',
    ':hover': { borderColor: tokens.colorBrandStroke1 },
  },
});

export function RealTimeHubPane() {
  const s = useStyles();
  const [tab, setTab] = useState('Microsoft');
  const [q, setQ] = useState('');
  const items = SOURCES.filter((x) => x.cat === tab && (!q || x.n.toLowerCase().includes(q.toLowerCase())));
  const cats = ['Microsoft', 'External', 'Fabric events', 'Sample'];
  return (
    <div>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
        {cats.map((c) => <Tab key={c} value={c}>{c} sources ({SOURCES.filter((s) => s.cat === c).length})</Tab>)}
      </TabList>
      <div style={{ marginTop: 12 }}>
        <div className={s.bar}>
          <Input contentBefore={<Search20Regular />} placeholder="Search sources" value={q} onChange={(_, d) => setQ(d.value)} style={{ flex: 1 }} />
        </div>
        <div className={s.cardGrid}>
          {items.map((x) => (
            <div key={x.n} className={s.card}>
              <Body1 style={{ fontWeight: 600 }}>{x.n}</Body1>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{x.cat}</Caption1>
              {x.preview && <Badge appearance="outline" color="warning" style={{ marginTop: 6 }}>Preview</Badge>}
            </div>
          ))}
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: 12, display: 'block' }}>
          Quick actions: Subscribe to OneLake events · Act on Job events · Visualize data · Set alerts
        </Caption1>
      </div>
    </div>
  );
}
