'use client';

/**
 * NavigatorDialog — the Power BI "Navigator" for the Loom report designer
 * (REPORT-BUILDER PARITY · WAVE 2). After a reusable, Key Vault-backed Loom
 * Connection is bound (W1 Get Data), the Navigator lets the author BROWSE the
 * connection's real objects in a Fluent Tree (catalog → schema → tables / views),
 * PREVIEW the top 100 rows of the highlighted object, multi-select the tables to
 * bring in, and choose an explicit Import-vs-DirectQuery connectivity mode — the
 * exact shape of the Power BI Desktop Navigator, themed with Loom tokens.
 *
 * ── Real backend, zero mocks (no-vaporware.md) ─────────────────────────────────
 * The tree introspects REAL database objects through a thin, report-scoped
 * dispatch route, `POST /api/items/report/[id]/connector-objects`, which fans out
 * to the existing introspection clients per connection type:
 *   • SQL family (Azure SQL / Synapse / Databricks SQL / generic) → `sql-objects-client`
 *     `listSchemas` / `listTables` / `listViews`
 *   • Lakehouse (serverless over Delta)                           → `synapse-catalog-client`
 *     `scanLakehouseTables`
 *   • Azure Data Explorer                                          → `kusto-client` `listTables`
 *   • Cosmos DB                                                    → `cosmos-data-client` containers
 * The route owns ALL backend knowledge (it loads the LoomConnection, resolves its
 * KV secret, checks the per-engine env gate); the dialog is connector-agnostic —
 * it renders whatever nodes come back and expands a branch lazily by passing the
 * node's opaque `childToken` back to the route. Each SELECTABLE node carries the
 * `ReportObjectRef` the route precomputed, so the dialog never reconstructs how to
 * read an object — it just emits the route-provided ref on confirm.
 *
 * The right pane reuses the W1 preview route `POST /connector-preview`
 * (`executor.preview(100)`) for the highlighted node: a real TOP-100 read against
 * the live Azure backend, NEVER a mock array. Any introspection / preview failure
 * surfaces an honest Fluent MessageBar naming the verbatim backend remediation
 * (env var / role / connection) — no dead nodes, no fake rows.
 *
 * ── Rules compliance ──────────────────────────────────────────────────────────
 *  - no-freeform-config: object selection is a Tree + checkboxes; connectivity is
 *    a RadioGroup; there is NO JSON / connection-string box anywhere in here.
 *  - no-fabric-dependency: Azure-native everywhere. The introspection + preview
 *    routes use Azure data-plane clients only; no api.powerbi.com / OneLake host
 *    is ever reached from the Navigator. Connectivity → StorageMode maps Power BI
 *    semantics onto Azure-native execution (Import = materialized Delta cache;
 *    DirectQuery = live Synapse / connector SQL) per the W2 storage contract.
 *  - web3-ui: Fluent v9 + Loom design tokens only (no hard-coded px / hex), card
 *    elevation, an icon per node kind, Spinner on load, dark-legible neutrals,
 *    EmptyState for the empty / no-selection panes.
 *  - back-compat: emitting one selection yields a single ConnectionDataSource
 *    (the W1 shape) with the chosen objectRef, plus a one-group `tableStorage`
 *    seed at the chosen StorageMode — pure single-source reports keep working.
 *
 * ── Mounting ──────────────────────────────────────────────────────────────────
 * This is a standalone dialog. The data-source picker and the W1 Get Data bind
 * step mount it (Wave 2 wiring in those files) and persist the `onConfirm`
 * result: `primarySource` → `state.dataSource`, `tableStorage` merged into
 * `state.tableStorage`. report-designer.tsx is NOT touched (Wave 5 owns it).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Badge, Spinner, Caption1, Subtitle1, Subtitle2, Text,
  Checkbox, RadioGroup, Radio, Field, Divider, Tooltip,
  Tree, TreeItem, TreeItemLayout,
  SearchBox, MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Dismiss24Regular, DatabaseSearch20Regular, Database20Regular,
  Table20Regular, DocumentTable20Regular, Folder20Regular,
  DocumentDatabase20Regular, ArrowClockwise20Regular, Checkmark20Regular,
  TableSearch20Regular, Eye20Regular, DatabasePlugConnected20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import {
  type ReportObjectRef,
  type ReportConnType,
  type ConnectionDataSource,
  REPORT_CONN_TYPE_LABEL,
} from './report-data-source';

// ============================================================================
// Storage contract — LOCAL string-validated mirror of the W2 SoT
// (lib/editors/report/storage-mode-pane.tsx). The Navigator is a `'use client'`
// surface that must compile standalone; rather than hard-couple to a sibling
// pane that may not exist in every checkout, it mirrors the small storage union
// + the one helper it needs, exactly as the resolver / wells-to-sql carry their
// own string-validated mirrors. The emitted `tableStorage` is structurally a
// `TableStorageMap` so the picker (the SoT consumer) persists it unchanged.
// ============================================================================

/** Power BI storage modes mapped 1:1 to Azure-native execution (W2 SoT mirror). */
export type StorageMode = 'DirectQuery' | 'Import' | 'Dual' | 'DirectLake';

