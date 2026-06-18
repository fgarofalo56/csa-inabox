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

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner,
  Avatar,
  Badge,
  Button,
  Dropdown,
  Option,
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
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  makeStyles,
  tokens,
  mergeClasses,
  Skeleton,
  SkeletonItem,
} from '@fluentui/react-components';
import {
  Dismiss20Regular,
  Open16Regular,
  FolderOpen20Regular,
  Table20Regular,
  DatabaseStack16Regular,
  AppsList20Regular,
  Person20Regular,
  Delete20Regular,
  BinRecycle20Regular,
  ShieldCheckmark20Regular,
  ShieldKeyhole16Regular,
  Storage20Regular,
  MoreHorizontal20Regular,
  Copy16Regular,
  Link16Regular,
  BranchFork16Regular,
  Info16Regular,
} from '@fluentui/react-icons';

import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { EmptyState } from '@/lib/components/empty-state';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { OneLakeSecurityTab } from '@/lib/panes/onelake-security-tab';
import { SecureView } from '@/lib/components/onelake/secure-view';
import { GovernView } from '@/lib/components/onelake/govern-view';
import { StorageView } from '@/lib/components/onelake/storage-view';
import { PropertiesPanel } from '@/lib/components/onelake/properties-panel';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import { RecycleView } from '@/lib/components/onelake/recycle-view';
import { ONELAKE_TYPES } from '@/lib/catalog/onelake-types';
import { initials, endorsementOf } from './card-badges';

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

