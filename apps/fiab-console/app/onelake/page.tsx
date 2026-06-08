'use client';

/**
 * OneLake catalog — Explore tab parity surface.
 *
 * One-for-one with the Microsoft Fabric OneLake catalog Explore tab
 * (https://learn.microsoft.com/fabric/governance/onelake-catalog-explore +
 * .../onelake-catalog-item-details), themed with Fluent v9 + Loom tokens:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Toolbar:  [search ≤360]  [All · per-type chips w/ counts]  [▦▤] │
 *   ├───────────┬──────────────────────────────┬────────────────────┤
 *   │ Filters   │  Items (tile grid / grouped   │  Item details pane  │
 *   │ • All     │  list per workspace)          │  Overview / Tables  │
 *   │ • Mine    │                               │  (in-context, no    │
 *   │ Workspaces│                               │   navigation)       │
 *   └───────────┴──────────────────────────────┴────────────────────┘
 *
 * REAL data:
 *   items      → GET /api/items/by-type?types=…
 *   workspaces → GET /api/workspaces?count=true
 *   tables     → GET /api/lakehouse/tables?id=<lakehouse>  (Tables tab)
 *
 * Honest gates: Endorsement / Sensitivity / Lineage require Purview — a
 * MessageBar names LOOM_PURVIEW_ACCOUNT rather than inventing values.
 * No mock arrays, no dead controls.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner,
  Avatar,
  Badge,
  Button,
  Text,
  Title3,
  Caption1,
  Tree,
  TreeItem,
  TreeItemLayout,
  TabList,
  Tab,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Tooltip,
  makeStyles,
  tokens,
  mergeClasses,
} from '@fluentui/react-components';
import {
  Dismiss20Regular,
  Open16Regular,
  FolderOpen20Regular,
  Table20Regular,
  DatabaseStack16Regular,
  AppsList20Regular,
  Person20Regular,
} from '@fluentui/react-icons';

import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { OneLakeSecurityTab } from '@/lib/panes/onelake-security-tab';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import { initials, endorsementOf } from './card-badges';

// ── Item types surfaced by the OneLake catalog Explore tab ────────────────
// "lakehouses, warehouses, Fabric databases, mirrored items, and other
// supported [data] item types" (Learn).
const ONELAKE_TYPES = [
  'lakehouse',
  'warehouse',
  'sql-database',
  'mirrored-database',
  'mirrored-databricks',
  'kql-database',
  'eventhouse',
] as const;

const TABLE_BACKED_TYPES = new Set(['lakehouse']);

interface OwnedItem {
  id: string;
  itemType: string;
  workspaceId: string;
  displayName: string;
  description?: string;
  state?: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Flattened from state.endorsement by the route. 'Certified' | 'Promoted' | 'Master data' | undefined */
  endorsement?: string;
  /** Flattened from state.sensitivityLabel by the route. */
  sensitivityLabel?: string;
  /** Domain id from parent workspace.domain; resolved to a display name via domainMap. */
  workspaceDomain?: string;
}

interface Workspace {
  id: string;
  name: string;
  itemCount?: number;
}

interface DeltaTable {
  schema: string;
  name: string;
  rowCount: number;
  sizeBytes: number;
  format: 'delta' | 'parquet' | 'iceberg';
  latestVersion: number;
}

