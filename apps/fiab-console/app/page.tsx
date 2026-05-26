'use client';

import {
  Subtitle1, Body1, Title2, Title3, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database24Filled, Flash24Filled, ChartMultiple24Filled, ShieldCheckmark24Filled,
  Sparkle24Filled, Bot24Filled, Apps24Filled, ServerLink24Filled,
} from '@fluentui/react-icons';
import Link from 'next/link';
import { PageShell } from '@/lib/components/page-shell';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { LoomLogo } from '@/lib/components/loom-logo';
import { RecentItems } from '@/lib/components/recent-items';
import { RecommendedApps } from '@/lib/components/recommended-apps';

const useStyles = makeStyles({
  hero: {
    background: 'var(--loom-hero-bg)',
    color: 'white',
    paddingTop: '48px', paddingRight: '56px', paddingBottom: '48px', paddingLeft: '56px',
    borderRadius: '18px',
    marginBottom: '32px',
    display: 'flex',
    alignItems: 'center',
    gap: '40px',
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
  heroSub: { color: 'rgba(255,255,255,0.92)', fontSize: '16px', lineHeight: 1.6, maxWidth: '720px', marginTop: '14px' },
  heroChips: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '24px' },
  chip: {
    fontSize: '12px',
    paddingTop: '7px', paddingRight: '14px', paddingBottom: '7px', paddingLeft: '14px',
    borderRadius: '999px',
    backgroundColor: 'rgba(255,255,255,0.22)', border: '1px solid rgba(255,255,255,0.35)',
    color: 'white', lineHeight: 1.4, fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  sectionTitle: { marginTop: '36px', marginBottom: '16px', display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '20px',
  },
  card: {
    paddingTop: '24px', paddingRight: '24px', paddingBottom: '24px', paddingLeft: '24px',
    cursor: 'pointer', height: '100%',
    display: 'flex', flexDirection: 'column',
    transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: '12px',
    textDecoration: 'none',
    color: tokens.colorNeutralForeground1,
    ':hover': {
      transform: 'translateY(-3px)',
      boxShadow: tokens.shadow16,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  cardIcon: {
    width: '44px', height: '44px', borderRadius: '12px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'white', marginBottom: '18px', flexShrink: 0,
  },
  cardTitle: { marginBottom: '8px', lineHeight: 1.3, display: 'block' },
  cardBody: { color: tokens.colorNeutralForeground3, margin: 0, lineHeight: 1.55, display: 'block' },
});
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
          <Title2 as="h2" className={s.heroTitle}>The Microsoft Fabric experience, on top of Azure-native services.</Title2>
          <Body1 className={s.heroSub}>
            <b>CSA Loom</b> — <b>Cloud Scale Analytics Loom</b> — delivers the Microsoft Fabric experience
            for Azure tenants where Fabric isn&apos;t available (Azure Government, sovereign clouds, regulated
            environments). Lakehouses ride on ADLS + Databricks. Warehouses ride on Synapse SQL pools.
            Notebooks ride on Databricks / Synapse Spark. Pipelines ride on ADF. Governance rides on
            Purview. Loom weaves it all into one console — no studio jumps, no learning four UIs.
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
          <Link key={q.href} href={q.href} className={s.card}>
            <div className={s.cardIcon} style={{ background: q.tint }}>{q.icon}</div>
            <Subtitle1 className={s.cardTitle}>{q.title}</Subtitle1>
            <Body1 className={s.cardBody}>{q.body}</Body1>
          </Link>
        ))}
      </div>

      <div className={s.sectionTitle}>
        <Title3 as="h2">Recent</Title3>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Items you've opened or edited
        </Caption1>
      </div>
      <RecentItems />

      <div className={s.sectionTitle}>
        <Title3 as="h2">Recommended apps</Title3>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Curated CSA solutions seeded into this tenant
        </Caption1>
      </div>
      <RecommendedApps />
    </PageShell>
  );
}
