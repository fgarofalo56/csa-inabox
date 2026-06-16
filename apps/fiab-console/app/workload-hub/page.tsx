'use client';

/**
 * /workload-hub — Fabric-parity Workload hub.
 *
 * The hub is a real create/manage-by-workload navigator backed by the
 * item-type registry (lib/catalog/workload-hub.ts + fabric-item-types.ts):
 *
 *   • Every workload tile's "N item types you can create" count is derived
 *     from the REAL catalog — `workloadItemCount(group)` = the number of
 *     non-deprecated item types in that workload. No hand-authored counts.
 *   • Clicking a workload does NOT dead-end into one create wizard — it opens
 *     the workload's landing page (/workload-hub/[key]) listing ITS item types
 *     as tiles, each of which launches the real /items/[slug]/new create flow
 *     or an existing-items view.
 *   • The tile glyph + brand color come from itemVisual(representativeSlug),
 *     so every workload is color-coded by its family via the shared registry.
 *
 * "My workloads" = core workloads (ship with every tenant) plus any optional
 * accelerator the tenant has explicitly enabled in its workloads-catalog
 * (real /api/workloads-catalog overlay). "More workloads" = the remaining
 * optional CSA accelerators. The model: a *workload* is a category; *item
 * types* are the things you create/manage inside it.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner, makeStyles, tokens, Badge, Button, Body1, Text, Tooltip,
} from '@fluentui/react-components';
import { ArrowRight20Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { clientFetch } from '@/lib/client-fetch';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import {
  workloadGroups,
  creatableItemTypes,
  representativeSlug,
  totalCreatableItemTypes,
  type WorkloadGroupDef,
} from '@/lib/catalog/workload-hub';

/** Shape of the per-tenant workloads-catalog rows (Cosmos-backed). */
interface CatalogWorkload {
  id: string; name: string; description?: string;
  category?: string; included?: boolean; featureSlugs?: string[];
}