// ── relative-time (Refreshed / Created) ───────────────────────────────────
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relative(iso?: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return RTF.format(Math.round(diffSec), 'second');
  if (abs < 3600) return RTF.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return RTF.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 2592000) return RTF.format(Math.round(diffSec / 86400), 'day');
  if (abs < 31536000) return RTF.format(Math.round(diffSec / 2592000), 'month');
  return RTF.format(Math.round(diffSec / 31536000), 'year');
}
function absolute(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function typeLabel(itemType: string): string {
  return findItemType(itemType)?.displayName ?? itemVisual(itemType).label;
}
function isPreviewType(itemType: string): boolean {
  return Boolean(findItemType(itemType)?.preview);
}
function fmtBytes(n: number): string {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Bottom-row badges for an ItemTile: endorsement chip + owner avatar + domain
 *  chip. Returns undefined when none apply so the tile renders no empty row. */
function tileFooter(
  it: OwnedItem,
  resolvedDomainName: string | undefined,
): React.ReactNode | undefined {
  // Endorsement: prefer the flattened top-level field, fall back to the
  // legacy state.certified flag (older items predate state.endorsement).
  const endorse = endorsementOf(it);
  const hasContent = Boolean(endorse || it.createdBy || resolvedDomainName);
  if (!hasContent) return undefined;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {endorse && (
        <Tooltip
          content={
            endorse === 'Certified'
              ? 'Certified — meets your organization’s quality standards'
              : endorse === 'Promoted'
              ? 'Promoted — recommended for sharing and reuse'
              : endorse
          }
          relationship="label"
        >
          <Badge
            appearance={endorse === 'Certified' ? 'filled' : 'outline'}
            color="brand"
            size="small"
          >
            {endorse}
          </Badge>
        </Tooltip>
      )}
      {it.createdBy && (
        <Tooltip content={`Owner: ${it.createdBy}`} relationship="label">
          <Avatar
            initials={initials(it.createdBy)}
            size={16}
            color="colorful"
            aria-label={`Owner: ${it.createdBy}`}
          />
        </Tooltip>
      )}
      {resolvedDomainName && (
        <Tooltip content={`Domain: ${resolvedDomainName}`} relationship="label">
          <Badge appearance="tint" color="subtle" size="small">
            {resolvedDomainName}
          </Badge>
        </Tooltip>
      )}
    </span>
  );
}

const useStyles = makeStyles({
  // three-column Explore layout: filters | items | details
  layout: {
    display: 'grid',
    gridTemplateColumns: '240px minmax(0, 1fr)',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  layoutWithDetails: {
    gridTemplateColumns: '240px minmax(0, 1fr) 380px',
  },

  // ── left filters rail ──
  rail: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    padding: tokens.spacingVerticalL,
    boxShadow: tokens.shadow2,
    position: 'sticky',
    top: tokens.spacingVerticalM,
  },
  railGroupLabel: {
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: '11px',
    marginBottom: tokens.spacingVerticalXS,
  },
  railItem: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    textAlign: 'left',
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase300,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  railItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
    ':hover': { backgroundColor: tokens.colorBrandBackground2 },
  },
  railItemText: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  railCount: {
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
    fontSize: tokens.fontSizeBase200,
  },
  railList: { display: 'flex', flexDirection: 'column', gap: '2px' },

  // ── category chips ──
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingTop: '4px',
    paddingBottom: '4px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    lineHeight: tokens.lineHeightBase200,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  chipActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
  },
  chipDot: { width: '8px', height: '8px', borderRadius: tokens.borderRadiusCircular, flexShrink: 0 },
  chipCount: { color: 'inherit', opacity: 0.7, fontVariantNumeric: 'tabular-nums' },

  // ── center items column ──
  itemsCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  wsGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  wsGroupHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  emptyBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXXL,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    textAlign: 'center',
  },

  // ── right details pane ──
  details: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalL,
    position: 'sticky',
    top: tokens.spacingVerticalM,
    maxHeight: 'calc(100vh - 120px)',
    overflowY: 'auto',
  },
  detailsHead: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM },
  detailsChip: {
    flexShrink: 0,
    width: '44px',
    height: '44px',
    borderRadius: tokens.borderRadiusLarge,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailsTitleWrap: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' },
  detailsTitle: { margin: 0, lineHeight: 1.25 },
  detailsActions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase300,
    alignItems: 'baseline',
  },
  metaKey: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightMedium, whiteSpace: 'nowrap' },
  metaVal: { color: tokens.colorNeutralForeground1, overflowWrap: 'anywhere' },
  closeBtn: { flexShrink: 0 },
  treeWrap: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
    maxHeight: '320px',
    overflowY: 'auto',
  },
  nameCell: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  nameIcon: {
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusSmall,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  nameText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: tokens.fontWeightSemibold },
});

