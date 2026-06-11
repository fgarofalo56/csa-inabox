'use client';

/**
 * /apps — top-level Apps page. Lists every curated CSA app from
 * /api/apps-catalog (Cosmos apps-catalog container, partitioned by
 * tenantId = session.claims.oid). Each card links to /apps/[id].
 *
 * Web 3.0 surface built on the shared Loom UI primitives (mirrors /browse
 * and /workloads):
 *   - Toolbar: constrained SearchBox + count Badge + a single Tile|List
 *     ViewToggle (persisted in localStorage).
 *   - Tile view: apps grouped into <Section> cards by category, each a
 *     <TileGrid> of <ItemTile>s. The tile inherits the dominant bundled
 *     item's icon+color from the item-type-visual registry; bundle count is
 *     a header badge; item-type chips + the Install button live in footer.
 *   - List view: one <LoomDataTable> over all visible apps with sortable,
 *     filterable columns (category becomes a constrained multiselect for
 *     free — no raw text config).
 *
 * Pure presentational refactor over the existing real /api/apps-catalog
 * backend — no new backend, no Fabric calls. Install actions stay deferred
 * to the /apps/[id] detail route (workspace picker + install POST live there).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner, tokens, Badge, Button, Subtitle2, Text, Tooltip,
  makeStyles,
} from '@fluentui/react-components';
import { ArrowDownload20Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

interface AppItemRef { type: string; template?: string; displayName?: string; }
interface AppDoc {
  id: string; name: string; description?: string;
  category?: string; publisher?: string;
  items?: AppItemRef[];
}

/** A category group of apps for the tile view. */
interface CategoryGroup { label: string; items: AppDoc[]; }

const LS_APPS_VIEW = 'loom.apps.viewMode.v1';

const useStyles = makeStyles({
  countBadges: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  empty: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: '13px',
    textAlign: 'center',
    lineHeight: 1.6,
  },
  spinnerWrap: {
    padding: tokens.spacingVerticalM,
  },
  nameCell: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  nameChip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusMedium,
    flexShrink: 0,
  },
});

/** The slug that drives an app tile's icon + color: the dominant bundled item. */
function appVisualType(a: AppDoc): string {
  return a.items?.[0]?.type ?? 'app';
}

/** Bucket apps by category, with deterministic section ordering ("Other" last). */
function bucket(apps: AppDoc[]): CategoryGroup[] {
  const byCat = new Map<string, AppDoc[]>();
  for (const a of apps) {
    const cat = a.category?.trim() || 'Other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(a);
  }
  const labels = Array.from(byCat.keys()).sort((x, y) => {
    if (x === 'Other') return 1;
    if (y === 'Other') return -1;
    return x.localeCompare(y);
  });
  return labels.map((label) => ({ label, items: byCat.get(label)! }));
}

