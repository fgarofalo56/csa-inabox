'use client';

import {
  Subtitle1, Body1, Title2, Title3, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database24Filled, Flash24Filled, ChartMultiple24Filled, ShieldCheckmark24Filled,
  Sparkle24Filled, Bot24Filled, Apps24Filled, ServerLink24Filled,
  HatGraduation24Filled,
  Rocket20Filled, History20Filled, AppsAddIn20Filled,
} from '@fluentui/react-icons';
import Link from 'next/link';
import { PageShell } from '@/lib/components/page-shell';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { LoomLogo } from '@/lib/components/loom-logo';
import { RecentItems } from '@/lib/components/recent-items';
import { RecommendedApps } from '@/lib/components/recommended-apps';

const useStyles = makeStyles({
  hero: {
    background: 'var(--loom-hero-bg)',
    color: 'white',
    paddingTop: tokens.spacingVerticalXXXL, paddingRight: tokens.spacingHorizontalXXXL,
    paddingBottom: tokens.spacingVerticalXXXL, paddingLeft: tokens.spacingHorizontalXXXL,
    borderRadius: tokens.borderRadiusXLarge,
    marginBottom: tokens.spacingVerticalXXL,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXXL,
    boxShadow: tokens.shadow16,
    position: 'relative',
    overflow: 'hidden',
  },
  heroPattern: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(circle at 90% 10%, rgba(255,255,255,0.18), transparent 45%), radial-gradient(circle at 10% 110%, rgba(216,159,61,0.30), transparent 50%)',
    pointerEvents: 'none',
  },
  heroCopy: { flex: 1, minWidth: 0, position: 'relative' },
  heroTitle: { color: 'white', fontWeight: 700, letterSpacing: '-0.01em' },
  heroSub: { color: 'rgba(255,255,255,0.92)', fontSize: tokens.fontSizeBase400, lineHeight: 1.6, maxWidth: '720px', marginTop: tokens.spacingVerticalM },
  heroChips: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXL },
  chip: {
    fontSize: tokens.fontSizeBase200,
    paddingTop: tokens.spacingVerticalXS, paddingRight: tokens.spacingHorizontalM,
    paddingBottom: tokens.spacingVerticalXS, paddingLeft: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: 'rgba(255,255,255,0.22)', border: '1px solid rgba(255,255,255,0.35)',
    color: 'white', lineHeight: 1.4, fontWeight: tokens.fontWeightMedium,
    whiteSpace: 'nowrap',
  },
  sectionTitle: {
    marginTop: tokens.spacingVerticalXXL, marginBottom: tokens.spacingVerticalL,
    display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
  },
  sectionHeading: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'flex', alignItems: 'center' },
  card: {
    paddingTop: tokens.spacingVerticalXL, paddingRight: tokens.spacingHorizontalXL,
    paddingBottom: tokens.spacingVerticalXL, paddingLeft: tokens.spacingHorizontalXL,
    cursor: 'pointer', height: '100%',
    display: 'flex', flexDirection: 'column',
    transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    textDecoration: 'none',
    color: tokens.colorNeutralForeground1,
    ':hover': {
      transform: 'translateY(-3px)',
      boxShadow: tokens.shadow16,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  cardIcon: {
    width: '44px', height: '44px', borderRadius: tokens.borderRadiusLarge,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorNeutralForegroundOnBrand, marginBottom: tokens.spacingVerticalL, flexShrink: 0,
  },
  cardTitle: { marginBottom: tokens.spacingVerticalXS, lineHeight: 1.3, display: 'block' },
  cardBody: { color: tokens.colorNeutralForeground3, margin: 0, lineHeight: 1.55, display: 'block' },
});

interface Quick {
  href: string;
  title: string;
  body: string;
  icon: React.ReactNode;
  tint: string;
}

const QUICK_LINKS: Quick[] = [
  { href: '/learn', title: 'Learning Hub', body: 'Step-by-step tutorials, real-world use-case walkthroughs, sample data, and shortcuts — learn by building in Loom.',
    icon: <HatGraduation24Filled />, tint: 'linear-gradient(135deg, #0b6a53, #21c08a)' },
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
        <span className={s.sectionHeading}>
          <span className={s.sectionIcon} aria-hidden><Rocket20Filled /></span>
          <Title3 as="h2">Get started</Title3>
        </span>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Press <kbd style={{ paddingTop: '1px', paddingBottom: '1px', paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusSmall }}>/</kbd> to search, <kbd style={{ paddingTop: '1px', paddingBottom: '1px', paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusSmall }}>Ctrl K</kbd> for the command palette
        </Caption1>
      </div>
      <TileGrid minTileWidth={280}>
        {QUICK_LINKS.map((q) => (
          <Link key={q.href} href={q.href} className={s.card}>
            <div className={s.cardIcon} style={{ background: q.tint }}>{q.icon}</div>
            <Subtitle1 className={s.cardTitle}>{q.title}</Subtitle1>
            <Body1 className={s.cardBody}>{q.body}</Body1>
          </Link>
        ))}
      </TileGrid>

      <div className={s.sectionTitle}>
        <span className={s.sectionHeading}>
          <span className={s.sectionIcon} aria-hidden><History20Filled /></span>
          <Title3 as="h2">Recent</Title3>
        </span>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Items you've opened or edited
        </Caption1>
      </div>
      <RecentItems />

      <div className={s.sectionTitle}>
        <span className={s.sectionHeading}>
          <span className={s.sectionIcon} aria-hidden><AppsAddIn20Filled /></span>
          <Title3 as="h2">Recommended apps</Title3>
        </span>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Curated CSA solutions seeded into this tenant
        </Caption1>
      </div>
      <RecommendedApps />
    </PageShell>
  );
}