// ── right-pane: Tables tab (lakehouse Delta schema) ───────────────────────
function TablesTab({ itemId }: { itemId: string }) {
  const styles = useStyles();
  const [tables, setTables] = useState<DeltaTable[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTables(null);
    setError(null);
    fetch(`/api/lakehouse/tables?id=${encodeURIComponent(itemId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!cancelled) setTables(Array.isArray(d) ? d : d?.tables ?? []); })
      .catch((e) => { if (!cancelled) setError(e?.message ?? 'Failed to load tables'); });
    return () => { cancelled = true; };
  }, [itemId]);

  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>Could not load tables: {error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (tables === null) return <Spinner size="tiny" label="Loading tables…" />;
  if (tables.length === 0) {
    return <Text size={200}>No Delta tables in this lakehouse yet.</Text>;
  }

  const bySchema = tables.reduce<Record<string, DeltaTable[]>>((acc, t) => {
    (acc[t.schema] ||= []).push(t);
    return acc;
  }, {});

  return (
    <div className={styles.treeWrap}>
      <Tree aria-label="Lakehouse table schema">
        {Object.entries(bySchema).map(([schema, ts]) => (
          <TreeItem itemType="branch" key={schema} value={schema}>
            <TreeItemLayout iconBefore={<FolderOpen20Regular />}>
              {schema} ({ts.length})
            </TreeItemLayout>
            <Tree>
              {ts.map((t) => (
                <TreeItem itemType="leaf" key={`${schema}.${t.name}`} value={`${schema}.${t.name}`}>
                  <TreeItemLayout
                    iconBefore={<Table20Regular />}
                    aside={<Caption1>{t.format}{t.sizeBytes ? ` · ${fmtBytes(t.sizeBytes)}` : ''}</Caption1>}
                  >
                    {t.name}
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        ))}
      </Tree>
    </div>
  );
}

// ── right-pane: in-context item details ───────────────────────────────────
function ItemDetails({
  item,
  workspaceName,
  onClose,
}: {
  item: OwnedItem;
  workspaceName: string;
  onClose: () => void;
}) {
  const styles = useStyles();
  const router = useRouter();
  const visual = itemVisual(item.itemType);
  const Icon = visual.icon;
  const hasTables = TABLE_BACKED_TYPES.has(item.itemType);
  const [tab, setTab] = useState<'overview' | 'tables' | 'security'>('overview');
  const stateLabel =
    typeof item.state?.['provisioningStatus'] === 'string'
      ? String(item.state['provisioningStatus'])
      : 'Active';
  // Governance signals are Azure-native — read from the item's own metadata
  // (set in the editor / Governance). Microsoft Purview *enriches* them with
  // scan-based classifications + lineage when connected; it is NOT required.
  const endorsement = (item.state?.['endorsement'] as string) || (item.state?.['certified'] ? 'Certified' : null);
  const sensitivity = (item.state?.['sensitivityLabel'] as string) || null;
  const classifications = Array.isArray(item.state?.['classifications']) ? (item.state!['classifications'] as string[]) : [];

  return (
    <aside className={styles.details} aria-label={`Details for ${item.displayName}`}>
      <div className={styles.detailsHead}>
        <span
          className={styles.detailsChip}
          style={{ backgroundColor: `${visual.color}1f`, color: visual.color }}
          aria-hidden
        >
          <Icon style={{ width: 26, height: 26, color: visual.color }} />
        </span>
        <span className={styles.detailsTitleWrap}>
          <Title3 className={styles.detailsTitle} title={item.displayName}>
            {item.displayName}
          </Title3>
          <Caption1>{typeLabel(item.itemType)}</Caption1>
        </span>
        <Tooltip content="Close details" relationship="label">
          <Button
            className={styles.closeBtn}
            appearance="subtle"
            icon={<Dismiss20Regular />}
            aria-label="Close details"
            onClick={onClose}
          />
        </Tooltip>
      </div>

      <div className={styles.detailsActions}>
        <Button
          appearance="primary"
          icon={<Open16Regular />}
          onClick={() => router.push(`/items/${item.itemType}/${item.id}`)}
        >
          Open
        </Button>
        {isPreviewType(item.itemType) && <Badge appearance="tint" color="brand">Preview</Badge>}
      </div>

      <TabList
        selectedValue={tab}
        onTabSelect={(_e, d) => setTab(d.value as 'overview' | 'tables' | 'security')}
        size="small"
      >
        <Tab value="overview">Overview</Tab>
        {hasTables && <Tab value="tables">Tables</Tab>}
        {hasTables && <Tab value="security">Security</Tab>}
      </TabList>

      {tab === 'overview' && (
        <>
          {item.description && <Text size={300}>{item.description}</Text>}
          <div className={styles.metaGrid}>
            <span className={styles.metaKey}>Type</span>
            <span className={styles.metaVal}>{typeLabel(item.itemType)}</span>
            <span className={styles.metaKey}>Location</span>
            <span className={styles.metaVal}>{workspaceName}</span>
            <span className={styles.metaKey}>Owner</span>
            <span className={styles.metaVal}>{item.createdBy || '—'}</span>
            <span className={styles.metaKey}>Refreshed</span>
            <Tooltip content={absolute(item.updatedAt)} relationship="label">
              <span className={styles.metaVal}>{relative(item.updatedAt || item.createdAt)}</span>
            </Tooltip>
            <span className={styles.metaKey}>Created</span>
            <Tooltip content={absolute(item.createdAt)} relationship="label">
              <span className={styles.metaVal}>{relative(item.createdAt)}</span>
            </Tooltip>
            <span className={styles.metaKey}>State</span>
            <span className={styles.metaVal}>
              <Badge appearance="outline" size="small">{stateLabel}</Badge>
            </span>
          </div>

          <div className={styles.metaGrid}>
            <span className={styles.metaKey}>Endorsement</span>
            <span className={styles.metaVal}>
              {endorsement
                ? <Badge appearance="filled" size="small" color={endorsement === 'Certified' ? 'success' : 'brand'}>{endorsement}</Badge>
                : <Badge appearance="outline" size="small">Not endorsed</Badge>}
            </span>
            <span className={styles.metaKey}>Sensitivity</span>
            <span className={styles.metaVal}>
              {sensitivity
                ? <Badge appearance="filled" size="small" color={sensitivity === 'Highly Confidential' ? 'danger' : sensitivity === 'Confidential' ? 'warning' : 'subtle'}>{sensitivity}</Badge>
                : <span style={{ color: tokens.colorNeutralForeground3 }}>—</span>}
            </span>
            <span className={styles.metaKey}>Classifications</span>
            <span className={styles.metaVal}>
              {classifications.length
                ? <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{classifications.map((c) => <Badge key={c} appearance="tint" size="small" color="informative">{c}</Badge>)}</span>
                : <span style={{ color: tokens.colorNeutralForeground3 }}>—</span>}
            </span>
            <span className={styles.metaKey}>Lineage</span>
            <span className={styles.metaVal}>
              <Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => router.push(`/governance/lineage?focusId=${encodeURIComponent(item.id)}`)}>View lineage</Button>
            </span>
          </div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: 8 }}>
            Set endorsement, sensitivity &amp; classifications in the item editor or Governance. Microsoft Purview
            enriches these with scan-based classifications &amp; cross-asset lineage when connected.
          </Caption1>
        </>
      )}

      {tab === 'tables' && hasTables && <TablesTab itemId={item.id} />}
      {tab === 'security' && hasTables && <OneLakeSecurityTab lakehouseId={item.id} />}
    </aside>
  );
}

export default function OneLakeCatalogPage() {
  const styles = useStyles();
  const router = useRouter();

  const [items, setItems] = useState<OwnedItem[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [domains, setDomains] = useState<Array<{ id: string; name: string }>>([]);
  const [unauth, setUnauth] = useState(false);
  const [me, setMe] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [view, setView] = useState<LoomView>('tile');
  const [typeFilter, setTypeFilter] = useState<string>('all'); // 'all' | itemType slug
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [wsFilter, setWsFilter] = useState<string | null>(null); // workspaceId or null
  const [selected, setSelected] = useState<OwnedItem | null>(null);

  // ── load items + workspaces + identity ──
  useEffect(() => {
    const qs = `types=${encodeURIComponent(ONELAKE_TYPES.join(','))}`;
    fetch(`/api/items/by-type?${qs}`)
      .then((r) => {
        if (r.status === 401 || r.status === 403) { setUnauth(true); setItems([]); return null; }
        return r.json();
      })
      .then((d) => { if (d) setItems(Array.isArray(d?.items) ? d.items : []); })
      .catch(() => setItems([]));

    fetch('/api/workspaces?count=true')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setWorkspaces(Array.isArray(d) ? d : []))
      .catch(() => setWorkspaces([]));

    // Domains resolve workspace.domain ids → display names for the card badge.
    // Azure-native by default (Cosmos governance-domains); honest-degrades to
    // no domain badge if the backend is gated (e.g. IL5 fabric opt-in 501).
    fetch('/api/governance/domains')
      .then((r) => (r.ok ? r.json() : { ok: false, domains: [] }))
      .then((d) => setDomains(Array.isArray(d?.domains) ? d.domains : []))
      .catch(() => setDomains([]));

    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // createdBy on items is upn || email || oid — match that precedence.
        const u = d?.user;
        setMe(u ? (u.upn ?? u.email ?? u.oid ?? null) : null);
      })
      .catch(() => setMe(null));
  }, []);

  const wsName = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workspaces) m.set(w.id, w.name);
    return m;
  }, [workspaces]);

  const domainMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of domains) m.set(d.id, d.name);
    return m;
  }, [domains]);

  // ── per-type counts (respect scope + workspace filter, ignore type chip) ──
  const scopedItems = useMemo(() => {
    let list = items ?? [];
    if (scope === 'mine' && me) list = list.filter((it) => it.createdBy === me);
    if (wsFilter) list = list.filter((it) => it.workspaceId === wsFilter);
    return list;
  }, [items, scope, me, wsFilter]);

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of scopedItems) m.set(it.itemType, (m.get(it.itemType) ?? 0) + 1);
    return m;
  }, [scopedItems]);

  // workspace counts (respect scope + type chip + search, ignore ws filter)
  const wsCounts = useMemo(() => {
    const filter = q.toLowerCase().trim();
    const m = new Map<string, number>();
    let list = items ?? [];
    if (scope === 'mine' && me) list = list.filter((it) => it.createdBy === me);
    if (typeFilter !== 'all') list = list.filter((it) => it.itemType === typeFilter);
    if (filter) {
      list = list.filter(
        (it) =>
          it.displayName.toLowerCase().includes(filter) ||
          (it.description ?? '').toLowerCase().includes(filter),
      );
    }
    for (const it of list) m.set(it.workspaceId, (m.get(it.workspaceId) ?? 0) + 1);
    return m;
  }, [items, scope, me, typeFilter, q]);

  // ── final visible set ──
  const visible = useMemo(() => {
    const filter = q.toLowerCase().trim();
    return scopedItems.filter((it) => {
      if (typeFilter !== 'all' && it.itemType !== typeFilter) return false;
      if (!filter) return true;
      return (
        it.displayName.toLowerCase().includes(filter) ||
        (it.description ?? '').toLowerCase().includes(filter)
      );
    });
  }, [scopedItems, typeFilter, q]);

  // group visible items per workspace (preserve workspace ordering)
  const grouped = useMemo(() => {
    const order = workspaces.map((w) => w.id);
    const byWs = new Map<string, OwnedItem[]>();
    for (const it of visible) {
      const bucket = byWs.get(it.workspaceId);
      if (bucket) bucket.push(it);
      else byWs.set(it.workspaceId, [it]);
    }
    const sortedIds = [...byWs.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
    });
    return sortedIds.map((id) => ({ id, name: wsName.get(id) ?? 'Unknown workspace', items: byWs.get(id)! }));
  }, [visible, workspaces, wsName]);

  // present type chips only for types that actually have items in scope
  const typesWithItems = useMemo(
    () => ONELAKE_TYPES.filter((t) => (typeCounts.get(t) ?? 0) > 0),
    [typeCounts],
  );

  // ── list columns ──
  const columns: LoomColumn<OwnedItem>[] = useMemo(
    () => [
      {
        key: 'displayName',
        label: 'Name',
        width: 260,
        render: (r) => {
          const v = itemVisual(r.itemType);
          const Icon = v.icon;
          return (
            <span className={styles.nameCell}>
              <span className={styles.nameIcon} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
                <Icon style={{ width: 16, height: 16, color: v.color }} />
              </span>
              <span className={styles.nameText} title={r.displayName}>{r.displayName}</span>
            </span>
          );
        },
      },
      { key: 'type', label: 'Type', width: 180, getValue: (r) => typeLabel(r.itemType), render: (r) => typeLabel(r.itemType) },
      { key: 'owner', label: 'Owner', width: 200, getValue: (r) => r.createdBy || '', render: (r) => r.createdBy || '—' },
      { key: 'location', label: 'Location', width: 180, getValue: (r) => wsName.get(r.workspaceId) ?? '', render: (r) => wsName.get(r.workspaceId) ?? '—' },
      {
        key: 'refreshed',
        label: 'Refreshed',
        width: 140,
        getValue: (r) => new Date(r.updatedAt || r.createdAt).getTime() || 0,
        render: (r) => (
          <Tooltip content={absolute(r.updatedAt || r.createdAt)} relationship="label">
            <span>{relative(r.updatedAt || r.createdAt)}</span>
          </Tooltip>
        ),
      },
    ],
    [styles.nameCell, styles.nameIcon, styles.nameText, wsName],
  );

  const subtitle =
    'Find, explore, and open the data items your tenant exposes — lakehouses, warehouses, databases, mirrored and KQL stores — without losing your place.';

  return (
    <PageShell title="OneLake catalog" subtitle={subtitle}>
      {unauth && <SignInRequired subject="catalog items" />}

      {/* Toolbar: search + category chips + view toggle */}
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Search items by name or description…"
        actions={<ViewToggle value={view} onChange={setView} ariaLabel="Switch catalog view" />}
      >
        <div className={styles.chips} role="group" aria-label="Filter by item type">
          <button
            type="button"
            className={mergeClasses(styles.chip, typeFilter === 'all' && styles.chipActive)}
            aria-pressed={typeFilter === 'all'}
            onClick={() => setTypeFilter('all')}
          >
            All
            <span className={styles.chipCount}>{scopedItems.length}</span>
          </button>
          {typesWithItems.map((t) => {
            const v = itemVisual(t);
            const active = typeFilter === t;
            return (
              <button
                key={t}
                type="button"
                className={mergeClasses(styles.chip, active && styles.chipActive)}
                aria-pressed={active}
                onClick={() => setTypeFilter(active ? 'all' : t)}
              >
                <span className={styles.chipDot} style={{ backgroundColor: v.color }} aria-hidden />
                {typeLabel(t)}
                <span className={styles.chipCount}>{typeCounts.get(t) ?? 0}</span>
              </button>
            );
          })}
        </div>
      </Toolbar>

      <div className={mergeClasses(styles.layout, Boolean(selected) && styles.layoutWithDetails)}>
        {/* LEFT — filters rail */}
        <nav className={styles.rail} aria-label="Catalog filters">
          <div>
            <div className={styles.railGroupLabel}>Show</div>
            <div className={styles.railList}>
              <button
                type="button"
                className={mergeClasses(styles.railItem, scope === 'all' && styles.railItemActive)}
                aria-pressed={scope === 'all'}
                onClick={() => setScope('all')}
              >
                <AppsList20Regular />
                <span className={styles.railItemText}>All items</span>
                <span className={styles.railCount}>{(items ?? []).length}</span>
              </button>
              <button
                type="button"
                className={mergeClasses(styles.railItem, scope === 'mine' && styles.railItemActive)}
                aria-pressed={scope === 'mine'}
                disabled={!me}
                onClick={() => setScope('mine')}
              >
                <Person20Regular />
                <span className={styles.railItemText}>My items</span>
                <span className={styles.railCount}>
                  {me ? (items ?? []).filter((it) => it.createdBy === me).length : 0}
                </span>
              </button>
            </div>
          </div>

          <div>
            <div className={styles.railGroupLabel}>Workspaces</div>
            <div className={styles.railList}>
              <button
                type="button"
                className={mergeClasses(styles.railItem, wsFilter === null && styles.railItemActive)}
                aria-pressed={wsFilter === null}
                onClick={() => setWsFilter(null)}
              >
                <span className={styles.railItemText}>All workspaces</span>
              </button>
              {workspaces.length === 0 && (
                <Caption1 style={{ padding: '4px 8px', color: tokens.colorNeutralForeground3 }}>
                  No workspaces yet.
                </Caption1>
              )}
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={mergeClasses(styles.railItem, wsFilter === w.id && styles.railItemActive)}
                  aria-pressed={wsFilter === w.id}
                  onClick={() => setWsFilter(wsFilter === w.id ? null : w.id)}
                  title={w.name}
                >
                  <DatabaseStack16Regular />
                  <span className={styles.railItemText}>{w.name}</span>
                  <span className={styles.railCount}>{wsCounts.get(w.id) ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
        </nav>

        {/* CENTER — items */}
        <div className={styles.itemsCol}>
          {items === null && <Spinner label="Loading catalog…" />}

          {items !== null && visible.length === 0 && (
            <div className={styles.emptyBox}>
              <Text weight="semibold">No items match your filters.</Text>
              <Caption1>
                {(items ?? []).length === 0
                  ? 'This tenant has no lakehouses, warehouses, or databases yet. Create one from any workspace.'
                  : 'Try clearing the search, type, or workspace filter.'}
              </Caption1>
            </div>
          )}

          {items !== null && visible.length > 0 && view === 'tile' && (
            <>
              {grouped.map((g) => (
                <div key={g.id} className={styles.wsGroup}>
                  <div className={styles.wsGroupHead}>
                    <DatabaseStack16Regular />
                    <Caption1>{g.name} · {g.items.length}</Caption1>
                  </div>
                  <TileGrid>
                    {g.items.map((it) => (
                      <ItemTile
                        key={it.id}
                        type={it.itemType}
                        title={it.displayName}
                        subtitle={typeLabel(it.itemType)}
                        meta={`Refreshed ${relative(it.updatedAt || it.createdAt)}`}
                        badge={isPreviewType(it.itemType) ? <Badge appearance="tint" color="brand" size="small">Preview</Badge> : undefined}
                        footer={tileFooter(
                          it,
                          it.workspaceDomain ? domainMap.get(it.workspaceDomain) : undefined,
                        )}
                        onClick={() => setSelected(it)}
                      />
                    ))}
                  </TileGrid>
                </div>
              ))}
            </>
          )}

          {items !== null && visible.length > 0 && view === 'list' && (
            <>
              {grouped.map((g) => (
                <Section key={g.id} title={`${g.name} · ${g.items.length}`}>
                  <LoomDataTable
                    columns={columns}
                    rows={g.items}
                    getRowId={(r) => r.id}
                    onRowClick={(r) => setSelected(r)}
                    ariaLabel={`Items in ${g.name}`}
                    empty="No items in this workspace."
                  />
                </Section>
              ))}
            </>
          )}
        </div>

        {/* RIGHT — in-context details */}
        {selected && (
          <ItemDetails
            item={selected}
            workspaceName={wsName.get(selected.workspaceId) ?? 'Unknown workspace'}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </PageShell>
  );
}
