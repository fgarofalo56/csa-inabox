'use client';

/**
 * /workload-hub — Fabric-parity Workload hub landing page.
 *
 * Two surfaces in one page:
 *   1. "My workloads" — the workloads currently included in this tenant
 *      (loaded from /api/workloads-catalog, filtered to `included` or `CSA`)
 *   2. "More workloads" — discovery view linking to /workloads for the full
 *      catalog including optional add-ons.
 *
 * v3.28 visual redesign: the dense horizontal cards were replaced with
 * spaced, vertical workload cards that match the homepage "Get started"
 * aesthetic — a large gradient-tinted colored icon at the top of each card,
 * generous 24px padding so nothing butts the border, a clear title, a
 * 2-line description, and a footer row showing the real item-type count in
 * the workload. Per-workload colors are preserved (the operator likes the
 * color-coded icons); only the layout/spacing/hierarchy changed. Data and
 * navigation are unchanged.
 *
 * v3.27 replaced the redirect-to-/workloads stub. Future v3.x:
 *   - per-workload landing pages under /workload-hub/<id>
 *   - "Add to workspace" inline action that wires capacity assignment
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner, makeStyles, tokens, Badge, Button, Caption1, Subtitle1, Subtitle2, Body1, Title3,
} from '@fluentui/react-components';
import {
  Database24Filled, DataLine24Filled, Flow24Filled, Bot24Filled,
  Server24Filled, ChartMultiple24Filled, Earth24Filled,
  Shield24Filled, Diversity24Filled, Code24Filled, Cloud24Filled,
  AppGeneric24Filled, PuzzlePiece24Filled,
  ArrowRight24Regular, ChevronRight16Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';

interface Workload {
  id: string; name: string; description?: string;
  category?: string; included?: boolean;
  featureSlugs?: string[];
}

const useStyles = makeStyles({
  hero: {
    paddingTop: 32, paddingRight: 36, paddingBottom: 32, paddingLeft: 36,
    borderRadius: 18,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 100%)`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    marginBottom: 36,
    display: 'flex', gap: 32, alignItems: 'center', flexWrap: 'wrap',
  },
  heroText: { flex: 1, minWidth: 320 },
  heroTitle: { fontSize: 24, fontWeight: 700, marginBottom: 10, lineHeight: 1.3, letterSpacing: '-0.01em' },
  heroBody: { color: tokens.colorNeutralForeground2, fontSize: 14, lineHeight: 1.55, maxWidth: 680 },
  heroStat: {
    display: 'flex', flexDirection: 'column',
    paddingTop: 18, paddingRight: 26, paddingBottom: 18, paddingLeft: 26,
    borderRadius: 14,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    minWidth: 148,
    boxShadow: tokens.shadow4,
  },
  heroStatVal: { fontSize: 32, fontWeight: 700, color: tokens.colorBrandForeground1, lineHeight: 1.1 },
  heroStatLabel: { fontSize: 12, color: tokens.colorNeutralForeground3, marginTop: 6 },
  section: { marginBottom: 40 },
  sectionHeader: {
    display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18,
    paddingLeft: 2,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: 24,
  },
  card: {
    paddingTop: 24, paddingRight: 24, paddingBottom: 20, paddingLeft: 24,
    borderRadius: 14,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    height: '100%',
    boxSizing: 'border-box',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
    display: 'flex', flexDirection: 'column',
    ':hover': {
      transform: 'translateY(-3px)',
      boxShadow: tokens.shadow16,
      borderColor: tokens.colorBrandStroke1,
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: '2px',
    },
  },
  cardTop: {
    display: 'flex', alignItems: 'flex-start', gap: 12,
    marginBottom: 16,
  },
  iconBox: {
    width: 48, height: 48, borderRadius: 13,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    color: 'white',
    // gradient background applied per-workload via inline style (see workloadVisual)
  },
  badgeSlot: { marginLeft: 'auto', flexShrink: 0 },
  name: {
    fontSize: 16, fontWeight: 600, lineHeight: 1.3,
    marginBottom: 8, display: 'block',
  },
  desc: {
    fontSize: 13, color: tokens.colorNeutralForeground3, lineHeight: 1.55,
    overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    margin: 0,
  },
  cardFooter: {
    display: 'flex', alignItems: 'center', gap: 6,
    marginTop: 'auto', paddingTop: 16,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3, fontSize: 12,
  },
  footerCount: { fontWeight: 600, color: tokens.colorNeutralForeground2 },
  footerArrow: {
    marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2,
    color: tokens.colorBrandForeground1, fontWeight: 600,
  },
  ctaCard: {
    paddingTop: 24, paddingRight: 28, paddingBottom: 24, paddingLeft: 28,
    borderRadius: 14,
    border: `1px dashed ${tokens.colorBrandStroke2}`,
    backgroundColor: tokens.colorBrandBackground2,
    display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
  },
});

/**
 * Per-workload-family gradient + icon. Each family gets a distinct gradient
 * tile (white icon on a colored gradient, matching the homepage "Get
 * started" quick-link tiles) so the grid scans as a visual category map
 * instead of identical brand-blue tiles. Gradients mirror the homepage and
 * item-type-icon palettes so the surfaces visually rhyme.
 */