export default function AppsPage() {
  const styles = useStyles();
  const router = useRouter();
  const [apps, setApps] = useState<AppDoc[] | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');
  const [view, setView] = useState<LoomView>('tile');

  // Hydrate the persisted view mode (SSR-safe).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_APPS_VIEW);
      if (raw === 'tile' || raw === 'list') setView(raw);
    } catch {
      /* ignore (quota / private mode) */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_APPS_VIEW, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  useEffect(() => {
    fetch('/api/apps-catalog').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setApps([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setApps(Array.isArray(d?.apps) ? d.apps : []);
    }).catch(() => setApps([]));
  }, []);

  const filter = q.toLowerCase().trim();
  const visible = useMemo(() => (apps ?? []).filter(a =>
    !filter || a.name.toLowerCase().includes(filter) ||
    (a.description ?? '').toLowerCase().includes(filter) ||
    (a.category ?? '').toLowerCase().includes(filter) ||
    (a.items ?? []).some(i => i.type.toLowerCase().includes(filter))
  ), [apps, filter]);

  const sections = useMemo(() => bucket(visible), [visible]);

  const totalCount = (apps ?? []).length;
  const shownCount = visible.length;

  // List-view columns: sortable + filterable. category/publisher/types are
  // low-cardinality → LoomDataTable renders them as constrained multiselect
  // dropdowns (no free-form config); only `name` stays free-text.
  const columns = useMemo<LoomColumn<AppDoc>[]>(() => [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      filterable: true,
      width: 320,
      getValue: (a) => a.name,
      render: (a) => {
        const visual = itemVisual(appVisualType(a));
        const Icon = visual.icon;
        return (
          <span className={styles.nameCell}>
            <span
              className={styles.nameChip}
              style={{ backgroundColor: `${visual.color}1f` }}
              aria-hidden
            >
              <Icon style={{ width: 16, height: 16, color: visual.color }} />
            </span>
            <Text weight="semibold">{a.name}</Text>
          </span>
        );
      },
    },
    {
      key: 'category',
      label: 'Category',
      sortable: true,
      filterable: true,
      width: 180,
      getValue: (a) => a.category ?? 'Other',
    },
    {
      key: 'bundle',
      label: 'Items',
      sortable: true,
      filterable: false,
      width: 110,
      getValue: (a) => a.items?.length ?? 0,
    },
    {
      key: 'types',
      label: 'Item types',
      sortable: true,
      filterable: true,
      width: 280,
      getValue: (a) =>
        Array.from(new Set((a.items ?? []).map(i => i.type)))
          .map(t => itemVisual(t).label)
          .join(', '),
    },
    {
      key: 'publisher',
      label: 'Publisher',
      sortable: true,
      filterable: true,
      width: 180,
      getValue: (a) => a.publisher ?? '—',
    },
  ], [styles.nameCell, styles.nameChip]);

  function openApp(a: AppDoc) {
    router.push(`/apps/${a.id}`);
  }

  /** One app as an ItemTile (tile view). */
  function renderTile(a: AppDoc) {
    const bundleCount = a.items?.length ?? 0;
    const itemTypes = Array.from(new Set((a.items ?? []).map(i => i.type)));
    return (
      <ItemTile
        key={a.id}
        type={appVisualType(a)}
        title={a.name}
        subtitle={a.category ?? 'App'}
        meta={a.description}
        badge={
          bundleCount > 0 ? (
            <Badge appearance="outline" color="informative" size="small">
              Bundle of {bundleCount} item{bundleCount === 1 ? '' : 's'}
            </Badge>
          ) : undefined
        }
        footer={
          <>
            {itemTypes.slice(0, 4).map(t => (
              <Badge key={t} appearance="tint" color="subtle" size="small">
                {itemVisual(t).label}
              </Badge>
            ))}
            {itemTypes.length > 4 && (
              <Tooltip
                content={itemTypes.slice(4).map(t => itemVisual(t).label).join(', ')}
                relationship="description"
              >
                <Badge appearance="tint" color="subtle" size="small">
                  +{itemTypes.length - 4} more
                </Badge>
              </Tooltip>
            )}
            <Button
              appearance="primary"
              size="small"
              icon={<ArrowDownload20Regular />}
              style={{ marginLeft: 'auto' }}
              onClick={(e) => {
                // footer sits inside the tile's clickable surface — stop the
                // click bubbling so Install defers to the detail page (where
                // the workspace picker + install POST live) without a double
                // navigation.
                e.stopPropagation();
                openApp(a);
              }}
            >
              Install
            </Button>
          </>
        }
        onClick={() => openApp(a)}
      />
    );
  }

  return (
    <PageShell
      title="Apps"
      subtitle="Curated CSA solutions that bundle items, dashboards, and pipelines into one click."
    >
      {unauth && <SignInRequired subject="the apps catalog" />}

      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter by name, category, or bundled item type…"
        actions={
          apps !== null ? (
            <div className={styles.countBadges}>
              <Badge appearance="outline">
                {filter ? `${shownCount} of ${totalCount} apps` : `${totalCount} apps`}
              </Badge>
              {shownCount > 0 && (
                <ViewToggle value={view} onChange={setView} ariaLabel="Apps view" />
              )}
            </div>
          ) : undefined
        }
      />

      {apps === null && (
        <div className={styles.spinnerWrap}>
          <Spinner label="Loading apps…" />
        </div>
      )}

      {apps !== null && apps.length === 0 && (
        <div className={styles.empty}>
          <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>No apps in this tenant yet</Subtitle2>
          <div>
            Run <code>scripts/csa-loom/seed-catalogs.sh</code> to seed the curated CSA apps.
          </div>
          <div style={{ marginTop: 4 }}>
            First sign-in also triggers a copy from the GLOBAL seed.
          </div>
        </div>
      )}

      {apps !== null && apps.length > 0 && shownCount === 0 && (
        <div className={styles.empty}>No apps match &ldquo;{q}&rdquo;.</div>
      )}

      {/* Tile view: one Section card per category. */}
      {shownCount > 0 && view === 'tile' &&
        sections.map((section) => (
          <Section key={section.label} title={`${section.label} · ${section.items.length}`}>
            <TileGrid minTileWidth={320}>
              {section.items.map(renderTile)}
            </TileGrid>
          </Section>
        ))}

      {/* List view: one flat table; category becomes a filterable column. */}
      {shownCount > 0 && view === 'list' && (
        <Section title={`All apps · ${shownCount}`}>
          <LoomDataTable
            columns={columns}
            rows={visible}
            getRowId={(a) => a.id}
            onRowClick={(a) => openApp(a)}
            ariaLabel="All apps"
            empty="No apps match this filter."
          />
        </Section>
      )}
    </PageShell>
  );
}