/** View-model row: a registry workload group enriched with tenant inclusion. */
interface HubWorkload {
  key: string;
  name: string;
  description: string;
  /** Registry-derived count of creatable item types. */
  count: number;
  /** Representative item-type slug → drives the tile glyph + color. */
  repType: string;
  /** True when this workload is part of "My workloads". */
  included: boolean;
  /** Optional CSA accelerator → shows a CSA badge. */
  csa: boolean;
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

export default function WorkloadHubPage() {
  const s = useStyles();
  const router = useRouter();
  // Tenant catalog overlay (real backend) — null = still loading.
  const [catalog, setCatalog] = useState<CatalogWorkload[] | null>(null);
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
    clientFetch('/api/workloads-catalog').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setCatalog([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setCatalog(Array.isArray(d?.workloads) ? d.workloads : []);
    }).catch(() => setCatalog([]));
  }, []);

  // Registry-derived workloads, enriched with the tenant catalog overlay.
  const workloads = useMemo<HubWorkload[]>(() => {
    const cat = catalog ?? [];
    // Slugs the tenant has explicitly enabled via an *included* catalog row.
    const enabledSlugs = new Set<string>();
    const enabledNames = new Set<string>();
    for (const w of cat) {
      if (w.included) {
        enabledNames.add((w.name || '').toLowerCase().trim());
        for (const f of w.featureSlugs || []) enabledSlugs.add(f);
      }
    }
    const tenantEnabled = (g: WorkloadGroupDef): boolean => {
      if (enabledNames.has(g.name.toLowerCase().trim())) return true;
      const slugs = creatableItemTypes(g).map(t => t.slug);
      return slugs.some(sl => enabledSlugs.has(sl));
    };
    return workloadGroups().map((g) => ({
      key: g.key,
      name: g.name,
      description: g.description,
      count: creatableItemTypes(g).length,
      repType: representativeSlug(g),
      // Core workloads are always "mine"; accelerators join when the tenant
      // catalog explicitly enables them.
      included: g.tier === 'core' || tenantEnabled(g),
      csa: g.tier === 'accelerator',
    }));
  }, [catalog]);

  const filter = q.trim().toLowerCase();
  const matches = useMemo(
    () => (w: HubWorkload) =>
      !filter ||
      w.name.toLowerCase().includes(filter) ||
      w.description.toLowerCase().includes(filter) ||
      itemVisual(w.repType).label.toLowerCase().includes(filter),
    [filter],
  );

  const { mine, more } = useMemo(() => ({
    mine: workloads.filter(w => w.included && matches(w)),
    more: workloads.filter(w => !w.included && matches(w)),
  }), [workloads, matches]);

  const totals = useMemo(() => ({
    mine: workloads.filter(w => w.included).length,
    more: workloads.filter(w => !w.included).length,
    itemTypes: totalCreatableItemTypes(),
  }), [workloads]);

  function openWorkload(w: HubWorkload) {
    // Expand, don't dead-end: open the workload's landing page listing its
    // item types — not a single create wizard.
    router.push(`/workload-hub/${w.key}`);
  }

  function countLabel(count: number): string {
    return `${count} ${count === 1 ? 'item type' : 'item types'} you can create`;
  }

  function tileGrid(list: HubWorkload[]) {
    return (
      <TileGrid minTileWidth={300}>
        {list.map((w) => (
          <ItemTile
            key={w.key}
            type={w.repType}
            size="lg"
            title={w.name}
            subtitle={w.description}
            meta={
              <Tooltip
                content={`${countLabel(w.count)} in the ${w.name} workload`}
                relationship="description"
              >
                <span>{countLabel(w.count)}</span>
              </Tooltip>
            }
            badge={
              w.csa
                ? <Badge appearance="tint" color="brand" size="small">CSA</Badge>
                : undefined
            }
            onClick={() => openWorkload(w)}
          />
        ))}
      </TileGrid>
    );
  }

  const columns = useMemo<LoomColumn<HubWorkload>[]>(() => [
    {
      key: 'name', label: 'Workload', sortable: true, filterable: true, width: 260,
      getValue: (w) => w.name,
      render: (w) => {
        const v = itemVisual(w.repType);
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
            {w.csa && <Badge appearance="tint" color="brand" size="small">CSA</Badge>}
          </span>
        );
      },
    },
    {
      key: 'description', label: 'Description', sortable: true, filterable: true, width: 460,
      getValue: (w) => w.description,
      render: (w) => (
        <Text className={s.muted2}>{w.description || '—'}</Text>
      ),
    },
    {
      key: 'items', label: 'Item types you can create', sortable: true, filterable: false, width: 180,
      getValue: (w) => w.count,
      render: (w) => <Text>{w.count}</Text>,
    },
  ], [s]);

  function collection(list: HubWorkload[], total: number, label: string) {
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
        getRowId={(w) => w.key}
        onRowClick={openWorkload}
        ariaLabel={label}
        empty={total === 0 ? `No ${label} available.` : `No ${label} match this filter.`}
      />
    );
  }

  const loading = catalog === null;

  return (
    <PageShell
      title="Workload hub"
      subtitle="Pick a workload, then create or manage the item types inside it."
    >
      {unauth && <SignInRequired subject="workloads" />}

      {!loading && (
        <div className={s.hero}>
          <div className={s.heroText}>
            <div className={s.heroTitle}>Create by workload</div>
            <Body1 className={s.heroBody}>
              A <b>workload</b> is a category of related capabilities; the <b>item types</b> inside it are
              the things you create and manage. Open a workload — Data Engineering, Real-Time Intelligence,
              Power BI — to see every item type you can create in it, then launch its create wizard or jump
              to the items you already have. Every item type runs on an Azure-native backend, so nothing
              here needs a Microsoft Fabric capacity.
            </Body1>
          </div>
          <div className={s.heroStats}>
            <div className={s.heroStat}>
              <div className={s.heroStatVal}>{totals.mine}</div>
              <div className={s.heroStatLabel}>workloads in your tenant</div>
            </div>
            <div className={s.heroStat}>
              <div className={s.heroStatVal}>{totals.itemTypes}</div>
              <div className={s.heroStatLabel}>item types you can create</div>
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

      {!loading && totals.more > 0 && (
        <Section title="More workloads">
          {collection(more, totals.more, 'add-ons')}
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
