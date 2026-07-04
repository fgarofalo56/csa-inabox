'use client';

/**
 * UnifiedSqlDatabaseEditor — the Loom "SQL database" surface, backed by REAL
 * Azure database services (NOT Fabric SQL). Replaces the misleading
 * "Fabric SQL / no Fabric workspace attached" framing entirely.
 *
 * Families (all real ARM REST + TDS):
 *   - azure-sql        → Microsoft.Sql/servers + /databases   (TDS query LIVE)
 *   - managed-instance → Microsoft.Sql/managedInstances        (TDS via PE — honest gate)
 *   - postgres         → Microsoft.DBforPostgreSQL/flexibleServers (PG query — honest gate)
 *
 * Tabs:
 *   - Connect    : tenant inventory across all 3 families; pick + bind to item state
 *   - Provision  : create a new Azure SQL DB (ARM PUT) or PostgreSQL flex server (ARM PUT)
 *   - Query      : Monaco SQL editor → /query (TDS for SQL; honest 501 gate for MI/PG)
 *   - Schema     : rich sys.* object navigator (SqlDbTree over live TDS) +
 *                  INFORMATION_SCHEMA fallback grid
 *   - Server admin: firewall rules, Microsoft Entra admin, and active
 *                  geo-replication — all calling the existing azure-sql-database
 *                  [id]/firewall · /aad-admin · /replication ARM routes
 *   - Catalog    : register the DB as a Purview/OneLake catalog asset
 *
 * Every control calls a real BFF route; every fetch is content-type guarded.
 * The only non-functional states are honest Fluent MessageBar infra-gates
 * naming the exact env var / role to provision (per no-vaporware.md +
 * ui-parity.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Label, Field, Textarea,
  Dropdown, Option, Tooltip, Checkbox,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  TabList, Tab, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Play20Regular, Add20Regular, PlugConnected20Regular,
  Table20Regular, BookDatabase20Regular, ShieldKeyhole20Regular,
  ArrowDownload20Regular, Delete20Regular, Copy20Regular, TopSpeed20Regular,
  PeopleTeam20Regular, BranchFork20Regular,
  Stop20Regular, ChartMultiple20Regular,
  Sparkle20Regular, Sparkle20Filled, Bug20Regular, TextBulletListSquare20Regular,
  ArrowEnter20Regular, Dismiss20Regular,
  BookmarkMultiple20Regular, Save20Regular, Rename20Regular, DocumentCopy20Regular,
  MoreHorizontal20Regular, Folder20Regular, Open20Regular, ArrowClockwise20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { useCollapsibleState, CollapsedRail } from '@/lib/components/collapsible-side-panel';
import { ResultsPanel } from './components/results-panel';
import type { BatchQueryResponse } from './components/results-panel';
import { buildConnectionStrings, getSqlHostSuffix } from './components/connection-strings-builder';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { registerInlineCompletion } from '@/lib/components/editor/inline-completion';
import { TsqlMonaco } from '@/lib/editors/components/tsql-monaco';
import { SqlDbTree } from '@/lib/components/sqldb/sqldb-tree';
import { SqlSecurityPanel } from '@/lib/panes/sql-security-panel';
import { ShareDialog } from './components/share-dialog';
import { SqlScalePanel } from './components/sql-scale-panel';
import { useJobsStore } from '@/lib/state/jobs-store';
import { SqlPerformanceDashboard } from '@/lib/editors/components/sql-performance-dashboard';
import { EmptyState } from '@/lib/components/empty-state';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useSharedEditorStyles } from './shared-styles';

// ── Real Azure database option sets (parity with the portal create blades) ──
const AZURE_REGIONS = [
  'eastus', 'eastus2', 'centralus', 'southcentralus', 'westus', 'westus2', 'westus3',
  'northcentralus', 'westcentralus', 'canadacentral', 'northeurope', 'westeurope',
  'uksouth', 'francecentral', 'germanywestcentral', 'switzerlandnorth', 'norwayeast',
  'swedencentral', 'eastasia', 'southeastasia', 'japaneast', 'australiaeast',
  'centralindia', 'koreacentral', 'brazilsouth', 'southafricanorth', 'uaenorth',
  'usgovvirginia', 'usgovarizona', 'usgovtexas', 'usdodeast', 'usdodcentral',
];
const SQL_DB_SKUS = [
  'Basic', 'S0', 'S1', 'S2', 'S3', 'S4', 'S6', 'S7', 'S9', 'S12',
  'P1', 'P2', 'P4', 'P6', 'P11', 'P15',
  'GP_Gen5_2', 'GP_Gen5_4', 'GP_Gen5_8', 'GP_Gen5_16', 'GP_Gen5_32',
  'GP_S_Gen5_1', 'GP_S_Gen5_2', 'GP_S_Gen5_4', 'GP_S_Gen5_8',
  'BC_Gen5_2', 'BC_Gen5_4', 'BC_Gen5_8', 'BC_Gen5_16',
  'HS_Gen5_2', 'HS_Gen5_4', 'HS_Gen5_8', 'HS_Gen5_16',
];
const SQL_DB_TIERS = ['Basic', 'Standard', 'Premium', 'GeneralPurpose', 'BusinessCritical', 'Hyperscale'];
// SQL Server collations surfaced in the Azure portal Create Database blade.
// The full catalog has thousands; these are the portal-offered choices. The
// first entry is the ARM default applied when no collation is sent.
const SQL_COLLATIONS = [
  'SQL_Latin1_General_CP1_CI_AS',       // portal default — case-insensitive, accent-sensitive
  'SQL_Latin1_General_CP1_CS_AS',       // case-sensitive variant
  'Latin1_General_100_CI_AS_SC_UTF8',   // UTF-8 aware, SQL Server 2019+
  'Latin1_General_100_CS_AS_SC_UTF8',
  'Latin1_General_BIN2',                // binary sort (fastest, case-sensitive)
  'Latin1_General_CI_AS',
  'Latin1_General_CS_AS',
  'French_CI_AS',
  'German_PhoneBook_CI_AS',
  'Japanese_CI_AS',
  'Korean_Wansung_CI_AS',
  'Modern_Spanish_CI_AS',
  'SQL_Latin1_General_CP437_CI_AI',     // accent-insensitive variant
  'SQL_Latin1_General_CP850_CI_AS',
  'SQL_Latin1_General_CP1_CI_AI',
  'Traditional_Spanish_CI_AS',
  'Chinese_PRC_CI_AS',
] as const;
type SqlCollation = typeof SQL_COLLATIONS[number];
const DEFAULT_COLLATION: SqlCollation = 'SQL_Latin1_General_CP1_CI_AS';
// requestedBackupStorageRedundancy — ARM validates the choice against the
// region/tier; an incompatible pick surfaces verbatim in the result MessageBar.
const BACKUP_REDUNDANCY_OPTIONS: { value: string; label: string }[] = [
  { value: 'Geo', label: 'Geo-redundant (default)' },
  { value: 'GeoZone', label: 'Geo-zone-redundant (requires AZ + paired region)' },
  { value: 'Zone', label: 'Zone-redundant (within region)' },
  { value: 'Local', label: 'Locally redundant (single region)' },
];
const PG_VERSIONS = ['11', '12', '13', '14', '15', '16'];
const PG_TIERS = ['Burstable', 'GeneralPurpose', 'MemoryOptimized'];
// Common PG flexible-server compute SKUs grouped by tier.
const PG_SKUS = [
  'Standard_B1ms', 'Standard_B2s', 'Standard_B2ms', 'Standard_B4ms',
  'Standard_D2s_v3', 'Standard_D4s_v3', 'Standard_D8s_v3', 'Standard_D16s_v3',
  'Standard_E2s_v3', 'Standard_E4s_v3', 'Standard_E8s_v3', 'Standard_E16s_v3',
];

// ── Results export + grid are provided by ./components/results-panel
//    (10k cap, Messages tab, multi-result-set, Copy/Download incl. XLSX,
//    in-grid search) — shared by the Query and Schema tabs below. ──

const useLocalStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalM, minHeight: '160px' },
  resultMeta: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', marginBottom: tokens.spacingVerticalS, flexWrap: 'wrap' },
  tableWrap: { overflow: 'auto', maxHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  treePad: { padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  formRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: tokens.spacingHorizontalM },
  select: {
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1,
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease-in-out',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  fullWidth: { width: '100%' },
  resultActions: { marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalXS },
  treeWrap: {
    flex: 1, minHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, overflow: 'hidden',
  },
  ruleGrid: { display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto', gap: tokens.spacingHorizontalM, alignItems: 'end' },
  // ---- Saved queries panel ----
  qpToolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  qpFolders: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, marginTop: tokens.spacingVerticalXS },
  qpFolderHead: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', paddingBottom: tokens.spacingVerticalXS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  qpList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalXS },
  qpRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer', border: '1px solid transparent',
  },
  qpRowSel: { background: tokens.colorNeutralBackground1Selected, border: `1px solid ${tokens.colorBrandStroke1}` },
  qpRowMain: { display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0, flex: 1 },
  qpName: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  qpMeta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase100, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  qpEmpty: { color: tokens.colorNeutralForeground3, fontStyle: 'italic', padding: `${tokens.spacingVerticalS} 0` },
  // ── Copilot side pane (Query tab) ──
  queryRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'stretch', minHeight: 0, flexWrap: 'wrap' },
  queryMain: { flex: 1, minWidth: '320px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  copilotPane: {
    flexGrow: 0, flexShrink: 1, flexBasis: '340px', minWidth: 0, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS,
    background: tokens.colorNeutralBackground2, maxHeight: '560px', boxShadow: tokens.shadow4,
  },
  copilotHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  copilotHeadActions: { marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalXS },
  copilotLog: {
    flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    minHeight: '160px', paddingRight: tokens.spacingHorizontalXS,
  },
  msgUser: {
    alignSelf: 'flex-end', maxWidth: '92%', background: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1, borderRadius: tokens.borderRadiusLarge, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, fontSize: tokens.fontSizeBase200,
  },
  msgAssistant: {
    alignSelf: 'flex-start', maxWidth: '100%', background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  msgFoot: { display: 'flex', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' },
  copilotInputRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  codeBlock: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    margin: `${tokens.spacingVerticalXS} 0`,
  },
  connCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease-in-out',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  connCodeWrap: { position: 'relative', background: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS },
  connCode: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, color: tokens.colorNeutralForeground1 },
  connCopyBtn: { position: 'absolute', top: tokens.spacingVerticalXS, right: tokens.spacingHorizontalXS },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

// ---- content-type guarded fetch ----------------------------------------
async function fetchJson(input: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(input, init);
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text().catch(() => '');
    return {
      ok: false,
      status: r.status,
      error:
        `Expected JSON from ${input} but received ${ct || 'an unknown content type'} (HTTP ${r.status}). ` +
        (r.status === 401 || r.status === 403
          ? 'Your session may have expired — sign in again.'
          : `First bytes: ${text.slice(0, 120)}`),
    };
  }
  try { return await r.json(); }
  catch (e: any) { return { ok: false, status: r.status, error: `Malformed JSON from ${input}: ${e?.message || String(e)}` }; }
}

type Family = 'azure-sql' | 'managed-instance' | 'postgres';

interface SqlServer { id: string; name: string; location: string; fqdn: string; state?: string; version?: string; resourceGroup?: string }
interface ManagedInstance { id: string; name: string; location: string; state?: string; fqdn?: string; sku?: { name?: string } }
interface PgServer { id: string; name: string; location: string; fqdn: string; state?: string; version?: string; resourceGroup?: string }

interface Inventory {
  sql: { servers: SqlServer[]; error?: string };
  mi: { instances: ManagedInstance[]; error?: string };
  postgres: { servers: PgServer[]; error?: string };
}

// Query responses now carry the full multi-recordset + messages shape; the
// ResultsPanel normalises both the new and legacy single-recordset forms.
type QueryResponse = BatchQueryResponse;

// ── Saved queries (My Queries / Shared Queries) — Cosmos-backed ──
type WorkspaceRoleName = 'Admin' | 'Member' | 'Contributor' | 'Viewer';
interface SavedQuery {
  id: string;
  itemId: string;
  workspaceId: string;
  scope: 'private' | 'shared';
  ownerId: string;
  name: string;
  description?: string;
  sql: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

// ---- Saved queries panel (My Queries / Shared Queries + bulk delete) ------
// Two folders mirror SSMS / ADS "saved queries": personal (private) and the
// workspace's shared set. Ctrl/Cmd-click toggles a row in the multi-select set;
// Shift-click range-selects; a plain click selects just that row. Per-row
// context menu = Open / Rename / Duplicate / Delete. Bulk-delete confirms then
// calls the DELETE route with the selected ids. All real Cosmos via the route.
function QueryRow({
  q, selected, onClick, onContextMenu, onOpen, onRename, onDuplicate, onDelete,
}: {
  q: SavedQuery; selected: boolean;
  onClick: (e: ReactMouseEvent) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onOpen: () => void; onRename: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const s = useStyles();
  const updated = (() => { try { return new Date(q.updatedAt).toLocaleString(); } catch { return q.updatedAt; } })();
  return (
    <div
      className={`${s.qpRow} ${selected ? s.qpRowSel : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
    >
      <Checkbox checked={selected} onClick={onClick} aria-label={`Select ${q.name}`} />
      <div className={s.qpRowMain}>
        <span className={s.qpName}>{q.name}</span>
        <span className={s.qpMeta}>
          {q.scope === 'shared' ? 'Shared' : 'Private'} · updated {updated}
          {q.description ? ` · ${q.description}` : ''}
        </span>
      </div>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${q.name}`}
            onClick={(e) => e.stopPropagation()} />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<Open20Regular />} onClick={onOpen}>Open in Query</MenuItem>
            <MenuItem icon={<Rename20Regular />} onClick={onRename}>Rename / edit</MenuItem>
            <MenuItem icon={<DocumentCopy20Regular />} onClick={onDuplicate}>Duplicate</MenuItem>
            <MenuItem icon={<Delete20Regular />} onClick={onDelete}>Delete</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    </div>
  );
}

function QueriesPanel({
  queries, loading, error, disabled, callerRole, selectedIds, onSelectionChange,
  onRefresh, onSaveNew, onOpen, onRename, onDuplicate, onBulkDelete,
}: {
  queries: SavedQuery[]; loading: boolean; error: string | null; disabled: boolean;
  callerRole: WorkspaceRoleName | null;
  selectedIds: Set<string>; onSelectionChange: (next: Set<string>) => void;
  onRefresh: () => void; onSaveNew: () => void;
  onOpen: (q: SavedQuery) => void; onRename: (q: SavedQuery) => void;
  onDuplicate: (q: SavedQuery) => void; onBulkDelete: () => void;
}) {
  const s = useStyles();
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mine = useMemo(() => queries.filter((q) => q.scope === 'private'), [queries]);
  const shared = useMemo(() => queries.filter((q) => q.scope === 'shared'), [queries]);
  // Flat display order drives Shift range-selection.
  const ordered = useMemo(() => [...mine, ...shared], [mine, shared]);
  const canShare = callerRole === 'Admin' || callerRole === 'Member' || callerRole === 'Contributor';

  const handleRowClick = useCallback((q: SavedQuery, e: ReactMouseEvent) => {
    e.preventDefault();
    const next = new Set(selectedIds);
    if (e.shiftKey && lastClicked) {
      const a = ordered.findIndex((x) => x.id === lastClicked);
      const b = ordered.findIndex((x) => x.id === q.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) next.add(ordered[i].id);
      } else {
        next.add(q.id);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (next.has(q.id)) next.delete(q.id); else next.add(q.id);
      setLastClicked(q.id);
    } else {
      next.clear();
      next.add(q.id);
      setLastClicked(q.id);
    }
    onSelectionChange(next);
  }, [selectedIds, lastClicked, ordered, onSelectionChange]);

  if (disabled) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Save the item first</MessageBarTitle>
          Saved queries live on a persisted SQL-database item. Create / save this item (it lives in a
          workspace), then return here to save personal and shared queries.
        </MessageBarBody>
      </MessageBar>
    );
  }

  const renderFolder = (label: string, icon: ReactNode, rows: SavedQuery[], emptyHint: string, gated?: string) => (
    <div>
      <div className={s.qpFolderHead}>
        {icon}
        <Subtitle2>{label}</Subtitle2>
        <Badge appearance="tint" color="informative">{rows.length}</Badge>
      </div>
      {gated
        ? <Caption1 className={s.qpEmpty}>{gated}</Caption1>
        : rows.length === 0
          ? <Caption1 className={s.qpEmpty}>{emptyHint}</Caption1>
          : (
            <div className={s.qpList} role="listbox" aria-label={label}>
              {rows.map((q) => (
                <QueryRow
                  key={q.id}
                  q={q}
                  selected={selectedIds.has(q.id)}
                  onClick={(e) => handleRowClick(q, e)}
                  onContextMenu={(e) => { if (!selectedIds.has(q.id)) handleRowClick(q, e); }}
                  onOpen={() => onOpen(q)}
                  onRename={() => onRename(q)}
                  onDuplicate={() => onDuplicate(q)}
                  onDelete={() => { onSelectionChange(new Set([q.id])); setConfirmDelete(true); }}
                />
              ))}
            </div>
          )}
    </div>
  );

  return (
    <>
      <div className={s.qpToolbar}>
        <Badge appearance="filled" color="brand" icon={<BookmarkMultiple20Regular />}>Saved queries</Badge>
        <Button size="small" appearance="primary" icon={<Save20Regular />} onClick={onSaveNew}>Save current query</Button>
        <Button size="small" appearance="outline" icon={<ArrowClockwise20Regular />} onClick={onRefresh} disabled={loading}>Refresh</Button>
        <Button
          size="small" appearance="outline" icon={<Delete20Regular />}
          disabled={selectedIds.size === 0} onClick={() => setConfirmDelete(true)}>
          Delete{selectedIds.size > 0 ? ` ${selectedIds.size} selected` : ''}
        </Button>
        {loading && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
        {callerRole && <Caption1>your role: <strong>{callerRole}</strong></Caption1>}
      </div>
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Saved queries error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}
      <Caption1>Tip: <strong>Ctrl/Cmd-click</strong> to multi-select, <strong>Shift-click</strong> for a range, then bulk delete.</Caption1>
      <div className={s.qpFolders}>
        {renderFolder('My Queries', <Folder20Regular />, mine, 'No personal saved queries yet. Save the current query to add one.')}
        {renderFolder(
          'Shared Queries', <Folder20Regular />, shared,
          'No shared queries yet.',
          canShare ? undefined : 'Shared queries are visible to workspace Admin / Member / Contributor. Your role does not include shared-query access.',
        )}
      </div>

      <Dialog open={confirmDelete} onOpenChange={(_, d) => setConfirmDelete(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete saved queries</DialogTitle>
            <DialogContent>
              <MessageBar intent="warning">
                <MessageBarBody>
                  This permanently deletes <strong>{selectedIds.size}</strong> saved {selectedIds.size === 1 ? 'query' : 'queries'}.
                  You can only delete your own queries (workspace Admins can delete any). The receipt reports
                  the exact before/after row counts.
                </MessageBarBody>
              </MessageBar>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button appearance="primary" icon={<Delete20Regular />}
                onClick={() => { setConfirmDelete(false); onBulkDelete(); }}>
                Delete {selectedIds.size} selected
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
//   - Firewall    GET/POST/DELETE /api/items/azure-sql-database/[id]/firewall
//   - Entra admin GET/PUT         /api/items/azure-sql-database/[id]/aad-admin
//   - Geo-repl.   POST            /api/items/azure-sql-database/[id]/replication
// For PostgreSQL we honest-gate to the dedicated PG firewall route; SQL MI
// admin is an honest gate (no public ARM admin surface wired). No mocks.
interface FirewallRule { name: string; startIpAddress: string; endIpAddress: string }
interface AadAdminState { login: string; sid: string; tenantId?: string; azureADOnlyAuthentication?: boolean }

function SqlServerAdminPanel({
  id, family, server, database, servers,
}: {
  id: string; family: Family; server: string; database: string;
  servers: { name: string; location: string }[];
}) {
  const s = useStyles();

  // Firewall
  const [fwRules, setFwRules] = useState<FirewallRule[]>([]);
  const [fwBusy, setFwBusy] = useState(false);
  const [fwError, setFwError] = useState<string | null>(null);
  const [fwName, setFwName] = useState('');
  const [fwStart, setFwStart] = useState('');
  const [fwEnd, setFwEnd] = useState('');
  const [confirmDeleteRule, setConfirmDeleteRule] = useState<string | null>(null);

  // Entra (AAD) admin
  const [aad, setAad] = useState<AadAdminState | null>(null);
  const [aadLogin, setAadLogin] = useState('');
  const [aadSid, setAadSid] = useState('');
  const [aadTenantId, setAadTenantId] = useState('');
  const [aadBusy, setAadBusy] = useState(false);
  const [aadMsg, setAadMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Geo-replication
  const [replicaServer, setReplicaServer] = useState('');
  const [replicaDb, setReplicaDb] = useState('');
  const [replicaLocation, setReplicaLocation] = useState('eastus2');
  const [replicaSku, setReplicaSku] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoMsg, setGeoMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fwBase = family === 'postgres'
    ? `/api/items/postgres-flexible-server/${encodeURIComponent(id)}/firewall`
    : `/api/items/azure-sql-database/${encodeURIComponent(id)}/firewall`;

  const loadFirewall = useCallback(async () => {
    if (!server) return;
    setFwBusy(true); setFwError(null);
    const j = await fetchJson(`${fwBase}?server=${encodeURIComponent(server)}`);
    if (!j.ok) setFwError(j.error || 'firewall list failed');
    else setFwRules(j.rules || []);
    setFwBusy(false);
  }, [fwBase, server]);

  const addRule = useCallback(async () => {
    if (!server || !fwName.trim() || !fwStart.trim() || !fwEnd.trim()) return;
    setFwBusy(true); setFwError(null);
    const j = await fetchJson(fwBase, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, name: fwName.trim(), startIpAddress: fwStart.trim(), endIpAddress: fwEnd.trim() }),
    });
    if (!j.ok) setFwError(j.error || 'add rule failed');
    else { setFwName(''); setFwStart(''); setFwEnd(''); await loadFirewall(); }
    setFwBusy(false);
  }, [fwBase, server, fwName, fwStart, fwEnd, loadFirewall]);

  const deleteRule = useCallback(async (rule: string) => {
    if (!server) return;
    setFwBusy(true); setFwError(null);
    const j = await fetchJson(`${fwBase}?server=${encodeURIComponent(server)}&rule=${encodeURIComponent(rule)}`, { method: 'DELETE' });
    if (!j.ok) setFwError(j.error || 'delete rule failed');
    else await loadFirewall();
    setFwBusy(false);
  }, [fwBase, server, loadFirewall]);

  const loadAad = useCallback(async () => {
    if (!server || family !== 'azure-sql') return;
    setAadBusy(true); setAadMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/aad-admin?server=${encodeURIComponent(server)}`);
    if (!j.ok) setAadMsg({ ok: false, text: j.error || 'load admin failed' });
    else {
      setAad(j.admin || null);
      if (j.admin) { setAadLogin(j.admin.login || ''); setAadSid(j.admin.sid || ''); setAadTenantId(j.admin.tenantId || ''); }
    }
    setAadBusy(false);
  }, [id, server, family]);

  const saveAad = useCallback(async () => {
    if (!server || !aadLogin.trim() || !aadSid.trim()) return;
    setAadBusy(true); setAadMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/aad-admin`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, login: aadLogin.trim(), sid: aadSid.trim(), tenantId: aadTenantId.trim() || undefined }),
    });
    if (!j.ok) setAadMsg({ ok: false, text: j.error || 'set admin failed' });
    else { setAad(j.admin || null); setAadMsg({ ok: true, text: `Microsoft Entra admin set to ${aadLogin.trim()}.` }); }
    setAadBusy(false);
  }, [id, server, aadLogin, aadSid, aadTenantId]);

  const submitGeo = useCallback(async () => {
    if (!server || !database) { setGeoMsg({ ok: false, text: 'select a server + database first' }); return; }
    if (!replicaServer || !replicaLocation) { setGeoMsg({ ok: false, text: 'replica server + region required' }); return; }
    setGeoBusy(true); setGeoMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/replication`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database, replicaServer, replicaDatabaseName: replicaDb || database, location: replicaLocation, skuName: replicaSku || undefined }),
    });
    setGeoMsg(j.ok
      ? { ok: true, text: `Geo-replica request accepted on ${replicaServer} / ${replicaDb || database}. ARM provisioning continues async.` }
      : { ok: false, text: j.error || 'geo-replication failed' });
    setGeoBusy(false);
  }, [id, server, database, replicaServer, replicaDb, replicaLocation, replicaSku]);

  useEffect(() => { if (server) { loadFirewall(); loadAad(); } }, [server, loadFirewall, loadAad]);

  if (family === 'managed-instance') {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Server admin is managed on the SQL MI resource</MessageBarTitle>
          SQL Managed Instance uses VNet-scoped networking (NSG / route table on the delegated subnet) and
          instance-level Microsoft Entra admin rather than the public <code>firewallRules</code> / server
          <code> administrators</code> ARM surfaces. Wire <code>Microsoft.Sql/managedInstances/administrators</code>
          + a private endpoint to manage these from Loom. Until then this is an honest gate, not a fake form.
        </MessageBarBody>
      </MessageBar>
    );
  }

  if (!server) {
    return (
      <EmptyState
        icon={<ShieldKeyhole20Regular />}
        title="No server selected"
        body="Pick a server on the Connect tab (or in the left pane) to manage firewall rules, the Microsoft Entra admin, and active geo-replication."
      />
    );
  }

  return (
    <>
      {/* Firewall rules — Microsoft.Sql/servers/firewallRules (or PG equivalent) */}
      <div className={s.card}>
        <Subtitle2><ShieldKeyhole20Regular style={{ verticalAlign: 'middle' }} /> Firewall rules — {server}</Subtitle2>
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>{family === 'postgres' ? 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules' : 'Microsoft.Sql/servers/firewallRules'}</MessageBarTitle>
          Inline ARM upsert/delete of server firewall rules. Requires the console UAMI to hold <code>Contributor</code> (or SQL Server Contributor) on the server's resource group; otherwise ARM returns 403 and it surfaces here.
        </MessageBarBody></MessageBar>
        {fwError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Firewall API error</MessageBarTitle>{fwError}</MessageBarBody></MessageBar>}
        <div className={s.tableWrap}>
          <Table size="small" aria-label="Firewall rules">
            <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Start IP</TableHeaderCell><TableHeaderCell>End IP</TableHeaderCell><TableHeaderCell>Action</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {fwRules.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>{fwBusy ? 'Loading…' : 'No firewall rules.'}</Caption1></TableCell></TableRow>}
              {fwRules.map((r) => (
                <TableRow key={r.name}>
                  <TableCell><strong>{r.name}</strong></TableCell>
                  <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{r.startIpAddress}</code></TableCell>
                  <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{r.endIpAddress}</code></TableCell>
                  <TableCell>
                    <Tooltip content={`Delete firewall rule ${r.name}`} relationship="label">
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete firewall rule ${r.name}`} disabled={fwBusy} onClick={() => setConfirmDeleteRule(r.name)}>Delete</Button>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className={s.ruleGrid}>
          <Field label="Rule name"><Input value={fwName} onChange={(_, d) => setFwName(d.value)} placeholder="allow-corp-vpn" /></Field>
          <Field label="Start IP"><Input value={fwStart} onChange={(_, d) => setFwStart(d.value)} placeholder="0.0.0.0" /></Field>
          <Field label="End IP"><Input value={fwEnd} onChange={(_, d) => setFwEnd(d.value)} placeholder="0.0.0.0" /></Field>
          <Button appearance="primary" disabled={fwBusy || !fwName.trim() || !fwStart.trim() || !fwEnd.trim()} onClick={addRule}>{fwBusy ? 'Saving…' : 'Add rule'}</Button>
        </div>
      </div>

      {/* Microsoft Entra admin — Microsoft.Sql/servers/administrators (Azure SQL only) */}
      {family === 'azure-sql' ? (
        <div className={s.card}>
          <Subtitle2><PeopleTeam20Regular style={{ verticalAlign: 'middle' }} /> Microsoft Entra admin — {server}</Subtitle2>
          <MessageBar intent="info"><MessageBarBody>
            <MessageBarTitle>Microsoft.Sql/servers/administrators</MessageBarTitle>
            Sets the server's Microsoft Entra (Azure AD) admin via ARM. The console UAMI itself must be the Entra admin (or a member of the admin group) for the TDS query path to authenticate.
          </MessageBarBody></MessageBar>
          {aad && <Caption1>Current: <strong>{aad.login}</strong>{aad.sid ? <> (<code>{aad.sid.slice(0, 8)}…</code>)</> : null}{aad.azureADOnlyAuthentication ? ' · Entra-only auth enabled' : ''}</Caption1>}
          <div className={s.formGrid}>
            <Field label="Login (UPN or group name)" required><Input value={aadLogin} onChange={(_, d) => setAadLogin(d.value)} placeholder="user@contoso.com" /></Field>
            <Field label="Object id (sid)" required><Input value={aadSid} onChange={(_, d) => setAadSid(d.value)} placeholder="11111111-2222-3333-4444-555555555555" /></Field>
            <Field label="Tenant id (optional)"><Input value={aadTenantId} onChange={(_, d) => setAadTenantId(d.value)} placeholder="leave blank for the server's tenant" /></Field>
          </div>
          {aadMsg && <MessageBar intent={aadMsg.ok ? 'success' : 'error'}><MessageBarBody><MessageBarTitle>{aadMsg.ok ? 'Entra admin updated' : 'Entra admin update failed'}</MessageBarTitle>{aadMsg.text}</MessageBarBody></MessageBar>}
          <Button appearance="primary" disabled={aadBusy || !aadLogin.trim() || !aadSid.trim()} onClick={saveAad}>{aadBusy ? 'Saving…' : 'Set Microsoft Entra admin'}</Button>
        </div>
      ) : (
        <div className={s.card}>
          <Subtitle2><PeopleTeam20Regular style={{ verticalAlign: 'middle' }} /> Microsoft Entra admin</Subtitle2>
          <MessageBar intent="warning"><MessageBarBody>
            <MessageBarTitle>Entra auth on PostgreSQL is principal-based</MessageBarTitle>
            PostgreSQL flexible servers don't expose a single server-level <code>administrators</code> ARM resource; Entra principals are created in-engine via <code>pgaadauth_create_principal</code>. The Query tab runs over the real <code>pg</code> wire protocol with an Entra token — register the console identity once (<code>SELECT * FROM pgaadauth_create_principal('&lt;console-uami-name&gt;', false, false)</code>) and set <code>LOOM_POSTGRES_AAD_USER</code> to that name. Honest gate — not a fake form.
          </MessageBarBody></MessageBar>
        </div>
      )}

      {/* Geo-replication — createMode=Secondary (Azure SQL only) */}
      {family === 'azure-sql' ? (
        <div className={s.card}>
          <Subtitle2><BranchFork20Regular style={{ verticalAlign: 'middle' }} /> Active geo-replication — {database || '(select a database)'}</Subtitle2>
          <MessageBar intent="info"><MessageBarBody>
            <MessageBarTitle>Microsoft.Sql/servers/databases · createMode=Secondary</MessageBarTitle>
            Creates a readable geo-secondary of the selected database on a replica server via ARM REST. Long-running; ARM continues async after acceptance.
          </MessageBarBody></MessageBar>
          <div className={s.formGrid}>
            <Field label="Replica server" required>
              <select className={s.select} value={replicaServer} onChange={(e) => setReplicaServer(e.target.value)}>
                <option value="">Select a replica server…</option>
                {servers.filter((x) => x.name !== server).map((x) => <option key={x.name} value={x.name}>{x.name} · {x.location}</option>)}
              </select>
            </Field>
            <Field label="Replica DB name"><Input value={replicaDb} onChange={(_, d) => setReplicaDb(d.value)} placeholder={database || 'same as primary'} /></Field>
            <Field label="Replica region" required>
              <Dropdown className={s.fullWidth} selectedOptions={replicaLocation ? [replicaLocation] : []} value={replicaLocation} onOptionSelect={(_, d) => setReplicaLocation(d.optionValue || '')} aria-label="Replica region">
                {AZURE_REGIONS.map((r) => <Option key={r} value={r}>{r}</Option>)}
              </Dropdown>
            </Field>
            <Field label="SKU (optional — blank matches primary)">
              <Dropdown className={s.fullWidth} selectedOptions={replicaSku ? [replicaSku] : []} value={replicaSku} placeholder="Match primary" onOptionSelect={(_, d) => setReplicaSku(d.optionValue || '')} aria-label="Replica SKU">
                <Option value="">Match primary</Option>
                {SQL_DB_SKUS.map((sku) => <Option key={sku} value={sku}>{sku}</Option>)}
              </Dropdown>
            </Field>
          </div>
          {geoMsg && <MessageBar intent={geoMsg.ok ? 'success' : 'error'}><MessageBarBody><MessageBarTitle>{geoMsg.ok ? 'Geo-replica accepted' : 'Geo-replication failed'}</MessageBarTitle>{geoMsg.text}</MessageBarBody></MessageBar>}
          <Button appearance="primary" icon={<Add20Regular />} disabled={geoBusy || !database || !replicaServer || !replicaLocation} onClick={submitGeo}>{geoBusy ? 'Creating…' : 'Create geo-replica'}</Button>
        </div>
      ) : (
        <div className={s.card}>
          <Subtitle2><BranchFork20Regular style={{ verticalAlign: 'middle' }} /> Geo-replication</Subtitle2>
          <MessageBar intent="warning"><MessageBarBody>
            <MessageBarTitle>PostgreSQL read replicas use a distinct ARM surface</MessageBarTitle>
            PG flexible-server read replicas are created via <code>Microsoft.DBforPostgreSQL/flexibleServers</code> with <code>createMode=Replica</code> + <code>sourceServerResourceId</code>, not the Azure SQL secondary-database path. Wire a PG replica route to manage it here. Honest gate.
          </MessageBarBody></MessageBar>
        </div>
      )}

      {/* Destructive-op confirmation for firewall rule deletion. */}
      <Dialog open={!!confirmDeleteRule} onOpenChange={(_, d) => { if (!d.open) setConfirmDeleteRule(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete firewall rule?</DialogTitle>
            <DialogContent>
              <Body1>
                This removes <code>{confirmDeleteRule}</code> from <strong>{server}</strong> via ARM.
                Clients in that IP range lose access. This cannot be undone.
              </Body1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDeleteRule(null)} disabled={fwBusy}>Cancel</Button>
              <Button appearance="primary" disabled={fwBusy} onClick={async () => { const n = confirmDeleteRule; setConfirmDeleteRule(null); if (n) await deleteRule(n); }}>
                {fwBusy ? 'Deleting…' : 'Delete rule'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

export function UnifiedSqlDatabaseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  // ---- tenant inventory ----
  const [inv, setInv] = useState<Inventory | null>(null);
  const [invLoading, setInvLoading] = useState(true);
  const [invError, setInvError] = useState<string | null>(null);

  const loadInventory = useCallback(async () => {
    setInvLoading(true); setInvError(null);
    const j = await fetchJson('/api/items/sql-databases');
    if (!j.ok) { setInvError(j.error || 'inventory failed'); setInv(null); }
    else setInv({ sql: j.sql, mi: j.mi, postgres: j.postgres });
    setInvLoading(false);
  }, []);
  useEffect(() => { loadInventory(); }, [loadInventory]);

  // ---- active connection (bound to item state) ----
  const [family, setFamily] = useState<Family>('azure-sql');
  const [server, setServer] = useState('');
  const [database, setDatabase] = useState('');
  const [databases, setDatabases] = useState<string[]>([]);
  // Full database objects (incl. sku) so the Compute & Storage tab can show the
  // currently-bound SKU as the "before" without an extra ARM GET.
  const [databasesFull, setDatabasesFull] = useState<Array<{ name: string; sku?: { name?: string; tier?: string; family?: string; capacity?: number } }>>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [bindMsg, setBindMsg] = useState<string | null>(null);

  const serverFqdn = useMemo(() => {
    if (!inv) return '';
    if (family === 'azure-sql') return inv.sql.servers.find((x) => x.name === server)?.fqdn || '';
    if (family === 'postgres') return inv.postgres.servers.find((x) => x.name === server)?.fqdn || '';
    return inv.mi.instances.find((x) => x.name === server)?.fqdn || '';
  }, [inv, family, server]);

  // ---- connection strings (Connect tab card) ----
  type ConnDriverKey = 'adonet' | 'jdbc' | 'odbc' | 'php' | 'go';
  const [connDriver, setConnDriver] = useState<ConnDriverKey>('adonet');
  const [connCopied, setConnCopied] = useState<ConnDriverKey | null>(null);
  const connStrings = useMemo(
    () => ((family === 'azure-sql' && serverFqdn && database)
      ? buildConnectionStrings({ fqdn: serverFqdn, database })
      : null),
    [family, serverFqdn, database],
  );
  const copyConnStr = useCallback(async (key: ConnDriverKey, value: string) => {
    await navigator.clipboard?.writeText(value);
    setConnCopied(key);
    setTimeout(() => setConnCopied(null), 2000);
  }, []);

  const loadDatabases = useCallback(async (fam: Family, srv: string) => {
    setDatabases([]); setDatabasesFull([]); setDbError(null);
    if (!srv || fam === 'managed-instance') return;
    setDbLoading(true);
    const url = fam === 'postgres'
      ? `/api/items/postgres-flexible-server/${encodeURIComponent(id)}/databases?server=${encodeURIComponent(srv)}`
      : `/api/items/azure-sql-server/${encodeURIComponent(id)}/databases?server=${encodeURIComponent(srv)}`;
    const j = await fetchJson(url);
    if (!j.ok) setDbError(j.error || 'databases failed');
    else {
      setDatabases((j.databases || []).map((d: any) => d.name));
      setDatabasesFull((j.databases || []).map((d: any) => ({ name: d.name, sku: d.sku })));
    }
    setDbLoading(false);
  }, [id]);

  const pickServer = useCallback((fam: Family, srv: string) => {
    setFamily(fam); setServer(srv); setDatabase('');
    loadDatabases(fam, srv);
  }, [loadDatabases]);

  const bindConnection = useCallback(async () => {
    setBindMsg(null);
    if (id === 'new') { setBindMsg('Save this item first (it lives in a workspace), then bind a connection.'); return; }
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/connect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ family, server, database }),
    });
    setBindMsg(j.ok ? `Bound ${family} · ${server}${database ? ' / ' + database : ''} to this item.` : (j.error || 'bind failed'));
  }, [id, family, server, database]);

  // ---- query ----
  const [tab, setTab] = useState<'connect' | 'provision' | 'query' | 'queries' | 'schema' | 'admin' | 'security' | 'performance' | 'catalog' | 'mirroring' | 'scale' | 'get-data' | 'share' | 'git'>('connect');
  const dialect = family === 'postgres' ? 'sql' : 'tsql';
  const [sqlText, setSqlText] = useState(
    `-- ${family === 'postgres' ? 'PostgreSQL' : 'Azure SQL'} smoke query\nSELECT 1 AS smoke;`,
  );
  const [qResult, setQResult] = useState<QueryResponse | null>(null);
  const [qLoading, setQLoading] = useState(false);
  // Background-job continuity: the query runs in the module-scope jobs-store so
  // it survives this editor unmounting (tab switch / close). activeJobId lets us
  // recover the result on remount; activeRequestId is the TDS cancel token.
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const startSqlQuery = useJobsStore((st) => st.startSqlQuery);
  const jobs = useJobsStore((st) => st.jobs);

  // ---- Copilot (Fix / Explain / NL→T-SQL + inline ghost text) ----
  // Only the Azure SQL (T-SQL) family is wired to the SQL Copilot; PostgreSQL /
  // SQL MI fall outside the T-SQL prompt contract and stay honest-gated.
  const copilotEligible = family === 'azure-sql' && !!server && !!database;
  // SQL Copilot pane open/collapsed persists PER SURFACE — collapsed hands the
  // query canvas its width back, leaving a thin re-expand rail. `collapsed` is
  // the inverse of `copilotOpen`, so every existing call site (incl. the
  // `(v) => !v` updater + `setCopilotOpen(true/false)`) keeps working.
  const [copilotCollapsed, setCopilotCollapsed] = useCollapsibleState(`sql-copilot.${id}`, true);
  const copilotOpen = !copilotCollapsed;
  const setCopilotOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCopilotCollapsed((prev) => !(typeof v === 'function' ? (v as (p: boolean) => boolean)(!prev) : v));
  }, [setCopilotCollapsed]);
  const [copilotMessages, setCopilotMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [copilotLoading, setCopilotLoading] = useState(false);
  const [copilotGate, setCopilotGate] = useState<string | null>(null);
  const [nlInput, setNlInput] = useState('');
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const inlineDisposeRef = useRef<{ dispose(): void } | null>(null);
  const sqlSelectionRef = useRef<string>('');
  const schemaRef = useRef<string>('');         // compact schema string for ghost-text grounding
  const copilotOpenRef = useRef<boolean>(false); // read live inside the inline provider
  useEffect(() => { copilotOpenRef.current = copilotOpen; }, [copilotOpen]);

  const queryUrl = useMemo(() => {
    if (family === 'postgres') return `/api/items/postgres-flexible-server/${encodeURIComponent(id)}/query`;
    return `/api/items/azure-sql-database/${encodeURIComponent(id)}/query`;
  }, [family, id]);

  const run = useCallback((sqlOverride?: string) => {
    const sqlToRun = sqlOverride ?? sqlText;
    if (!server) { setQResult({ ok: false, error: 'select a server first' }); return; }
    if (family !== 'postgres' && !database) { setQResult({ ok: false, error: 'select a database first' }); return; }
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setActiveRequestId(reqId);
    setQLoading(true); setQResult(null);
    const jobId = startSqlQuery({
      databaseName: database || 'postgres',
      server,
      sqlLabel: sqlToRun.slice(0, 80),
      sqlText: sqlToRun,
      queryUrl,
      requestId: reqId,
      onDone: ({ ok, queryResult, error, code }) => {
        // Fires whether or not we're still mounted; React no-ops setState on an
        // unmounted component. The remount useEffect recovers a backgrounded
        // result from the store.
        setQLoading(false); setActiveJobId(null); setActiveRequestId(null);
        setQResult(ok && queryResult
          ? { ok: true, ...queryResult }
          : { ok: false, error: error || 'query failed', code });
      },
    });
    setActiveJobId(jobId);
  }, [queryUrl, server, database, family, sqlText, startSqlQuery]);

  // Cancel an in-flight query by sending a TDS ATTENTION packet to the BFF. The
  // running fetch in the jobs-store then resolves with { ok:false, code:'ECANCEL' }
  // and onDone restores the UI — no AbortController, the server actually stops.
  const cancelQuery = useCallback(async () => {
    if (!activeRequestId || family === 'postgres') return;
    try {
      await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/query/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: activeRequestId }),
      });
    } catch { /* cancel is best-effort; the query promise still settles */ }
  }, [id, activeRequestId, family]);

  // Recover a result for a query that completed while this editor was unmounted
  // (the user navigated away and came back). onDone was a no-op on the unmounted
  // component, but the finished job is still in the store.
  useEffect(() => {
    if (!activeJobId) return;
    const job = jobs.find((j) => j.id === activeJobId);
    if (!job || job.status === 'running') return;
    setQLoading(false);
    setQResult(job.status === 'success' && job.queryResult
      ? { ok: true, ...job.queryResult }
      : { ok: false, error: job.error || 'query failed' });
    setActiveJobId(null);
    setActiveRequestId(null);
  }, [jobs, activeJobId]);

  // Load a statement from the object navigator into the Query tab (SELECT
  // TOP 1000, EXEC, CREATE templates) — matches the SSMS / portal flow.
  const openInQuery = useCallback((sql: string) => {
    setSqlText(sql);
    setTab('query');
  }, []);

  // ---- saved queries (My Queries / Shared Queries) ----
  const queriesUrl = useMemo(
    () => `/api/items/azure-sql-database/${encodeURIComponent(id)}/queries`,
    [id],
  );
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [sqLoading, setSqLoading] = useState(false);
  const [sqError, setSqError] = useState<string | null>(null);
  const [callerRole, setCallerRole] = useState<WorkspaceRoleName | null>(null);
  const [selectedQueryIds, setSelectedQueryIds] = useState<Set<string>>(new Set());
  // Save / rename dialog state.
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');
  const [saveScope, setSaveScope] = useState<'private' | 'shared'>('private');
  const [saveSql, setSaveSql] = useState('');
  const [editingQueryId, setEditingQueryId] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const loadSavedQueries = useCallback(async () => {
    if (id === 'new') return;
    setSqLoading(true); setSqError(null);
    const j = await fetchJson(queriesUrl);
    if (j.ok) {
      setSavedQueries(j.queries || []);
      setCallerRole(j.callerRole ?? null);
      setSelectedQueryIds((prev) => {
        const live = new Set((j.queries || []).map((q: SavedQuery) => q.id));
        const next = new Set<string>();
        for (const sid of prev) if (live.has(sid)) next.add(sid);
        return next;
      });
    } else {
      setSqError(j.error || 'failed to load saved queries');
    }
    setSqLoading(false);
  }, [queriesUrl, id]);

  // Load saved queries when the item id resolves (skip the transient 'new').
  useEffect(() => { if (id !== 'new') loadSavedQueries(); }, [id, loadSavedQueries]);

  const openSaveNew = useCallback(() => {
    setEditingQueryId(null);
    setSaveName('');
    setSaveDesc('');
    setSaveScope('private');
    setSaveSql(sqlText);
    setSaveErr(null);
    setSaveDialogOpen(true);
  }, [sqlText]);

  const openRename = useCallback((q: SavedQuery) => {
    setEditingQueryId(q.id);
    setSaveName(q.name);
    setSaveDesc(q.description || '');
    setSaveScope(q.scope);
    setSaveSql(q.sql);
    setSaveErr(null);
    setSaveDialogOpen(true);
  }, []);

  const submitSaveQuery = useCallback(async () => {
    if (!saveName.trim()) { setSaveErr('name is required'); return; }
    if (!saveSql.trim()) { setSaveErr('the query text is empty'); return; }
    setSaveBusy(true); setSaveErr(null);
    const j = await fetchJson(queriesUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queryId: editingQueryId || undefined,
        name: saveName.trim(),
        description: saveDesc.trim() || undefined,
        sql: saveSql,
        scope: saveScope,
      }),
    });
    setSaveBusy(false);
    if (j.ok) {
      setSaveDialogOpen(false);
      setEditingQueryId(null);
      loadSavedQueries();
    } else {
      setSaveErr(j.error || 'save failed');
    }
  }, [queriesUrl, editingQueryId, saveName, saveDesc, saveSql, saveScope, loadSavedQueries]);

  const duplicateQuery = useCallback(async (q: SavedQuery) => {
    setSqError(null);
    const j = await fetchJson(queriesUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${q.name} (copy)`, description: q.description, sql: q.sql, scope: 'private' }),
    });
    if (j.ok) loadSavedQueries(); else setSqError(j.error || 'duplicate failed');
  }, [queriesUrl, loadSavedQueries]);

  const bulkDeleteQueries = useCallback(async () => {
    if (selectedQueryIds.size === 0) return;
    setSqError(null);
    const j = await fetchJson(queriesUrl, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queryIds: [...selectedQueryIds] }),
    });
    if (j.ok) {
      setSelectedQueryIds(new Set());
      loadSavedQueries();
    } else {
      setSqError(j.error || 'delete failed');
    }
  }, [queriesUrl, selectedQueryIds, loadSavedQueries]);

  const openSavedQuery = useCallback((q: SavedQuery) => {
    setSqlText(q.sql);
    setTab('query');
  }, []);

  // ---- Copilot ghost-text schema grounding ----
  // Populate schemaRef with a compact INFORMATION_SCHEMA.COLUMNS catalog over
  // the SAME live TDS path the Query tab uses, so the inline completion provider
  // (and the side pane) reference REAL table/column names. Soft-fails to empty.
  const loadCopilotSchema = useCallback(async () => {
    if (family !== 'azure-sql' || !server || !database) { schemaRef.current = ''; return; }
    const j = await fetchJson(queryUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server, database,
        sql: 'SELECT TOP 200 TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION',
      }),
    });
    if (j.ok && Array.isArray(j.rows)) {
      schemaRef.current = j.rows.map((r: unknown[]) => `${r[0]}.${r[1]}.${r[2]} (${r[3]})`).join('\n');
    } else {
      schemaRef.current = '';
    }
  }, [queryUrl, server, database, family]);

  // Refresh the ghost-text schema cache whenever the Copilot is open against a
  // new Azure SQL server/database.
  useEffect(() => {
    if (copilotOpen && copilotEligible) { loadCopilotSchema(); }
  }, [copilotOpen, copilotEligible, loadCopilotSchema]);

  // Wire ghost-text inline completion + selection capture onto the Monaco
  // editor once it mounts. The provider reads copilotOpenRef/schemaRef live so
  // it always reflects the latest state without re-registering.
  const handleEditorReady = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    inlineDisposeRef.current?.dispose();
    inlineDisposeRef.current = registerInlineCompletion(editor, monaco, () => ({
      enabled: copilotOpenRef.current,
      locked: false,
      lang: 'tsql',
      priorCells: [],
      schemaContext: schemaRef.current,
    }));
    editor.onDidChangeCursorSelection?.(() => {
      const sel = editor.getSelection?.();
      const model = editor.getModel?.();
      sqlSelectionRef.current = (sel && model && !sel.isEmpty?.())
        ? (model.getValueInRange?.(sel) || '')
        : '';
    });
  }, []);
  useEffect(() => () => { inlineDisposeRef.current?.dispose(); }, []);

  // Extract the first fenced ```sql block (falls back to the whole text).
  const extractSql = useCallback((text: string): string => {
    const m = text.match(/```(?:sql|tsql)?\s*([\s\S]*?)```/i);
    return (m ? m[1] : text).trim();
  }, []);

  // Replace the whole editor buffer with the Copilot-generated SQL.
  const insertSql = useCallback((sql: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    if (editor && model) {
      editor.executeEdits?.('sql-copilot', [{ range: model.getFullModelRange(), text: sql }]);
      editor.focus?.();
    }
    setSqlText(sql);
  }, []);

  // Stream a Fix / Explain / NL→T-SQL turn from the new copilot BFF route.
  const invokeCopilot = useCallback(async (command: 'fix' | 'explain' | 'nl2sql') => {
    if (!copilotEligible) return;
    const selection = sqlSelectionRef.current.trim();
    const snippet = command === 'nl2sql' ? nlInput.trim() : (selection || sqlText);
    if (!snippet) {
      setCopilotMessages((prev) => [...prev, { role: 'assistant', text: command === 'nl2sql' ? 'Type a request above first.' : 'Write or select some SQL first.' }]);
      return;
    }
    setCopilotOpen(true);
    setCopilotGate(null);
    setCopilotLoading(true);
    const userText = command === 'nl2sql'
      ? nlInput.trim()
      : `/${command} ${(selection ? '(selection) ' : '')}${snippet.replace(/\s+/g, ' ').slice(0, 80)}${snippet.length > 80 ? '…' : ''}`;
    setCopilotMessages((prev) => [...prev, { role: 'user', text: userText }]);

    let res: Response;
    try {
      res = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/copilot`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server, database, command, sql: snippet, selection }),
      });
    } catch (e: any) {
      setCopilotMessages((prev) => [...prev, { role: 'assistant', text: `Network error: ${e?.message || String(e)}` }]);
      setCopilotLoading(false);
      return;
    }

    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({} as any));
      if (j?.code === 'no_aoai') setCopilotGate(j.hint || j.error || 'Azure OpenAI not configured.');
      else setCopilotMessages((prev) => [...prev, { role: 'assistant', text: j?.error || `Request failed (HTTP ${res.status}).` }]);
      setCopilotLoading(false);
      return;
    }

    // Stream the SSE envelope (event: chunk → { delta }).
    setCopilotMessages((prev) => [...prev, { role: 'assistant', text: '' }]);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (j.delta) {
              full += j.delta;
              setCopilotMessages((prev) => {
                const msgs = [...prev];
                msgs[msgs.length - 1] = { role: 'assistant', text: full };
                return msgs;
              });
            }
            if (j.error) {
              setCopilotMessages((prev) => {
                const msgs = [...prev];
                msgs[msgs.length - 1] = { role: 'assistant', text: full || `Error: ${j.error}` };
                return msgs;
              });
            }
          } catch { /* partial JSON across a chunk boundary */ }
        }
      }
    } finally {
      setCopilotLoading(false);
      if (command === 'nl2sql') setNlInput('');
    }
  }, [copilotEligible, id, server, database, sqlText, nlInput]);

  // ---- Get data → ADF ingestion deep-links (Copy / pipeline / dataflow) ----
  // Opens REAL Azure Data Factory Studio with THIS database pre-wired as the
  // copy sink. New pipeline/dataflow first upsert the AzureSqlDatabase linked
  // service + AzureSqlTable dataset + artifact via ARM, then window.open the
  // authoring canvas. No toasts — real navigation (per ui-parity.md).
  type GetDataAction = 'copy-data' | 'new-pipeline' | 'new-dataflow';
  const [getDataBusy, setGetDataBusy] = useState(false);
  const [getDataMsg, setGetDataMsg] = useState<
    { ok: boolean; text: string; url?: string; factoryName?: string; privateNetworkGate?: boolean; factoryMiPrincipalHint?: string } | null
  >(null);
  const [receiptRunId, setReceiptRunId] = useState('');

  const openGetData = useCallback(async (action: GetDataAction) => {
    if (!server || !database) { setGetDataMsg({ ok: false, text: 'Pick a server + database on the Connect tab first.' }); setTab('get-data'); return; }
    setGetDataBusy(true); setGetDataMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/get-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, family, server, serverFqdn, database }),
    });
    setGetDataBusy(false);
    setTab('get-data');
    if (!j.ok) { setGetDataMsg({ ok: false, text: j.error || 'Get data failed' }); return; }
    // Real navigation — open ADF Studio in a new tab. No toast.
    if (j.url) window.open(j.url, '_blank', 'noopener,noreferrer');
    const label = action === 'copy-data' ? 'Copy Data Tool'
      : action === 'new-pipeline' ? `pipeline ${j.pipelineName}`
      : `dataflow ${j.dataflowName}`;
    setGetDataMsg({
      ok: true,
      text: `Opened ADF Studio — ${label}. This database is the pre-wired copy sink.`,
      url: j.url, factoryName: j.factoryName, privateNetworkGate: j.privateNetworkGate,
      factoryMiPrincipalHint: j.factoryMiPrincipalHint,
    });
  }, [id, family, server, serverFqdn, database]);

  // Azure-native mirroring (change feed → ADLS Bronze Delta; no Fabric).
  const [mirror, setMirror] = useState<any>(null);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const toggleMirror = useCallback(async () => {
    if (!server || !database) { setMirror({ ok: false, error: 'select a server + database first' }); return; }
    setMirrorBusy(true); setMirror(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/mirroring`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database }),
    });
    setMirror(j); setMirrorBusy(false);
  }, [server, database, id]);

  // ---- schema browser (INFORMATION_SCHEMA via the live query path) ----
  const [schema, setSchema] = useState<QueryResponse | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const loadSchema = useCallback(async () => {
    if (!server || (family !== 'postgres' && !database)) { setSchema({ ok: false, error: 'select a server + database first' }); return; }
    setSchemaLoading(true); setSchema(null);
    const sql =
      'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME;';
    const j = await fetchJson(queryUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database: database || 'postgres', sql }),
    });
    setSchema(j);
    setSchemaLoading(false);
  }, [queryUrl, server, database, family]);

  // ---- provision (SQL DB on existing server, or new PG flex server) ----
  const [provFamily, setProvFamily] = useState<'azure-sql' | 'postgres'>('azure-sql');
  const [provBusy, setProvBusy] = useState(false);
  const [provMsg, setProvMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // SQL DB fields
  const [newDbServer, setNewDbServer] = useState('');
  const [newDbName, setNewDbName] = useState('');
  const [newDbSku, setNewDbSku] = useState('GP_S_Gen5_2');
  const [newDbTier, setNewDbTier] = useState('GeneralPurpose');
  const [newDbSample, setNewDbSample] = useState(false);
  const [newDbZoneRedundant, setNewDbZoneRedundant] = useState(false);
  const [newDbCollation, setNewDbCollation] = useState<SqlCollation>(DEFAULT_COLLATION);
  const [newDbBackupRedundancy, setNewDbBackupRedundancy] = useState('');
  const [newDbMaintenanceWindow, setNewDbMaintenanceWindow] = useState('');
  const [maintenanceConfigs, setMaintenanceConfigs] = useState<{ id: string; name: string; displayName: string }[]>([]);
  const [maintLoading, setMaintLoading] = useState(false);
  // PG fields
  const [pgName, setPgName] = useState('');
  const [pgRg, setPgRg] = useState('');
  const [pgLocation, setPgLocation] = useState('eastus2');
  const [pgAdmin, setPgAdmin] = useState('');
  const [pgPassword, setPgPassword] = useState('');
  const [pgSku, setPgSku] = useState('Standard_B1ms');
  const [pgTier, setPgTier] = useState('Burstable');
  const [pgVersion, setPgVersion] = useState('16');

  const loadMaintenanceConfigs = useCallback(async (serverName: string) => {
    if (!serverName) { setMaintenanceConfigs([]); return; }
    const loc = inv?.sql.servers.find((srv) => srv.name === serverName)?.location;
    if (!loc) { setMaintenanceConfigs([]); return; }
    setMaintLoading(true);
    const j = await fetchJson(
      `/api/items/azure-sql-database/${encodeURIComponent(id)}/maintenance-configs?location=${encodeURIComponent(loc)}`,
    );
    setMaintenanceConfigs(j.ok ? (j.configs || []) : []);
    setMaintLoading(false);
  }, [id, inv]);

  // Discover the region's maintenance windows whenever a target server is picked.
  useEffect(() => {
    if (newDbServer) loadMaintenanceConfigs(newDbServer);
    else setMaintenanceConfigs([]);
    // Reset any prior selection — windows are region-specific.
    setNewDbMaintenanceWindow('');
  }, [newDbServer, loadMaintenanceConfigs]);

  const provisionSqlDb = useCallback(async () => {
    // Client-side collation guard — reject anything outside the enumerated list
    // before issuing the BFF call (the dropdown enforces this; this is a
    // defense-in-depth check that mirrors the route-level validation).
    if (!SQL_COLLATIONS.includes(newDbCollation)) {
      setProvMsg({ ok: false, text: `Collation '${newDbCollation}' is not in the supported list.` });
      return;
    }
    setProvBusy(true); setProvMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/create-db`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server: newDbServer, name: newDbName, skuName: newDbSku, tier: newDbTier,
        sampleName: newDbSample ? 'AdventureWorksLT' : undefined,
        zoneRedundant: newDbZoneRedundant || undefined,
        collation: newDbCollation !== DEFAULT_COLLATION ? newDbCollation : undefined,
        requestedBackupStorageRedundancy: newDbBackupRedundancy || undefined,
        maintenanceConfigurationId: newDbMaintenanceWindow || undefined,
      }),
    });
    setProvMsg(j.ok
      ? { ok: true, text: `Azure SQL database '${newDbName}' provisioning on ${newDbServer} · collation ${newDbCollation}${newDbZoneRedundant ? ' · zone-redundant' : ''} (status: ${j.status || 'accepted'}). ARM continues async.` }
      : { ok: false, text: j.error || 'create failed' });
    if (j.ok) loadInventory();
    setProvBusy(false);
  }, [id, newDbServer, newDbName, newDbSku, newDbTier, newDbSample, newDbZoneRedundant, newDbCollation, newDbBackupRedundancy, newDbMaintenanceWindow, loadInventory]);

  const provisionPg = useCallback(async () => {
    setProvBusy(true); setProvMsg(null);
    const j = await fetchJson('/api/items/postgres-flexible-server', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: pgName, resourceGroup: pgRg, location: pgLocation,
        administratorLogin: pgAdmin, administratorLoginPassword: pgPassword,
        skuName: pgSku, tier: pgTier, version: pgVersion,
      }),
    });
    setProvMsg(j.ok
      ? { ok: true, text: `PostgreSQL flexible server '${pgName}' provisioning in ${pgRg} (${j.provisioningState || 'accepted'}). ARM continues async.` }
      : { ok: false, text: j.error || 'create failed' });
    if (j.ok) loadInventory();
    setProvBusy(false);
  }, [pgName, pgRg, pgLocation, pgAdmin, pgPassword, pgSku, pgTier, pgVersion, loadInventory]);

  // ---- catalog register ----
  const [catBusy, setCatBusy] = useState(false);
  const [catMsg, setCatMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const registerCatalog = useCallback(async () => {
    setCatBusy(true); setCatMsg(null);
    const j = await fetchJson('/api/catalog/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'azure-database', family, fqdn: serverFqdn, database, displayName: database || server }),
    });
    setCatMsg(j.ok
      ? { ok: true, text: `Registered as Purview asset (${j.typeName}).`, link: j.purviewDeepLink }
      : { ok: false, text: j.hint ? `${j.error} — ${j.hint}` : (j.error || 'register failed') });
    setCatBusy(false);
  }, [family, serverFqdn, database, server]);

  // Ctrl+S → Run on the Query tab; on the Saved-queries tab it opens the
  // "Save current query" dialog (SSMS muscle memory either way).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (tab === 'queries') { if (id !== 'new') openSaveNew(); }
        else if (tab === 'query' && !qLoading) run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, qLoading, run, id, openSaveNew]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Connection', actions: [
        { label: invLoading ? 'Refreshing…' : 'Refresh inventory', onClick: invLoading ? undefined : loadInventory, disabled: invLoading },
        { label: 'Bind connection', onClick: server ? bindConnection : undefined, disabled: !server, title: !server ? 'Pick a server first' : undefined },
      ]},
      { label: 'Query', actions: [
        { label: qLoading ? 'Running…' : 'Run', onClick: !qLoading ? () => run() : undefined, disabled: qLoading || !server },
      ]},
      { label: 'Copilot', actions: [
        { label: copilotOpen ? 'Hide Copilot' : 'Copilot', icon: copilotOpen ? <Sparkle20Filled /> : <Sparkle20Regular />,
          onClick: () => { setTab('query'); setCopilotOpen((v) => !v); },
          title: 'Toggle the SQL Copilot side pane (Fix / Explain / NL→T-SQL + inline ghost text)' },
        { label: 'Explain', icon: <TextBulletListSquare20Regular />,
          onClick: copilotEligible ? () => { setTab('query'); invokeCopilot('explain'); } : undefined,
          disabled: !copilotEligible,
          title: family !== 'azure-sql' ? 'Azure SQL (T-SQL) only' : !(server && database) ? 'Connect a server + database first' : 'Annotate the selected SQL with inline comments' },
        { label: 'Fix', icon: <Bug20Regular />,
          onClick: copilotEligible ? () => { setTab('query'); invokeCopilot('fix'); } : undefined,
          disabled: !copilotEligible,
          title: family !== 'azure-sql' ? 'Azure SQL (T-SQL) only' : !(server && database) ? 'Connect a server + database first' : 'Repair the selected (or full) SQL so it runs' },
      ]},
      { label: 'Schema', actions: [
        { label: 'Browse objects', onClick: server ? () => { setTab('schema'); loadSchema(); } : undefined, disabled: !server, title: !server ? 'Pick a server first' : 'Open the sys.* object navigator' },
      ]},
      { label: 'Server admin', actions: [
        { label: 'Firewall', onClick: server ? () => setTab('admin') : undefined, disabled: !server, title: !server ? 'Pick a server first' : 'Manage firewall rules' },
        { label: 'Entra admin', onClick: server ? () => setTab('admin') : undefined, disabled: !server, title: !server ? 'Pick a server first' : 'Set the Microsoft Entra admin' },
        { label: 'Geo-replication', onClick: server ? () => setTab('admin') : undefined, disabled: !server, title: !server ? 'Pick a server first' : 'Create a geo-secondary' },
        { label: 'Scale compute', onClick: (family === 'azure-sql' && server && database) ? () => setTab('scale') : undefined, disabled: !(family === 'azure-sql' && server && database), title: family !== 'azure-sql' ? 'Azure SQL only' : !(server && database) ? 'Pick a server + database first' : 'Change DTU / vCore tier, serverless auto-pause, and max storage' },
      ]},
      { label: 'Data security', actions: [
        { label: 'GRANT / RLS / masking', onClick: (server && database && family === 'azure-sql') ? () => setTab('security') : undefined, disabled: !(server && database && family === 'azure-sql'), title: family !== 'azure-sql' ? 'Azure SQL only' : !(server && database) ? 'Pick a server + database first' : 'Object/column GRANT, Row-Level Security, Dynamic Data Masking' },
      ]},
      { label: 'Share', actions: [
        { label: 'Manage access', onClick: (server && database && family === 'azure-sql') ? () => setTab('share') : undefined, disabled: !(server && database && family === 'azure-sql'), title: family !== 'azure-sql' ? 'Azure SQL only' : !(server && database) ? 'Pick a server + database first' : 'Assign Azure RBAC roles on this database (Access control / IAM)' },
      ]},
      { label: 'Source control', actions: [
        { label: 'Git settings', onClick: () => setTab('git'), title: 'Connect this database schema to Azure DevOps or GitHub' },
      ]},
      { label: 'Performance', actions: [
        { label: 'Query Store / QPI', onClick: (server && database) ? () => setTab('performance') : undefined, disabled: !(server && database), title: !(server && database) ? 'Pick a server + database first' : 'Top-resource queries, runtime-stats time series + execution plans over Query Store' },
      ]},
      { label: 'Catalog', actions: [
        { label: 'Register in Purview', onClick: serverFqdn ? () => { setTab('catalog'); } : undefined, disabled: !serverFqdn },
      ]},
      { label: 'Saved queries', actions: [
        { label: 'My Queries', onClick: id !== 'new' ? () => { setTab('queries'); loadSavedQueries(); } : undefined, disabled: id === 'new', title: id === 'new' ? 'Save the item first' : 'Open the saved-queries panel' },
        { label: 'Save current query', onClick: id !== 'new' ? openSaveNew : undefined, disabled: id === 'new', title: id === 'new' ? 'Save the item first' : 'Save the current Query-tab text' },
      ]},
      { label: 'Get data', actions: [
        {
          label: 'Get data',
          disabled: getDataBusy || !server,
          title: !server ? 'Pick a server first' : 'Open Azure Data Factory ingestion surfaces with this database as the sink',
          dropdownItems: [
            {
              label: getDataBusy ? 'Opening…' : 'Copy data',
              icon: <ArrowDownload20Regular />,
              onClick: (server && database && !getDataBusy) ? () => openGetData('copy-data') : undefined,
              disabled: getDataBusy || !(server && database),
              title: !database ? 'Pick a database first' : 'Open the ADF Copy Data Tool (this DB is the sink)',
            },
            {
              label: 'New pipeline',
              icon: <Play20Regular />,
              onClick: (server && database && family === 'azure-sql' && !getDataBusy) ? () => openGetData('new-pipeline') : undefined,
              disabled: getDataBusy || !(server && database && family === 'azure-sql'),
              title: family !== 'azure-sql' ? 'Azure SQL sink only — use Copy data for other engines' : !database ? 'Pick a database first' : 'Create an ADF pipeline with this DB as the Copy sink',
            },
            {
              label: 'New dataflow',
              icon: <Database20Regular />,
              onClick: (server && database && family === 'azure-sql' && !getDataBusy) ? () => openGetData('new-dataflow') : undefined,
              disabled: getDataBusy || !(server && database && family === 'azure-sql'),
              title: family !== 'azure-sql' ? 'Azure SQL sink only — use Copy data for other engines' : !database ? 'Pick a database first' : 'Create an ADF Mapping Data Flow with this DB as the sink',
            },
          ],
        },
      ]},
    ]},
  ], [invLoading, loadInventory, server, database, family, bindConnection, qLoading, run, serverFqdn, loadSchema, id, loadSavedQueries, openSaveNew, copilotOpen, copilotEligible, invokeCopilot, getDataBusy, openGetData]);

  const pgGate = inv?.postgres.error;
  const sqlGate = inv?.sql.error;
  const miGate = inv?.mi.error;

  return (
    <ItemEditorChrome
      item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2>Active connection</Subtitle2>
          <div className={s.formRow}>
            <Label>Family</Label>
            <select className={s.select} value={family} onChange={(e) => { const f = e.target.value as Family; setFamily(f); setServer(''); setDatabase(''); setDatabases([]); }}>
              <option value="azure-sql">Azure SQL Database</option>
              <option value="managed-instance">SQL Managed Instance</option>
              <option value="postgres">PostgreSQL Flexible Server</option>
            </select>
          </div>
          <div className={s.formRow}>
            <Label>Server / instance</Label>
            <select className={s.select} value={server} onChange={(e) => pickServer(family, e.target.value)} disabled={invLoading}>
              <option value="">{invLoading ? 'Loading…' : 'Select…'}</option>
              {family === 'azure-sql' && (inv?.sql.servers || []).map((x) => <option key={x.id} value={x.name}>{x.name} · {x.location}</option>)}
              {family === 'managed-instance' && (inv?.mi.instances || []).map((x) => <option key={x.id} value={x.name}>{x.name} · {x.location}</option>)}
              {family === 'postgres' && (inv?.postgres.servers || []).map((x) => <option key={x.id} value={x.name}>{x.name} · {x.location}</option>)}
            </select>
          </div>
          {family !== 'managed-instance' && (
            <div className={s.formRow}>
              <Label>Database</Label>
              <select className={s.select} value={database} onChange={(e) => setDatabase(e.target.value)} disabled={!server || dbLoading}>
                <option value="">{dbLoading ? 'Loading…' : (server ? 'Select…' : 'Pick a server first')}</option>
                {databases.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}
          {dbError && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Databases not reachable</MessageBarTitle>{dbError}</MessageBarBody></MessageBar>}
          {bindMsg && <Caption1>{bindMsg}</Caption1>}
          {serverFqdn && (
            <Caption1>
              FQDN: <code>{serverFqdn}</code>
              <Tooltip content="Copy FQDN" relationship="label">
                <Button size="small" appearance="subtle" icon={<Copy20Regular />} aria-label="Copy server FQDN"
                  onClick={() => navigator.clipboard?.writeText(serverFqdn)} style={{ marginLeft: tokens.spacingHorizontalXS }} />
              </Tooltip>
            </Caption1>
          )}
        </div>
      }
      main={
        <div className={s.pad}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
            <Tab value="connect" icon={<PlugConnected20Regular />}>Connect</Tab>
            <Tab value="provision" icon={<Add20Regular />}>Provision</Tab>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="queries" icon={<BookmarkMultiple20Regular />}>Saved queries</Tab>
            <Tab value="schema" icon={<Table20Regular />}>Schema</Tab>
            <Tab value="admin" icon={<ShieldKeyhole20Regular />}>Server admin</Tab>
            {family === 'azure-sql' && <Tab value="security" icon={<ShieldKeyhole20Regular />}>SQL security</Tab>}
            {family === 'azure-sql' && <Tab value="performance" icon={<ChartMultiple20Regular />}>Performance</Tab>}
            {family === 'azure-sql' && <Tab value="share" icon={<PeopleTeam20Regular />}>Share</Tab>}
            <Tab value="catalog" icon={<BookDatabase20Regular />}>Catalog</Tab>
            <Tab value="get-data" icon={<ArrowDownload20Regular />}>Get data</Tab>
            {family === 'azure-sql' && <Tab value="mirroring" icon={<ShieldKeyhole20Regular />}>Mirroring</Tab>}
            {family === 'azure-sql' && <Tab value="scale" icon={<TopSpeed20Regular />}>Compute &amp; Storage</Tab>}
            <Tab value="git" icon={<BranchFork20Regular />}>Source control</Tab>
          </TabList>

          {/* ---------------- Connect ---------------- */}
          {tab === 'connect' && (
            <>
              <div className={s.toolbar}>
                <Badge appearance="filled" color="brand" icon={<Database20Regular />}>Azure database services</Badge>
                <Button size="small" appearance="outline" onClick={loadInventory} disabled={invLoading}>Refresh inventory</Button>
                {invLoading && <Spinner size="tiny" label="Querying ARM…" labelPosition="after" />}
              </div>
              {invError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Inventory failed</MessageBarTitle>{invError}</MessageBarBody></MessageBar>}

              <Subtitle2>Azure SQL servers ({inv?.sql.servers.length ?? 0})</Subtitle2>
              {sqlGate
                ? <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Azure SQL not reachable</MessageBarTitle>{sqlGate} · Grant the console UAMI <code>Reader</code> on the subscription (LOOM_SUBSCRIPTION_ID).</MessageBarBody></MessageBar>
                : (
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Azure SQL servers">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Region</TableHeaderCell><TableHeaderCell>FQDN</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
                      <TableBody>
                        {(inv?.sql.servers || []).map((x) => (
                          <TableRow key={x.id}>
                            <TableCell><strong>{x.name}</strong></TableCell>
                            <TableCell>{x.location}</TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{x.fqdn}</code></TableCell>
                            <TableCell><Button size="small" appearance="subtle" onClick={() => { pickServer('azure-sql', x.name); setTab('query'); }}>Connect</Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

              <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>SQL Managed Instances ({inv?.mi.instances.length ?? 0})</Subtitle2>
              {miGate
                ? <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>SQL MI not reachable</MessageBarTitle>{miGate}</MessageBarBody></MessageBar>
                : (
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="SQL Managed Instances">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Region</TableHeaderCell><TableHeaderCell>FQDN</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
                      <TableBody>
                        {(inv?.mi.instances || []).map((x) => (
                          <TableRow key={x.id}>
                            <TableCell><strong>{x.name}</strong></TableCell>
                            <TableCell>{x.state}</TableCell>
                            <TableCell>{x.location}</TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{x.fqdn}</code></TableCell>
                            <TableCell><Button size="small" appearance="subtle" onClick={() => pickServer('managed-instance', x.name)}>Select</Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

              <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>PostgreSQL Flexible Servers ({inv?.postgres.servers.length ?? 0})</Subtitle2>
              {pgGate
                ? <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>PostgreSQL not reachable</MessageBarTitle>{pgGate} · Grant the console UAMI <code>Reader</code> on the subscription; the provider is <code>Microsoft.DBforPostgreSQL/flexibleServers</code>.</MessageBarBody></MessageBar>
                : (
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="PostgreSQL flexible servers">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Region</TableHeaderCell><TableHeaderCell>FQDN</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
                      <TableBody>
                        {(inv?.postgres.servers || []).map((x) => (
                          <TableRow key={x.id}>
                            <TableCell><strong>{x.name}</strong></TableCell>
                            <TableCell>PG {x.version}</TableCell>
                            <TableCell>{x.location}</TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{x.fqdn}</code></TableCell>
                            <TableCell><Button size="small" appearance="subtle" onClick={() => { pickServer('postgres', x.name); setTab('query'); }}>Connect</Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              <Caption1>Pick a server, then <strong>Bind connection</strong> (ribbon) to persist it to this item, or open the <strong>Query</strong> tab.</Caption1>

              {/* ---- Connection strings (ADO.NET / JDBC / ODBC / PHP / Go) ---- */}
              {family === 'azure-sql' && serverFqdn && (
                <div className={s.connCard}>
                  <Subtitle2><PlugConnected20Regular style={{ verticalAlign: 'middle' }} /> Connection strings</Subtitle2>
                  {!database ? (
                    <Caption1>Select a database (left pane or a <strong>Connect</strong> button above) to generate driver-ready strings.</Caption1>
                  ) : (
                    <>
                      <Caption1>
                        FQDN: <code>{serverFqdn}</code> · DB: <code>{database}</code> · Auth: Microsoft Entra Managed Identity (password-free)
                      </Caption1>
                      <TabList
                        size="small"
                        selectedValue={connDriver}
                        onTabSelect={(_, d) => setConnDriver(d.value as ConnDriverKey)}
                      >
                        <Tab value="adonet">ADO.NET</Tab>
                        <Tab value="jdbc">JDBC</Tab>
                        <Tab value="odbc">ODBC</Tab>
                        <Tab value="php">PHP</Tab>
                        <Tab value="go">Go</Tab>
                      </TabList>
                      {connStrings && (
                        <div className={s.connCodeWrap}>
                          <pre className={s.connCode}>{connStrings[connDriver]}</pre>
                          <Tooltip content={connCopied === connDriver ? 'Copied!' : 'Copy to clipboard'} relationship="label">
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<Copy20Regular />}
                              aria-label={`Copy ${connDriver} connection string`}
                              className={s.connCopyBtn}
                              onClick={() => copyConnStr(connDriver, connStrings[connDriver])}
                            />
                          </Tooltip>
                        </div>
                      )}
                      <Caption1>
                        All strings use password-free Microsoft Entra authentication (Managed Identity / Default).
                        Grant the connecting identity <code>db_datareader</code> / <code>db_datawriter</code> in the database via{' '}
                        <code>CREATE USER [&lt;entra-principal&gt;] FROM EXTERNAL PROVIDER;</code>.
                        {getSqlHostSuffix(serverFqdn).includes('usgovcloudapi') && (
                          <> Gov cloud detected — endpoint suffix is <code>{getSqlHostSuffix(serverFqdn)}</code> (GCC-High / IL5 / DoD).</>
                        )}
                      </Caption1>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {/* ---------------- Provision ---------------- */}
          {tab === 'provision' && (
            <>
              <div className={s.toolbar}>
                <Label>Resource type</Label>
                <select className={s.select} value={provFamily} onChange={(e) => setProvFamily(e.target.value as any)}>
                  <option value="azure-sql">Azure SQL database (on an existing server)</option>
                  <option value="postgres">PostgreSQL flexible server (new)</option>
                </select>
              </div>
              {provMsg && (
                <MessageBar intent={provMsg.ok ? 'success' : 'error'}>
                  <MessageBarBody><MessageBarTitle>{provMsg.ok ? 'Provisioning' : 'Create failed'}</MessageBarTitle>{provMsg.text}</MessageBarBody>
                </MessageBar>
              )}
              {provFamily === 'azure-sql' ? (
                <div className={s.card}>
                  <MessageBar intent="info"><MessageBarBody><MessageBarTitle>ARM PUT — Microsoft.Sql/servers/databases</MessageBarTitle>Creates a database on an existing logical server. Requires the console UAMI to hold <code>Contributor</code> (or SQL DB Contributor) on the server's resource group; otherwise ARM returns 403 and it surfaces here.</MessageBarBody></MessageBar>
                  <div className={s.formGrid}>
                    <Field label="Logical server" required>
                      <select className={s.select} value={newDbServer} onChange={(e) => setNewDbServer(e.target.value)}>
                        <option value="">Select a server…</option>
                        {(inv?.sql.servers || []).map((x) => <option key={x.id} value={x.name}>{x.name} · {x.location}</option>)}
                      </select>
                    </Field>
                    <Field label="Database name" required><Input value={newDbName} onChange={(_, d) => setNewDbName(d.value)} placeholder="loom_app_db" /></Field>
                    <Field label="SKU / service objective">
                      <Dropdown className={s.fullWidth} selectedOptions={[newDbSku]} value={newDbSku} onOptionSelect={(_, d) => setNewDbSku(d.optionValue || newDbSku)} aria-label="SKU / service objective">
                        {SQL_DB_SKUS.map((sku) => <Option key={sku} value={sku}>{sku}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Tier">
                      <Dropdown className={s.fullWidth} selectedOptions={[newDbTier]} value={newDbTier} onOptionSelect={(_, d) => setNewDbTier(d.optionValue || newDbTier)} aria-label="Service tier">
                        {SQL_DB_TIERS.map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Collation" hint="Set at create time only — immutable after the database exists.">
                      <Dropdown
                        className={s.fullWidth}
                        selectedOptions={[newDbCollation]}
                        value={newDbCollation}
                        onOptionSelect={(_, d) => setNewDbCollation((d.optionValue as SqlCollation) || newDbCollation)}
                        aria-label="Database collation"
                      >
                        {SQL_COLLATIONS.map((c) => <Option key={c} value={c}>{c}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Backup storage redundancy">
                      <Dropdown
                        className={s.fullWidth}
                        selectedOptions={newDbBackupRedundancy ? [newDbBackupRedundancy] : []}
                        value={newDbBackupRedundancy ? (BACKUP_REDUNDANCY_OPTIONS.find((o) => o.value === newDbBackupRedundancy)?.label || newDbBackupRedundancy) : ''}
                        placeholder="Geo-redundant (default)"
                        onOptionSelect={(_, d) => setNewDbBackupRedundancy(d.optionValue || '')}
                        aria-label="Backup storage redundancy"
                      >
                        {BACKUP_REDUNDANCY_OPTIONS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label={`Maintenance window${maintLoading ? ' (loading…)' : ''}`} hint="vCore tiers only. System default applies any time outside business hours.">
                      <Dropdown
                        className={s.fullWidth}
                        selectedOptions={[newDbMaintenanceWindow]}
                        value={newDbMaintenanceWindow ? (maintenanceConfigs.find((c) => c.id === newDbMaintenanceWindow)?.displayName || newDbMaintenanceWindow) : 'System default (any time)'}
                        disabled={maintLoading || !newDbServer}
                        onOptionSelect={(_, d) => setNewDbMaintenanceWindow(d.optionValue || '')}
                        aria-label="Maintenance window"
                      >
                        <Option value="">System default (any time)</Option>
                        {maintenanceConfigs.map((c) => <Option key={c.id} value={c.id}>{c.displayName}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                  <Checkbox checked={newDbSample} onChange={(_, d) => setNewDbSample(!!d.checked)} label="Seed AdventureWorksLT sample schema" />
                  <Checkbox checked={newDbZoneRedundant} onChange={(_, d) => setNewDbZoneRedundant(!!d.checked)}
                    label="Zone-redundant (vCore tiers only: GeneralPurpose / BusinessCritical / Hyperscale)" />
                  <Button appearance="primary" icon={<Add20Regular />} disabled={provBusy || !newDbServer || !newDbName} onClick={provisionSqlDb}>
                    {provBusy ? 'Creating…' : 'Create Azure SQL database'}
                  </Button>
                </div>
              ) : (
                <div className={s.card}>
                  <MessageBar intent="info"><MessageBarBody><MessageBarTitle>ARM PUT — Microsoft.DBforPostgreSQL/flexibleServers</MessageBarTitle>Provisions a new PostgreSQL flexible server (long-running). Requires <code>Contributor</code> on the target resource group.</MessageBarBody></MessageBar>
                  <div className={s.formGrid}>
                    <Field label="Server name" required><Input value={pgName} onChange={(_, d) => setPgName(d.value)} placeholder="loom-pg-01" /></Field>
                    <Field label="Resource group" required><Input value={pgRg} onChange={(_, d) => setPgRg(d.value)} placeholder="rg-loom-data" /></Field>
                    <Field label="Region" required>
                      <Dropdown className={s.fullWidth} selectedOptions={[pgLocation]} value={pgLocation} onOptionSelect={(_, d) => setPgLocation(d.optionValue || pgLocation)} aria-label="Region">
                        {AZURE_REGIONS.map((r) => <Option key={r} value={r}>{r}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="PG version">
                      <Dropdown className={s.fullWidth} selectedOptions={[pgVersion]} value={pgVersion} onOptionSelect={(_, d) => setPgVersion(d.optionValue || pgVersion)} aria-label="PostgreSQL version">
                        {PG_VERSIONS.map((v) => <Option key={v} value={v}>{v}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Admin login" required><Input value={pgAdmin} onChange={(_, d) => setPgAdmin(d.value)} placeholder="pgadmin" /></Field>
                    <Field label="Admin password" required><Input type="password" value={pgPassword} onChange={(_, d) => setPgPassword(d.value)} /></Field>
                    <Field label="Tier">
                      <Dropdown className={s.fullWidth} selectedOptions={[pgTier]} value={pgTier} onOptionSelect={(_, d) => setPgTier(d.optionValue || pgTier)} aria-label="Compute tier">
                        {PG_TIERS.map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="SKU">
                      <Dropdown className={s.fullWidth} selectedOptions={[pgSku]} value={pgSku} onOptionSelect={(_, d) => setPgSku(d.optionValue || pgSku)} aria-label="Compute SKU">
                        {PG_SKUS.map((sku) => <Option key={sku} value={sku}>{sku}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                  <Button appearance="primary" icon={<Add20Regular />} disabled={provBusy || !pgName || !pgRg || !pgAdmin || !pgPassword} onClick={provisionPg}>
                    {provBusy ? 'Creating…' : 'Create PostgreSQL flexible server'}
                  </Button>
                </div>
              )}
            </>
          )}

          {/* ---------------- Query ---------------- */}
          {tab === 'query' && (
            <>
              <div className={s.toolbar}>
                <Badge appearance="filled" color="brand">{family === 'postgres' ? 'PostgreSQL' : family === 'managed-instance' ? 'SQL MI' : 'Azure SQL'}</Badge>
                <Caption1>server: <strong>{server || 'not set'}</strong>{family !== 'managed-instance' && <>, db: <strong>{database || 'not set'}</strong></>}</Caption1>
                <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS }}>
                  <Tooltip content={family !== 'azure-sql' ? 'SQL Copilot is Azure SQL (T-SQL) only' : !(server && database) ? 'Connect a server + database first' : 'Fix / Explain / NL→T-SQL + inline ghost text'} relationship="label">
                    <Button appearance={copilotOpen ? 'primary' : 'outline'} icon={copilotOpen ? <Sparkle20Filled /> : <Sparkle20Regular />}
                      onClick={() => setCopilotOpen((v) => !v)} disabled={family !== 'azure-sql'}>
                      Copilot
                    </Button>
                  </Tooltip>
                  <Button appearance="primary" icon={<Play20Regular />} disabled={qLoading || !server} onClick={() => run()}>Run</Button>
                  {qLoading && (
                    <Button appearance="secondary" icon={<Stop20Regular />} onClick={cancelQuery} disabled={family === 'postgres' || !activeRequestId} title={family === 'postgres' ? 'Cancel is available on the Azure SQL TDS path' : 'Send a TDS ATTENTION packet — cancels the running query on the server'}>Cancel</Button>
                  )}
                </div>
              </div>
              {qLoading && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Running in background — switch tabs or close this editor freely; a toast fires when the query completes.
                </Caption1>
              )}
              {family === 'managed-instance' && (
                <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>MI query requires a private endpoint in the MI subnet</MessageBarTitle>SQL MI has no public TDS gateway. Provision <code>Microsoft.Network/privateEndpoints</code> to the instance and grant the console UAMI <code>db_datareader</code>, then the same TDS path the Azure SQL editor uses applies. The route returns an honest 501 until then.</MessageBarBody></MessageBar>
              )}
              {family === 'postgres' && (
                <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>PostgreSQL query path is gated</MessageBarTitle>Add the <code>pg</code> driver to apps/fiab-console and set <code>LOOM_POSTGRES_QUERY_LIVE=true</code> (with the console UAMI created as a PG AAD principal via <code>pgaadauth_create_principal</code>). ARM inventory, provisioning, databases, and firewall are fully live now.</MessageBarBody></MessageBar>
              )}
              <div className={s.queryRow}>
                <div className={s.queryMain}>
                  {family === 'postgres' ? (
                    // PostgreSQL: the sys.*-fed IntelliSense + T-SQL templates are
                    // T-SQL-specific, so the PG path keeps the plain Monaco surface
                    // until a pg-catalog provider lands. Run still posts the script.
                    <MonacoTextarea value={sqlText} onChange={setSqlText} language={dialect} height={240} minHeight={200} ariaLabel="SQL editor" />
                  ) : (
                    <TsqlMonaco
                      value={sqlText}
                      onChange={setSqlText}
                      onRun={(sql) => run(sql)}
                      server={server}
                      database={database}
                      itemId={id}
                      height={240}
                      readOnly={family === 'managed-instance'}
                      busy={qLoading}
                      onReady={family === 'azure-sql' ? handleEditorReady : undefined}
                    />
                  )}
                  {copilotEligible && (
                    <Caption1>
                      <Sparkle20Regular style={{ verticalAlign: 'middle', fontSize: tokens.fontSizeBase200 }} /> Copilot inline completion is on while the pane is open —
                      write <code>-- describe what you want</code> on a new line and press <strong>Tab</strong> to accept the ghost-text T-SQL.
                    </Caption1>
                  )}
                  <ResultsPanel result={qResult} loading={qLoading} />
                </div>
                {copilotOpen && family === 'azure-sql' && (
                  <div className={s.copilotPane} aria-label="SQL Copilot">
                    <div className={s.copilotHead}>
                      <Sparkle20Filled />
                      <Subtitle2>SQL Copilot</Subtitle2>
                      <div className={s.copilotHeadActions}>
                        <Tooltip content="Annotate the selected (or full) SQL with inline comments" relationship="label">
                          <Button size="small" appearance="subtle" icon={<TextBulletListSquare20Regular />} disabled={!copilotEligible || copilotLoading} onClick={() => invokeCopilot('explain')}>Explain</Button>
                        </Tooltip>
                        <Tooltip content="Repair the selected (or full) SQL so it runs" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Bug20Regular />} disabled={!copilotEligible || copilotLoading} onClick={() => invokeCopilot('fix')}>Fix</Button>
                        </Tooltip>
                        <Tooltip content="Close Copilot" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close Copilot" onClick={() => setCopilotOpen(false)} />
                        </Tooltip>
                      </div>
                    </div>
                    {!copilotEligible && (
                      <MessageBar intent="info"><MessageBarBody><MessageBarTitle>Connect a database</MessageBarTitle>Pick an Azure SQL server + database on the <strong>Connect</strong> tab to use the Copilot.</MessageBarBody></MessageBar>
                    )}
                    {copilotGate && (
                      <MessageBar intent="warning"><MessageBarBody>
                        <MessageBarTitle>SQL Copilot not configured</MessageBarTitle>
                        {copilotGate}
                      </MessageBarBody></MessageBar>
                    )}
                    <div className={s.copilotLog}>
                      {copilotMessages.length === 0 && !copilotGate && (
                        <Caption1>
                          Select a statement and click <strong>Explain</strong> or <strong>Fix</strong>, or describe what you want below and
                          generate T-SQL. Every answer is grounded in this database's real schema.
                        </Caption1>
                      )}
                      {copilotMessages.map((m, i) => {
                        if (m.role === 'user') return <div key={i} className={s.msgUser}>{m.text}</div>;
                        const code = extractSql(m.text);
                        const hasCode = /```/.test(m.text) || /\bselect\b|\bupdate\b|\binsert\b|\bdelete\b|\bcreate\b/i.test(m.text);
                        return (
                          <div key={i} className={s.msgAssistant}>
                            {m.text || (copilotLoading ? <Spinner size="tiny" label="Thinking…" labelPosition="after" /> : '')}
                            {m.text && hasCode && code && (
                              <div className={s.msgFoot}>
                                <Tooltip content="Replace the editor with this SQL" relationship="label">
                                  <Button size="small" appearance="primary" icon={<ArrowEnter20Regular />} onClick={() => insertSql(code)}>Insert into editor</Button>
                                </Tooltip>
                                <Tooltip content="Copy SQL to clipboard" relationship="label">
                                  <Button size="small" appearance="subtle" icon={<Copy20Regular />} onClick={() => navigator.clipboard?.writeText(code)}>Copy</Button>
                                </Tooltip>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className={s.copilotInputRow}>
                      <Field label="Natural language → T-SQL">
                        <Textarea
                          value={nlInput}
                          onChange={(_, d) => setNlInput(d.value)}
                          placeholder="e.g. top 10 customers by total order amount in 2024"
                          resize="vertical"
                          disabled={!copilotEligible || copilotLoading}
                        />
                      </Field>
                      <Button appearance="primary" icon={<Sparkle20Regular />} disabled={!copilotEligible || copilotLoading || !nlInput.trim()} onClick={() => invokeCopilot('nl2sql')}>
                        {copilotLoading ? 'Generating…' : 'Generate T-SQL'}
                      </Button>
                    </div>
                  </div>
                )}
                {!copilotOpen && family === 'azure-sql' && (
                  <CollapsedRail side="right" label="SQL Copilot" onExpand={() => setCopilotOpen(true)} />
                )}
              </div>
            </>
          )}

          {/* ---------------- Saved queries (My Queries / Shared Queries) ---------------- */}
          {tab === 'queries' && (
            <QueriesPanel
              queries={savedQueries}
              loading={sqLoading}
              error={sqError}
              disabled={id === 'new'}
              callerRole={callerRole}
              selectedIds={selectedQueryIds}
              onSelectionChange={setSelectedQueryIds}
              onRefresh={loadSavedQueries}
              onSaveNew={openSaveNew}
              onOpen={openSavedQuery}
              onRename={openRename}
              onDuplicate={duplicateQuery}
              onBulkDelete={bulkDeleteQueries}
            />
          )}

          {/* ---------------- Schema (rich sys.* object navigator) ---------------- */}
          {tab === 'schema' && (
            <>
              {!server ? (
                <EmptyState
                  icon={<Table20Regular />}
                  title="No database selected"
                  body="Pick a server on the Connect tab (or the left pane) to browse tables, views, procedures, functions, and schemas over live TDS."
                />
              ) : family === 'azure-sql' ? (
                <>
                  <div className={s.toolbar}>
                    <Badge appearance="filled" color="brand" icon={<Database20Regular />}>sys.* object navigator</Badge>
                    <Caption1>Tables, views, procedures, functions, table types, schemas over live TDS · double-click an action to load it into the Query tab.</Caption1>
                  </div>
                  {/* Real SqlDbTree wired to the SAME sys.*-over-TDS backend the
                      Fabric SQL editor uses, targeting the user-selected Azure
                      SQL server/database via the new server/database override. */}
                  <div className={s.treeWrap}>
                    <SqlDbTree
                      // No Fabric workspace here — the explicit server/database
                      // override drives resolution, so workspaceId is unused.
                      workspaceId=""
                      itemId={id}
                      server={server}
                      database={database}
                      onOpenQuery={openInQuery}
                    />
                  </div>
                </>
              ) : family === 'postgres' ? (
                <MessageBar intent="warning"><MessageBarBody>
                  <MessageBarTitle>PostgreSQL object navigator is gated</MessageBarTitle>
                  The sys.* navigator is T-SQL-specific. The PostgreSQL catalog browser (information_schema / pg_catalog over the <code>pg</code> wire protocol) lights up once the <code>pg</code> driver is added and <code>LOOM_POSTGRES_QUERY_LIVE=true</code>. Use the INFORMATION_SCHEMA query below in the meantime.
                </MessageBarBody></MessageBar>
              ) : (
                <MessageBar intent="warning"><MessageBarBody>
                  <MessageBarTitle>SQL MI object navigator requires a private endpoint</MessageBarTitle>
                  SQL Managed Instance has no public TDS gateway; provision <code>Microsoft.Network/privateEndpoints</code> into the MI subnet and grant the console UAMI <code>db_datareader</code>, then the same sys.* navigator the Azure SQL surface uses applies.
                </MessageBarBody></MessageBar>
              )}
              {/* INFORMATION_SCHEMA fallback grid (works for any reachable engine via the query path). */}
              {server && (
                <>
                  <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
                    <Caption1>INFORMATION_SCHEMA.TABLES on <strong>{database || server || 'not set'}</strong></Caption1>
                    <Button size="small" appearance="outline" onClick={loadSchema} disabled={schemaLoading || !server}>Refresh</Button>
                  </div>
                  <ResultsPanel result={schema} loading={schemaLoading} />
                </>
              )}
            </>
          )}

          {/* ---------------- Server admin (firewall / Entra / geo-replication) ---------------- */}
          {tab === 'admin' && (
            <SqlServerAdminPanel
              id={id}
              family={family}
              server={server}
              database={database}
              servers={(inv?.sql.servers || []).map((x) => ({ name: x.name, location: x.location }))}
            />
          )}

          {/* ---------------- SQL granular security (F11) ---------------- */}
          {tab === 'security' && (
            family === 'azure-sql'
              ? (server && database
                  ? <SqlSecurityPanel itemType="azure-sql-database" itemId={id} server={server} database={database} />
                  : <EmptyState
                      icon={<ShieldKeyhole20Regular />}
                      title="No database selected"
                      body="Pick a server and database on the Connect tab to manage object/column GRANT, Row-Level Security, and Dynamic Data Masking."
                    />)
              : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>T-SQL security wizards apply to Azure SQL</MessageBarTitle>
                    Object/column GRANT, Row-Level Security and Dynamic Data Masking are T-SQL features. Select an Azure SQL database to use them; PostgreSQL uses its own role/RLS model.
                  </MessageBarBody>
                </MessageBar>
              )
          )}

          {/* ---------------- Share (per-database Access control / IAM) ---------------- */}
          {tab === 'share' && (
            family === 'azure-sql'
              ? (server && database
                  ? <ShareDialog itemId={id} server={server} database={database} open={true} />
                  : <EmptyState
                      icon={<PeopleTeam20Regular />}
                      title="No database selected"
                      body="Pick an Azure SQL server and database on the Connect tab to assign Azure RBAC roles at the database scope."
                    />)
              : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Database Share applies to Azure SQL</MessageBarTitle>
                    Per-database Azure RBAC role assignment targets the <code>Microsoft.Sql/servers/databases</code> scope. Select an Azure SQL database; SQL MI and PostgreSQL manage access at the instance/server resource scope.
                  </MessageBarBody>
                </MessageBar>
              )
          )}

          {/* ---------------- Performance (Query Store / QPI) ---------------- */}
          {tab === 'performance' && (
            family === 'azure-sql'
              ? <SqlPerformanceDashboard id={id} server={server} database={database} />
              : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Query Store performance applies to Azure SQL</MessageBarTitle>
                    The Query Store dashboard reads the T-SQL <code>sys.query_store_*</code> catalog views. Select an Azure SQL database to use it; PostgreSQL exposes performance via <code>pg_stat_statements</code> instead.
                  </MessageBarBody>
                </MessageBar>
              )
          )}


          {/* ---------------- Source control (Git) — honest connection gate ---------------- */}
          {tab === 'git' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Source control for this database schema</MessageBarTitle>
                  Mirrors the Azure SQL Database / SSDT "Schema compare + Git" workflow. Schema version
                  control (DACPAC diff, migration history) runs through an Azure DevOps service connection or
                  a GitHub Actions workflow — not a live ARM data-plane API — so it is gated on a one-time
                  connection setting rather than a fake in-app commit form.
                </MessageBarBody>
              </MessageBar>
              <div className={s.card}>
                <Subtitle2><BranchFork20Regular style={{ verticalAlign: 'middle' }} /> Connect a Git provider</Subtitle2>
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>No ADO / GitHub connection configured</MessageBarTitle>
                    Set the following environment variables on the Console container app and redeploy, then
                    schema source control activates for this database:
                    <br /><br />
                    <code>LOOM_SQL_GIT_PROVIDER</code> — <code>azdo</code> or <code>github</code>
                    <br />
                    <strong>Azure DevOps</strong> (when <code>LOOM_SQL_GIT_PROVIDER=azdo</code>):
                    <br />
                    <code>LOOM_SQL_GIT_ADO_ORG</code> — your Azure DevOps organization name
                    <br />
                    <code>LOOM_SQL_GIT_ADO_PROJECT</code> — the Azure DevOps project that holds the repo
                    <br />
                    <code>LOOM_SQL_GIT_ADO_REPO</code> — the Git repository name for the DACPAC project
                    <br />
                    <code>LOOM_SQL_GIT_ADO_PAT_SECRET</code> — Key Vault secret name holding the ADO PAT
                    <br /><br />
                    <strong>GitHub</strong> (when <code>LOOM_SQL_GIT_PROVIDER=github</code>):
                    <br />
                    <code>LOOM_SQL_GIT_GITHUB_REPO</code> — <code>org/repo</code> for the schema project
                    <br />
                    <code>LOOM_SQL_GIT_GITHUB_BRANCH</code> — default branch (e.g. <code>main</code>)
                    <br />
                    <code>LOOM_SQL_GIT_GITHUB_PAT_SECRET</code> — Key Vault secret name holding the GitHub PAT
                    <br /><br />
                    Wire these in <code>platform/fiab/bicep/modules/admin-plane/main.bicep</code> (env block) and
                    add a pipeline step that runs <code>SqlPackage /Action:Extract</code> (DACPAC) +
                    <code> /Action:Script</code> to diff against the checked-in schema. See
                    <code> docs/fiab/v3-tenant-bootstrap.md</code>. Honest gate — no fake commit form.
                  </MessageBarBody>
                </MessageBar>
              </div>
            </>
          )}

          {/* ---------------- Catalog ---------------- */}
          {tab === 'catalog' && (            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>OneLake / Purview catalog</MessageBarTitle>
                  Register this Azure database as a governed catalog asset (Atlas entity) in Microsoft Purview, consistent with the Loom OneLake catalog. Requires <code>LOOM_PURVIEW_ACCOUNT</code> + the console UAMI as a Purview data-curator; otherwise the call returns a 501 with the exact hint.
                </MessageBarBody>
              </MessageBar>
              <div className={s.card}>
                <Caption1>Selected: <strong>{family}</strong> · <code>{serverFqdn || 'no server'}</code>{database && <> / <code>{database}</code></>}</Caption1>
                <Button appearance="primary" icon={<BookDatabase20Regular />} disabled={catBusy || !serverFqdn} onClick={registerCatalog}>
                  {catBusy ? 'Registering…' : 'Register in catalog'}
                </Button>
                {catMsg && (
                  <MessageBar intent={catMsg.ok ? 'success' : 'warning'}>
                    <MessageBarBody>
                      <MessageBarTitle>{catMsg.ok ? 'Registered' : 'Catalog gate'}</MessageBarTitle>
                      {catMsg.text}{catMsg.link && <> · <a href={catMsg.link} target="_blank" rel="noreferrer">Open in Purview</a></>}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </>
          )}

          {/* ---------------- Get data → ADF ingestion deep-links ---------------- */}
          {tab === 'get-data' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Get data — Azure Data Factory ingestion surfaces</MessageBarTitle>
                  Opens Azure Data Factory Studio with this database (<code>{database || 'select one'}</code>) pre-wired
                  as the copy <strong>sink</strong> — Azure-native, no Microsoft Fabric. <strong>Copy data</strong> opens
                  the stepped Copy Data Tool; <strong>New pipeline</strong> / <strong>New dataflow</strong> create the
                  AzureSqlDatabase linked service + AzureSqlTable dataset + artifact via ARM, then open the authoring
                  canvas. The factory uses its system-assigned managed identity — grant it <code>db_datareader</code> +{' '}
                  <code>db_datawriter</code> on <code>{database || 'the target database'}</code> via Microsoft Entra so the
                  Copy activity can write rows.
                </MessageBarBody>
              </MessageBar>

              <div className={s.toolbar}>
                <Button appearance="primary" icon={<ArrowDownload20Regular />} disabled={getDataBusy || !server || !database}
                  onClick={() => openGetData('copy-data')}>{getDataBusy ? 'Opening…' : 'Copy data'}</Button>
                <Button appearance="outline" icon={<Play20Regular />} disabled={getDataBusy || !(server && database && family === 'azure-sql')}
                  onClick={() => openGetData('new-pipeline')} title={family !== 'azure-sql' ? 'Azure SQL sink only' : undefined}>New pipeline</Button>
                <Button appearance="outline" icon={<Database20Regular />} disabled={getDataBusy || !(server && database && family === 'azure-sql')}
                  onClick={() => openGetData('new-dataflow')} title={family !== 'azure-sql' ? 'Azure SQL sink only' : undefined}>New dataflow</Button>
              </div>

              {getDataMsg && (
                <MessageBar intent={getDataMsg.ok ? 'success' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>{getDataMsg.ok ? 'ADF Studio opened' : 'Get data failed'}</MessageBarTitle>
                    {getDataMsg.text}
                    {getDataMsg.factoryName && <> · factory <code>{getDataMsg.factoryName}</code></>}
                    {getDataMsg.url && <> · <a href={getDataMsg.url} target="_blank" rel="noreferrer">Re-open in ADF Studio</a></>}
                  </MessageBarBody>
                </MessageBar>
              )}

              {getDataMsg?.ok && getDataMsg.privateNetworkGate && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>ADF Studio requires private-network access</MessageBarTitle>
                    The factory has <code>publicNetworkAccess: Disabled</code> (private link only). Reach ADF Studio's
                    management plane from the corporate VPN or an Azure Bastion session on the hub VNet.
                  </MessageBarBody>
                </MessageBar>
              )}

              {getDataMsg?.ok && getDataMsg.factoryMiPrincipalHint && (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>One-time: grant the factory managed identity write access</MessageBarTitle>
                    <code style={{ display: 'block', maxWidth: '100%', fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{getDataMsg.factoryMiPrincipalHint}</code>
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* Run receipt — verify rows landed via a COUNT(*) in the Query tab. */}
              <div className={s.card}>
                <Subtitle2><Play20Regular style={{ verticalAlign: 'middle' }} /> Pipeline run receipt</Subtitle2>
                <Caption1>
                  After running the pipeline / dataflow in ADF Studio, paste its <strong>Run ID</strong> and click{' '}
                  <strong>Check count delta</strong> — it switches to the Query tab with a <code>SELECT COUNT(*)</code>{' '}
                  template so you can confirm new rows landed in <code>{database || 'the target database'}</code>.
                </Caption1>
                <Field label="ADF pipeline run ID">
                  <Input value={receiptRunId} onChange={(_, d) => setReceiptRunId(d.value)}
                    placeholder="00000000-0000-0000-0000-000000000000" />
                </Field>
                <Button appearance="primary" icon={<Play20Regular />}
                  disabled={!receiptRunId.trim() || !server || !database}
                  onClick={() => {
                    const countSql =
                      `-- Verify rows landed from ADF pipeline run ${receiptRunId.trim()}\n` +
                      `-- Replace <your_target_table> with the table the Copy/dataflow sink wrote to.\n` +
                      `SELECT COUNT(*) AS row_count FROM dbo.[<your_target_table>];`;
                    setSqlText(countSql);
                    setTab('query');
                  }}>
                  Check count delta (open in Query)
                </Button>
              </div>
            </>
          )}

          {tab === 'mirroring' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Mirroring — Azure-native CDC (no Microsoft Fabric)</MessageBarTitle>
                  Enables the database <strong>change feed</strong> via the real{' '}
                  <code>sys.sp_change_feed_enable_db</code>, then — when the ADLS{' '}
                  <strong>Bronze</strong> landing zone is configured (<code>LOOM_BRONZE_URL</code>) — snapshots
                  each table to <strong>Bronze Delta</strong> via the Loom mirroring engine and returns a
                  ready-to-run Synapse Serverless query per table. The next run syncs only Change-Tracking
                  deltas. The console identity must be <code>db_owner</code> on this database; a permission /
                  tier error is shown verbatim (no Fabric workspace required).
                </MessageBarBody>
              </MessageBar>
              <div className={s.card}>
                <Caption1>Selected: <code>{serverFqdn || 'no server'}</code>{database && <> / <code>{database}</code></>}</Caption1>
                <Button appearance="primary" icon={<ShieldKeyhole20Regular />} disabled={mirrorBusy || !server || !database} onClick={toggleMirror}>
                  {mirrorBusy ? 'Enabling…' : 'Enable / refresh mirroring'}
                </Button>
                {mirror && (
                  <MessageBar intent={mirror.ok && mirror.config?.state !== 'Error' ? 'success' : 'warning'}>
                    <MessageBarBody>
                      <MessageBarTitle>
                        {mirror.ok ? `Change feed: ${mirror.config?.state || 'updated'}` : 'Could not enable'}
                      </MessageBarTitle>
                      {mirror.ok
                        ? (mirror.config?.lastError || mirror.config?.note || 'Change feed enabled.')
                        : (mirror.error || 'request failed')}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {/* Honest gate: change feed on, but Bronze landing not configured / item not saved. */}
                {mirror?.ok && mirror.bronzeNote && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Bronze landing not run</MessageBarTitle>
                      {mirror.bronzeNote}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {/* Real Bronze gate from the mirror engine (e.g. source unreachable). */}
                {mirror?.bronze?.gate && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Bronze landing gated — {mirror.bronze.gate.missing}</MessageBarTitle>
                      {mirror.bronze.gate.message}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {/* Bronze receipt: real per-table snapshot landed to ADLS + a ready-to-run Serverless query. */}
                {Array.isArray(mirror?.bronze?.tables) && mirror.bronze.tables.length > 0 && (
                  <div className={s.card}>
                    <Caption1>
                      Landed to ADLS Bronze: <code>{mirror.bronze.basePath}</code>
                      {mirror.bronze.basePath && (
                        <Tooltip content="Copy Bronze base path" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Copy20Regular />}
                            onClick={() => navigator.clipboard?.writeText(String(mirror.bronze.basePath))} style={{ marginLeft: tokens.spacingHorizontalXS }} />
                        </Tooltip>
                      )}
                    </Caption1>
                    {mirror.bronze.tables.map((t: any, i: number) => (
                      <div key={`${t.schema}.${t.table}.${i}`} className={s.formRow}>
                        <Caption1>
                          <strong>{t.schema}.{t.table}</strong>{' '}
                          {t.status === 'replicated'
                            ? <Badge appearance="tint" color="success">{t.mode || 'snapshot'} · {t.rows} rows</Badge>
                            : <Badge appearance="tint" color="danger">error</Badge>}
                          {t.note ? <> — {t.note}</> : null}
                          {t.error ? <> — {t.error}</> : null}
                        </Caption1>
                        {t.openrowset && (
                          <div className={s.cell} style={{ whiteSpace: 'pre-wrap', display: 'flex', gap: tokens.spacingVerticalXS, alignItems: 'flex-start' }}>
                            <code style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{t.openrowset}</code>
                            <Tooltip content="Copy Synapse Serverless query" relationship="label">
                              <Button size="small" appearance="subtle" icon={<Copy20Regular />}
                                onClick={() => navigator.clipboard?.writeText(String(t.openrowset))} />
                            </Tooltip>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ---------------- Save / rename query dialog (shared by Save + Rename) ---------------- */}
          <Dialog open={saveDialogOpen} onOpenChange={(_, d) => setSaveDialogOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>{editingQueryId ? 'Rename / edit saved query' : 'Save query'}</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <Field label="Name" required>
                      <Input value={saveName} onChange={(_, d) => setSaveName(d.value)} placeholder="Top customers by revenue" maxLength={120} />
                    </Field>
                    <Field label="Description (optional)">
                      <Input value={saveDesc} onChange={(_, d) => setSaveDesc(d.value)} placeholder="What this query answers" maxLength={500} />
                    </Field>
                    <Field label="Folder">
                      <Dropdown
                        aria-label="Folder / scope"
                        selectedOptions={[saveScope]}
                        value={saveScope === 'shared' ? 'Shared Queries (workspace)' : 'My Queries (private)'}
                        onOptionSelect={(_, d) => setSaveScope((d.optionValue as 'private' | 'shared') || 'private')}
                      >
                        <Option value="private">My Queries (private)</Option>
                        <Option value="shared" disabled={callerRole === 'Viewer' || callerRole === null}>
                          Shared Queries (workspace)
                        </Option>
                      </Dropdown>
                    </Field>
                    {(callerRole === 'Viewer' || callerRole === null) && (
                      <Caption1>Shared queries need workspace Admin / Member / Contributor. Your queries save privately.</Caption1>
                    )}
                    <Field label="Query text">
                      <Textarea
                        value={saveSql}
                        onChange={(_, d) => setSaveSql(d.value)}
                        rows={8}
                        textarea={{ style: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 } }}
                        aria-label="SQL text to save"
                      />
                    </Field>
                    {saveErr && (
                      <MessageBar intent="error"><MessageBarBody>{saveErr}</MessageBarBody></MessageBar>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
                  <Button appearance="primary" icon={<Save20Regular />} disabled={saveBusy || !saveName.trim() || !saveSql.trim()} onClick={submitSaveQuery}>
                    {saveBusy ? 'Saving…' : editingQueryId ? 'Save changes' : 'Save query'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
          {/* ---------------- Compute & Storage (scale) ---------------- */}
          {tab === 'scale' && (
            family === 'azure-sql'
              ? (server && database
                  ? <SqlScalePanel
                      id={id} server={server} database={database}
                      currentSku={databasesFull.find((d) => d.name === database)?.sku}
                    />
                  : <EmptyState
                      icon={<TopSpeed20Regular />}
                      title="No database selected"
                      body="Pick a server and database on the Connect tab to change its compute & storage (DTU / vCore / serverless auto-pause and max storage)."
                    />)
              : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Compute &amp; Storage scaling applies to Azure SQL Database</MessageBarTitle>
                    SQL Managed Instance scaling uses the instance SKU (<code>Microsoft.Sql/managedInstances</code> PATCH) and PostgreSQL flexible server uses a distinct compute ARM surface — wire those separately. Select an Azure SQL database to scale its compute and storage here.
                  </MessageBarBody>
                </MessageBar>
              )
          )}
        </div>
      }
    />
  );
}
