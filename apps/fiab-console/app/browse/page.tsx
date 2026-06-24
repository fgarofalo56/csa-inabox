'use client';

/**
 * /browse — the cross-tenant landing surface.
 *
 * Three stacked, breathing-room sections (Web 3.0 standard, see
 * docs/fiab/design/ui-web3-guide.md):
 *   1. Pinned     — pinned items, grouped by type, as ItemTiles.
 *   2. Recent     — the shared RecentItems row.
 *   3. Workspaces — every workspace in the tenant, with a Tile | List
 *                   ViewToggle (tile = ItemTile/TileGrid, list =
 *                   LoomDataTable with sort + filter on name / type /
 *                   modified). Rows/tiles route to /workspaces/{id}.
 *
 * All data is real:
 *   • pinned     -> /api/user-prefs?key=pinnedItems
 *   • workspaces -> /api/workspaces
 *   • recent     -> RecentItems (/api/items/recent)
 *
 * The top Toolbar's SearchBox (capped at 360px by the Toolbar primitive)
 * scans pinned + workspaces; the workspace List view also has its own
 * per-column filters from LoomDataTable.
 */

import { clientFetch } from '@/lib/client-fetch';
import { PageShell } from '@/lib/components/page-shell';
import { RecentItems } from '@/lib/components/recent-items';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  makeStyles,
  tokens,
  Spinner,
  Badge,
  MessageBar,
  MessageBarBody,
  Text,
} from '@fluentui/react-components';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { AllItemsExplorer } from '@/lib/components/browse/all-items-explorer';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

interface Pin {
  id: string;
  label: string;
  href: string;
  type?: string;
}
interface WorkspaceLite {
  id: string;
  name: string;
  tenantId?: string;
  description?: string;
  createdAt?: string;
  lastAccessedAt?: string;
}

const LS_BROWSE_VIEW = 'loom.browse.workspaces.viewMode.v1';

const useStyles = makeStyles({
  countBadges: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  groupLabel: {
    display: 'block',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightBold,
    marginBottom: tokens.spacingVerticalS,
  },
  group: {
    marginBottom: tokens.spacingVerticalL,
  },
  empty: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: '13px',
    textAlign: 'center',
    lineHeight: 1.6,
    // Guard against a long unbroken search query (rendered inline below)
    // forcing horizontal overflow of this dashed container.
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  spinnerWrap: {
    padding: tokens.spacingVerticalM,
  },
  // Workspace name-cell: icon chip + label. Static layout here; the chip's
  // colour tint stays inline (data-driven), mirroring item-tile.tsx:194-200.
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
  nameChipIcon: {
    width: '16px',
    height: '16px',
  },
});