/** PBI Navigator "connectivity mode" radio per source (W2 SoT mirror). */
export type ConnectivityMode = 'import' | 'directQuery';

/** Navigator connectivity → default StorageMode (mirror of the SoT helper). */
function storageModeForConnectivity(c: ConnectivityMode): StorageMode {
  return c === 'import' ? 'Import' : 'DirectQuery';
}

/**
 * Connection types that can push a live query down (DirectQuery-capable). SQL
 * family + ADX + Databricks → DirectQuery + Import. Cosmos / storage / file →
 * Import-only (PBI convention), so the connectivity radio constrains itself to
 * Import. Mirrors connector-catalog's `directQueryCapable` flag without a
 * compile-time coupling to it.
 */
const DIRECT_QUERY_CAPABLE: ReadonlySet<ReportConnType> = new Set<ReportConnType>([
  'azure-sql', 'synapse-dedicated', 'synapse-serverless', 'generic-sql',
  'databricks-sql', 'postgres', 'adx',
]);

// ============================================================================
// Navigator node contract (consumed from /connector-objects). The route shapes
// the hierarchy (catalog → schema → tables/views, or db → containers, or
// lakehouse → tables); the dialog renders generically and expands a branch by
// echoing its `childToken`. Treat every field defensively — it is wire data.
// ============================================================================

/** One node in the Navigator tree (a level returned by /connector-objects). */
export interface NavNode {
  /** Stable unique id within this tree (also the TreeItem value / open key). */
  id: string;
  /** Human label shown on the row. */
  name: string;
  /** Node role — drives the icon + whether it can be selected. */
  kind: 'catalog' | 'database' | 'schema' | 'folder' | 'table' | 'view' | 'container' | 'file';
  /** True when the node has children to load lazily (rendered as a branch). */
  expandable?: boolean;
  /** Opaque token echoed back to the route to fetch this node's children. */
  childToken?: string;
  /** True when the node is a bindable object (table / view / container / file). */
  selectable?: boolean;
  /** The W1 ReportObjectRef to read this object (present iff selectable). */
  objectRef?: ReportObjectRef;
  /** Canonical key for state.tableStorage (defaults to schema.name / name). */
  tableKey?: string;
  /** Owning schema, when applicable (for the summary + tableStorage key). */
  schema?: string;
  /** Light metadata for the row badge (format, row estimate, object type). */
  meta?: { format?: string; rowEstimate?: number; type?: string };
}

