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
  ServerSurface24Regular, ChartMultiple24Regular, Earth24Regular,
  Shield24Regular, Diversity24Regular, Code24Regular, Cloud24Regular,
  AppGeneric24Regular, PuzzlePiece24Regular,
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
    padding: '24px 24px 20px',
    borderRadius: 12,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 100%)`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    marginBottom: 24,
    display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap',
  },
  heroText: { flex: 1, minWidth: 280 },
  heroTitle: { fontSize: 22, fontWeight: 600, marginBottom: 6 },
  heroBody: { color: tokens.colorNeutralForeground2, fontSize: 14, lineHeight: 1.5 },
  heroStat: {
    display: 'flex', flexDirection: 'column',
    padding: '12px 20px', borderRadius: 8,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  heroStatVal: { fontSize: 28, fontWeight: 600, color: tokens.colorBrandForeground1 },
  heroStatLabel: { fontSize: 12, color: tokens.colorNeutralForeground3 },
  section: { marginBottom: 28 },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12,
  },
  sectionTitle: { fontSize: 16, fontWeight: 600 },
  sectionCount: { color: tokens.colorNeutralForeground3, fontSize: 13 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 12,
  },
  card: {
    padding: 14, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
    display: 'flex', flexDirection: 'column', gap: 6,
    ':hover': {
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  cardRow: { display: 'flex', alignItems: 'center', gap: 10 },
  iconBox: {
    width: 36, height: 36, borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  name: { fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0 },
  desc: {
    fontSize: 12, color: tokens.colorNeutralForeground2, lineHeight: 1.4,
    overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    marginTop: 2,
  },
  ctaCard: {
    padding: 18, borderRadius: 10,
    border: `1px dashed ${tokens.colorBrandStroke2}`,
    backgroundColor: tokens.colorBrandBackground2,
    display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
  },
});

function workloadIcon(id: string, name: string): React.ReactNode {
  const key = (id + ' ' + name).toLowerCase();
  if (key.includes('warehouse') || key.includes('sql')) return <Database24Regular />;
  if (key.includes('realtime') || key.includes('rti') || key.includes('stream')) return <DataLine24Regular />;
  if (key.includes('factory') || key.includes('pipeline') || key.includes('engineering')) return <Flow24Regular />;
  if (key.includes('copilot') || key.includes('agent')) return <Bot24Regular />;
  if (key.includes('database')) return <ServerSurface24Regular />;
  if (key.includes('power-bi') || key.includes('powerbi') || key.includes('bi')) return <ChartMultiple24Regular />;
  if (key.includes('geo') || key.includes('map')) return <Earth24Regular />;
  if (key.includes('fedramp') || key.includes('compliance')) return <Shield24Regular />;
  if (key.includes('industry')) return <Diversity24Regular />;
  if (key.includes('graph') || key.includes('vector')) return <PuzzlePiece24Regular />;
  if (key.includes('data-science') || key.includes('ml') || key.includes('ai')) return <Code24Regular />;
  if (key.includes('platform')) return <Cloud24Regular />;
  return <AppGeneric24Regular />;
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
            {mine.map((w) => (
              <div
                key={w.id}
                className={s.card}
                role="button"
                tabIndex={0}
                onClick={() => openWorkload(w)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWorkload(w); } }}
              >
                <div className={s.cardRow}>
                  <div className={s.iconBox}>{workloadIcon(w.id, w.name)}</div>
                  <div className={s.name}>{w.name}</div>
                  {w.category === 'CSA' && (
                    <Badge appearance="outline" color="brand" size="small">CSA</Badge>
                  )}
                </div>
                {w.description && <div className={s.desc}>{w.description}</div>}
              </div>
            ))}
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
