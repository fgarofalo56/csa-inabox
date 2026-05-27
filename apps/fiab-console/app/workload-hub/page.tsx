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
 * v3.27 replaced the redirect-to-/workloads stub. Future v3.x:
 *   - per-workload landing pages under /workload-hub/<id>
 *   - "Add to workspace" inline action that wires capacity assignment
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Spinner, makeStyles, tokens, Badge, Button, Caption1, Subtitle2, Body1,
} from '@fluentui/react-components';
import {
  Database24Regular, DataLine24Regular, Flow24Regular, Bot24Regular,
  ServerRegular, ChartMultiple24Regular, Earth24Regular,
  Shield24Regular, Diversity24Regular, Code24Regular, Cloud24Regular,
  AppGeneric24Regular, PuzzlePieceRegular,
  ArrowRight24Regular,
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
    padding: '28px 32px',
    borderRadius: 16,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 100%)`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    marginBottom: 32,
    display: 'flex', gap: 28, alignItems: 'center', flexWrap: 'wrap',
  },
  heroText: { flex: 1, minWidth: 320 },
  heroTitle: { fontSize: 24, fontWeight: 600, marginBottom: 8, lineHeight: 1.3 },
  heroBody: { color: tokens.colorNeutralForeground2, fontSize: 14, lineHeight: 1.55 },
  heroStat: {
    display: 'flex', flexDirection: 'column',
    padding: '16px 24px', borderRadius: 12,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    minWidth: 140,
  },
  heroStatVal: { fontSize: 30, fontWeight: 700, color: tokens.colorBrandForeground1, lineHeight: 1.1 },
  heroStatLabel: { fontSize: 12, color: tokens.colorNeutralForeground3, marginTop: 4 },
  section: { marginBottom: 36 },
  sectionHeader: {
    display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16,
    paddingLeft: 4,
  },
  sectionTitle: { fontSize: 17, fontWeight: 600 },
  sectionCount: { color: tokens.colorNeutralForeground3, fontSize: 13 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: 20,
  },
  card: {
    padding: 20, borderRadius: 14,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    transition: 'transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease',
    display: 'flex', flexDirection: 'column', gap: 10,
    minHeight: 110,
    ':hover': {
      transform: 'translateY(-3px)',
      boxShadow: tokens.shadow16,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  cardRow: { display: 'flex', alignItems: 'center', gap: 14 },
  iconBox: {
    width: 44, height: 44, borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    // background/foreground colors are applied per-icon via inline style
    // (see iconStyleFor below) so each workload family gets its own
    // distinct tint instead of every card being brand-blue.
  },
  name: {
    fontSize: 15, fontWeight: 600,
    flex: 1, minWidth: 0,
    paddingRight: 4,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  desc: {
    fontSize: 13, color: tokens.colorNeutralForeground2, lineHeight: 1.5,
    overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    paddingLeft: 58,    // align desc with the title text, past the icon
  },
  ctaCard: {
    padding: '24px 28px', borderRadius: 14,
    border: `1px dashed ${tokens.colorBrandStroke2}`,
    backgroundColor: tokens.colorBrandBackground2,
    display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
  },
});

/**
 * Per-icon palette — each workload family gets a distinct fill so the grid
 * scans as a visual category map (not 12 identical blue tiles).
 * Pairs a tile-background tint with a contrasting icon foreground.
 */
const ICON_PALETTE = {
  warehouse:  { bg: '#E3F2FD', fg: '#0d47a1' },    // blue
  rti:        { bg: '#F3E5F5', fg: '#6a1b9a' },    // purple
  pipeline:   { bg: '#E0F2F1', fg: '#00695C' },    // teal
  bot:        { bg: '#E8F5E9', fg: '#2E7D32' },    // green
  database:   { bg: '#FFF3E0', fg: '#E65100' },    // orange
  powerbi:    { bg: '#FFFDE7', fg: '#F9A825' },    // amber
  geo:        { bg: '#E0F7FA', fg: '#00838F' },    // cyan
  shield:     { bg: '#FFEBEE', fg: '#C62828' },    // red
  industry:   { bg: '#F1F8E9', fg: '#558B2F' },    // light-green
  graph:      { bg: '#EDE7F6', fg: '#4527A0' },    // deep-purple
  ml:         { bg: '#FCE4EC', fg: '#AD1457' },    // pink
  platform:   { bg: '#ECEFF1', fg: '#37474F' },    // blue-grey
  default:    { bg: '#F5F5F5', fg: '#424242' },    // neutral
} as const;

function workloadIcon(id: string, name: string): { node: React.ReactNode; palette: { bg: string; fg: string } } {
  const key = (id + ' ' + name).toLowerCase();
  if (key.includes('warehouse') || key.includes('sql')) return { node: <Database24Regular />, palette: ICON_PALETTE.warehouse };
  if (key.includes('realtime') || key.includes('rti') || key.includes('stream')) return { node: <DataLine24Regular />, palette: ICON_PALETTE.rti };
  if (key.includes('factory') || key.includes('pipeline') || key.includes('engineering')) return { node: <Flow24Regular />, palette: ICON_PALETTE.pipeline };
  if (key.includes('copilot') || key.includes('agent')) return { node: <Bot24Regular />, palette: ICON_PALETTE.bot };
  if (key.includes('database')) return { node: <ServerRegular />, palette: ICON_PALETTE.database };
  if (key.includes('power-bi') || key.includes('powerbi') || key.includes('bi')) return { node: <ChartMultiple24Regular />, palette: ICON_PALETTE.powerbi };
  if (key.includes('geo') || key.includes('map')) return { node: <Earth24Regular />, palette: ICON_PALETTE.geo };
  if (key.includes('fedramp') || key.includes('compliance')) return { node: <Shield24Regular />, palette: ICON_PALETTE.shield };
  if (key.includes('industry')) return { node: <Diversity24Regular />, palette: ICON_PALETTE.industry };
  if (key.includes('graph') || key.includes('vector')) return { node: <PuzzlePieceRegular />, palette: ICON_PALETTE.graph };
  if (key.includes('data-science') || key.includes('ml') || key.includes('ai')) return { node: <Code24Regular />, palette: ICON_PALETTE.ml };
  if (key.includes('platform')) return { node: <Cloud24Regular />, palette: ICON_PALETTE.platform };
  return { node: <AppGeneric24Regular />, palette: ICON_PALETTE.default };
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
              Real-Time Intelligence brings Eventhouse + KQL + Activator. Click any tile to jump straight into
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
            <div className={s.sectionTitle}>My workloads</div>
            <Caption1 className={s.sectionCount}>· {mine.length}</Caption1>
          </div>
          <div className={s.grid}>
            {mine.map((w) => {
              const { node: iconNode, palette } = workloadIcon(w.id, w.name);
              return (
                <div
                  key={w.id}
                  className={s.card}
                  role="button"
                  tabIndex={0}
                  onClick={() => openWorkload(w)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWorkload(w); } }}
                >
                  <div className={s.cardRow}>
                    <div className={s.iconBox} style={{ backgroundColor: palette.bg, color: palette.fg }}>{iconNode}</div>
                    <div className={s.name}>{w.name}</div>
                    {w.category === 'CSA' && (
                      <Badge appearance="outline" color="brand" size="small">CSA</Badge>
                    )}
                  </div>
                  {w.description && <div className={s.desc}>{w.description}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {items !== null && (
        <div className={s.section}>
          <div className={s.sectionHeader}>
            <div className={s.sectionTitle}>More workloads</div>
            <Caption1 className={s.sectionCount}>· {more.length} available</Caption1>
          </div>
          <div className={s.ctaCard}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <Subtitle2>Browse the full workload catalog</Subtitle2>
              <Body1 style={{ fontSize: 13, color: tokens.colorNeutralForeground2 }}>
                Compliance, Geoanalytics, Graph + Vector, and other optional accelerators ship with Loom but stay opt-in until you enable them.
              </Body1>
            </div>
            <Link href="/workloads" passHref legacyBehavior>
              <Button appearance="primary" icon={<ArrowRight24Regular />} iconPosition="after">
                Browse all workloads
              </Button>
            </Link>
          </div>
        </div>
      )}
    </PageShell>
  );
}