const WORKLOAD_STYLE = {
  warehouse:  { grad: 'linear-gradient(135deg, #0050b3, #1f6feb)' },  // blue
  rti:        { grad: 'linear-gradient(135deg, #4b1d8f, #9f6df2)' },  // purple
  pipeline:   { grad: 'linear-gradient(135deg, #117865, #1dbe9c)' },  // teal-green
  bot:        { grad: 'linear-gradient(135deg, #1a7f4e, #34c77b)' },  // green
  database:   { grad: 'linear-gradient(135deg, #ad6800, #d89f3d)' },  // amber-orange
  powerbi:    { grad: 'linear-gradient(135deg, #b88600, #f0c33c)' },  // amber
  geo:        { grad: 'linear-gradient(135deg, #0d7377, #2bb3a3)' },  // cyan-teal
  shield:     { grad: 'linear-gradient(135deg, #b91c4b, #f25e8a)' },  // red-pink
  industry:   { grad: 'linear-gradient(135deg, #558B2F, #8bc34a)' },  // light-green
  graph:      { grad: 'linear-gradient(135deg, #3d2e80, #7d6cff)' },  // violet
  ml:         { grad: 'linear-gradient(135deg, #7c3aed, #b388ff)' },  // purple
  platform:   { grad: 'linear-gradient(135deg, #37474F, #607d8b)' },  // blue-grey
  default:    { grad: 'linear-gradient(135deg, #424242, #6b7280)' },  // neutral
} as const;

function workloadVisual(id: string, name: string): { node: React.ReactNode; grad: string } {
  const key = (id + ' ' + name).toLowerCase();
  if (key.includes('warehouse') || key.includes('sql')) return { node: <Database24Filled />, grad: WORKLOAD_STYLE.warehouse.grad };
  if (key.includes('realtime') || key.includes('rti') || key.includes('stream')) return { node: <DataLine24Filled />, grad: WORKLOAD_STYLE.rti.grad };
  if (key.includes('factory') || key.includes('pipeline') || key.includes('engineering')) return { node: <Flow24Filled />, grad: WORKLOAD_STYLE.pipeline.grad };
  if (key.includes('copilot') || key.includes('agent')) return { node: <Bot24Filled />, grad: WORKLOAD_STYLE.bot.grad };
  if (key.includes('database')) return { node: <Server24Filled />, grad: WORKLOAD_STYLE.database.grad };
  if (key.includes('power-bi') || key.includes('powerbi') || key.includes('bi')) return { node: <ChartMultiple24Filled />, grad: WORKLOAD_STYLE.powerbi.grad };
  if (key.includes('geo') || key.includes('map')) return { node: <Earth24Filled />, grad: WORKLOAD_STYLE.geo.grad };
  if (key.includes('fedramp') || key.includes('compliance')) return { node: <Shield24Filled />, grad: WORKLOAD_STYLE.shield.grad };
  if (key.includes('industry')) return { node: <Diversity24Filled />, grad: WORKLOAD_STYLE.industry.grad };
  if (key.includes('graph') || key.includes('vector')) return { node: <PuzzlePiece24Filled />, grad: WORKLOAD_STYLE.graph.grad };
  if (key.includes('data-science') || key.includes('ml') || key.includes('ai')) return { node: <Code24Filled />, grad: WORKLOAD_STYLE.ml.grad };
  if (key.includes('platform')) return { node: <Cloud24Filled />, grad: WORKLOAD_STYLE.platform.grad };
  return { node: <AppGeneric24Filled />, grad: WORKLOAD_STYLE.default.grad };
}