/** A MIP sensitivity label from the Purview Data Map (GET /sensitivity). */
interface SensitivityLabelOption {
  id: string;
  displayName: string;
  typedefName: string;
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

// ── OneLake addressing ─────────────────────────────────────────────────────
// Map a Loom item to the {container, itemPath} tuple used by the OneLake path
// helper. Container = the workspace (OneLake's "workspace" == ADLS container);
// itemPath = "<displayName>.<itemType>" (Fabric's "<item>.<type>" convention).
function onelakeAddress(it: OwnedItem, workspaceName: string) {
  return {
    container: workspaceName || it.workspaceId,
    itemPath: `${it.displayName}.${it.itemType}`,
    workspaceGuid: it.workspaceId,
    itemGuid: it.id,
  };
}

/**
 * Resolve a OneLake URI form for an item via the BFF (which holds the storage
 * account name) and write it to the clipboard. Returns silently on failure —
 * the menu item is fire-and-forget; the Properties panel surfaces any gate.
 */
async function copyOnelakeForm(
  it: OwnedItem,
  workspaceName: string,
  form: 'abfs' | 'dfs',
): Promise<void> {
  const a = onelakeAddress(it, workspaceName);
  const qs = new URLSearchParams({
    container: a.container,
    itemPath: a.itemPath,
    workspaceGuid: a.workspaceGuid,
    itemGuid: a.itemGuid,
  });
  try {
    const r = await clientFetch(`/api/onelake/paths?${qs.toString()}`);
    const j = await r.json();
    if (j?.ok && j.paths?.[form]) {
      await navigator.clipboard.writeText(j.paths[form] as string);
    }
  } catch {
    // network/clipboard failure — no-op (Properties panel shows the honest gate)
  }
}

/** Bottom-row badges for an ItemTile: endorsement chip + owner avatar + domain
 *  chip. Returns undefined when none apply so the tile renders no empty row. */
function tileFooter(
  it: OwnedItem,
  resolvedDomainName: string | undefined,
  styles: ReturnType<typeof useStyles>,
): React.ReactNode | undefined {
  // Endorsement: prefer the flattened top-level field, fall back to the
  // legacy state.certified flag (older items predate state.endorsement).
  const endorse = endorsementOf(it);
  const hasContent = Boolean(endorse || it.createdBy || resolvedDomainName);
  if (!hasContent) return undefined;

  return (
    <span className={styles.tileFooterRow}>
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
  // top-level page pivot: Explore | Govern
  pageTabBar: {
    marginBottom: tokens.spacingVerticalL,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
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
  // residual inline-style extractions (static layout; chip tints stay inline)
  muted: { color: tokens.colorNeutralForeground3 },
  inlineBadges: { display: 'inline-flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  tileFooterRow: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  labelRow: { display: 'inline-flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  detailsChipIcon: { width: '26px', height: '26px' },
  nameIconGlyph: { width: '16px', height: '16px' },
  metaNote: { color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalS },
  wsEmpty: { padding: '4px 8px', color: tokens.colorNeutralForeground3 },
  errorBarSpaced: { marginTop: tokens.spacingVerticalM },
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
    clientFetch(`/api/lakehouse/tables?id=${encodeURIComponent(itemId)}`)
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
  if (tables === null) {
    return (
      <Skeleton aria-label="Loading Delta tables" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
        {[...Array(5)].map((_, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: i % 2 === 0 ? 0 : 20 }}>
            <SkeletonItem shape="rectangle" style={{ width: 16, height: 16, flexShrink: 0 }} />
            <SkeletonItem shape="rectangle" style={{ width: `${55 + (i * 11) % 35}%`, height: 14 }} />
          </div>
        ))}
      </Skeleton>
    );
  }
  if (tables.length === 0) {
    return (
      <EmptyState
        icon={<Table20Regular />}
        title="No Delta tables"
        body="No Delta tables in this lakehouse yet. Write data to the Tables/ path in ADLS to register them."
      />
    );
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
  me,
  onClose,
  onDeleted,
  onLabelChange,
}: {
  item: OwnedItem;
  workspaceName: string;
  me: string | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onLabelChange: (itemId: string, labelName: string | null, labelId: string | null) => void;
}) {
  const styles = useStyles();
  const router = useRouter();
  const visual = itemVisual(item.itemType);
  const Icon = visual.icon;
  const hasTables = TABLE_BACKED_TYPES.has(item.itemType);
  const [tab, setTab] = useState<'overview' | 'tables' | 'security'>('overview');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleSoftDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await clientFetch(`/api/onelake/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemType: item.itemType }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${res.status}`);
      setConfirmDelete(false);
      onDeleted(item.id);
    } catch (e: any) {
      setDeleteError(e?.message ?? 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };
  const isOwner = !!me && item.createdBy === me;

  // ── Set-label state (Purview MIP via GET/PUT /sensitivity) ──
  const [labelPhase, setLabelPhase] = useState<'idle' | 'loading' | 'ready' | 'saving'>('idle');
  const [labelOptions, setLabelOptions] = useState<SensitivityLabelOption[]>([]);
  const [labelGate, setLabelGate] = useState<{ govNote?: string; missingEnvVar?: string } | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);

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

  // Load the live MIP label taxonomy from the Purview Data Map. On an honest
  // gate (no LOOM_PURVIEW_ACCOUNT) surface the named MessageBar instead of a
  // crash; the picker simply doesn't open.
  async function openLabelPicker() {
    setLabelPhase('loading');
    setLabelError(null);
    setLabelGate(null);
    try {
      const r = await clientFetch(`/api/items/${encodeURIComponent(item.itemType)}/${encodeURIComponent(item.id)}/sensitivity`);
      const j = await r.json();
      if (!j?.ok) {
        if (j?.code === 'purview_not_configured') {
          setLabelGate({ govNote: j.govNote, missingEnvVar: j.hint?.missingEnvVar || 'LOOM_PURVIEW_ACCOUNT' });
        } else {
          setLabelError(j?.error || `Failed to load labels (HTTP ${r.status}).`);
        }
        setLabelPhase('idle');
        return;
      }
      setLabelOptions(Array.isArray(j.labels) ? j.labels : []);
      setLabelPhase('ready');
    } catch (e: any) {
      setLabelError(e?.message || 'Failed to load sensitivity labels.');
      setLabelPhase('idle');
    }
  }

  // Persist the chosen label (Cosmos + best-effort Purview Atlas tag) and lift
  // the change so the tile chip + details badge update without a reload.
  async function applyLabel(opt: SensitivityLabelOption | null) {
    setLabelPhase('saving');
    setLabelError(null);
    try {
      const r = await clientFetch(`/api/items/${encodeURIComponent(item.itemType)}/${encodeURIComponent(item.id)}/sensitivity`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opt ? { labelId: opt.id, labelName: opt.displayName } : { labelId: '' }),
      });
      const j = await r.json();
      if (!j?.ok) {
        setLabelError(j?.error || `Failed to apply label (HTTP ${r.status}).`);
        setLabelPhase('ready');
        return;
      }
      onLabelChange(item.id, opt ? opt.displayName : null, opt ? opt.id : null);
      setLabelPhase('idle');
    } catch (e: any) {
      setLabelError(e?.message || 'Failed to apply sensitivity label.');
      setLabelPhase('ready');
    }
  }

  return (
    <aside className={styles.details} aria-label={`Details for ${item.displayName}`}>
      <div className={styles.detailsHead}>
        <span
          className={styles.detailsChip}
          style={{ backgroundColor: `${visual.color}1f`, color: visual.color }}
          aria-hidden
        >
          <Icon className={styles.detailsChipIcon} style={{ color: visual.color }} />
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
        <Button
          appearance="subtle"
          icon={<Delete20Regular />}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </Button>
        {isPreviewType(item.itemType) && <Badge appearance="tint" color="brand">Preview</Badge>}
      </div>

      <Dialog open={confirmDelete} onOpenChange={(_e, d) => { if (!d.open) { setConfirmDelete(false); setDeleteError(null); } }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Move to recycle bin</DialogTitle>
            <DialogContent>
              <Text>
                Delete <strong>{item.displayName}</strong>? It moves to the recycle bin and its ADLS Gen2 data
                is soft-deleted. You can restore it from the recycle bin until its retention window elapses.
              </Text>
              {deleteError && (
                <MessageBar intent="error" className={styles.errorBarSpaced}>
                  <MessageBarBody>{deleteError}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button appearance="primary" icon={<Delete20Regular />} onClick={handleSoftDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Move to recycle bin'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

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
                : <span className={styles.muted}>—</span>}
            </span>
            <span className={styles.metaKey}>Classifications</span>
            <span className={styles.metaVal}>
              {classifications.length
                ? <span className={styles.inlineBadges}>{classifications.map((c) => <Badge key={c} appearance="tint" size="small" color="informative">{c}</Badge>)}</span>
                : <span className={styles.muted}>—</span>}
            </span>
            <span className={styles.metaKey}>Lineage</span>
            <span className={styles.metaVal}>
              <Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => router.push(`/governance/lineage?focusId=${encodeURIComponent(item.id)}`)}>View lineage</Button>
            </span>
            {isOwner && (
              <>
                <span className={styles.metaKey}>Set label</span>
                <span className={styles.metaVal}>
                  {labelPhase === 'idle' && (
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<ShieldKeyhole16Regular />}
                      onClick={openLabelPicker}
                    >
                      {sensitivity ? 'Change' : 'Set'} sensitivity label
                    </Button>
                  )}
                  {labelPhase === 'loading' && <Spinner size="tiny" label="Loading labels…" />}
                  {labelPhase === 'saving' && <Spinner size="tiny" label="Applying…" />}
                  {labelPhase === 'ready' && (
                    <span className={styles.labelRow}>
                      {labelOptions.length === 0 ? (
                        <Caption1 className={styles.muted}>
                          No MIP labels are registered in the Purview Data Map yet. Enable
                          Information Protection + run a scan, then retry.
                        </Caption1>
                      ) : (
                        <Dropdown
                          size="small"
                          placeholder="Select a label…"
                          aria-label="Select sensitivity label"
                          selectedOptions={item.state?.['sensitivityLabelId'] ? [String(item.state['sensitivityLabelId'])] : []}
                          onOptionSelect={(_e, d) => {
                            const opt = labelOptions.find((l) => l.id === d.optionValue);
                            if (opt) applyLabel(opt);
                          }}
                        >
                          {labelOptions.map((l) => (
                            <Option key={l.id} value={l.id} text={l.displayName}>
                              {l.displayName}
                            </Option>
                          ))}
                        </Dropdown>
                      )}
                      {sensitivity && (
                        <Button size="small" appearance="subtle" onClick={() => applyLabel(null)}>
                          Clear
                        </Button>
                      )}
                      <Button size="small" appearance="transparent" onClick={() => setLabelPhase('idle')}>
                        Cancel
                      </Button>
                    </span>
                  )}
                </span>
              </>
            )}
          </div>
          {labelError && (
            <MessageBar intent="error">
              <MessageBarBody>{labelError}</MessageBarBody>
            </MessageBar>
          )}
          {labelGate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Microsoft Purview not configured</MessageBarTitle>
                {labelGate.govNote ||
                  `Sensitivity-label management reads the live MIP taxonomy from the Microsoft Purview Data Map. Set ${labelGate.missingEnvVar || 'LOOM_PURVIEW_ACCOUNT'} to a provisioned Purview account (and grant the Console UAMI the Data Curator role) to enable it.`}
              </MessageBarBody>
            </MessageBar>
          )}
          <Caption1 className={styles.metaNote}>
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

  const [pageTab, setPageTab] = useState<'explore' | 'secure' | 'govern' | 'storage'>('explore');
  const [q, setQ] = useState('');
  const [view, setView] = useState<LoomView>('tile');
  const [typeFilter, setTypeFilter] = useState<string>('all'); // 'all' | itemType slug
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [wsFilter, setWsFilter] = useState<string | null>(null); // workspaceId or null
  const [selected, setSelected] = useState<OwnedItem | null>(null);
  const [activeSection, setActiveSection] = useState<'explore' | 'recycle'>('explore');
  const [propsItem, setPropsItem] = useState<OwnedItem | null>(null);

  // ── load items + workspaces + identity ──
  useEffect(() => {
    const qs = `types=${encodeURIComponent(ONELAKE_TYPES.join(','))}`;
    clientFetch(`/api/items/by-type?${qs}`)
      .then((r) => {
        if (r.status === 401 || r.status === 403) { setUnauth(true); setItems([]); return null; }
        return r.json();
      })
      .then((d) => { if (d) setItems(Array.isArray(d?.items) ? d.items : []); })
      .catch(() => setItems([]));

    clientFetch('/api/workspaces?count=true')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setWorkspaces(Array.isArray(d) ? d : []))
      .catch(() => setWorkspaces([]));

    // Domains resolve workspace.domain ids → display names for the card badge.
    // Azure-native by default (Cosmos governance-domains); honest-degrades to
    // no domain badge if the backend is gated (e.g. IL5 fabric opt-in 501).
    clientFetch('/api/governance/domains')
      .then((r) => (r.ok ? r.json() : { ok: false, domains: [] }))
      .then((d) => setDomains(Array.isArray(d?.domains) ? d.domains : []))
      .catch(() => setDomains([]));

    clientFetch('/api/me')
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
                <Icon className={styles.nameIconGlyph} style={{ color: v.color }} />
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

  // Per-tile overflow (kebab) — Fabric OneLake item context menu, themed.
  function renderOverflow(it: OwnedItem) {
    const workspaceName = wsName.get(it.workspaceId) ?? it.workspaceId;
    return (
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            size="small"
            appearance="subtle"
            icon={<MoreHorizontal20Regular />}
            aria-label={`More actions for ${it.displayName}`}
          />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<Open16Regular />} onClick={() => router.push(`/items/${it.itemType}/${it.id}`)}>
              Open
            </MenuItem>
            <MenuItem icon={<Copy16Regular />} onClick={() => { void copyOnelakeForm(it, workspaceName, 'abfs'); }}>
              Copy OneLake path
            </MenuItem>
            <MenuItem icon={<Link16Regular />} onClick={() => { void copyOnelakeForm(it, workspaceName, 'dfs'); }}>
              Get URL (DFS)
            </MenuItem>
            <MenuItem
              icon={<BranchFork16Regular />}
              onClick={() => router.push(`/governance/lineage?focusId=${encodeURIComponent(it.id)}`)}
            >
              View lineage
            </MenuItem>
            <MenuItem icon={<Info16Regular />} onClick={() => setPropsItem(it)}>
              Properties
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  }

  return (
    <PageShell title="OneLake catalog" subtitle={subtitle}>
      {unauth && <SignInRequired subject="catalog items" />}

      {/* Page-level pivot: Explore (find/open items) vs Secure (access matrix) vs Govern (posture) */}
      <div className={styles.pageTabBar}>
        <TabList
          selectedValue={pageTab}
          onTabSelect={(_e, d) => setPageTab(d.value as 'explore' | 'secure' | 'govern' | 'storage')}
          size="medium"
        >
          <Tab value="explore" icon={<AppsList20Regular />}>Explore</Tab>
          <Tab value="secure" icon={<ShieldKeyhole16Regular />}>Secure</Tab>
          <Tab value="govern" icon={<ShieldCheckmark20Regular />}>Govern</Tab>
          <Tab value="storage" icon={<Storage20Regular />}>Storage</Tab>
        </TabList>
      </div>

      {pageTab === 'secure' && <SecureView workspaces={workspaces} items={items ?? []} />}
      {pageTab === 'govern' && <GovernView />}
      {pageTab === 'storage' && <StorageView workspaceId={wsFilter} />}

      {pageTab === 'explore' && (
        <>
      {/* Toolbar: search + category chips + view toggle (Explore only) */}
      {activeSection === 'explore' && (
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
      )}

      <div className={mergeClasses(styles.layout, activeSection === 'explore' && Boolean(selected) && styles.layoutWithDetails)}>
        {/* LEFT — filters rail */}
        <nav className={styles.rail} aria-label="Catalog filters">
          <div>
            <div className={styles.railGroupLabel}>Show</div>
            <div className={styles.railList}>
              <button
                type="button"
                className={mergeClasses(styles.railItem, activeSection === 'explore' && scope === 'all' && styles.railItemActive)}
                aria-pressed={activeSection === 'explore' && scope === 'all'}
                onClick={() => { setActiveSection('explore'); setScope('all'); }}
              >
                <AppsList20Regular />
                <span className={styles.railItemText}>All items</span>
                <span className={styles.railCount}>{(items ?? []).length}</span>
              </button>
              <button
                type="button"
                className={mergeClasses(styles.railItem, activeSection === 'explore' && scope === 'mine' && styles.railItemActive)}
                aria-pressed={activeSection === 'explore' && scope === 'mine'}
                disabled={!me}
                onClick={() => { setActiveSection('explore'); setScope('mine'); }}
              >
                <Person20Regular />
                <span className={styles.railItemText}>My items</span>
                <span className={styles.railCount}>
                  {me ? (items ?? []).filter((it) => it.createdBy === me).length : 0}
                </span>
              </button>
              <button
                type="button"
                className={mergeClasses(styles.railItem, activeSection === 'recycle' && styles.railItemActive)}
                aria-pressed={activeSection === 'recycle'}
                onClick={() => { setSelected(null); setActiveSection('recycle'); }}
              >
                <BinRecycle20Regular />
                <span className={styles.railItemText}>Recycle bin</span>
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
                <Caption1 className={styles.wsEmpty}>
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

        {/* CENTER — items (Explore) or Recycle bin */}
        <div className={styles.itemsCol}>
          {activeSection === 'recycle' && <RecycleView workspaceNames={wsName} />}

          {activeSection === 'explore' && items === null && <Spinner label="Loading catalog…" />}

          {activeSection === 'explore' && items !== null && visible.length === 0 && (
            <div className={styles.emptyBox}>
              <Text weight="semibold">No items match your filters.</Text>
              <Caption1>
                {(items ?? []).length === 0
                  ? 'This tenant has no lakehouses, warehouses, or databases yet. Create one from any workspace.'
                  : 'Try clearing the search, type, or workspace filter.'}
              </Caption1>
            </div>
          )}

          {activeSection === 'explore' && items !== null && visible.length > 0 && view === 'tile' && (
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
                        sensitivityLabel={(it.state?.['sensitivityLabel'] as string | undefined) || undefined}
                        overflowMenu={renderOverflow(it)}
                        footer={tileFooter(
                          it,
                          it.workspaceDomain ? domainMap.get(it.workspaceDomain) : undefined,
                          styles,
                        )}
                        onClick={() => setSelected(it)}
                      />
                    ))}
                  </TileGrid>
                </div>
              ))}
            </>
          )}

          {activeSection === 'explore' && items !== null && visible.length > 0 && view === 'list' && (
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
        {activeSection === 'explore' && selected && (
          <ItemDetails
            item={selected}
            workspaceName={wsName.get(selected.workspaceId) ?? 'Unknown workspace'}
            me={me}
            onClose={() => setSelected(null)}
            onDeleted={(id) => {
              setItems((prev) => (prev ? prev.filter((it) => it.id !== id) : prev));
              setSelected(null);
            }}
            onLabelChange={(itemId, labelName, labelId) => {
              const patch = (it: OwnedItem): OwnedItem =>
                it.id === itemId
                  ? {
                      ...it,
                      state: {
                        ...(it.state || {}),
                        sensitivityLabel: labelName ?? undefined,
                        sensitivityLabelId: labelId ?? undefined,
                      },
                    }
                  : it;
              setItems((prev) => (prev ? prev.map(patch) : prev));
              setSelected((prev) => (prev ? patch(prev) : prev));
            }}
          />
        )}
      </div>

      {/* Properties dialog — Paths (DFS/Blob/ABFS/GUID) + Connect snippets */}
      <Dialog open={Boolean(propsItem)} onOpenChange={(_e, d) => { if (!d.open) setPropsItem(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogContent>
              {propsItem && (
                <PropertiesPanel
                  {...onelakeAddress(propsItem, wsName.get(propsItem.workspaceId) ?? propsItem.workspaceId)}
                  itemName={propsItem.displayName}
                  itemType={typeLabel(propsItem.itemType)}
                  onClose={() => setPropsItem(null)}
                />
              )}
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>
        </>
      )}
    </PageShell>
  );
}