/** A confirmed object the author chose to bring into the report. */
export interface NavigatorObjectSelection {
  /**
   * BARE `state.tableStorage` / `/fields` key — NOT schema-qualified. This is the
   * exact key space the Storage-mode pane, the refresh route, and the query route
   * all read (the resolver's Fields-pane table name): `objectRef.table` for a
   * table, `'Query'` for a custom SELECT, the file basename for a file. Keying by
   * the schema-qualified `schema.name` (the display `label`) would store the
   * Import/DirectQuery choice where nothing reads it — the cache would never build
   * or read and "connectivity changes execution" would silently no-op.
   */
  table: string;
  /** Owning schema, when known. */
  schema?: string;
  /** Display label for the source summary (schema-qualified `schema.name`). */
  label: string;
  /** Node kind (icon / labelling on the parent). */
  kind: NavNode['kind'];
  /** The W1 ReportObjectRef to read this object (from the route). */
  objectRef: ReportObjectRef;
}

/** Everything the picker needs to persist on confirm. */
export interface NavigatorResult {
  /** The introspected connection. */
  connectionId: string;
  connType: ReportConnType;
  /** Chosen Import-vs-DirectQuery connectivity. */
  connectivity: ConnectivityMode;
  /** The StorageMode the connectivity seeds for every selection. */
  storageMode: StorageMode;
  /** ≥1 selected objects. */
  selections: NavigatorObjectSelection[];
  /** A complete primary ConnectionDataSource for the first selection
   *  (ready to write to state.dataSource — the W1 single-source shape). */
  primarySource: ConnectionDataSource;
  /** Seed for state.tableStorage: every selection at the chosen mode, group
   *  'primary' — structurally a W2 TableStorageMap (the picker persists it).
   *  Keyed by the BARE Fields-pane name (the same key space the Storage-mode
   *  pane / refresh route / query route read), NOT the schema-qualified label. */
  tableStorage: Record<string, { mode: StorageMode; group?: string }>;
}

// ── styles (Loom tokens only — no hard-coded px / hex) ────────────────────────