export default function BrowsePage() {
  const styles = useStyles();
  const router = useRouter();

  const [pins, setPins] = useState<Pin[] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState<LoomView>('tile');

  // Hydrate the persisted workspace view mode (SSR-safe).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_BROWSE_VIEW);
      if (raw === 'tile' || raw === 'list') setView(raw);
    } catch {
      /* ignore (quota / private mode) */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_BROWSE_VIEW, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  useEffect(() => {
    clientFetch('/api/user-prefs?key=pinnedItems')
      .then((r) => r.json())
      .then((d) => {
        setPins(Array.isArray(d?.value) ? d.value : []);
      })
      .catch(() => setPins([]));
    clientFetch('/api/workspaces')
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d) ? d : d?.workspaces || [];
        setWorkspaces(list);
      })
      .catch(() => setWorkspaces([]));
  }, []);

  const filter = q.trim().toLowerCase();

  const visiblePins = useMemo(
    () =>
      (pins ?? []).filter(
        (p) =>
          !filter ||
          p.label.toLowerCase().includes(filter) ||
          (p.type ?? '').toLowerCase().includes(filter),
      ),
    [pins, filter],
  );

  const visibleWorkspaces = useMemo(
    () =>
      (workspaces ?? []).filter(
        (w) =>
          !filter ||
          w.name.toLowerCase().includes(filter) ||
          (w.description ?? '').toLowerCase().includes(filter),
      ),
    [workspaces, filter],
  );

  // Group pins by type so users find them when the list grows past a few.
  const groupedPins = useMemo(() => {
    const groups = new Map<string, Pin[]>();
    for (const p of visiblePins) {
      const key = (p.type || 'other').toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [visiblePins]);

  // Workspace list-view columns (sortable + filterable per the design guide).
  const workspaceColumns = useMemo<LoomColumn<WorkspaceLite>[]>(
    () => [
      {
        key: 'name',
        label: 'Name',
        sortable: true,
        filterable: true,
        width: 320,
        getValue: (w) => w.name,
        render: (w) => {
          const visual = itemVisual('workspace');
          return (
            <span className={styles.nameCell}>
              <span
                className={styles.nameChip}
                style={{ backgroundColor: `${visual.color}1f` }}
                aria-hidden
              >
                <visual.icon className={styles.nameChipIcon} style={{ color: visual.color }} />
              </span>
              <Text weight="semibold">{w.name}</Text>
            </span>
          );
        },
      },
      {
        key: 'type',
        label: 'Type',
        sortable: true,
        filterable: true,
        width: 160,
        getValue: () => 'Workspace',
      },
      {
        key: 'modified',
        label: 'Modified',
        sortable: true,
        filterable: false,
        width: 180,
        getValue: (w) => w.lastAccessedAt ?? w.createdAt ?? '',
        render: (w) => {
          const d = w.lastAccessedAt ?? w.createdAt;
          return d ? new Date(d).toLocaleDateString() : '—';
        },
      },
    ],
    [styles],
  );

  const pinsLoading = pins === null;
  const wsLoading = workspaces === null;

  return (
    <PageShell
      title="Browse"
      subtitle="Everything in your Loom tenant — every item across every workspace, plus pinned and recent. (Workspaces lists the workspaces themselves.)"
    >
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter pinned and workspaces…"
        actions={
          !pinsLoading && !wsLoading ? (
            <div className={styles.countBadges}>
              <Badge appearance="outline">{pins?.length ?? 0} pinned</Badge>
              <Badge appearance="outline">{workspaces?.length ?? 0} workspaces</Badge>
            </div>
          ) : undefined
        }
      />

      {/* ── All items (everything in the tenant) ───────────────────────── */}
      <Section title="All items">
        <AllItemsExplorer />
      </Section>

      {/* ── Pinned ──────────────────────────────────────────────────── */}
      <Section title="Pinned">
        {pinsLoading && (
          <div className={styles.spinnerWrap}>
            <Spinner size="tiny" label="Loading pins…" />
          </div>
        )}
        {!pinsLoading && (pins?.length ?? 0) === 0 && (
          <div className={styles.empty}>
            Nothing pinned yet. Open a workspace or item and click the pin icon to make it stick
            here and in the left sidebar.
          </div>
        )}
        {!pinsLoading && (pins?.length ?? 0) > 0 && visiblePins.length === 0 && (
          <div className={styles.empty}>No pinned items match &quot;{q}&quot;.</div>
        )}
        {groupedPins.map(([type, list]) => (
          <div key={type} className={styles.group}>
            <Text size={200} className={styles.groupLabel}>
              {itemVisual(type).label}
            </Text>
            <TileGrid>
              {list.map((p) => (
                <ItemTile
                  key={p.id}
                  type={p.type ?? 'workspace'}
                  title={p.label}
                  subtitle={itemVisual(p.type ?? 'workspace').label}
                  onClick={() => router.push(p.href)}
                />
              ))}
            </TileGrid>
          </div>
        ))}
      </Section>

      {/* ── Recent ──────────────────────────────────────────────────── */}
      <Section title="Recent">
        <RecentItems />
      </Section>

      {/* ── All workspaces ──────────────────────────────────────────── */}
      <Section
        title="All workspaces"
        actions={
          !wsLoading && (workspaces?.length ?? 0) > 0 ? (
            <ViewToggle value={view} onChange={setView} ariaLabel="Workspace view" />
          ) : undefined
        }
      >
        {wsLoading && (
          <div className={styles.spinnerWrap}>
            <Spinner size="tiny" label="Loading workspaces…" />
          </div>
        )}
        {!wsLoading && (workspaces?.length ?? 0) === 0 && (
          <MessageBar intent="info">
            <MessageBarBody>
              No workspaces in this tenant yet. Visit /workspaces to create one.
            </MessageBarBody>
          </MessageBar>
        )}
        {!wsLoading && (workspaces?.length ?? 0) > 0 && visibleWorkspaces.length === 0 && filter && (
          <div className={styles.empty}>No workspaces match &quot;{q}&quot;.</div>
        )}
        {!wsLoading && visibleWorkspaces.length > 0 && (
          view === 'tile' ? (
            <TileGrid>
              {visibleWorkspaces.map((w) => (
                <ItemTile
                  key={w.id}
                  type="workspace"
                  title={w.name}
                  subtitle={w.description || 'Workspace'}
                  meta={
                    w.lastAccessedAt
                      ? `Opened ${new Date(w.lastAccessedAt).toLocaleDateString()}`
                      : w.createdAt
                        ? `Created ${new Date(w.createdAt).toLocaleDateString()}`
                        : undefined
                  }
                  onClick={() => router.push(`/workspaces/${w.id}`)}
                />
              ))}
            </TileGrid>
          ) : (
            <LoomDataTable
              columns={workspaceColumns}
              rows={visibleWorkspaces}
              getRowId={(w) => w.id}
              onRowClick={(w) => router.push(`/workspaces/${w.id}`)}
              ariaLabel="All workspaces"
              empty="No workspaces match this filter."
            />
          )
        )}
      </Section>
    </PageShell>
  );
}
