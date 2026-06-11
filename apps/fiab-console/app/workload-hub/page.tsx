'use client';

/**
 * /workload-hub — Fabric-parity Workload hub landing page.
 *
 * Two surfaces in one page:
 *   1. "My workloads" — the workloads currently included in this tenant
 *      (loaded from /api/workloads-catalog, filtered to `included` or `CSA`)
 *   2. "More workloads" — optional add-ons + a CTA to the full /workloads
 *      catalog.
 *
 * v3.29 Web 3.0 redesign (docs/fiab/design/ui-web3-guide.md):
 *   The bespoke smushed cards/makeStyles were replaced with the shared
 *   primitives so this page rhymes with /browse and /onelake:
 *     • <Section> + <Toolbar> for spacing + a capped (≤360px) search box
 *     • <ViewToggle> Tile|List per collection
 *     • <ItemTile>/<TileGrid> for the tile view — icon + brand color come
 *       from itemVisual(<representative item-type slug>), so every workload
 *       gets a high-quality Fluent glyph color-coded by its family instead of
 *       a hand-rolled gradient map.
 *     • <LoomDataTable> for the list view — sortable / resizable / per-column
 *       filter, padded cells (Name / Category / Item types).
 *   Each workload's representative type = its first featureSlug (always a real
 *   item-type slug per the catalog seed), so the visual is fully driven by the
 *   shared registry. Data + navigation (open first feature's /new) unchanged.
 *
 * Future v3.x:
 *   - per-workload landing pages under /workload-hub/<id>
 *   - "Add to workspace" inline action that wires capacity assignment
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner, makeStyles, tokens, Badge, Button, Body1, MessageBar, MessageBarBody, Text,
} from '@fluentui/react-components';
import { ArrowRight20Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

interface Workload {
  id: string; name: string; description?: string;
  category?: string; included?: boolean;
  featureSlugs?: string[];
  /** Optional experience-home route — when set, opening the workload navigates
   *  here (the experience switcher landing page) instead of the first
   *  feature's /new wizard. */
  homeHref?: string;
}

const LS_VIEW = 'loom.workload-hub.viewMode.v1';

