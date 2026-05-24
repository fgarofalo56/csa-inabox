'use client';

import {
  Card, CardHeader, CardPreview,
  Subtitle1, Subtitle2, Body1, Title2, Title3, Caption1, Badge,
  makeStyles, tokens, Button,
} from '@fluentui/react-components';
import {
  Database24Filled, Flash24Filled, ChartMultiple24Filled, ShieldCheckmark24Filled,
  Sparkle24Filled, Bot24Filled, Apps24Filled, ServerLink24Filled,
} from '@fluentui/react-icons';
import Link from 'next/link';
import { PageShell } from '@/lib/components/page-shell';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { LoomLogo } from '@/lib/components/loom-logo';

const useStyles = makeStyles({
  hero: {
    background: 'var(--loom-hero-bg)',
    color: 'white',
    padding: '40px 48px',
    borderRadius: 16,
    marginBottom: 24,
    display: 'flex',
    alignItems: 'center',
    gap: 32,
    boxShadow: '0 12px 32px rgba(31, 111, 235, 0.18)',
    position: 'relative',
    overflow: 'hidden',
  },
  heroPattern: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(circle at 90% 10%, rgba(255,255,255,0.18), transparent 45%), radial-gradient(circle at 10% 110%, rgba(216,159,61,0.30), transparent 50%)',
    pointerEvents: 'none',
  },
  heroCopy: { flex: 1, position: 'relative' },
  heroTitle: { color: 'white', fontWeight: 700, letterSpacing: '-0.01em' },
  heroSub: { color: 'rgba(255,255,255,0.92)', fontSize: 16, lineHeight: 1.55, maxWidth: 720, marginTop: 8 },
  heroChips: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 },
  chip: {
    fontSize: 12, padding: '4px 10px', borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.25)',
    color: 'white', backdropFilter: 'blur(8px)',
  },
  sectionTitle: { marginTop: 24, marginBottom: 12, display: 'flex', alignItems: 'baseline', gap: 10 },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14,
  },
  card: {
    padding: 18, cursor: 'pointer', height: '100%',
    transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    ':hover': {
      transform: 'translateY(-3px)',
      boxShadow: tokens.shadow16,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  cardIcon: {
    width: 40, height: 40, borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'white', marginBottom: 12,
  },
});

interface Quick {
  href: string;
  title: string;
  body: string;
  icon: React.ReactNode;
  tint: string;
}

const QUICK_LINKS: Quick[] = [
  { href: '/workspaces', title: 'Workspaces', body: 'Open or create a workspace. Items live inside workspaces.',
    icon: <Apps24Filled />, tint: 'linear-gradient(135deg, #3d2e80, #5e4dc0)' },
  { href: '/onelake', title: 'OneLake catalog', body: 'Find data across every workspace, with lineage and sensitivity labels.',
    icon: <Database24Filled />, tint: 'linear-gradient(135deg, #117865, #1dbe9c)' },
  { href: '/governance', title: 'Governance', body: 'Lineage scans, classifications, sensitivity labels, Purview-backed catalog.',
    icon: <ShieldCheckmark24Filled />, tint: 'linear-gradient(135deg, #b91c4b, #f25e8a)' },
  { href: '/monitor', title: 'Monitor', body: 'Check the health of pipelines, notebooks, dataflows, ML runs.',
    icon: <ChartMultiple24Filled />, tint: 'linear-gradient(135deg, #ad6800, #d89f3d)' },
  { href: '/realtime-hub', title: 'Real-Time hub', body: '28 streaming sources across Microsoft, external clouds, and Fabric events.',
    icon: <Flash24Filled />, tint: 'linear-gradient(135deg, #0050b3, #1f6feb)' },
  { href: '/items/synapse-dedicated-sql-pool/new', title: 'Synapse, Databricks, ADF', body: 'Underlying Azure services — natively surfaced in Loom, no studio jumps.',
    icon: <ServerLink24Filled />, tint: 'linear-gradient(135deg, #1a1342, #7d6cff)' },
  { href: '/data-agent', title: 'Data agents', body: 'Conversational Q&A grounded in your warehouse, lakehouse, and semantic models.',
    icon: <Bot24Filled />, tint: 'linear-gradient(135deg, #4b1d8f, #9f6df2)' },
  { href: '/copilot', title: 'Copilot', body: 'Full-screen Copilot. Or press Ctrl + / from anywhere.',
    icon: <Sparkle24Filled />, tint: 'linear-gradient(135deg, #c2410c, #f97316)' },
];

const WORKLOADS = [
  'Data Engineering', 'Data Factory', 'Real-Time Intelligence', 'Data Warehouse',
  'Databases', 'Data Science', 'Power BI', 'Fabric IQ', 'APIs & functions',
  'Synapse Analytics', 'Azure Databricks', 'Azure Data Factory',
];

export default function HomePage() {
  const s = useStyles();
  return (
    <PageShell title="Home" subtitle="Welcome to CSA Loom — the unified Azure analytics fabric." actions={<NewItemDialog />}>
      <section className={s.hero}>
        <div className={s.heroPattern} aria-hidden />
        <div style={{ position: 'relative' }}><LoomLogo variant="icon" size={96} /></div>
        <div className={s.heroCopy}>
          <Title2 as="h2" className={s.heroTitle}>One thread across every Azure data service.</Title2>
          <Body1 className={s.heroSub}>
            <b>CSA Loom</b> — <b>Cloud Scale Analytics Loom</b> — weaves Fabric, Synapse, Databricks,
            Data Factory, U-SQL, OneLake, and Purview into a single console. Build a Lakehouse,
            query a Synapse SQL pool, run a Databricks notebook, set an Activator alert, and
            promote across Dev → Test → Prod — without leaving Loom or learning four different studios.
          </Body1>
          <div className={s.heroChips}>
            {WORKLOADS.map((w) => <span key={w} className={s.chip}>{w}</span>)}
          </div>
        </div>
      </section>

      <div className={s.sectionTitle}>
        <Title3 as="h2">Get started</Title3>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Press <kbd style={{ padding: '1px 6px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}>/</kbd> to search, <kbd style={{ padding: '1px 6px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}>Ctrl K</kbd> for the command palette
        </Caption1>
      </div>
      <div className={s.grid}>
        {QUICK_LINKS.map((q) => (
          <Link key={q.href} href={q.href} style={{ display: 'block', textDecoration: 'none' }}>
            <Card className={s.card}>
              <div className={s.cardIcon} style={{ background: q.tint }}>{q.icon}</div>
              <Subtitle1>{q.title}</Subtitle1>
              <Body1 style={{ color: tokens.colorNeutralForeground3, marginTop: 4 }}>{q.body}</Body1>
            </Card>
          </Link>
        ))}
      </div>
    </PageShell>
  );
}