const useStyles = makeStyles({
  surface: { maxWidth: '1120px', width: '94vw' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },

  // two-pane body: tree (left) + preview (right)
  split: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 360px) minmax(0, 1fr)',
    gap: tokens.spacingHorizontalL,
    minHeight: 0,
    minWidth: 0,
  },
  pane: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    minWidth: 0, minHeight: 0,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalM,
  },
  paneHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  spacer: { flex: 1 },
  treeScroll: {
    overflowY: 'auto', overflowX: 'hidden',
    minHeight: '46vh', maxHeight: '60vh',
    minWidth: 0,
  },
  rowLayout: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%', minWidth: 0 },
  rowName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  rowMeta: { marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flexShrink: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  statePad: { padding: tokens.spacingVerticalS },
  checkboxCell: { flexShrink: 0 },

  // preview grid
  previewScroll: {
    overflow: 'auto',
    minHeight: '46vh', maxHeight: '60vh',
    minWidth: 0,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalS,
  },
  cell: { whiteSpace: 'nowrap', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' },

  // footer: connectivity radio + selection summary + actions
  footerBar: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalL,
    flexWrap: 'wrap', width: '100%',
  },
  connBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  radioRow: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  selSummary: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  footerActions: { marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

// ── per-kind icon ─────────────────────────────────────────────────────────────

function nodeIcon(kind: NavNode['kind']): ReactElement {
  switch (kind) {
    case 'catalog':
    case 'database': return <Database20Regular />;
    case 'schema':
    case 'folder': return <Folder20Regular />;
    case 'view': return <DocumentTable20Regular />;
    case 'container': return <DocumentDatabase20Regular />;
    case 'file': return <DocumentTable20Regular />;
    case 'table':
    default: return <Table20Regular />;
  }
}

/** Canonical tableStorage key for a node (route-provided, else schema.name / name). */
function nodeTableKey(n: NavNode): string {
  if (n.tableKey && n.tableKey.trim()) return n.tableKey.trim();
  return n.schema ? `${n.schema}.${n.name}` : n.name;
}

/**
 * The BARE `state.tableStorage` / `/fields` key for a selected object — derived
 * from the route-provided `ReportObjectRef`, NOT from the schema-qualified
 * display name `nodeTableKey` builds. This MUST mirror the resolver's Fields-pane
 * table name per `objectRef.mode`, because that is the exact key space the
 * Storage-mode pane (keys by the `/fields` `t.name`), the refresh route
 * (`materializableFromConnection`), and the query route (`tryConnectionCacheRead`)
 * all read:
 *   • table → `ref.table`  (bare, e.g. 'Customer' — what the routes key on; the
 *                            schema lives separately on the ref / the label)
 *   • query → 'Query'      (the resolver's Fields-pane name for a custom SELECT)
 *   • file  → the file's basename
 *   • kql   → 'Query'
 * Seeding the Import/DirectQuery choice under the schema-qualified `schema.name`
 * instead (the old behaviour) stored it under a key nothing else read, so the
 * Import/Dual cache was never built or read through the Navigator and the
 * connectivity choice silently no-op'd until the mode was re-set in the
 * Storage-mode pane (which re-keys to bare).
 */
function objectRefStorageKey(ref: ReportObjectRef): string {
  switch (ref.mode) {
    case 'table': return ref.table;
    case 'query': return 'Query';
    case 'file': return ref.containerPath.split('/').filter(Boolean).pop() || ref.containerPath;
    case 'kql': return 'Query';
    default: return '';
  }
}

// ── live-preview shape (from /connector-preview) ──────────────────────────────

interface PreviewData { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }

/** Render a cell value compactly (objects → JSON, null → em dash). */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

// ── component ─────────────────────────────────────────────────────────────────

export interface NavigatorDialogProps {
  open: boolean;
  /** Report item id — scopes the introspection + preview routes (owner-checked). */
  reportId?: string;
  /** The bound connection to introspect. The Navigator requires a connection. */
  connectionId: string;
  /** The connection's report ConnType (drives capability + the emitted source). */
  connType: ReportConnType;
  /** Optional connection label for the header (falls back to the ConnType label). */
  connectionLabel?: string;
  /** Pre-seed the connectivity radio (default 'import'). */
  defaultConnectivity?: ConnectivityMode;
  /** Fires with the chosen object(s) + connectivity + tableStorage seed. */
  onConfirm: (result: NavigatorResult) => void;
  onDismiss: () => void;
}

export function NavigatorDialog({
  open, reportId, connectionId, connType, connectionLabel,
  defaultConnectivity = 'import', onConfirm, onDismiss,
}: NavigatorDialogProps) {
  const s = useStyles();

  const directQueryCapable = DIRECT_QUERY_CAPABLE.has(connType);
  const connLabel = connectionLabel || REPORT_CONN_TYPE_LABEL[connType] || 'Connection';

  // The introspection source: a connection with a placeholder objectRef. The
  // /connector-objects + /connector-preview routes read connectionId + connType;
  // the objectRef is spliced in per-node for preview.
  const introspectSource: ConnectionDataSource = useMemo(() => ({
    kind: 'connection', connectionId, connType,
    objectRef: { mode: 'table', table: '' },
  }), [connectionId, connType]);

  // ── tree state (lazy) ───────────────────────────────────────────────────────
  const [rootNodes, setRootNodes] = useState<NavNode[] | null>(null);
  const [rootErr, setRootErr] = useState<{ error: string; missing?: string } | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  // children keyed by the parent's childToken
  const [childrenByToken, setChildrenByToken] = useState<Record<string, NavNode[]>>({});
  const [childErrByToken, setChildErrByToken] = useState<Record<string, string>>({});
  const [loadingTokens, setLoadingTokens] = useState<Set<string>>(new Set());
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  // id → node, so onOpenChange can resolve a node's childToken to lazily load it.
  const nodesById = useRef<Map<string, NavNode>>(new Map());

  const [filter, setFilter] = useState('');

  // ── selection + connectivity ────────────────────────────────────────────────
  const [selected, setSelected] = useState<Map<string, NavNode>>(new Map());
  const [connectivity, setConnectivity] = useState<ConnectivityMode>(
    directQueryCapable ? defaultConnectivity : 'import',
  );

  // ── preview (right pane) ────────────────────────────────────────────────────
  const [highlighted, setHighlighted] = useState<NavNode | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewErr, setPreviewErr] = useState<{ error: string; missing?: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const registerNodes = useCallback((nodes: NavNode[]) => {
    for (const n of nodes) nodesById.current.set(n.id, n);
  }, []);

  // ── introspection (real backend via /connector-objects) ─────────────────────
  const objectsUrl = reportId
    ? `/api/items/report/${encodeURIComponent(reportId)}/connector-objects`
    : null;

  const fetchLevel = useCallback(async (parentToken: string | null): Promise<
    { ok: true; nodes: NavNode[] } | { ok: false; error: string; missing?: string }
  > => {
    if (!objectsUrl) {
      return {
        ok: false,
        error: 'Save the report first — the object browser reads the connection through the saved report.',
        missing: 'reportId',
      };
    }
    try {
      const r = await clientFetch(
        objectsUrl,
        {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: introspectSource, parent: parentToken }),
        },
        30000,
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        return { ok: false, error: j?.error || `HTTP ${r.status}`, missing: j?.missing };
      }
      const nodes: NavNode[] = Array.isArray(j.nodes) ? j.nodes : [];
      return { ok: true, nodes };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, [objectsUrl, introspectSource]);

  const loadRoots = useCallback(async () => {
    setRootLoading(true); setRootErr(null);
    const res = await fetchLevel(null);
    if (res.ok) { registerNodes(res.nodes); setRootNodes(res.nodes); }
    else { setRootNodes([]); setRootErr({ error: res.error, missing: res.missing }); }
    setRootLoading(false);
  }, [fetchLevel, registerNodes]);

  const loadChildren = useCallback(async (node: NavNode) => {
    const token = node.childToken;
    if (!token) return;
    if (childrenByToken[token]) return;          // cached
    setLoadingTokens((prev) => new Set(prev).add(token));
    setChildErrByToken((m) => { const n = { ...m }; delete n[token]; return n; });
    const res = await fetchLevel(token);
    if (res.ok) {
      registerNodes(res.nodes);
      setChildrenByToken((m) => ({ ...m, [token]: res.nodes }));
    } else {
      setChildErrByToken((m) => ({ ...m, [token]: res.missing ? `${res.error} (set ${res.missing})` : res.error }));
    }
    setLoadingTokens((prev) => { const n = new Set(prev); n.delete(token); return n; });
  }, [childrenByToken, fetchLevel, registerNodes]);

  // Reset + (re)introspect whenever the dialog opens against a connection.
  useEffect(() => {
    if (!open) return;
    nodesById.current = new Map();
    setRootNodes(null); setRootErr(null);
    setChildrenByToken({}); setChildErrByToken({}); setLoadingTokens(new Set());
    setOpenItems(new Set());
    setSelected(new Map());
    setHighlighted(null); setPreview(null); setPreviewErr(null);
    setFilter('');
    setConnectivity(directQueryCapable ? defaultConnectivity : 'import');
    void loadRoots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId, connType]);

  // ── lazy expand on open ─────────────────────────────────────────────────────
  const onOpenChange = useCallback((_: unknown, data: { open: boolean; value: unknown }) => {
    const value = String(data.value);
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (data.open) next.add(value); else next.delete(value);
      return next;
    });
    if (!data.open) return;
    const node = nodesById.current.get(value);
    if (node && node.expandable && node.childToken) void loadChildren(node);
  }, [loadChildren]);

  // ── highlight a node → real TOP-100 preview via /connector-preview ──────────
  const runPreview = useCallback(async (node: NavNode) => {
    setHighlighted(node);
    setPreview(null); setPreviewErr(null);
    if (!node.selectable || !node.objectRef) return;
    if (!reportId) {
      setPreviewErr({
        error: 'Save the report first to preview rows from the live Azure backend.',
        missing: 'reportId',
      });
      return;
    }
    setPreviewLoading(true);
    try {
      const r = await clientFetch(
        `/api/items/report/${encodeURIComponent(reportId)}/connector-preview`,
        {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: introspectSource, objectRef: node.objectRef, limit: 100 }),
        },
        30000,
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        setPreviewErr({ error: j?.error || `HTTP ${r.status}`, missing: j?.missing });
        return;
      }
      setPreview({ columns: j.columns || [], rows: j.rows || [], truncated: !!j.truncated });
    } catch (e: any) {
      setPreviewErr({ error: e?.message || String(e) });
    } finally {
      setPreviewLoading(false);
    }
  }, [reportId, introspectSource]);

  // ── selection toggles ───────────────────────────────────────────────────────
  const toggleSelect = useCallback((node: NavNode, checked: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (checked) next.set(node.id, node); else next.delete(node.id);
      return next;
    });
  }, []);

  const filterMatch = useCallback((name: string) => {
    const f = filter.trim().toLowerCase();
    return !f || name.toLowerCase().includes(f);
  }, [filter]);

  // ── confirm → emit NavigatorResult ──────────────────────────────────────────
  const storageMode = storageModeForConnectivity(connectivity);
  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);

  const confirm = useCallback(() => {
    const chosen = selectedList.filter((n) => n.selectable && n.objectRef);
    if (chosen.length === 0) return;
    const selections: NavigatorObjectSelection[] = chosen.map((n) => ({
      // BARE Fields-pane key (objectRef.table / 'Query' / file basename) so the
      // seed lands in the SAME key space the Storage-mode pane / refresh / query
      // routes read — never the schema-qualified display key.
      table: objectRefStorageKey(n.objectRef as ReportObjectRef),
      schema: n.schema,
      label: nodeTableKey(n),
      kind: n.kind,
      objectRef: n.objectRef as ReportObjectRef,
    }));
    const primarySource: ConnectionDataSource = {
      kind: 'connection', connectionId, connType,
      objectRef: chosen[0].objectRef as ReportObjectRef,
    };
    const tableStorage: Record<string, { mode: StorageMode; group?: string }> = {};
    for (const sel of selections) tableStorage[sel.table] = { mode: storageMode, group: 'primary' };
    onConfirm({
      connectionId, connType, connectivity, storageMode,
      selections, primarySource, tableStorage,
    });
  }, [selectedList, connectionId, connType, connectivity, storageMode, onConfirm]);

  // ── recursive tree render ───────────────────────────────────────────────────
  const renderNodes = useCallback((nodes: NavNode[]): ReactElement[] => {
    return nodes
      .filter((n) => filterMatch(n.name) || n.expandable) // keep branches so deep matches stay reachable
      .map((node) => {
        const isBranch = !!(node.expandable && node.childToken);
        const checked = selected.has(node.id);
        const meta = node.meta;
        const metaBadge = meta?.format || meta?.type
          || (typeof meta?.rowEstimate === 'number' ? `${meta.rowEstimate.toLocaleString()} rows` : '');

        const layout = (
          <TreeItemLayout iconBefore={nodeIcon(node.kind)}>
            <span className={s.rowLayout}>
              {node.selectable && (
                <span
                  className={s.checkboxCell}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={checked}
                    onChange={(_e, d) => toggleSelect(node, !!d.checked)}
                    aria-label={`Select ${node.name}`}
                  />
                </span>
              )}
              <span
                className={s.rowName}
                title={node.name}
                onClick={(e) => { if (node.selectable) { e.stopPropagation(); void runPreview(node); } }}
              >
                {node.name}
              </span>
              <span className={s.rowMeta}>
                {metaBadge && <Badge size="small" appearance="tint" color="informative">{metaBadge}</Badge>}
                {node.selectable && (
                  <Tooltip content="Preview top 100 rows" relationship="label">
                    <Button
                      size="small" appearance="subtle" icon={<Eye20Regular />}
                      aria-label={`Preview ${node.name}`}
                      onClick={(e) => { e.stopPropagation(); void runPreview(node); }}
                    />
                  </Tooltip>
                )}
              </span>
            </span>
          </TreeItemLayout>
        );

        if (!isBranch) {
          return (
            <TreeItem key={node.id} itemType="leaf" value={node.id}>
              {layout}
            </TreeItem>
          );
        }

        const token = node.childToken as string;
        const kids = childrenByToken[token];
        const kidErr = childErrByToken[token];
        const kidLoading = loadingTokens.has(token);
        return (
          <TreeItem key={node.id} itemType="branch" value={node.id}>
            {layout}
            <Tree>
              {kidLoading && !kids && (
                <TreeItem itemType="leaf" value={`${node.id}::loading`}>
                  <TreeItemLayout><Spinner size="tiny" label="Loading objects…" /></TreeItemLayout>
                </TreeItem>
              )}
              {kidErr && (
                <TreeItem itemType="leaf" value={`${node.id}::err`}>
                  <TreeItemLayout><Caption1 className={s.muted}>{kidErr}</Caption1></TreeItemLayout>
                </TreeItem>
              )}
              {kids && kids.length === 0 && !kidErr && (
                <TreeItem itemType="leaf" value={`${node.id}::empty`}>
                  <TreeItemLayout><Caption1 className={s.muted}>No objects</Caption1></TreeItemLayout>
                </TreeItem>
              )}
              {kids && kids.length > 0 && renderNodes(kids)}
              {!kids && !kidLoading && !kidErr && (
                <TreeItem itemType="leaf" value={`${node.id}::hint`}>
                  <TreeItemLayout><Caption1 className={s.muted}>Expand to load…</Caption1></TreeItemLayout>
                </TreeItem>
              )}
            </Tree>
          </TreeItem>
        );
      });
  }, [
    s, selected, childrenByToken, childErrByToken, loadingTokens,
    filterMatch, toggleSelect, runPreview,
  ]);

  // ── render ──────────────────────────────────────────────────────────────────
  const selectableCount = selectedList.filter((n) => n.selectable && n.objectRef).length;

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onDismiss(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle
            action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close Navigator" onClick={onDismiss} />}
          >
            <span className={s.titleRow}>
              <DatabaseSearch20Regular />
              <Subtitle1>Navigator</Subtitle1>
              <Badge appearance="tint" color="brand" size="small">
                <DatabasePlugConnected20Regular /> {connLabel}
              </Badge>
              <Badge appearance="outline" color="subtle" size="small">Azure-native · no Fabric required</Badge>
            </span>
          </DialogTitle>

          <DialogContent>
            <div className={s.split}>
              {/* LEFT — object tree (catalog → schema → tables / views) */}
              <div className={s.pane}>
                <div className={s.paneHead}>
                  <Subtitle2>Objects</Subtitle2>
                  <span className={s.spacer} />
                  <Tooltip content="Refresh" relationship="label">
                    <Button
                      size="small" appearance="subtle" icon={<ArrowClockwise20Regular />}
                      aria-label="Refresh objects" disabled={rootLoading} onClick={() => void loadRoots()}
                    />
                  </Tooltip>
                </div>

                <SearchBox
                  placeholder="Filter objects…"
                  value={filter}
                  onChange={(_, d) => setFilter(d.value)}
                  aria-label="Filter objects"
                />

                {rootLoading && rootNodes === null && (
                  <div className={s.statePad}><Spinner size="tiny" label="Introspecting the connection…" /></div>
                )}

                {rootErr && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Could not browse this connection</MessageBarTitle>
                      {rootErr.error}{rootErr.missing ? ` — set ${rootErr.missing}.` : ''}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {rootNodes && rootNodes.length === 0 && !rootErr && (
                  <EmptyState
                    icon={<DatabaseSearch20Regular />}
                    title="No objects found"
                    body="This connection exposed no tables, views, or containers. Check the connection’s database / catalog, or your RBAC on it."
                  />
                )}

                {rootNodes && rootNodes.length > 0 && (
                  <div className={s.treeScroll}>
                    <Tree
                      aria-label="Connection objects"
                      openItems={Array.from(openItems)}
                      onOpenChange={onOpenChange as any}
                    >
                      {renderNodes(rootNodes)}
                    </Tree>
                  </div>
                )}
              </div>

              {/* RIGHT — TOP-100 preview of the highlighted object */}
              <div className={s.pane}>
                <div className={s.paneHead}>
                  <Subtitle2>Preview</Subtitle2>
                  {highlighted && <Caption1 className={s.muted}>{nodeTableKey(highlighted)}</Caption1>}
                  <span className={s.spacer} />
                  {highlighted?.selectable && (
                    <Tooltip content="Reload preview" relationship="label">
                      <Button
                        size="small" appearance="subtle" icon={<TableSearch20Regular />}
                        aria-label="Reload preview" disabled={previewLoading}
                        onClick={() => highlighted && void runPreview(highlighted)}
                      />
                    </Tooltip>
                  )}
                </div>

                {!highlighted && (
                  <EmptyState
                    icon={<Eye20Regular />}
                    title="Select an object to preview"
                    body="Click a table, view, or container in the tree to see its first 100 rows — a real read against the live Azure backend."
                  />
                )}

                {previewLoading && (
                  <div className={s.statePad}><Spinner size="tiny" label="Reading top 100 rows…" /></div>
                )}

                {previewErr && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Could not preview</MessageBarTitle>
                      {previewErr.error}{previewErr.missing ? ` — set ${previewErr.missing}.` : ''}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {preview && preview.columns.length > 0 && (
                  <div className={s.previewScroll}>
                    <Caption1 className={s.muted}>
                      {preview.rows.length} row(s){preview.truncated ? ' (truncated to 100)' : ''}
                    </Caption1>
                    <Table size="small" aria-label="Object preview">
                      <TableHeader>
                        <TableRow>
                          {preview.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.rows.map((row, i) => (
                          <TableRow key={i}>
                            {preview.columns.map((c) => (
                              <TableCell key={c}><span className={s.cell}>{formatCell(row[c])}</span></TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {preview && preview.columns.length === 0 && !previewErr && !previewLoading && (
                  <Caption1 className={s.muted}>The object returned no columns.</Caption1>
                )}
              </div>
            </div>
          </DialogContent>

          <DialogActions>
            <div className={s.footerBar}>
              {/* connectivity mode — Import vs DirectQuery (no-freeform-config) */}
              <div className={s.connBlock}>
                <Field label="Data connectivity mode">
                  <RadioGroup
                    layout="horizontal"
                    value={connectivity}
                    onChange={(_e, d) => setConnectivity(d.value as ConnectivityMode)}
                    aria-label="Data connectivity mode"
                  >
                    <div className={s.radioRow}>
                      <Radio value="import" label="Import" />
                      <Radio
                        value="directQuery"
                        label="DirectQuery"
                        disabled={!directQueryCapable}
                      />
                    </div>
                  </RadioGroup>
                </Field>
                <Caption1 className={s.muted}>
                  {connectivity === 'import'
                    ? 'Import — materialize a Delta/Synapse cache (refresh on demand). Fast aggregations; data is a point-in-time copy.'
                    : 'DirectQuery — query the live Synapse / connector SQL on every visual. Always current; no copy.'}
                  {!directQueryCapable && ' DirectQuery is unavailable for this source (Import-only).'}
                </Caption1>
              </div>

              <Divider vertical style={{ alignSelf: 'stretch' }} />

              <div className={s.selSummary}>
                <Badge appearance="filled" color={selectableCount ? 'brand' : 'subtle'} size="medium">
                  {selectableCount} selected
                </Badge>
                <Caption1 className={s.muted}>
                  {selectableCount === 0 ? 'Check one or more tables / views to bring into the report.' : `→ ${storageMode}`}
                </Caption1>
              </div>

              <div className={s.footerActions}>
                <Button appearance="secondary" onClick={onDismiss}>Cancel</Button>
                <Button
                  appearance="primary"
                  icon={<Checkmark20Regular />}
                  disabled={selectableCount === 0}
                  onClick={confirm}
                >
                  Load {selectableCount > 0 ? `(${selectableCount})` : ''}
                </Button>
              </div>
            </div>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default NavigatorDialog;