const useStyles = makeStyles({
  hero: {
    display: 'flex',
    gap: tokens.spacingHorizontalXXL,
    alignItems: 'center',
    flexWrap: 'wrap',
    padding: tokens.spacingVerticalXL,
    borderRadius: tokens.borderRadiusXLarge,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 100%)`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
    marginBottom: tokens.spacingVerticalXXL,
  },
  heroText: { flex: 1, minWidth: '320px' },
  heroTitle: {
    fontSize: '24px', fontWeight: 700, lineHeight: 1.3,
    letterSpacing: '-0.01em', marginBottom: tokens.spacingVerticalS,
  },
  heroBody: {
    color: tokens.colorNeutralForeground2, fontSize: '14px',
    lineHeight: 1.55, maxWidth: '680px',
  },
  heroStats: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  heroStat: {
    display: 'flex', flexDirection: 'column',
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    minWidth: '148px',
    boxShadow: tokens.shadow4,
  },
  heroStatVal: {
    fontSize: '32px', fontWeight: 700,
    color: tokens.colorBrandForeground1, lineHeight: 1.1,
  },
  heroStatLabel: {
    fontSize: '12px', color: tokens.colorNeutralForeground3,
    marginTop: tokens.spacingVerticalXS,
  },
  countBadges: {
    display: 'flex', gap: tokens.spacingHorizontalS,
    alignItems: 'center', flexWrap: 'wrap',
  },
  ctaCard: {
    display: 'flex', alignItems: 'center',
    gap: tokens.spacingHorizontalXL, flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalL,
  },
  ctaText: { flex: 1, minWidth: '240px' },
  ctaSub: { color: tokens.colorNeutralForeground2, marginTop: tokens.spacingVerticalXS },
  spinnerWrap: { padding: tokens.spacingVerticalM },
  // Name-cell list rendering: static layout extracted; chip tint + icon colour
  // stay inline (data-driven), per item-tile.tsx:194-200.
  nameCell: { display: 'inline-flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  nameChip: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px', borderRadius: tokens.borderRadiusMedium, flexShrink: 0,
  },
  nameChipIcon: { width: '18px', height: '18px' },
  muted2: { color: tokens.colorNeutralForeground2 },
  muted3: { color: tokens.colorNeutralForeground3 },
});

/**
 * Representative item-type slug for a workload — its first featureSlug, which
 * the catalog seed always sets to a real item-type slug. itemVisual() resolves
 * this to a Fluent icon + brand color, so the tile/list visual is fully driven
 * by the shared registry (no bespoke per-page icon map).
 */
function workloadType(w: Workload): string {
  return (w.featureSlugs || [])[0] || 'data-product';
}

export default function WorkloadHubPage() {
  const s = useStyles();
  const router = useRouter();
  const [items, setItems] = useState<Workload[] | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');
  const [view, setView] = useState<LoomView>('tile');

  // Hydrate the persisted view mode (SSR-safe).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_VIEW);
      if (raw === 'tile' || raw === 'list') setView(raw);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(LS_VIEW, view); } catch { /* ignore */ }
  }, [view]);

  useEffect(() => {
    fetch('/api/workloads-catalog').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setItems([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setItems(Array.isArray(d?.workloads) ? d.workloads : []);
    }).catch(() => setItems([]));
  }, []);

  const filter = q.trim().toLowerCase();

  const matches = useMemo(
    () => (w: Workload) =>
      !filter ||
      w.name.toLowerCase().includes(filter) ||
      (w.description ?? '').toLowerCase().includes(filter) ||
      (w.category ?? '').toLowerCase().includes(filter) ||
      itemVisual(workloadType(w)).label.toLowerCase().includes(filter),
    [filter],
  );

  const { mine, more } = useMemo(() => {
    const all = items ?? [];
    return {
      mine: all.filter(w => (w.included || w.category === 'CSA') && matches(w)),
      more: all.filter(w => !w.included && w.category !== 'CSA' && matches(w)),
    };
  }, [items, matches]);

  // unfiltered totals for the hero stats / badges
  const totals = useMemo(() => {
    const all = items ?? [];
    return {
      mine: all.filter(w => w.included || w.category === 'CSA').length,
      more: all.filter(w => !w.included && w.category !== 'CSA').length,
    };
  }, [items]);

  function openWorkload(w: Workload) {
    // Experience-home workloads (e.g. Data Science) land on their dedicated
    // experience page; the rest open the first feature's create wizard.
    if (w.homeHref) { router.push(w.homeHref); return; }
    const first = (w.featureSlugs || [])[0];
    if (first) router.push(`/items/${first}/new`);
  }

  function tileGrid(list: Workload[]) {
    return (
      <TileGrid minTileWidth={300}>
        {list.map((w) => {
          const type = workloadType(w);
          const count = (w.featureSlugs || []).length;
          return (
            <ItemTile
              key={w.id}
              type={type}
              size="lg"
              title={w.name}
              subtitle={w.description}
              meta={`${count} ${count === 1 ? 'item type' : 'item types'}`}
              badge={
                w.category === 'CSA'
                  ? <Badge appearance="tint" color="brand" size="small">CSA</Badge>
                  : undefined
              }
              onClick={() => openWorkload(w)}
            />
          );
        })}
      </TileGrid>
    );
  }

  const columns = useMemo<LoomColumn<Workload>[]>(() => [
    {
      key: 'name', label: 'Workload', sortable: true, filterable: true, width: 280,
      getValue: (w) => w.name,
      render: (w) => {
        const v = itemVisual(workloadType(w));
        return (
          <span className={s.nameCell}>
            <span
              className={s.nameChip}
              style={{ backgroundColor: `${v.color}1f` }}
              aria-hidden
            >
              <v.icon className={s.nameChipIcon} style={{ color: v.color }} />
            </span>
            <Text weight="semibold">{w.name}</Text>
            {w.category === 'CSA' && (
              <Badge appearance="tint" color="brand" size="small">CSA</Badge>
            )}
          </span>
        );
      },
    },
    {
      key: 'description', label: 'Description', sortable: true, filterable: true, width: 420,
      getValue: (w) => w.description ?? '',
      render: (w) => (
        <Text className={s.muted2}>{w.description || '—'}</Text>
      ),
    },
    {
      key: 'items', label: 'Item types', sortable: true, filterable: false, width: 130,
      getValue: (w) => (w.featureSlugs || []).length,
      render: (w) => <Text>{(w.featureSlugs || []).length}</Text>,
    },
  ], [s]);

  function collection(list: Workload[], total: number, label: string) {
    if (view === 'tile') {
      if (list.length === 0) {
        return (
          <Text className={s.muted3}>
            {total === 0 ? `No ${label} available.` : `No ${label} match "${q}".`}
          </Text>
        );
      }
      return tileGrid(list);
    }
    return (
      <LoomDataTable
        columns={columns}
        rows={list}
        getRowId={(w) => w.id}
        onRowClick={openWorkload}
        ariaLabel={label}
        empty={total === 0 ? `No ${label} available.` : `No ${label} match this filter.`}
      />
    );
  }

  const loading = items === null;

  return (
    <PageShell
      title="Workload hub"
      subtitle="Your one-stop view of every workload available in this tenant."
    >
      {unauth && <SignInRequired subject="workloads" />}

      {!loading && (
        <div className={s.hero}>
          <div className={s.heroText}>
            <div className={s.heroTitle}>Build with the workloads that match your problem</div>
            <Body1 className={s.heroBody}>
              Workloads are bundles of related item types — Data Engineering brings Synapse + ADF + Spark,
              Real-Time Intelligence brings Eventhouse + KQL + Activator. Open any workload to jump straight
              into creating an item from it.
            </Body1>
          </div>
          <div className={s.heroStats}>
            <div className={s.heroStat}>
              <div className={s.heroStatVal}>{totals.mine}</div>
              <div className={s.heroStatLabel}>included in your tenant</div>
            </div>
            <div className={s.heroStat}>
              <div className={s.heroStatVal}>{totals.more}</div>
              <div className={s.heroStatLabel}>optional add-ons</div>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className={s.spinnerWrap}>
          <Spinner label="Loading workloads…" />
        </div>
      )}

      {!loading && (
        <Toolbar
          search={q}
          onSearch={setQ}
          searchPlaceholder="Filter workloads…"
          actions={
            <div className={s.countBadges}>
              <Badge appearance="outline">{totals.mine} included</Badge>
              <Badge appearance="outline">{totals.more} add-ons</Badge>
              <ViewToggle value={view} onChange={setView} ariaLabel="Workload view" />
            </div>
          }
        />
      )}

      {!loading && (
        <Section title="My workloads">
          {collection(mine, totals.mine, 'workloads')}
        </Section>
      )}

      {!loading && (
        <Section title="More workloads">
          {totals.more > 0 ? (
            collection(more, totals.more, 'add-ons')
          ) : (
            <MessageBar intent="info">
              <MessageBarBody>
                Every optional add-on is already included in this tenant.
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.ctaCard}>
            <div className={s.ctaText}>
              <Text weight="semibold" block>Browse the full workload catalog</Text>
              <Text size={200} block className={s.ctaSub}>
                Compliance, Geoanalytics, Graph + Vector, and other optional accelerators ship with Loom but
                stay opt-in until you enable them.
              </Text>
            </div>
            <Button
              as="a"
              href="/workloads"
              appearance="primary"
              icon={<ArrowRight20Regular />}
              iconPosition="after"
            >
              Browse all workloads
            </Button>
          </div>
        </Section>
      )}
    </PageShell>
  );
}