export default function WorkloadHubPage() {
  const s = useStyles();
  const router = useRouter();
  const [items, setItems] = useState<Workload[] | null>(null);
  const [unauth, setUnauth] = useState(false);

  useEffect(() => {
    fetch('/api/workloads-catalog').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setItems([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setItems(Array.isArray(d?.workloads) ? d.workloads : []);
    }).catch(() => setItems([]));
  }, []);

  const { mine, more } = useMemo(() => {
    const all = items ?? [];
    return {
      mine: all.filter(w => w.included || w.category === 'CSA'),
      more: all.filter(w => !w.included && w.category !== 'CSA'),
    };
  }, [items]);

  function openWorkload(w: Workload) {
    const first = (w.featureSlugs || [])[0];
    if (first) router.push(`/items/${first}/new`);
  }

  function renderCard(w: Workload) {
    const { node: iconNode, grad } = workloadVisual(w.id, w.name);
    const count = (w.featureSlugs || []).length;
    return (
      <div
        key={w.id}
        className={s.card}
        role="button"
        tabIndex={0}
        onClick={() => openWorkload(w)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWorkload(w); } }}
      >
        <div className={s.cardTop}>
          <div className={s.iconBox} style={{ background: grad }}>{iconNode}</div>
          {w.category === 'CSA' && (
            <div className={s.badgeSlot}>
              <Badge appearance="tint" color="brand" size="small">CSA</Badge>
            </div>
          )}
        </div>
        <Subtitle1 className={s.name}>{w.name}</Subtitle1>
        {w.description && <p className={s.desc}>{w.description}</p>}
        <div className={s.cardFooter}>
          <span className={s.footerCount}>{count}</span>
          <span>{count === 1 ? 'item type' : 'item types'}</span>
          <span className={s.footerArrow} aria-hidden>
            Open <ChevronRight16Regular />
          </span>
        </div>
      </div>
    );
  }

  return (
    <PageShell
      title="Workload hub"
      subtitle="Your one-stop view of every workload available in this tenant."
    >
      {unauth && <SignInRequired subject="workloads" />}

      {items !== null && (
        <div className={s.hero}>
          <div className={s.heroText}>
            <div className={s.heroTitle}>Build with the workloads that match your problem</div>
            <Body1 className={s.heroBody}>
              Workloads are bundles of related item types — Data Engineering brings Synapse + ADF + Spark,
              Real-Time Intelligence brings Eventhouse + KQL + Activator. Click any card to jump straight into
              creating an item from that workload.
            </Body1>
          </div>
          <div className={s.heroStat}>
            <div className={s.heroStatVal}>{mine.length}</div>
            <div className={s.heroStatLabel}>included in your tenant</div>
          </div>
          <div className={s.heroStat}>
            <div className={s.heroStatVal}>{more.length}</div>
            <div className={s.heroStatLabel}>optional add-ons</div>
          </div>
        </div>
      )}

      {items === null && <Spinner label="Loading workloads…" />}

      {mine.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionHeader}>
            <Title3 as="h2">My workloads</Title3>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>· {mine.length}</Caption1>
          </div>
          <div className={s.grid}>
            {mine.map(renderCard)}
          </div>
        </div>
      )}

      {items !== null && (
        <div className={s.section}>
          <div className={s.sectionHeader}>
            <Title3 as="h2">More workloads</Title3>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>· {more.length} available</Caption1>
          </div>
          <div className={s.ctaCard}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <Subtitle2>Browse the full workload catalog</Subtitle2>
              <Body1 style={{ fontSize: 13, color: tokens.colorNeutralForeground2, display: 'block', marginTop: 4 }}>
                Compliance, Geoanalytics, Graph + Vector, and other optional accelerators ship with Loom but stay opt-in until you enable them.
              </Body1>
            </div>
            <Button
              as="a"
              href="/workloads"
              appearance="primary"
              icon={<ArrowRight24Regular />}
              iconPosition="after"
            >
              Browse all workloads
            </Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}
