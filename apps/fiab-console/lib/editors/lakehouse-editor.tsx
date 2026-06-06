'use client';

/**
 * LakehouseEditor — real ADLS Gen2 browser + OPENROWSET preview, wired
 * to the DLZ storage account via the BFF (UAMI -> Storage Blob Data
 * Contributor; Synapse Serverless for preview).
 *
 * Tabs:
 *   - Files:    DataGrid of paths with Upload/New folder/Delete/Refresh
 *   - Preview:  First 100 rows of the selected file via OPENROWSET
 *   - SQL:      Pre-filled OPENROWSET query, runs through the existing
 *               Synapse Serverless query route.
 *
 * No mock data. Loading + empty + error states are surfaced verbatim.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getItem, type WorkspaceItem } from '@/lib/api/workspaces';
import type { LakehouseContent } from '@/lib/apps/content-bundles/types';
import {
  Badge, Body1, Button, Caption1, Spinner, Subtitle2,
  Tree, TreeItem, TreeItemLayout,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Menu, MenuTrigger, MenuList, MenuItem, MenuPopover,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Input, Field, Switch, Dropdown, Option, Textarea, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, ArrowUpload20Regular, Database20Regular, Delete20Regular,
  DocumentTable20Regular, Eye20Regular, Folder20Regular, FolderAdd20Regular, Play20Regular,
  BookOpen20Regular, TableSimple20Regular,
  ArrowDownload20Regular, Info20Regular, LinkMultiple20Regular,
  Add20Regular, CloudLink20Regular, CheckmarkCircle20Filled, ErrorCircle20Filled, Clock20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  treePad: { padding: 8 },
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: '8px 8px 0' },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflow: 'auto', maxHeight: 480, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  rowHover: { ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, cursor: 'pointer' } },
  rowSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  editor: {
    width: '100%', minHeight: 160,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  preview: { width: '100%', minHeight: 240,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1 },
});

interface ContainerInfo { name: string; url: string }
interface PathEntry { name: string; isDirectory: boolean; size: number; lastModified?: string; etag?: string }

/**
 * Reference-Lakehouse federation (F8) — another in-workspace lakehouse added to
 * the explorer for side-by-side, READ-ONLY browsing. `account` is the resolved
 * ADLS account (primary LOOM account unless the lakehouse declares its own);
 * `reachable` reflects the pass-through RBAC probe (Console UAMI must hold
 * Storage Blob Data Reader on the referenced containers).
 */
interface ReferenceLakehouse {
  id: string;
  displayName: string;
  account: string;
  containers: string[];
  reachable: boolean;
}

/** A file selected inside a referenced lakehouse (drives the read-only preview). */
interface RefSelection {
  refId: string;
  displayName: string;
  account: string;
  container: string;
  entry: PathEntry;
}

interface PreviewResponse {
  ok: boolean;
  format?: string;
  bulkUrl?: string;
  sql?: string;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  error?: string;
  code?: string;
}

function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function leafName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.substring(i + 1) : trimmed;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Defensive response parser. If a gateway / Container App / WAF / 404 returns
 * an HTML error page (`<!DOCTYPE ...`), `r.json()` throws
 * "Unexpected token '<', "<!DOCTYPE "... is not valid JSON". Sniff the
 * content-type and only call `.json()` when the body actually is JSON;
 * otherwise return a structured `{ ok: false, error }` carrying the HTTP
 * status + the first line of the body so the user sees a precise message
 * instead of a raw JSON.parse crash.
 *
 * Every `fetch().json()` in this editor routes through here.
 */
async function parseJsonOrError<T extends { ok?: boolean; error?: string }>(
  r: Response,
  label: string,
): Promise<T> {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      const j = (await r.json()) as T;
      // Surface an HTTP error even when the body parsed but lacks ok.
      if (!r.ok && j && j.ok === undefined) {
        return { ok: false, error: j.error || `${label} failed (HTTP ${r.status}).` } as T;
      }
      return j;
    } catch {
      /* fall through to text handling */
    }
  }
  let bodyText = '';
  try { bodyText = (await r.text()).trim(); } catch { /* ignore */ }
  const firstLine = bodyText.split(/\r?\n/)[0]?.slice(0, 200) || '';
  const detail =
    r.status === 404 ? 'endpoint not found (404)'
    : r.status === 502 ? 'upstream error (502)'
    : r.status === 503 ? 'service unavailable (503)'
    : r.status === 401 ? 'sign-in expired (401) — reload and re-authenticate'
    : `HTTP ${r.status}`;
  return {
    ok: false,
    error: `${label} failed: ${detail}${firstLine ? ` — server said: ${firstLine}` : ''}`,
  } as T;
}

interface Props { item: FabricItemType; id: string }

export function LakehouseEditor({ item, id }: Props) {
  const s = useStyles();
  const router = useRouter();

  // Bundle-installed lakehouses stamp their rich definition (folder tree,
  // Delta tables, shortcuts) into the Cosmos item's state.content
  // (LakehouseContent). The live ADLS account / Synapse Serverless endpoint may
  // not be provisioned yet, in which case the Files/Tables/Shortcuts listings
  // come back empty. Read the persisted content from the React Query cache the
  // host page primes at ['item','lakehouse',id] so the editor opens FULLY
  // built-out — showing the planned folders, Delta tables, and shortcuts — even
  // before the live backend exists. Browse / preview / SQL still hit live ADLS.
  const isNewItem = id === 'new';
  const itemQ = useQuery<WorkspaceItem>({
    queryKey: ['item', 'lakehouse', id],
    queryFn: () => getItem('lakehouse', id),
    enabled: !isNewItem,
  });
  const lhContentRaw = (itemQ.data?.state as any)?.content as LakehouseContent | undefined;
  const lhContent = lhContentRaw?.kind === 'lakehouse' ? lhContentRaw : undefined;
  const bundleFolders = lhContent?.folders ?? [];
  const bundleDeltaTables = lhContent?.deltaTables ?? [];
  const bundleShortcuts = lhContent?.shortcuts ?? [];
  const hasBundle = bundleFolders.length > 0 || bundleDeltaTables.length > 0 || bundleShortcuts.length > 0;
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [containerError, setContainerError] = useState<string | null>(null);
  const [activeContainer, setActiveContainer] = useState<string | null>(null);
  const [openPrefixes, setOpenPrefixes] = useState<Record<string, PathEntry[] | 'loading' | { error: string }>>({});
  const [activePath, setActivePath] = useState<PathEntry | null>(null);
  const [tab, setTab] = useState<string>('files');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sqlText, setSqlText] = useState<string>(
    `-- Select a file in the Files tab and click "Query this file"\n-- to populate this editor with a Synapse Serverless OPENROWSET.`,
  );
  const [sqlResult, setSqlResult] = useState<PreviewResponse | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Phase 4.5 — positive feedback for upload / mkdir / delete so the user
  // can tell the operation actually hit ADLS. Mirrors the "Saved at HH:MM:SS"
  // pattern used by the document editors (notebook, pipeline, dataflow, etc.).
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Reference lakehouses (F8) --------------------------------------
  // Other in-workspace lakehouses added to the explorer for side-by-side,
  // READ-ONLY browsing. The set is persisted on this lakehouse's Cosmos doc
  // (state.referencedLakehouseIds) via /api/lakehouse/references. File listings
  // and previews for references go through the read-only references routes /
  // the account-scoped preview route — write actions are never offered.
  const [references, setReferences] = useState<ReferenceLakehouse[] | null>(null);
  const [refsLoading, setRefsLoading] = useState(false);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [workspaceLakehouses, setWorkspaceLakehouses] = useState<{ id: string; displayName: string }[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Tree-expansion cache for reference file/folder listings, keyed
  // `ref::<refId>::<container>::<prefix>` so every reference browses its own
  // namespace without colliding with the primary lakehouse's openPrefixes.
  const [refOpenPrefixes, setRefOpenPrefixes] = useState<Record<string, PathEntry[] | 'loading' | { error: string }>>({});
  // The reference file currently selected for the read-only preview pane.
  const [refSelection, setRefSelection] = useState<RefSelection | null>(null);
  const [refPreview, setRefPreview] = useState<PreviewResponse | null>(null);
  const [refPreviewLoading, setRefPreviewLoading] = useState(false);

  // Permissions dialog state — Azure RBAC role assignments at the container scope.
  interface PermAssignment { id: string; principalId: string; principalType?: string; roleName?: string }
  interface PermRole { name: string; id: string }
  const [permsOpen, setPermsOpen] = useState(false);
  const [permsRows, setPermsRows] = useState<PermAssignment[]>([]);
  const [permsRoles, setPermsRoles] = useState<PermRole[]>([]);
  const [permsBusy, setPermsBusy] = useState(false);
  const [permsError, setPermsError] = useState<string | null>(null);
  const [newPrincipalId, setNewPrincipalId] = useState('');
  const [newPrincipalType, setNewPrincipalType] = useState<'User' | 'Group' | 'ServicePrincipal'>('User');
  const [newRole, setNewRole] = useState('Storage Blob Data Reader');

  // Settings dialog state — Loom-side lakehouse defaults persisted in
  // Cosmos `tenant-settings`, consumed by Notebook + Preview editors.
  interface LakehouseSettings {
    displayName?: string; description?: string; defaultSparkPool?: string;
    sparkConfig?: Record<string, string>;
    timeTravelDays?: number;
    deltaDefaults?: { autoOptimize?: boolean; tableProperties?: Record<string, string> };
  }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<LakehouseSettings>({});
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSparkConfText, setSettingsSparkConfText] = useState('');
  // Real deployed Synapse Spark pools — bind the "Default Spark pool" field to
  // an enumerated picker (no freeform compute input) per the UI-parity rule.
  const [sparkPools, setSparkPools] = useState<{ name: string }[] | null>(null);

  // ---- Live Delta catalog (Tables tab) ----------------------------------
  // The Tables tree is the REAL physical Delta catalog: an ADLS Gen2 scan of
  // the active container's Tables/ directory + a _delta_log read for status /
  // version, with optional Serverless OPENROWSET COUNT(*) row counts. Azure-
  // native, NO Fabric dependency. Source: GET /api/lakehouse/tables.
  interface LiveCatalogTable {
    schema: string; name: string; adlsPath: string; bulkUrl: string;
    format: 'delta' | 'parquet' | 'unknown';
    status: 'ok' | 'empty' | 'broken';
    latestVersion: number | null;
    rowCount: number | null; sizeBytes: number | null;
    lastModified: string | null;
  }
  const [liveTables, setLiveTables] = useState<LiveCatalogTable[] | null>(null);
  const [liveTablesLoading, setLiveTablesLoading] = useState(false);
  const [liveTablesError, setLiveTablesError] = useState<string | null>(null);
  const [liveTablesGate, setLiveTablesGate] = useState<string | null>(null);

  const loadLiveTables = useCallback(async () => {
    if (!activeContainer) return;
    setLiveTablesLoading(true); setLiveTablesError(null); setLiveTablesGate(null);
    try {
      const r = await fetch(
        `/api/lakehouse/tables?containers=${encodeURIComponent(activeContainer)}&rowCounts=true`,
      );
      const j = await parseJsonOrError<{ ok: boolean; tables?: LiveCatalogTable[]; gate?: string; error?: string }>(r, 'List tables');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setLiveTables(j.tables || []);
      setLiveTablesGate(j.gate || null);
    } catch (e: any) { setLiveTablesError(e?.message || String(e)); }
    finally { setLiveTablesLoading(false); }
  }, [activeContainer]);

  useEffect(() => {
    if (tab === 'tables' && activeContainer) loadLiveTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeContainer]);

  // ---- Fabric-style context menu (right-click on tree / table nodes) ----
  // Anchored at the cursor via a virtual positioning target, mirroring the
  // Fabric lakehouse explorer right-click menu. Each item invokes the SAME
  // real backend the toolbar / row actions use — no dead items.
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxEntry, setCtxEntry] = useState<PathEntry | null>(null);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const openContextMenu = useCallback((e: React.MouseEvent, entry: PathEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxEntry(entry);
    setCtxPos({ x: e.clientX, y: e.clientY });
    setCtxOpen(true);
  }, []);

  // ---- Shortcuts tab (Azure-native, NO Fabric dependency) ----
  // A shortcut is a named, zero-copy pointer that surfaces external data as a
  // folder under Files or a table under Tables. ADLS Gen2 + internal Loom
  // lakehouse resolve on the Console UAMI; Tables register a real external table
  // (Synapse Serverless preferred, Databricks UC otherwise). S3/GCS/Dataverse
  // render the create form and honest-gate on submit. Registry is the Cosmos
  // `lakehouse-shortcuts` container. See docs/fiab/design/lakehouse-shortcuts.md.
  type ShortcutTargetType = 'adls' | 'internal' | 's3' | 'gcs' | 'dataverse';
  type ShortcutKind = 'files' | 'tables';
  interface ShortcutRow {
    id: string; lakehouseId: string; name: string; kind: ShortcutKind;
    parentPath: string; fullPath: string; targetType: ShortcutTargetType;
    targetUri: string; abfssUri?: string; engine?: 'synapse' | 'databricks' | 'none';
    engineObject?: string; format?: string; status: 'active' | 'pending' | 'error';
    statusDetail?: string; createdBy: string; createdAt: string;
  }
  const SHORTCUT_SOURCES: { type: ShortcutTargetType; label: string; ready: boolean }[] = [
    { type: 'internal', label: 'Internal Loom lakehouse', ready: true },
    { type: 'adls', label: 'ADLS Gen2 / Azure Blob', ready: true },
    { type: 's3', label: 'Amazon S3', ready: true },
    { type: 'gcs', label: 'Google Cloud Storage', ready: true },
    { type: 'dataverse', label: 'Dataverse', ready: true },
  ];
  // In-tenant ADLS/Blob account picker (vs typing the abfss URI) + external SAS.
  const [scAdlsMode, setScAdlsMode] = useState<'picker' | 'external'>('picker');
  const [storageAccts, setStorageAccts] = useState<Array<{ name: string; dfsHost?: string; blobHost?: string; isHns: boolean; resourceGroup?: string }>>([]);
  const [storageAcctsLoading, setStorageAcctsLoading] = useState(false);
  const [scAcctHost, setScAcctHost] = useState(''); // selected dfs/blob host
  const [scAdlsContainer, setScAdlsContainer] = useState('');
  const [scAdlsPath, setScAdlsPath] = useState('');
  const [shortcuts, setShortcuts] = useState<ShortcutRow[] | null>(null);
  const [shortcutsBusy, setShortcutsBusy] = useState(false);
  const [shortcutsError, setShortcutsError] = useState<string | null>(null);
  const [scWizardOpen, setScWizardOpen] = useState(false);
  const [scStep, setScStep] = useState<1 | 2 | 3>(1);
  const [scType, setScType] = useState<ShortcutTargetType>('internal');
  const [scTargetUri, setScTargetUri] = useState('');
  const [scInternalContainer, setScInternalContainer] = useState('');
  const [scInternalPath, setScInternalPath] = useState('');
  const [scKvSecret, setScKvSecret] = useState('');
  const [scName, setScName] = useState('');
  const [scKind, setScKind] = useState<ShortcutKind>('files');
  const [scParentPath, setScParentPath] = useState('');
  const [scFormat, setScFormat] = useState<'delta' | 'parquet' | 'csv' | 'json'>('delta');
  const [scSubmitting, setScSubmitting] = useState(false);
  const [scSubmitError, setScSubmitError] = useState<string | null>(null);

  // Discover in-tenant storage accounts for the ADLS picker when the wizard is
  // on the ADLS source in picker mode.
  useEffect(() => {
    if (!scWizardOpen || scType !== 'adls' || scAdlsMode !== 'picker' || storageAccts.length) return;
    setStorageAcctsLoading(true);
    fetch('/api/storage/accounts').then((r) => r.json()).then((j) => {
      if (j?.ok && Array.isArray(j.accounts)) setStorageAccts(j.accounts);
    }).catch(() => {}).finally(() => setStorageAcctsLoading(false));
  }, [scWizardOpen, scType, scAdlsMode, storageAccts.length]);

  // The lakehouse identity for the registry = the selected ADLS container
  // (the Loom "lakehouse" is a medallion container). Falls back to the item id.
  const shortcutLakehouseId = activeContainer || id;

  const loadShortcuts = useCallback(async () => {
    if (!shortcutLakehouseId) return;
    setShortcutsBusy(true); setShortcutsError(null);
    try {
      const r = await fetch(`/api/lakehouse/shortcuts?lakehouseId=${encodeURIComponent(shortcutLakehouseId)}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; data?: ShortcutRow[] }>(r, 'List shortcuts');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setShortcuts(j.data || []);
    } catch (e: any) { setShortcutsError(e?.message || String(e)); setShortcuts([]); }
    finally { setShortcutsBusy(false); }
  }, [shortcutLakehouseId]);

  const resetWizard = useCallback((presetKind?: ShortcutKind, presetParent?: string) => {
    setScStep(1); setScType('internal'); setScTargetUri('');
    setScInternalContainer(''); setScInternalPath(''); setScKvSecret('');
    setScName(''); setScKind(presetKind || 'files'); setScParentPath(presetParent || '');
    setScFormat('delta'); setScSubmitError(null);
  }, []);

  const openShortcutWizard = useCallback((presetKind?: ShortcutKind, presetParent?: string) => {
    resetWizard(presetKind, presetParent);
    setScWizardOpen(true);
  }, [resetWizard]);

  const submitShortcut = useCallback(async () => {
    if (!shortcutLakehouseId || !scName.trim()) return;
    setScSubmitting(true); setScSubmitError(null);
    // Resolve targetUri from the per-source fields.
    let targetUri = scTargetUri.trim();
    if (scType === 'internal') {
      const c = scInternalContainer.trim();
      const p = scInternalPath.trim().replace(/^\/+/, '');
      targetUri = `internal://${c}${p ? `/${p}` : ''}`;
    } else if (scType === 'adls' && scAdlsMode === 'picker' && scAcctHost) {
      // Build abfss from the picked account + container + path (no typed URI).
      const c = scAdlsContainer.trim();
      const p = scAdlsPath.trim().replace(/^\/+/, '');
      targetUri = `abfss://${c}@${scAcctHost}/${p}`;
    }
    const credentialRef = scKvSecret.trim()
      ? { kind: scType === 's3' ? 'awsKeys' : scType === 'gcs' ? 'gcsServiceAccount' : 'sas', keyVaultSecret: scKvSecret.trim() }
      : undefined;
    try {
      const r = await fetch('/api/lakehouse/shortcuts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lakehouseId: shortcutLakehouseId, name: scName.trim(), kind: scKind,
          parentPath: scParentPath.trim(), targetType: scType, targetUri,
          format: scKind === 'tables' ? scFormat : undefined, credentialRef,
        }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; hint?: string }>(r, 'Create shortcut');
      if (!j.ok) throw new Error(j.hint || j.error || `HTTP ${r.status}`);
      setScWizardOpen(false);
      await loadShortcuts();
    } catch (e: any) { setScSubmitError(e?.message || String(e)); }
    finally { setScSubmitting(false); }
  }, [shortcutLakehouseId, scName, scTargetUri, scType, scAdlsMode, scAcctHost, scAdlsContainer, scAdlsPath, scInternalContainer, scInternalPath, scKvSecret, scKind, scParentPath, scFormat, loadShortcuts]);

  // Register a PLANNED bundle shortcut into the live registry (one click) — the
  // bundle only carries metadata, so this materializes it against the real
  // backend (resolves the "shows in the tree but 'no shortcuts registered'"
  // contradiction). Bundle targets are abfss ADLS Gen2 URIs (Console UAMI auth).
  const [regBusy, setRegBusy] = useState<string | null>(null);
  const registerBundleShortcut = useCallback(async (sc: any) => {
    if (!shortcutLakehouseId) return;
    setRegBusy(sc.name); setShortcutsError(null);
    try {
      const r = await fetch('/api/lakehouse/shortcuts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lakehouseId: shortcutLakehouseId, name: sc.name,
          kind: sc.kind || 'files', parentPath: sc.parentPath || '',
          targetType: 'adls', targetUri: sc.target,
        }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; hint?: string }>(r, 'Register shortcut');
      if (!j.ok) throw new Error(j.hint || j.error || `HTTP ${r.status}`);
      await loadShortcuts();
    } catch (e: any) { setShortcutsError(e?.message || String(e)); }
    finally { setRegBusy(null); }
  }, [shortcutLakehouseId, loadShortcuts]);
  const registerAllBundleShortcuts = useCallback(async () => {
    for (const sc of bundleShortcuts) await registerBundleShortcut(sc);
  }, [bundleShortcuts, registerBundleShortcut]);

  const testShortcut = useCallback(async (row: ShortcutRow) => {
    setShortcutsBusy(true); setShortcutsError(null);
    try {
      const r = await fetch('/api/lakehouse/shortcuts/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: row.lakehouseId, id: row.id }),
      });
      await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Test shortcut');
      await loadShortcuts();
    } catch (e: any) { setShortcutsError(e?.message || String(e)); }
    finally { setShortcutsBusy(false); }
  }, [loadShortcuts]);

  const deleteShortcutRow = useCallback(async (row: ShortcutRow) => {
    // eslint-disable-next-line no-alert
    const ok = typeof window !== 'undefined'
      ? window.confirm(`Delete shortcut "${row.name}"? This drops the registry pointer and any external table — it never deletes the underlying source data.`)
      : false;
    if (!ok) return;
    setShortcutsBusy(true); setShortcutsError(null);
    try {
      const r = await fetch(`/api/lakehouse/shortcuts?lakehouseId=${encodeURIComponent(row.lakehouseId)}&id=${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Delete shortcut');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadShortcuts();
    } catch (e: any) { setShortcutsError(e?.message || String(e)); }
    finally { setShortcutsBusy(false); }
  }, [loadShortcuts]);

  // Load shortcuts when the tab is opened or the container changes.
  useEffect(() => {
    if (tab === 'shortcuts' && shortcutLakehouseId) loadShortcuts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, shortcutLakehouseId]);

  const loadPerms = useCallback(async () => {
    if (!activeContainer) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await fetch(`/api/lakehouse/permissions?container=${encodeURIComponent(activeContainer)}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; assignments?: PermAssignment[]; knownRoles?: PermRole[] }>(r, 'List permissions');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setPermsRows(j.assignments || []);
      setPermsRoles(j.knownRoles || []);
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [activeContainer]);

  const openPerms = useCallback(() => {
    setPermsOpen(true);
    loadPerms();
  }, [loadPerms]);

  const grantPerm = useCallback(async () => {
    if (!activeContainer || !newPrincipalId.trim()) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await fetch(`/api/lakehouse/permissions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          container: activeContainer,
          principalId: newPrincipalId.trim(),
          principalType: newPrincipalType,
          role: newRole,
        }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Grant permission');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setNewPrincipalId('');
      await loadPerms();
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [activeContainer, newPrincipalId, newPrincipalType, newRole, loadPerms]);

  const revokePerm = useCallback(async (armId: string) => {
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await fetch(`/api/lakehouse/permissions?id=${encodeURIComponent(armId)}`, { method: 'DELETE' });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Revoke permission');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadPerms();
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [loadPerms]);

  const loadSettings = useCallback(async () => {
    if (!activeContainer) return;
    setSettingsBusy(true); setSettingsError(null);
    try {
      const r = await fetch(`/api/lakehouse/settings?container=${encodeURIComponent(activeContainer)}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; settings?: LakehouseSettings }>(r, 'Load settings');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSettings(j.settings || {});
      const cfg = j.settings?.sparkConfig || {};
      setSettingsSparkConfText(Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join('\n'));
    } catch (e: any) { setSettingsError(e?.message || String(e)); }
    finally { setSettingsBusy(false); }
  }, [activeContainer]);

  const loadSparkPools = useCallback(async () => {
    try {
      const r = await fetch('/api/loom/compute-targets');
      const j = await parseJsonOrError<{ ok: boolean; computes?: { name: string; kind: string }[] }>(r, 'List compute');
      if (j.ok && Array.isArray(j.computes)) {
        setSparkPools(
          j.computes
            .filter((c) => c.kind === 'synapse-spark')
            .map((c) => ({ name: c.name.replace(/\s*\(Synapse Spark\)\s*$/, '') })),
        );
      } else {
        setSparkPools([]);
      }
    } catch { setSparkPools([]); }
  }, []);

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    loadSettings();
    if (sparkPools === null) loadSparkPools();
  }, [loadSettings, loadSparkPools, sparkPools]);

  const saveSettings = useCallback(async () => {
    if (!activeContainer) return;
    setSettingsBusy(true); setSettingsError(null);
    try {
      const sparkConfig: Record<string, string> = {};
      for (const line of settingsSparkConfText.split(/\r?\n/)) {
        const t = line.trim(); if (!t || t.startsWith('#')) continue;
        const idx = t.indexOf('=');
        if (idx > 0) sparkConfig[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
      }
      const r = await fetch(`/api/lakehouse/settings`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          container: activeContainer,
          displayName: settings.displayName,
          description: settings.description,
          defaultSparkPool: settings.defaultSparkPool,
          sparkConfig,
          timeTravelDays: settings.timeTravelDays ?? 7,
          deltaDefaults: settings.deltaDefaults || { autoOptimize: true },
        }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; settings?: LakehouseSettings }>(r, 'Save settings');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSettings(j.settings || settings);
      setActionStatus(`Lakehouse settings saved at ${new Date().toLocaleTimeString()}`);
      setSettingsOpen(false);
    } catch (e: any) { setSettingsError(e?.message || String(e)); }
    finally { setSettingsBusy(false); }
  }, [activeContainer, settings, settingsSparkConfText]);

  // ---- reference lakehouses: load / mutate / browse / preview ---------
  const loadReferences = useCallback(async () => {
    if (isNewItem) return;
    setRefsLoading(true); setRefsError(null);
    try {
      const r = await fetch(`/api/lakehouse/references?lakehouseId=${encodeURIComponent(id)}`);
      const j = await parseJsonOrError<{
        ok: boolean; error?: string;
        references?: ReferenceLakehouse[];
        workspaceLakehouses?: { id: string; displayName: string }[];
      }>(r, 'Load references');
      if (!j.ok) throw new Error(j.error);
      setReferences(j.references ?? []);
      setWorkspaceLakehouses(j.workspaceLakehouses ?? []);
    } catch (e: any) { setRefsError(e?.message || String(e)); setReferences([]); }
    finally { setRefsLoading(false); }
  }, [id, isNewItem]);

  const addReference = useCallback(async (refId: string) => {
    setRefsError(null);
    try {
      const r = await fetch('/api/lakehouse/references', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: id, addId: refId }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Add reference');
      if (!j.ok) throw new Error(j.error);
      await loadReferences();
    } catch (e: any) { setRefsError(e?.message || String(e)); }
  }, [id, loadReferences]);

  const removeReference = useCallback(async (refId: string) => {
    setRefsError(null);
    try {
      const r = await fetch('/api/lakehouse/references', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: id, removeId: refId }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Remove reference');
      if (!j.ok) throw new Error(j.error);
      if (refSelection?.refId === refId) { setRefSelection(null); setRefPreview(null); }
      await loadReferences();
    } catch (e: any) { setRefsError(e?.message || String(e)); }
  }, [id, loadReferences, refSelection]);

  const refCacheKey = useCallback(
    (refId: string, container: string, prefix: string) => `ref::${refId}::${container}::${prefix}`,
    [],
  );

  const loadRefPaths = useCallback(async (refId: string, container: string, prefix: string) => {
    const key = refCacheKey(refId, container, prefix);
    setRefOpenPrefixes((p) => ({ ...p, [key]: 'loading' }));
    try {
      const qs = new URLSearchParams({ refId, container, prefix });
      const r = await fetch(`/api/lakehouse/references/paths?${qs.toString()}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; paths?: PathEntry[] }>(r, 'Reference paths');
      setRefOpenPrefixes((p) => ({
        ...p,
        [key]: j.ok ? (j.paths ?? []) : { error: j.error || `HTTP ${r.status}` },
      }));
    } catch (e: any) {
      setRefOpenPrefixes((p) => ({ ...p, [key]: { error: e?.message || String(e) } }));
    }
  }, [refCacheKey]);

  // Select a file inside a referenced lakehouse and run a READ-ONLY preview via
  // the account-scoped OPENROWSET route (real Synapse Serverless; pass-through
  // RBAC). Directories just expand in the tree.
  const selectRefFile = useCallback(async (ref: ReferenceLakehouse, container: string, entry: PathEntry) => {
    if (entry.isDirectory) { loadRefPaths(ref.id, container, entry.name); return; }
    setRefSelection({ refId: ref.id, displayName: ref.displayName, account: ref.account, container, entry });
    setRefPreview(null); setRefPreviewLoading(true);
    try {
      const qs = new URLSearchParams({ container, path: entry.name });
      if (ref.account) qs.set('account', ref.account);
      const r = await fetch(`/api/lakehouse/preview?${qs.toString()}`);
      const j = await parseJsonOrError<PreviewResponse>(r, 'Reference preview');
      setRefPreview(j);
    } catch (e: any) {
      setRefPreview({ ok: false, error: e?.message || String(e) });
    } finally { setRefPreviewLoading(false); }
  }, [loadRefPaths]);

  // Load references once on mount (and whenever the item id changes).
  useEffect(() => { loadReferences(); }, [loadReferences]);

  // ---- container load -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    fetch('/api/lakehouse/containers')
      .then((r) => parseJsonOrError<{ ok: boolean; error?: string; containers?: ContainerInfo[] }>(r, 'List containers'))
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) {
          setContainerError(j.error || 'Failed to list containers');
          setContainers([]);
          return;
        }
        setContainers(j.containers || []);
        if ((j.containers || []).length) setActiveContainer(j.containers![0].name);
      })
      .catch((e) => { if (!cancelled) { setContainerError(String(e)); setContainers([]); } });
    return () => { cancelled = true; };
  }, []);

  // ---- listing helpers ------------------------------------------------
  const cacheKey = useCallback((container: string, prefix: string) => `${container}::${prefix}`, []);

  const loadPaths = useCallback(async (container: string, prefix: string) => {
    const key = cacheKey(container, prefix);
    setOpenPrefixes((p) => ({ ...p, [key]: 'loading' }));
    try {
      const qs = new URLSearchParams({ container, prefix });
      const r = await fetch(`/api/lakehouse/paths?${qs.toString()}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; paths?: PathEntry[] }>(r, 'List paths');
      setOpenPrefixes((p) => ({
        ...p,
        [key]: j.ok ? (j.paths as PathEntry[]) : { error: j.error || `HTTP ${r.status}` },
      }));
    } catch (e: any) {
      setOpenPrefixes((p) => ({ ...p, [key]: { error: e?.message || String(e) } }));
    }
  }, [cacheKey]);

  // Auto-load root listing when active container changes.
  useEffect(() => {
    if (!activeContainer) return;
    const key = cacheKey(activeContainer, '');
    if (openPrefixes[key] === undefined) loadPaths(activeContainer, '');
  }, [activeContainer, loadPaths, openPrefixes, cacheKey]);

  const refreshActive = useCallback(() => {
    if (!activeContainer) return;
    const prefix = activePath?.isDirectory ? activePath.name : '';
    loadPaths(activeContainer, prefix);
    loadPaths(activeContainer, '');
  }, [activeContainer, activePath, loadPaths]);

  // ---- selection / preview -------------------------------------------
  const selectFile = useCallback(async (entry: PathEntry) => {
    setActivePath(entry);
    setActionError(null);
    if (entry.isDirectory) {
      // expand directory in tree
      if (activeContainer) loadPaths(activeContainer, entry.name);
      return;
    }
    if (!activeContainer) return;
    // populate SQL tab template
    const bulkUrl = `https://__account__.dfs.core.windows.net/${activeContainer}/${entry.name}`;
    setSqlText(
      `SELECT TOP 100 *\nFROM OPENROWSET(BULK '${bulkUrl}', FORMAT = 'PARQUET') AS r;\n-- Note: the BFF rewrites the host. Use the Preview tab for an authenticated run.`,
    );
    // load preview
    setPreview(null);
    setPreviewLoading(true);
    try {
      const qs = new URLSearchParams({ container: activeContainer, path: entry.name });
      const r = await fetch(`/api/lakehouse/preview?${qs.toString()}`);
      const j = await parseJsonOrError<PreviewResponse>(r, 'Preview');
      setPreview(j);
      if (j.sql) {
        setSqlText(j.sql);
      }
    } catch (e: any) {
      setPreview({ ok: false, error: e?.message || String(e) });
    } finally {
      setPreviewLoading(false);
    }
  }, [activeContainer, loadPaths]);

  // ---- file actions ---------------------------------------------------
  const onUploadClick = useCallback(() => fileInputRef.current?.click(), []);

  /** Open the selected file in a new notebook, prefilled with Spark Delta load + display. */
  const onOpenInNotebook = useCallback((entry: PathEntry) => {
    if (!activeContainer) return;
    const ext = entry.name.split('.').pop()?.toLowerCase();
    const isDelta = ext === 'delta' || entry.name.endsWith('_delta_log');
    const fmt = isDelta ? 'delta' : ext === 'parquet' ? 'parquet'
      : ext === 'csv' ? 'csv' : ext === 'json' ? 'json' : 'parquet';
    const bulk = `abfss://${activeContainer}@__accountname__.dfs.core.windows.net/${entry.name}`;
    const code = [
      `# Auto-generated from Lakehouse — ${activeContainer}/${entry.name}`,
      `df = spark.read.format("${fmt}")${fmt === 'csv' ? '.option("header", "true").option("inferSchema", "true")' : ''}.load("${bulk}")`,
      `display(df.limit(100))`,
      `print(f"Loaded {df.count()} rows from ${bulk}")`,
    ].join('\n');
    // Stash the code in localStorage; the notebook editor reads it on mount.
    try {
      localStorage.setItem('loom.notebook.prefill', JSON.stringify({
        source: 'lakehouse', container: activeContainer, path: entry.name, code,
      }));
    } catch {}
    router.push(`/items/notebook/new?lakehouse=${encodeURIComponent(activeContainer)}&path=${encodeURIComponent(entry.name)}`);
  }, [activeContainer, router]);

  /** Load a file as a Delta table — opens notebook with the conversion code prefilled. */
  const onLoadToTables = useCallback((entry: PathEntry) => {
    if (!activeContainer) return;
    const tableName = leafName(entry.name).replace(/\.[^.]+$/, '').replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
    const ext = entry.name.split('.').pop()?.toLowerCase();
    const fmt = ext === 'parquet' ? 'parquet' : ext === 'csv' ? 'csv' : ext === 'json' ? 'json' : 'parquet';
    const bulk = `abfss://${activeContainer}@__accountname__.dfs.core.windows.net/${entry.name}`;
    const code = [
      `# Load ${entry.name} into Tables/${tableName} as Delta`,
      `df = spark.read.format("${fmt}")${fmt === 'csv' ? '.option("header", "true").option("inferSchema", "true")' : ''}.load("${bulk}")`,
      `df.write.mode("overwrite").format("delta").saveAsTable("${tableName}")`,
      `display(spark.table("${tableName}").limit(100))`,
    ].join('\n');
    try {
      localStorage.setItem('loom.notebook.prefill', JSON.stringify({
        source: 'lakehouse-load-to-tables', container: activeContainer, path: entry.name, tableName, code,
      }));
    } catch {}
    router.push(`/items/notebook/new?lakehouse=${encodeURIComponent(activeContainer)}&loadToTable=${encodeURIComponent(tableName)}`);
  }, [activeContainer, router]);

  const onUploadChange = useCallback(async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file || !activeContainer) return;
    const prefix = activePath?.isDirectory ? activePath.name : '';
    const targetPath = prefix ? `${prefix.replace(/\/+$/, '')}/${file.name}` : file.name;
    setUploading(true);
    setActionError(null);
    setActionStatus(null);
    try {
      const fd = new FormData();
      fd.set('container', activeContainer);
      fd.set('path', targetPath);
      fd.set('file', file);
      const r = await fetch('/api/lakehouse/upload', { method: 'POST', body: fd });
      // Defensive JSON parse — if the gateway / Container App / WAF returns
      // an HTML error page (5xx, 413, 502), JSON.parse blows up with
      // "Unexpected token '<'". Sniff the Content-Type first and only call
      // .json() when the response is actually JSON; otherwise surface the
      // status + a trimmed text body to the user.
      const ct = r.headers.get('content-type') || '';
      let j: any = null;
      let bodyText: string | null = null;
      if (ct.includes('application/json')) {
        try { j = await r.json(); } catch { /* fall through to text */ }
      }
      if (!j) {
        try { bodyText = (await r.text()).slice(0, 240); } catch { /* ignore */ }
      }
      if (!r.ok || j?.ok === false) {
        const msg = j?.error
          || (r.status === 413 ? `File too large (${file.size.toLocaleString()} bytes). Max 4 GB.`
          : r.status === 502 ? `Upstream storage error (502). Check ADLS network/role assignments.`
          : r.status === 401 ? `Sign in expired. Reload and re-authenticate.`
          : `Upload failed (HTTP ${r.status}).${bodyText ? ` Server said: ${bodyText}` : ''}`);
        setActionError(msg);
      } else {
        const fmt = j.sparkFormat;
        const fmtLabel = fmt?.label ? ` — detected ${fmt.label}` : '';
        setActionStatus(`Uploaded ${file.name}${fmtLabel} at ${new Date().toLocaleTimeString()}`);
      }
    } catch (e: any) {
      setActionError(e?.message || String(e));
    } finally {
      setUploading(false);
      refreshActive();
    }
  }, [activeContainer, activePath, refreshActive]);

  const onNewFolder = useCallback(async () => {
    if (!activeContainer) return;
    // eslint-disable-next-line no-alert
    const name = typeof window !== 'undefined' ? window.prompt('New folder name (relative to current path):') : null;
    if (!name) return;
    const prefix = activePath?.isDirectory ? activePath.name : '';
    const targetPath = prefix ? `${prefix.replace(/\/+$/, '')}/${name}` : name;
    setActionError(null);
    setActionStatus(null);
    try {
      const qs = new URLSearchParams({ container: activeContainer, path: targetPath });
      const r = await fetch(`/api/lakehouse/path?${qs.toString()}`, { method: 'POST' });
      const j = await parseJsonOrError<{ ok?: boolean; error?: string }>(r, 'Create folder');
      if (!r.ok || j.ok === false) setActionError(j.error || `Mkdir failed (HTTP ${r.status})`);
      else setActionStatus(`Folder ${targetPath} created at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setActionError(e?.message || String(e));
    } finally {
      refreshActive();
    }
  }, [activeContainer, activePath, refreshActive]);

  const onDelete = useCallback(async (entry: PathEntry) => {
    if (!activeContainer) return;
    // eslint-disable-next-line no-alert
    const ok = typeof window !== 'undefined'
      ? window.confirm(`Delete ${entry.name}${entry.isDirectory ? ' (recursive)' : ''}?`)
      : false;
    if (!ok) return;
    setActionError(null);
    setActionStatus(null);
    try {
      const qs = new URLSearchParams({
        container: activeContainer,
        path: entry.name,
        recursive: entry.isDirectory ? 'true' : 'false',
      });
      const r = await fetch(`/api/lakehouse/path?${qs.toString()}`, { method: 'DELETE' });
      const j = await parseJsonOrError<{ ok?: boolean; error?: string }>(r, 'Delete');
      if (!r.ok || j.ok === false) setActionError(j.error || `Delete failed (HTTP ${r.status})`);
      else setActionStatus(`Deleted ${entry.name} at ${new Date().toLocaleTimeString()}`);
      if (activePath?.name === entry.name) setActivePath(null);
    } catch (e: any) {
      setActionError(e?.message || String(e));
    } finally {
      refreshActive();
    }
  }, [activeContainer, activePath, refreshActive]);

  /** Download a file's bytes via the ADLS passthrough route. */
  const onDownload = useCallback((entry: PathEntry) => {
    if (!activeContainer || entry.isDirectory) return;
    const qs = new URLSearchParams({ container: activeContainer, path: entry.name });
    // Navigate to the download endpoint; Content-Disposition: attachment makes
    // the browser save the file instead of rendering it.
    if (typeof window !== 'undefined') {
      window.open(`/api/lakehouse/download?${qs.toString()}`, '_blank');
    }
  }, [activeContainer]);

  // Properties dialog state — shows the real ADLS metadata already in hand.
  const [propsEntry, setPropsEntry] = useState<PathEntry | null>(null);

  // ---- SQL tab --------------------------------------------------------
  const runSql = useCallback(async () => {
    setSqlLoading(true);
    setSqlResult(null);
    try {
      // The lakehouse's OWN SQL analytics endpoint — Synapse Serverless
      // OPENROWSET over the medallion lake. Previously this POSTed to the
      // synapse-serverless-sql-pool route with a LAKEHOUSE id (wrong item
      // type) which could 404 to an HTML page and crash JSON.parse.
      const r = await fetch(`/api/items/lakehouse/${encodeURIComponent(id)}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText, database: 'master' }),
      });
      const j = await parseJsonOrError<PreviewResponse>(r, 'SQL query');
      setSqlResult(j);
    } catch (e: any) {
      setSqlResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setSqlLoading(false);
    }
  }, [id, sqlText]);

  // ---- current listing for files table -------------------------------
  const currentPrefix = useMemo(
    () => (activePath?.isDirectory ? activePath.name : ''),
    [activePath],
  );
  const currentListing = useMemo(() => {
    if (!activeContainer) return null;
    return openPrefixes[cacheKey(activeContainer, currentPrefix)] ?? null;
  }, [openPrefixes, activeContainer, currentPrefix, cacheKey]);

  // ---- tree renderer --------------------------------------------------
  function renderTreeChildren(container: string, prefix: string): React.ReactElement {
    const state = openPrefixes[cacheKey(container, prefix)];
    if (state === undefined) {
      return (
        <TreeItem itemType="leaf" value={`${container}-${prefix}-unloaded`}
          onClick={() => loadPaths(container, prefix)}>
          <TreeItemLayout>Click to load…</TreeItemLayout>
        </TreeItem>
      );
    }
    if (state === 'loading') {
      return (
        <TreeItem itemType="leaf" value={`${container}-${prefix}-loading`}>
          <TreeItemLayout><Spinner size="tiny" /> Loading…</TreeItemLayout>
        </TreeItem>
      );
    }
    if (!Array.isArray(state)) {
      return (
        <TreeItem itemType="leaf" value={`${container}-${prefix}-err`}>
          <TreeItemLayout>Error: {state.error}</TreeItemLayout>
        </TreeItem>
      );
    }
    if (state.length === 0) {
      return (
        <TreeItem itemType="leaf" value={`${container}-${prefix}-empty`}>
          <TreeItemLayout><Caption1>(empty)</Caption1></TreeItemLayout>
        </TreeItem>
      );
    }
    return (
      <>
        {state.map((entry) => entry.isDirectory ? (
          <TreeItem
            key={`${container}-${entry.name}`}
            itemType="branch"
            value={`${container}-${entry.name}`}
            onClick={() => selectFile(entry)}
            onContextMenu={(e) => openContextMenu(e, entry)}
          >
            <TreeItemLayout iconBefore={<Folder20Regular />}>{leafName(entry.name)}</TreeItemLayout>
            <Tree>{renderTreeChildren(container, entry.name)}</Tree>
          </TreeItem>
        ) : (
          <TreeItem
            key={`${container}-${entry.name}`}
            itemType="leaf"
            value={`${container}-${entry.name}`}
            onClick={() => selectFile(entry)}
            onContextMenu={(e) => openContextMenu(e, entry)}
          >
            <TreeItemLayout iconBefore={<DocumentTable20Regular />}>{leafName(entry.name)}</TreeItemLayout>
          </TreeItem>
        ))}
      </>
    );
  }

  // ---- reference tree renderer (read-only, mirrors renderTreeChildren) -
  function renderRefTreeChildren(ref: ReferenceLakehouse, container: string, prefix: string): React.ReactElement {
    const state = refOpenPrefixes[refCacheKey(ref.id, container, prefix)];
    const base = `ref-${ref.id}-${container}-${prefix}`;
    if (state === undefined) {
      return (
        <TreeItem itemType="leaf" value={`${base}-unloaded`} onClick={() => loadRefPaths(ref.id, container, prefix)}>
          <TreeItemLayout>Click to load…</TreeItemLayout>
        </TreeItem>
      );
    }
    if (state === 'loading') {
      return (
        <TreeItem itemType="leaf" value={`${base}-loading`}>
          <TreeItemLayout><Spinner size="tiny" /> Loading…</TreeItemLayout>
        </TreeItem>
      );
    }
    if (!Array.isArray(state)) {
      return (
        <TreeItem itemType="leaf" value={`${base}-err`}>
          <TreeItemLayout><Caption1>Error: {state.error}</Caption1></TreeItemLayout>
        </TreeItem>
      );
    }
    if (state.length === 0) {
      return (
        <TreeItem itemType="leaf" value={`${base}-empty`}>
          <TreeItemLayout><Caption1>(empty)</Caption1></TreeItemLayout>
        </TreeItem>
      );
    }
    return (
      <>
        {state.map((entry) => entry.isDirectory ? (
          <TreeItem key={`ref-${ref.id}-${entry.name}`} itemType="branch" value={`ref-${ref.id}-${entry.name}`}
            onClick={() => selectRefFile(ref, container, entry)}>
            <TreeItemLayout iconBefore={<Folder20Regular />}>{leafName(entry.name)}</TreeItemLayout>
            <Tree>{renderRefTreeChildren(ref, container, entry.name)}</Tree>
          </TreeItem>
        ) : (
          <TreeItem key={`ref-${ref.id}-${entry.name}`} itemType="leaf" value={`ref-${ref.id}-${entry.name}`}
            onClick={() => selectRefFile(ref, container, entry)}>
            <TreeItemLayout iconBefore={<DocumentTable20Regular />}>{leafName(entry.name)}</TreeItemLayout>
          </TreeItem>
        ))}
      </>
    );
  }

  const canFileAction = !!activeContainer;
  const hasFile = !!activePath && !activePath.isDirectory;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Files', actions: [
        { label: uploading ? 'Uploading…' : 'Upload file', onClick: canFileAction && !uploading ? onUploadClick : undefined, disabled: !canFileAction || uploading },
        { label: 'New folder', onClick: canFileAction ? onNewFolder : undefined, disabled: !canFileAction },
        { label: 'Refresh', onClick: canFileAction ? refreshActive : undefined, disabled: !canFileAction },
      ]},
      { label: 'Query', actions: [
        { label: 'Preview', onClick: hasFile ? () => { if (activePath) { selectFile(activePath); setTab('preview'); } } : undefined, disabled: !hasFile },
        { label: 'Query this file', onClick: hasFile ? () => { if (activePath) { selectFile(activePath); setTab('sql'); } } : undefined, disabled: !hasFile },
      ]},
      { label: 'Manage', actions: [
        { label: 'Permissions', onClick: activeContainer ? openPerms : undefined, disabled: !activeContainer, title: !activeContainer ? 'Select a container first' : undefined },
        { label: 'Settings', onClick: activeContainer ? openSettings : undefined, disabled: !activeContainer, title: !activeContainer ? 'Select a container first' : undefined },
      ]},
    ]},
  ], [canFileAction, uploading, onUploadClick, onNewFolder, refreshActive, hasFile, activePath, selectFile, activeContainer, openPerms, openSettings]);

  // ---- render ---------------------------------------------------------
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          {/* Primary lakehouse — always bold to distinguish it from references. */}
          <Caption1 style={{ display: 'block', padding: '2px 0 6px', fontWeight: tokens.fontWeightBold }}>
            <Database20Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {itemQ.data?.displayName ?? 'Primary lakehouse'}
          </Caption1>
          {containers === null && <Spinner size="tiny" label="Loading containers…" labelPosition="after" />}
          {containerError && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Cannot list containers</MessageBarTitle>
                {containerError}
              </MessageBarBody>
            </MessageBar>
          )}
          {containers && containers.length === 0 && !containerError && (
            <Caption1>No containers visible to BFF identity. Confirm LOOM_*_URL env vars + Storage Blob Data Contributor role.</Caption1>
          )}
          {containers && containers.length > 0 && (
            <Tree aria-label="Lakehouse containers" defaultOpenItems={containers.map((c) => `c-${c.name}`)}>
              {containers.map((c) => (
                <TreeItem
                  key={c.name}
                  itemType="branch"
                  value={`c-${c.name}`}
                  onClick={() => { setActiveContainer(c.name); setActivePath(null); }}
                >
                  <TreeItemLayout iconBefore={<Database20Regular />}>
                    {c.name}{activeContainer === c.name && ' ·'}
                  </TreeItemLayout>
                  <Tree>{renderTreeChildren(c.name, '')}</Tree>
                </TreeItem>
              ))}
            </Tree>
          )}
          {/* Live Delta catalog tree — real ADLS scan of the active container's
              Tables/ dir, grouped by schema, with Delta/non-Delta icons and
              loading / broken / empty badges. Shown once a container is picked. */}
          {activeContainer && (liveTables !== null || liveTablesLoading || liveTablesError) && (
            <Tree aria-label="Live Delta catalog" defaultOpenItems={['live-tables', `live-schema-${activeContainer}`]} style={{ marginTop: 12 }}>
              <TreeItem itemType="branch" value="live-tables">
                <TreeItemLayout
                  iconBefore={<TableSimple20Regular />}
                  aside={liveTablesLoading ? <Spinner size="extra-tiny" /> : (
                    <Button appearance="subtle" size="small" icon={<ArrowSync20Regular />}
                      aria-label="Refresh live tables"
                      onClick={(e) => { e.stopPropagation(); loadLiveTables(); }} />
                  )}
                >
                  Tables (live)
                </TreeItemLayout>
                <Tree>
                  {liveTablesError && (
                    <TreeItem itemType="leaf" value="live-tables-error">
                      <TreeItemLayout iconBefore={<ErrorCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />}>
                        {liveTablesError}
                      </TreeItemLayout>
                    </TreeItem>
                  )}
                  {!liveTablesError && liveTables !== null && liveTables.length === 0 && (
                    <TreeItem itemType="leaf" value="live-tables-empty">
                      <TreeItemLayout iconBefore={<Info20Regular />}>
                        No Delta tables in /{activeContainer}/Tables/ yet
                      </TreeItemLayout>
                    </TreeItem>
                  )}
                  {Object.entries(
                    (liveTables || []).reduce<Record<string, LiveCatalogTable[]>>((acc, t) => {
                      (acc[t.schema] ??= []).push(t); return acc;
                    }, {}),
                  ).map(([schema, schemaTables]) => (
                    <TreeItem key={schema} itemType="branch" value={`live-schema-${schema}`}>
                      <TreeItemLayout iconBefore={<Database20Regular />}>{schema} ({schemaTables.length})</TreeItemLayout>
                      <Tree>
                        {schemaTables.map((t) => (
                          <TreeItem key={t.adlsPath} itemType="leaf" value={`live-tbl-${t.adlsPath}`}
                            title={`${t.format} · ${t.status}${typeof t.latestVersion === 'number' ? ` · v${t.latestVersion}` : ''}`}
                            onClick={() => setTab('tables')}>
                            <TreeItemLayout
                              iconBefore={t.format === 'delta' ? <DocumentTable20Regular /> : <Folder20Regular />}
                              aside={
                                t.status === 'broken'
                                  ? <Badge appearance="tint" color="danger" size="small">broken</Badge>
                                  : t.status === 'empty'
                                  ? <Badge appearance="tint" color="warning" size="small">empty</Badge>
                                  : t.format !== 'delta'
                                  ? <Badge appearance="outline" size="small">{t.format}</Badge>
                                  : null
                              }
                            >
                              {t.name}
                            </TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </TreeItem>
                  ))}
                </Tree>
              </TreeItem>
            </Tree>
          )}
          {hasBundle && (
            <Tree
              aria-label="Planned lakehouse structure from app bundle"
              defaultOpenItems={['bundle', 'bundle-folders', 'bundle-tables', 'bundle-shortcuts']}
              style={{ marginTop: 12 }}
            >
              <TreeItem itemType="branch" value="bundle">
                <TreeItemLayout iconBefore={<Database20Regular />}>Starter structure (app bundle)</TreeItemLayout>
                <Tree>
                  {bundleFolders.length > 0 && (
                    <TreeItem itemType="branch" value="bundle-folders">
                      <TreeItemLayout iconBefore={<Folder20Regular />}>Folders ({bundleFolders.length})</TreeItemLayout>
                      <Tree>
                        {bundleFolders.map((f) => (
                          <TreeItem key={f.path} itemType="leaf" value={`bf-${f.path}`} title={f.description}>
                            <TreeItemLayout iconBefore={<Folder20Regular />}>{f.path}</TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </TreeItem>
                  )}
                  {bundleDeltaTables.length > 0 && (
                    <TreeItem itemType="branch" value="bundle-tables">
                      <TreeItemLayout iconBefore={<TableSimple20Regular />}>Delta tables ({bundleDeltaTables.length})</TreeItemLayout>
                      <Tree>
                        {bundleDeltaTables.map((t) => (
                          <TreeItem
                            key={t.name}
                            itemType="leaf"
                            value={`bt-${t.name}`}
                            onClick={() => setTab('tables')}
                          >
                            <TreeItemLayout iconBefore={<DocumentTable20Regular />}>{t.name}</TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </TreeItem>
                  )}
                  {bundleShortcuts.length > 0 && (
                    <TreeItem itemType="branch" value="bundle-shortcuts">
                      <TreeItemLayout iconBefore={<LinkMultiple20Regular />}>Shortcuts ({bundleShortcuts.length})</TreeItemLayout>
                      <Tree>
                        {bundleShortcuts.map((sc) => (
                          <TreeItem
                            key={sc.name}
                            itemType="leaf"
                            value={`bs-${sc.name}`}
                            title={sc.target}
                            onClick={() => setTab('shortcuts')}
                          >
                            <TreeItemLayout iconBefore={<CloudLink20Regular />}>{sc.name}</TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </TreeItem>
                  )}
                </Tree>
              </TreeItem>
            </Tree>
          )}

          {/* ── Reference lakehouses (F8) ─────────────────────────────── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 14, padding: '4px 0' }}>
            <Caption1 style={{ flex: 1, fontWeight: tokens.fontWeightSemibold }}>
              <LinkMultiple20Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
              References
            </Caption1>
            <Tooltip content={isNewItem ? 'Save the lakehouse first' : 'Add an in-workspace lakehouse to browse side-by-side'} relationship="label">
              <Button appearance="subtle" size="small" icon={<Add20Regular />} disabled={isNewItem}
                onClick={() => { loadReferences(); setPickerOpen(true); }} aria-label="Add reference lakehouse" />
            </Tooltip>
          </div>
          {refsLoading && <Spinner size="tiny" label="Loading references…" labelPosition="after" />}
          {refsError && (
            <MessageBar intent="error"><MessageBarBody>{refsError}</MessageBarBody></MessageBar>
          )}
          {references !== null && references.length === 0 && !refsLoading && (
            <Caption1 style={{ display: 'block', padding: '0 4px', color: tokens.colorNeutralForeground3 }}>
              No references. Click + to browse another lakehouse in this workspace side-by-side.
            </Caption1>
          )}
          {references !== null && references.length > 0 && (
            <Tree aria-label="Reference lakehouses">
              {references.map((ref) => (
                <TreeItem key={ref.id} itemType="branch" value={`refroot-${ref.id}`}>
                  <TreeItemLayout
                    iconBefore={<Database20Regular />}
                    aside={
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Badge appearance="outline" size="small" color="informative">ref</Badge>
                        {!ref.reachable && (
                          <Tooltip relationship="label" content="The Console UAMI cannot reach this lakehouse's containers. Grant it Storage Blob Data Reader on the referenced storage account.">
                            <ErrorCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />
                          </Tooltip>
                        )}
                        <Tooltip relationship="label" content="Remove reference">
                          <Button appearance="subtle" size="small" aria-label={`Remove ${ref.displayName}`}
                            onClick={(e) => { e.stopPropagation(); removeReference(ref.id); }}>×</Button>
                        </Tooltip>
                      </span>
                    }
                  >
                    {ref.displayName}
                  </TreeItemLayout>
                  <Tree>
                    {ref.containers.map((c) => (
                      <TreeItem key={`refc-${ref.id}-${c}`} itemType="branch" value={`refc-${ref.id}-${c}`}
                        onClick={() => loadRefPaths(ref.id, c, '')}>
                        <TreeItemLayout iconBefore={<Database20Regular />}>{c}</TreeItemLayout>
                        <Tree>{renderRefTreeChildren(ref, c, '')}</Tree>
                      </TreeItem>
                    ))}
                  </Tree>
                </TreeItem>
              ))}
            </Tree>
          )}
        </div>
      }
      main={
        <>
          {/* Reference-Lakehouse read-only preview pane (F8). Appears above the
              primary tabs when a file inside a referenced lakehouse is selected.
              Write actions are rendered DISABLED with an explanatory tooltip —
              references are read-only by construction (no write BFF route). */}
          {refSelection && (
            <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: tokens.colorNeutralBackground2 }}>
              <div className={s.toolbar}>
                <Badge appearance="filled" color="informative" icon={<LinkMultiple20Regular />}>Reference · read-only</Badge>
                <Subtitle2>{refSelection.displayName}</Subtitle2>
                <Caption1>· {refSelection.container}/{leafName(refSelection.entry.name)}</Caption1>
                <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                  <Tooltip relationship="label" content="Write actions are disabled on reference lakehouses. Switch to the primary lakehouse to upload files.">
                    <span><Button appearance="primary" icon={<ArrowUpload20Regular />} disabled>Upload</Button></span>
                  </Tooltip>
                  <Tooltip relationship="label" content="Write actions are disabled on reference lakehouses. Switch to the primary lakehouse to create folders.">
                    <span><Button appearance="outline" icon={<FolderAdd20Regular />} disabled>New folder</Button></span>
                  </Tooltip>
                  <Tooltip relationship="label" content="Write actions are disabled on reference lakehouses. Switch to the primary lakehouse to delete files.">
                    <span><Button appearance="outline" icon={<Delete20Regular />} disabled>Delete</Button></span>
                  </Tooltip>
                  <Button appearance="subtle" onClick={() => { setRefSelection(null); setRefPreview(null); }}>Close</Button>
                </div>
              </div>
              {refPreviewLoading && <Spinner size="small" label="Running OPENROWSET…" labelPosition="after" />}
              {!refPreviewLoading && refPreview && !refPreview.ok && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Preview failed</MessageBarTitle>
                    {refPreview.error} {refPreview.code && <Caption1>· {refPreview.code}</Caption1>}
                  </MessageBarBody>
                </MessageBar>
              )}
              {!refPreviewLoading && refPreview?.ok && (refPreview as any).previewable === false && (
                <MessageBar intent="info"><MessageBarBody>{(refPreview as any).message || 'This file type is not previewable in-browser.'}</MessageBarBody></MessageBar>
              )}
              {!refPreviewLoading && refPreview?.ok && (refPreview.columns?.length ?? 0) > 0 && (
                <div className={s.tableWrap}>
                  <Table aria-label="Reference preview rows" size="small">
                    <TableHeader>
                      <TableRow>
                        {(refPreview.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(refPreview.rows || []).map((row, i) => (
                        <TableRow key={i}>
                          {(refPreview.columns || []).map((_, j) => (
                            <TableCell key={j} className={s.cell}>{formatCell((row as unknown[])[j])}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
          <div className={s.tabs}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
              <Tab value="files">Files</Tab>
              <Tab value="tables">Tables</Tab>
              <Tab value="preview">Preview</Tab>
              <Tab value="sql">SQL</Tab>
              <Tab value="shortcuts">Shortcuts</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            {tab === 'files' && (
              <>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="brand">{activeContainer || 'no container'}</Badge>
                  <Caption1>path: <strong>/{currentPrefix || ''}</strong></Caption1>
                  <Button appearance="primary" icon={<ArrowUpload20Regular />} disabled={!activeContainer || uploading} onClick={onUploadClick}>
                    {uploading ? 'Uploading…' : 'Upload file'}
                  </Button>
                  <input ref={fileInputRef} type="file" hidden onChange={onUploadChange} />
                  <Button appearance="outline" icon={<FolderAdd20Regular />} disabled={!activeContainer} onClick={onNewFolder}>
                    New folder
                  </Button>
                  <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={!activeContainer} onClick={refreshActive}>
                    Refresh
                  </Button>
                </div>
                {actionError && (
                  <MessageBar intent="error">
                    <MessageBarBody>{actionError}</MessageBarBody>
                  </MessageBar>
                )}
                {actionStatus && !actionError && (
                  <MessageBar intent="success">
                    <MessageBarBody>{actionStatus}</MessageBarBody>
                  </MessageBar>
                )}
                {currentListing === 'loading' && <Spinner size="small" label="Listing paths…" labelPosition="after" />}
                {currentListing && !Array.isArray(currentListing) && currentListing !== 'loading' && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>List failed</MessageBarTitle>
                      {(currentListing as { error: string }).error}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {Array.isArray(currentListing) && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Lakehouse paths" size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Name</TableHeaderCell>
                          <TableHeaderCell>Size</TableHeaderCell>
                          <TableHeaderCell>Modified</TableHeaderCell>
                          <TableHeaderCell>Actions</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {currentListing.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={4}>
                              <div style={{ padding: 20, textAlign: 'center' }}>
                                <Body1 style={{ display: 'block', marginBottom: 8 }}>
                                  No files in <strong>/{currentPrefix || ''}</strong> yet.
                                </Body1>
                                <Caption1 style={{ display: 'block' }}>
                                  Use the toolbar above to <b>Upload file</b> or create a <b>New folder</b>.
                                  Once you have files, right-click any one for <b>Preview · Query · Open in notebook · Load to Tables · Delete</b>.
                                </Caption1>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                        {currentListing.map((entry) => (
                          <TableRow
                            key={entry.name}
                            className={`${s.rowHover} ${activePath?.name === entry.name ? s.rowSelected : ''}`}
                            onClick={() => selectFile(entry)}
                            onContextMenu={(e) => openContextMenu(e, entry)}
                          >
                            <TableCell>
                              {entry.isDirectory ? <Folder20Regular /> : <DocumentTable20Regular />} {leafName(entry.name)}
                            </TableCell>
                            <TableCell className={s.cell}>{entry.isDirectory ? '—' : formatBytes(entry.size)}</TableCell>
                            <TableCell className={s.cell}>{entry.lastModified?.replace('T', ' ').replace(/\..*/, '') ?? '—'}</TableCell>
                            <TableCell>
                              <Menu>
                                <MenuTrigger disableButtonEnhancement>
                                  <Button appearance="subtle" size="small">…</Button>
                                </MenuTrigger>
                                <MenuPopover>
                                  <MenuList>
                                    {!entry.isDirectory && (
                                      <MenuItem icon={<Eye20Regular />} onClick={() => { selectFile(entry); setTab('preview'); }}>
                                        Preview
                                      </MenuItem>
                                    )}
                                    {!entry.isDirectory && (
                                      <MenuItem icon={<Play20Regular />} onClick={() => { selectFile(entry); setTab('sql'); }}>
                                        Query this file
                                      </MenuItem>
                                    )}
                                    {!entry.isDirectory && (
                                      <MenuItem icon={<BookOpen20Regular />} onClick={() => onOpenInNotebook(entry)}>
                                        Open in notebook
                                      </MenuItem>
                                    )}
                                    {!entry.isDirectory && (
                                      <MenuItem icon={<TableSimple20Regular />} onClick={() => onLoadToTables(entry)}>
                                        Load to Tables (Delta)
                                      </MenuItem>
                                    )}
                                    <MenuItem icon={<Delete20Regular />} onClick={() => onDelete(entry)}>
                                      Delete
                                    </MenuItem>
                                  </MenuList>
                                </MenuPopover>
                              </Menu>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'tables' && (
              <>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="brand">{activeContainer || 'no container'}</Badge>
                  <Caption1>Live Delta catalog — real <code>_delta_log</code> scan of <code>/Tables/</code></Caption1>
                  <Button appearance="outline" icon={<ArrowSync20Regular />}
                    disabled={!activeContainer || liveTablesLoading}
                    onClick={() => loadLiveTables()}>
                    Refresh
                  </Button>
                </div>
                {(() => {
                  if (!activeContainer) return <Caption1>Select a container.</Caption1>;
                  if (liveTablesLoading && liveTables === null) {
                    return <Spinner size="small" label="Scanning Delta catalog…" labelPosition="after" />;
                  }
                  if (liveTablesError) {
                    return (
                      <MessageBar intent="error">
                        <MessageBarBody>
                          <MessageBarTitle>Could not scan tables</MessageBarTitle>
                          {liveTablesError}
                        </MessageBarBody>
                      </MessageBar>
                    );
                  }
                  if (liveTablesGate) {
                    return (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Lakehouse storage not configured</MessageBarTitle>
                          {liveTablesGate}
                        </MessageBarBody>
                      </MessageBar>
                    );
                  }
                  const tables = liveTables ?? [];
                  if (tables.length === 0) {
                    // Honest empty — no fabricated rows. Offer the bundle's planned
                    // tables (if any) as a "what to materialize" reference only.
                    return (
                      <>
                        <MessageBar intent="info">
                          <MessageBarBody>
                            No Delta tables found under <strong>/{activeContainer}/Tables/</strong>. From the
                            Files tab, right-click a Parquet / CSV / JSON file and choose
                            <strong> Load to Tables (Delta)</strong> to materialize one, then Refresh.
                          </MessageBarBody>
                        </MessageBar>
                        {bundleDeltaTables.length > 0 && (
                          <>
                            <Caption1 style={{ display: 'block', marginTop: 12 }}>
                              <strong>Planned tables from the installed app bundle</strong> — run the load/DDL in a
                              notebook against the live lakehouse to materialize these.
                            </Caption1>
                            <div className={s.tableWrap}>
                              <Table aria-label="Planned Delta tables" size="small">
                                <TableHeader>
                                  <TableRow>
                                    <TableHeaderCell>Table</TableHeaderCell>
                                    <TableHeaderCell>DDL</TableHeaderCell>
                                    <TableHeaderCell>Sample rows</TableHeaderCell>
                                    <TableHeaderCell></TableHeaderCell>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {bundleDeltaTables.map((t) => (
                                    <TableRow key={t.name}>
                                      <TableCell><strong>{t.name}</strong></TableCell>
                                      <TableCell><code style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{t.ddl}</code></TableCell>
                                      <TableCell className={s.cell}>{t.sampleRows?.length ?? 0}</TableCell>
                                      <TableCell>
                                        <Button size="small" appearance="primary"
                                          onClick={() => {
                                            setSqlText(`-- Read Delta table (once materialized under Tables/${t.name})\nSELECT TOP 100 *\nFROM OPENROWSET(BULK 'https://__account__.dfs.core.windows.net/${activeContainer || '<container>'}/Tables/${t.name}', FORMAT='DELTA') AS r;`);
                                            setTab('sql');
                                          }}>
                                          Query template
                                        </Button>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          </>
                        )}
                      </>
                    );
                  }
                  // Group by schema (container) for a Fabric-explorer-style layout.
                  const bySchema = tables.reduce<Record<string, LiveCatalogTable[]>>((acc, t) => {
                    (acc[t.schema] ??= []).push(t); return acc;
                  }, {});
                  const statusIcon = (st: LiveCatalogTable['status']) =>
                    st === 'ok' ? <CheckmarkCircle20Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />
                    : st === 'broken' ? <ErrorCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />
                    : <Clock20Regular style={{ color: tokens.colorPaletteYellowForeground1 }} />;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {Object.entries(bySchema).map(([schema, schemaTables]) => (
                        <div key={schema}>
                          <Subtitle2 style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                            <Database20Regular /> {schema} <Caption1>({schemaTables.length})</Caption1>
                          </Subtitle2>
                          <div className={s.tableWrap}>
                            <Table aria-label={`Tables in ${schema}`} size="small">
                              <TableHeader>
                                <TableRow>
                                  <TableHeaderCell>Table</TableHeaderCell>
                                  <TableHeaderCell>Format</TableHeaderCell>
                                  <TableHeaderCell>Status</TableHeaderCell>
                                  <TableHeaderCell>Version</TableHeaderCell>
                                  <TableHeaderCell>Rows</TableHeaderCell>
                                  <TableHeaderCell>Size</TableHeaderCell>
                                  <TableHeaderCell>Modified</TableHeaderCell>
                                  <TableHeaderCell></TableHeaderCell>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {schemaTables.map((t) => (
                                  <TableRow key={t.adlsPath}>
                                    <TableCell>
                                      {t.format === 'delta' ? <DocumentTable20Regular /> : <Folder20Regular />}{' '}
                                      <strong>{t.name}</strong>
                                    </TableCell>
                                    <TableCell>
                                      <Badge appearance={t.format === 'delta' ? 'filled' : 'outline'}
                                        color={t.format === 'delta' ? 'brand' : 'informative'} size="small">
                                        {t.format}
                                      </Badge>
                                    </TableCell>
                                    <TableCell title={t.status}>{statusIcon(t.status)}</TableCell>
                                    <TableCell className={s.cell}>{typeof t.latestVersion === 'number' ? `v${t.latestVersion}` : '—'}</TableCell>
                                    <TableCell className={s.cell}>{typeof t.rowCount === 'number' ? t.rowCount.toLocaleString() : '—'}</TableCell>
                                    <TableCell className={s.cell}>{typeof t.sizeBytes === 'number' ? formatBytes(t.sizeBytes) : '—'}</TableCell>
                                    <TableCell className={s.cell}>{t.lastModified ? new Date(t.lastModified).toLocaleString() : '—'}</TableCell>
                                    <TableCell>
                                      <Button size="small" appearance="primary"
                                        disabled={t.format !== 'delta'}
                                        title={t.format !== 'delta' ? 'OPENROWSET DELTA query available for Delta tables' : undefined}
                                        onClick={() => {
                                          setSqlText(`-- Read Delta table ${t.schema}.${t.name}\nSELECT TOP 100 *\nFROM OPENROWSET(BULK '${t.bulkUrl}', FORMAT='DELTA') AS r;`);
                                          setTab('sql');
                                        }}>
                                        Query
                                      </Button>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </>
            )}

            {tab === 'shortcuts' && (
              <>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="brand">{shortcutLakehouseId || 'no lakehouse'}</Badge>
                  <Caption1>Shortcuts — virtualize external storage into the lakehouse without copying data (zero-copy)</Caption1>
                  <Button appearance="primary" icon={<Add20Regular />} disabled={!shortcutLakehouseId}
                    onClick={() => openShortcutWizard()} style={{ marginLeft: 'auto' }}>
                    New shortcut
                  </Button>
                  <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={!shortcutLakehouseId || shortcutsBusy}
                    onClick={loadShortcuts}>
                    Refresh
                  </Button>
                </div>

                {shortcutsError && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Shortcuts error</MessageBarTitle>{shortcutsError}</MessageBarBody></MessageBar>
                )}
                {shortcutsBusy && shortcuts === null && <Spinner size="small" label="Loading shortcuts…" labelPosition="after" />}

                {shortcuts !== null && shortcuts.length === 0 && !shortcutsBusy && (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>No shortcuts registered yet</MessageBarTitle>
                        Click <strong>New shortcut</strong> to virtualize an ADLS Gen2 path, another
                        Loom lakehouse, S3, GCS, or Dataverse into this lakehouse — without copying data.
                        ADLS Gen2 and internal Loom lakehouse work today on the Console UAMI;
                        external clouds prompt for a Key Vault credential.
                      </MessageBarBody>
                    </MessageBar>
                    {bundleShortcuts.length > 0 && (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                          <Caption1 style={{ display: 'block' }}>
                            <strong>Planned shortcuts from the installed app bundle</strong> — register each into the live backend.
                          </Caption1>
                          <Button size="small" appearance="primary" style={{ marginLeft: 'auto' }}
                            onClick={registerAllBundleShortcuts} disabled={!!regBusy}>
                            {regBusy ? 'Registering…' : 'Register all'}
                          </Button>
                        </div>
                        <div className={s.tableWrap}>
                          <Table aria-label="Planned shortcuts" size="small">
                            <TableHeader>
                              <TableRow>
                                <TableHeaderCell>Name</TableHeaderCell>
                                <TableHeaderCell>Target</TableHeaderCell>
                                <TableHeaderCell>Description</TableHeaderCell>
                                <TableHeaderCell></TableHeaderCell>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {bundleShortcuts.map((sc) => {
                                const live = (shortcuts || []).some((x) => x.name === sc.name);
                                return (
                                  <TableRow key={sc.name}>
                                    <TableCell>
                                      <CloudLink20Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
                                      <strong>{sc.name}</strong>
                                    </TableCell>
                                    <TableCell><code style={{ fontSize: 11 }}>{sc.target}</code></TableCell>
                                    <TableCell>{sc.description || '—'}</TableCell>
                                    <TableCell>
                                      {live ? (
                                        <Badge appearance="tint" color="success">Registered</Badge>
                                      ) : (
                                        <Button size="small" appearance="outline" onClick={() => registerBundleShortcut(sc)} disabled={regBusy === sc.name}>
                                          {regBusy === sc.name ? 'Registering…' : 'Register'}
                                        </Button>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      </>
                    )}
                  </>
                )}

                {shortcuts !== null && shortcuts.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Lakehouse shortcuts" size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Name</TableHeaderCell>
                          <TableHeaderCell>Path</TableHeaderCell>
                          <TableHeaderCell>Source</TableHeaderCell>
                          <TableHeaderCell>Engine</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Actions</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shortcuts.map((sc) => (
                          <TableRow key={sc.id}>
                            <TableCell>
                              <CloudLink20Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
                              <strong>{sc.name}</strong>
                            </TableCell>
                            <TableCell><code style={{ fontSize: 11 }}>{sc.fullPath}</code></TableCell>
                            <TableCell>
                              <Badge appearance="outline" color={sc.targetType === 'adls' || sc.targetType === 'internal' ? 'brand' : 'warning'}>
                                {sc.targetType}
                              </Badge>
                            </TableCell>
                            <TableCell>{sc.engine && sc.engine !== 'none' ? sc.engine : '—'}</TableCell>
                            <TableCell>
                              {sc.status === 'active' && <Badge appearance="tint" color="success" icon={<CheckmarkCircle20Filled />}>active</Badge>}
                              {sc.status === 'pending' && <Badge appearance="tint" color="warning" icon={<Clock20Regular />} title={sc.statusDetail}>pending</Badge>}
                              {sc.status === 'error' && <Badge appearance="tint" color="danger" icon={<ErrorCircle20Filled />} title={sc.statusDetail}>error</Badge>}
                            </TableCell>
                            <TableCell>
                              <Menu>
                                <MenuTrigger disableButtonEnhancement>
                                  <Button appearance="subtle" size="small">…</Button>
                                </MenuTrigger>
                                <MenuPopover>
                                  <MenuList>
                                    {sc.kind === 'tables' && sc.engineObject && (
                                      <MenuItem icon={<Play20Regular />} onClick={() => {
                                        setSqlText(`SELECT TOP 100 * FROM ${sc.engineObject};`);
                                        setTab('sql');
                                      }}>Query (SQL)</MenuItem>
                                    )}
                                    <MenuItem icon={<ArrowSync20Regular />} onClick={() => testShortcut(sc)}>Test</MenuItem>
                                    <MenuItem icon={<Delete20Regular />} onClick={() => deleteShortcutRow(sc)}>Delete</MenuItem>
                                  </MenuList>
                                </MenuPopover>
                              </Menu>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'preview' && (
              <>
                {!activePath && <Caption1>Select a file in the Files tab.</Caption1>}
                {activePath?.isDirectory && <Caption1>{leafName(activePath.name)} is a directory — select a file.</Caption1>}
                {activePath && !activePath.isDirectory && (
                  <>
                    <div className={s.toolbar}>
                      <Subtitle2>{leafName(activePath.name)}</Subtitle2>
                      <Badge appearance="outline">{formatBytes(activePath.size)}</Badge>
                      {preview?.format && <Badge appearance="filled" color="brand">{preview.format}</Badge>}
                      {preview?.executionMs !== undefined && <Caption1>· {preview.executionMs} ms</Caption1>}
                      {preview?.rowCount !== undefined && (
                        <Badge appearance="filled" color="success">{preview.rowCount} rows</Badge>
                      )}
                    </div>
                    {previewLoading && <Spinner size="small" label="Running OPENROWSET…" labelPosition="after" />}
                    {!previewLoading && preview && !preview.ok && (
                      <MessageBar intent="error">
                        <MessageBarBody>
                          <MessageBarTitle>Preview failed</MessageBarTitle>
                          {preview.error} {preview.code && <Caption1>· {preview.code}</Caption1>}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {!previewLoading && preview?.ok && (
                      (preview.columns?.length ?? 0) === 0 ? (
                        <Caption1>Query returned no rows.</Caption1>
                      ) : (
                        <div className={s.tableWrap}>
                          <Table aria-label="Preview rows" size="small">
                            <TableHeader>
                              <TableRow>
                                {(preview.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {(preview.rows || []).map((row, i) => (
                                <TableRow key={i}>
                                  {(preview.columns || []).map((_, j) => (
                                    <TableCell key={j} className={s.cell}>{formatCell((row as unknown[])[j])}</TableCell>
                                  ))}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )
                    )}
                  </>
                )}
              </>
            )}

            {tab === 'sql' && (
              <>
                <div className={s.toolbar}>
                  <Body1>OPENROWSET via Synapse Serverless</Body1>
                  <Button
                    appearance="primary"
                    icon={<Play20Regular />}
                    disabled={sqlLoading}
                    onClick={runSql}
                    style={{ marginLeft: 'auto' }}
                  >
                    Run
                  </Button>
                </div>
                <MonacoTextarea
                  value={sqlText}
                  onChange={setSqlText}
                  language="tsql"
                  height={240}
                  minHeight={180}
                  ariaLabel="OPENROWSET T-SQL editor"
                />
                {sqlLoading && <Spinner size="small" label="Executing…" labelPosition="after" />}
                {!sqlLoading && sqlResult && !sqlResult.ok && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>Query failed</MessageBarTitle>
                      {sqlResult.error} {sqlResult.code && <Caption1>· {sqlResult.code}</Caption1>}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {!sqlLoading && sqlResult?.ok && (
                  <div className={s.tableWrap}>
                    <Table aria-label="SQL results" size="small">
                      <TableHeader>
                        <TableRow>
                          {(sqlResult.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(sqlResult.rows || []).map((row, i) => (
                          <TableRow key={i}>
                            {(sqlResult.columns || []).map((_, j) => (
                              <TableCell key={j} className={s.cell}>{formatCell((row as unknown[])[j])}</TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Fabric-style right-click context menu — anchored at the cursor via
              a virtual positioning target. Every item invokes the same real
              backend as the toolbar / row actions; no dead items. The command
              set differs for files vs folders, mirroring Fabric's explorer. */}
          <Menu
            open={ctxOpen}
            onOpenChange={(_, d) => setCtxOpen(d.open)}
            positioning={{ target: { getBoundingClientRect: () => ({
              x: ctxPos.x, y: ctxPos.y, left: ctxPos.x, top: ctxPos.y,
              right: ctxPos.x, bottom: ctxPos.y, width: 0, height: 0,
              toJSON: () => ({}),
            }) } as any }}
          >
            <MenuTrigger disableButtonEnhancement>
              <span style={{ position: 'fixed', left: ctxPos.x, top: ctxPos.y, width: 0, height: 0 }} />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {ctxEntry && !ctxEntry.isDirectory && (
                  <>
                    <MenuItem icon={<Eye20Regular />} onClick={() => { if (ctxEntry) { selectFile(ctxEntry); setTab('preview'); } setCtxOpen(false); }}>Preview</MenuItem>
                    <MenuItem icon={<Play20Regular />} onClick={() => { if (ctxEntry) { selectFile(ctxEntry); setTab('sql'); } setCtxOpen(false); }}>Query this file</MenuItem>
                    <MenuItem icon={<BookOpen20Regular />} onClick={() => { if (ctxEntry) onOpenInNotebook(ctxEntry); setCtxOpen(false); }}>Open in notebook</MenuItem>
                    <MenuItem icon={<TableSimple20Regular />} onClick={() => { if (ctxEntry) onLoadToTables(ctxEntry); setCtxOpen(false); }}>Load to Tables (Delta)</MenuItem>
                    <MenuItem icon={<ArrowDownload20Regular />} onClick={() => { if (ctxEntry) onDownload(ctxEntry); setCtxOpen(false); }}>Download</MenuItem>
                  </>
                )}
                {ctxEntry && ctxEntry.isDirectory && (
                  <>
                    <MenuItem icon={<Folder20Regular />} onClick={() => { if (ctxEntry && activeContainer) loadPaths(activeContainer, ctxEntry.name); setCtxOpen(false); }}>Open</MenuItem>
                    <MenuItem icon={<LinkMultiple20Regular />} onClick={() => {
                      // Pre-fill section + sub-path from the right-clicked folder, mirroring
                      // the Fabric Explorer "New shortcut…" entry, then open the wizard.
                      const folder = ctxEntry?.name || '';
                      const isTables = /(^|\/)Tables(\/|$)/i.test(folder);
                      const parent = folder.replace(/^Tables\/?|^Files\/?/i, '').replace(/\/+$/, '');
                      setTab('shortcuts');
                      openShortcutWizard(isTables ? 'tables' : 'files', parent);
                      setCtxOpen(false);
                    }}>New shortcut…</MenuItem>
                    <MenuItem icon={<ArrowSync20Regular />} onClick={() => { if (ctxEntry && activeContainer) loadPaths(activeContainer, ctxEntry.name); setCtxOpen(false); }}>Refresh</MenuItem>
                  </>
                )}
                <MenuItem icon={<Info20Regular />} onClick={() => { setPropsEntry(ctxEntry); setCtxOpen(false); }}>Properties</MenuItem>
                <MenuItem icon={<Delete20Regular />} onClick={() => { if (ctxEntry) onDelete(ctxEntry); setCtxOpen(false); }}>Delete</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>

          {/* New shortcut wizard — 3 steps mirroring Fabric (source → connection → name/place). */}
          <Dialog open={scWizardOpen} onOpenChange={(_, d) => setScWizardOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '720px', width: '90vw' }}>
              <DialogBody>
                <DialogTitle>New shortcut — step {scStep} of 3</DialogTitle>
                <DialogContent>
                  {scStep === 1 && (
                    <>
                      <Caption1>Choose the source to virtualize into <strong>{shortcutLakehouseId}</strong>. ADLS Gen2 and internal Loom lakehouse work on the Console UAMI; external clouds need a Key Vault credential.</Caption1>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                        {SHORTCUT_SOURCES.map((src) => (
                          <Button
                            key={src.type}
                            appearance={scType === src.type ? 'primary' : 'outline'}
                            icon={<CloudLink20Regular />}
                            onClick={() => setScType(src.type)}
                            style={{ justifyContent: 'flex-start', height: 'auto', padding: '10px 12px' }}
                          >
                            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                              <span>{src.label}</span>
                              <Badge appearance="tint" color={src.ready ? 'success' : 'warning'} size="small">
                                {src.ready ? 'UAMI-ready' : 'Needs credential'}
                              </Badge>
                            </span>
                          </Button>
                        ))}
                      </div>
                    </>
                  )}

                  {scStep === 2 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {scType === 'internal' && (
                        <>
                          <Field label="Source container (Loom lakehouse)" required>
                            <Dropdown
                              selectedOptions={scInternalContainer ? [scInternalContainer] : []}
                              value={scInternalContainer}
                              placeholder="Select a container"
                              onOptionSelect={(_, d) => setScInternalContainer(d.optionValue || '')}
                            >
                              {(containers || []).map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                            </Dropdown>
                          </Field>
                          <Field label="Source sub-path" hint="Relative to the container root, e.g. silver/partner_products">
                            <Input value={scInternalPath} onChange={(_, d) => setScInternalPath(d.value)} placeholder="folder/subfolder" />
                          </Field>
                        </>
                      )}
                      {scType === 'adls' && (
                        <>
                          <Field label="Source">
                            <div style={{ display: 'flex', gap: 8 }}>
                              <Button size="small" appearance={scAdlsMode === 'picker' ? 'primary' : 'outline'} onClick={() => setScAdlsMode('picker')}>In-tenant account</Button>
                              <Button size="small" appearance={scAdlsMode === 'external' ? 'primary' : 'outline'} onClick={() => setScAdlsMode('external')}>External (URI + SAS/key)</Button>
                            </div>
                          </Field>
                          {scAdlsMode === 'picker' ? (
                            <>
                              <Field label="Storage account" required hint={storageAcctsLoading ? 'Discovering accounts…' : 'ADLS Gen2 / Blob accounts you can access across the tenant'}>
                                <Dropdown
                                  value={scAcctHost ? (storageAccts.find((a) => (a.dfsHost || a.blobHost) === scAcctHost)?.name || scAcctHost) : ''}
                                  selectedOptions={scAcctHost ? [scAcctHost] : []}
                                  placeholder={storageAcctsLoading ? 'Loading…' : 'Select a storage account'}
                                  onOptionSelect={(_, d) => setScAcctHost(d.optionValue || '')}>
                                  {storageAccts.map((a) => {
                                    const host = a.dfsHost || a.blobHost || '';
                                    return <Option key={a.name} value={host} text={a.name}>{a.name}{a.isHns ? ' (ADLS Gen2)' : ' (Blob)'}{a.resourceGroup ? ` · ${a.resourceGroup}` : ''}</Option>;
                                  })}
                                </Dropdown>
                              </Field>
                              <div style={{ display: 'flex', gap: 8 }}>
                                <Field label="Container / filesystem" required style={{ flex: 1 }}>
                                  <Input value={scAdlsContainer} onChange={(_, d) => setScAdlsContainer(d.value)} placeholder="landing" />
                                </Field>
                                <Field label="Path" hint="folder under the container (optional)" style={{ flex: 1 }}>
                                  <Input value={scAdlsPath} onChange={(_, d) => setScAdlsPath(d.value)} placeholder="eventhub-capture" />
                                </Field>
                              </div>
                              {scAcctHost && scAdlsContainer && (
                                <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1 }}>
                                  abfss://{scAdlsContainer}@{scAcctHost}/{scAdlsPath.replace(/^\/+/, '')}
                                </Caption1>
                              )}
                            </>
                          ) : (
                            <>
                              <Field label="Target URI" required
                                hint="abfss://<container>@<account>.dfs.core.windows.net/<path>">
                                <Input value={scTargetUri} onChange={(_, d) => setScTargetUri(d.value)}
                                  placeholder="abfss://data@acct.dfs.core.windows.net/partner/exports" />
                              </Field>
                              <Field label="Key Vault secret (SAS token or storage key)" hint="admin-plane Key Vault secret name holding the external account's SAS/key">
                                <Input value={scKvSecret} onChange={(_, d) => setScKvSecret(d.value)} placeholder="shortcut-ext-adls-sas" />
                              </Field>
                            </>
                          )}
                        </>
                      )}
                      {(scType === 's3' || scType === 'gcs' || scType === 'dataverse') && (
                        <>
                          <MessageBar intent="warning">
                            <MessageBarBody>
                              {scType === 's3' && 'Amazon S3 requires AWS credentials. '}
                              {scType === 'gcs' && 'Google Cloud Storage requires a service-account JSON. '}
                              {scType === 'dataverse' && 'Dataverse reads via its Synapse-Link export storage. '}
                              Store the secret in Key Vault and name it below; create will save the reference and
                              honest-gate the read-through until the credential wiring lands.
                            </MessageBarBody>
                          </MessageBar>
                          <Field label="Target URI" required
                            hint={scType === 's3' ? 's3://<bucket>/<path>' : scType === 'gcs' ? 'gs://<bucket>/<path>' : 'Dataverse export ADLS path'}>
                            <Input value={scTargetUri} onChange={(_, d) => setScTargetUri(d.value)}
                              placeholder={scType === 's3' ? 's3://my-bucket/data' : scType === 'gcs' ? 'gs://my-bucket/data' : 'abfss://dataverse@…'} />
                          </Field>
                          <Field label="Key Vault secret name" hint="The admin-plane Key Vault secret holding the credential.">
                            <Input value={scKvSecret} onChange={(_, d) => setScKvSecret(d.value)} placeholder="shortcut-s3-creds" />
                          </Field>
                        </>
                      )}
                    </div>
                  )}

                  {scStep === 3 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <Field label="Section" required>
                        <Dropdown
                          selectedOptions={[scKind]}
                          value={scKind === 'tables' ? 'Tables' : 'Files'}
                          onOptionSelect={(_, d) => setScKind((d.optionValue as ShortcutKind) || 'files')}
                        >
                          <Option value="files">Files</Option>
                          <Option value="tables">Tables</Option>
                        </Dropdown>
                      </Field>
                      <Field label="Sub-folder" hint="Folder under the section, blank for top-level.">
                        <Input value={scParentPath} onChange={(_, d) => setScParentPath(d.value)} placeholder="optional/subfolder" />
                      </Field>
                      <Field label="Shortcut name" required>
                        <Input value={scName} onChange={(_, d) => setScName(d.value)} placeholder="partner_products" />
                      </Field>
                      {scKind === 'tables' && (
                        <Field label="Format" hint="Tables shortcuts register a real external table on Synapse Serverless or Databricks UC.">
                          <Dropdown selectedOptions={[scFormat]} value={scFormat}
                            onOptionSelect={(_, d) => setScFormat((d.optionValue as typeof scFormat) || 'delta')}>
                            <Option value="delta">Delta</Option>
                            <Option value="parquet">Parquet</Option>
                            <Option value="csv">CSV</Option>
                            <Option value="json">JSON</Option>
                          </Dropdown>
                        </Field>
                      )}
                      <MessageBar intent="info">
                        <MessageBarBody>
                          Will create <strong>{scKind === 'tables' ? 'Tables' : 'Files'}/{[scParentPath.trim(), scName.trim()].filter(Boolean).join('/')}</strong>
                          {' '}pointing at <code>{scType === 'internal' ? `internal://${scInternalContainer}${scInternalPath ? `/${scInternalPath.replace(/^\/+/, '')}` : ''}` : (scTargetUri || '(set the target)')}</code>.
                          {scKind === 'tables' && ' A real external table is registered and queryable from the SQL tab.'}
                        </MessageBarBody>
                      </MessageBar>
                      {scSubmitError && (
                        <MessageBar intent="error"><MessageBarBody>{scSubmitError}</MessageBarBody></MessageBar>
                      )}
                    </div>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setScWizardOpen(false)} disabled={scSubmitting}>Cancel</Button>
                  {scStep > 1 && <Button appearance="outline" onClick={() => setScStep((scStep - 1) as 1 | 2 | 3)} disabled={scSubmitting}>Back</Button>}
                  {scStep < 3 && <Button appearance="primary" onClick={() => setScStep((scStep + 1) as 1 | 2 | 3)}>Next</Button>}
                  {scStep === 3 && (
                    <Button appearance="primary" onClick={submitShortcut} disabled={scSubmitting || !scName.trim()}>
                      {scSubmitting ? 'Creating…' : 'Create'}
                    </Button>
                  )}
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Add-reference picker (F8) — lists in-workspace lakehouses not yet referenced. */}
          <Dialog open={pickerOpen} onOpenChange={(_, d) => setPickerOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 560 }}>
              <DialogBody>
                <DialogTitle>Add reference lakehouse</DialogTitle>
                <DialogContent>
                  <Caption1>
                    Browse another lakehouse from this workspace side-by-side. Read actions use pass-through
                    RBAC — the Console UAMI must hold <strong>Storage Blob Data Reader</strong> on the referenced
                    containers. Write actions stay disabled on references.
                  </Caption1>
                  {refsError && (
                    <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{refsError}</MessageBarBody></MessageBar>
                  )}
                  {(() => {
                    const referenced = new Set((references ?? []).map((r) => r.id));
                    const addable = workspaceLakehouses.filter((lh) => lh.id !== id && !referenced.has(lh.id));
                    return (
                      <Table size="small" style={{ marginTop: 12 }} aria-label="Workspace lakehouses">
                        <TableHeader>
                          <TableRow>
                            <TableHeaderCell>Lakehouse</TableHeaderCell>
                            <TableHeaderCell></TableHeaderCell>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {addable.map((lh) => (
                            <TableRow key={lh.id}>
                              <TableCell>
                                <Database20Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
                                {lh.displayName}
                              </TableCell>
                              <TableCell>
                                <Button size="small" appearance="primary"
                                  onClick={() => { addReference(lh.id); setPickerOpen(false); }}>
                                  Add
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                          {addable.length === 0 && (
                            <TableRow>
                              <TableCell colSpan={2}>
                                <Caption1>No other lakehouses in this workspace, or all are already referenced.</Caption1>
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    );
                  })()}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setPickerOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Properties dialog — real ADLS metadata already in hand. */}
          <Dialog open={!!propsEntry} onOpenChange={(_, d) => { if (!d.open) setPropsEntry(null); }}>
            <DialogSurface style={{ maxWidth: 560 }}>
              <DialogBody>
                <DialogTitle>Properties — {propsEntry ? leafName(propsEntry.name) : ''}</DialogTitle>
                <DialogContent>
                  {propsEntry && (
                    <Table size="small">
                      <TableBody>
                        <TableRow><TableCell><strong>Name</strong></TableCell><TableCell className={s.cell}>{leafName(propsEntry.name)}</TableCell></TableRow>
                        <TableRow><TableCell><strong>Path</strong></TableCell><TableCell className={s.cell}>/{propsEntry.name}</TableCell></TableRow>
                        <TableRow><TableCell><strong>Container</strong></TableCell><TableCell className={s.cell}>{activeContainer}</TableCell></TableRow>
                        <TableRow><TableCell><strong>Type</strong></TableCell><TableCell>{propsEntry.isDirectory ? 'Directory' : 'File'}</TableCell></TableRow>
                        {!propsEntry.isDirectory && <TableRow><TableCell><strong>Size</strong></TableCell><TableCell className={s.cell}>{formatBytes(propsEntry.size)}</TableCell></TableRow>}
                        <TableRow><TableCell><strong>Last modified</strong></TableCell><TableCell className={s.cell}>{propsEntry.lastModified ? new Date(propsEntry.lastModified).toLocaleString() : '—'}</TableCell></TableRow>
                        {propsEntry.etag && <TableRow><TableCell><strong>ETag</strong></TableCell><TableCell className={s.cell}>{propsEntry.etag}</TableCell></TableRow>}
                      </TableBody>
                    </Table>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setPropsEntry(null)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={permsOpen} onOpenChange={(_, d) => setPermsOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '880px', width: '90vw' }}>
              <DialogBody>
                <DialogTitle>Permissions — {activeContainer}</DialogTitle>
                <DialogContent>
                  <Caption1>
                    Azure RBAC role assignments scoped to the container. Storage Blob Data
                    Reader/Contributor/Owner govern data-plane access (read/write/manage).
                  </Caption1>
                  {permsBusy && <Spinner size="tiny" label="Calling ARM…" labelPosition="after" />}
                  {permsError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>RBAC error</MessageBarTitle>{permsError}</MessageBarBody></MessageBar>
                  )}
                  <div style={{ overflow: 'auto', margin: '8px 0 12px' }}>
                    <Table aria-label="Role assignments" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Principal id</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Role</TableHeaderCell>
                        <TableHeaderCell>Action</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {permsRows.length === 0 && (
                          <TableRow><TableCell colSpan={4}><Caption1>No Storage Blob Data role assignments at the container scope.</Caption1></TableCell></TableRow>
                        )}
                        {permsRows.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell><code style={{ fontSize: 11 }}>{r.principalId?.slice(0, 8)}…</code></TableCell>
                            <TableCell>{r.principalType || '—'}</TableCell>
                            <TableCell>{r.roleName || '—'}</TableCell>
                            <TableCell><Button size="small" appearance="subtle" disabled={permsBusy} onClick={() => revokePerm(r.id)}>Revoke</Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <Subtitle2>Grant access</Subtitle2>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr', gap: 12, marginTop: 8 }}>
                    <Field label="Principal object id" required>
                      <Input value={newPrincipalId} onChange={(_, d) => setNewPrincipalId(d.value)} placeholder="11111111-2222-3333-4444-555555555555" />
                    </Field>
                    <Field label="Principal type">
                      <Dropdown
                        selectedOptions={[newPrincipalType]}
                        value={newPrincipalType}
                        onOptionSelect={(_, d) => setNewPrincipalType((d.optionValue as 'User' | 'Group' | 'ServicePrincipal') || 'User')}
                      >
                        <Option value="User">User</Option>
                        <Option value="Group">Group</Option>
                        <Option value="ServicePrincipal">ServicePrincipal</Option>
                      </Dropdown>
                    </Field>
                    <Field label="Role">
                      <Dropdown
                        selectedOptions={[newRole]}
                        value={newRole}
                        onOptionSelect={(_, d) => setNewRole(d.optionValue || newRole)}
                      >
                        {permsRoles.map((r) => (
                          <Option key={r.name} value={r.name}>{r.name}</Option>
                        ))}
                      </Dropdown>
                    </Field>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setPermsOpen(false)} disabled={permsBusy}>Close</Button>
                  <Button appearance="primary" onClick={grantPerm} disabled={permsBusy || !newPrincipalId.trim()}>
                    {permsBusy ? 'Working…' : 'Grant'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={settingsOpen} onOpenChange={(_, d) => setSettingsOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '720px', width: '90vw' }}>
              <DialogBody>
                <DialogTitle>Lakehouse settings — {activeContainer}</DialogTitle>
                <DialogContent>
                  {settingsBusy && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
                  {settingsError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Settings error</MessageBarTitle>{settingsError}</MessageBarBody></MessageBar>
                  )}
                  <Field label="Display name (override)">
                    <Input value={settings.displayName || ''} onChange={(_, d) => setSettings((s) => ({ ...s, displayName: d.value }))} />
                  </Field>
                  <Field label="Description">
                    <Textarea value={settings.description || ''} onChange={(_, d) => setSettings((s) => ({ ...s, description: d.value }))} />
                  </Field>
                  <Field
                    label="Default Spark pool (Synapse)"
                    hint={sparkPools !== null && sparkPools.length === 0
                      ? 'No Synapse Spark pools discovered. Provision a pool in the Synapse workspace (LOOM_SYNAPSE_WORKSPACE) to populate this list.'
                      : 'Notebooks attached to this lakehouse default to this pool.'}
                  >
                    {sparkPools === null ? (
                      <Spinner size="tiny" label="Loading pools…" labelPosition="after" />
                    ) : (
                      <Dropdown
                        selectedOptions={settings.defaultSparkPool ? [settings.defaultSparkPool] : []}
                        value={settings.defaultSparkPool || ''}
                        placeholder={sparkPools.length === 0 ? 'No Spark pools deployed' : 'Select a Spark pool'}
                        disabled={sparkPools.length === 0}
                        onOptionSelect={(_, d) => setSettings((s) => ({ ...s, defaultSparkPool: d.optionValue || '' }))}
                      >
                        {sparkPools.map((p) => (
                          <Option key={p.name} value={p.name}>{p.name}</Option>
                        ))}
                      </Dropdown>
                    )}
                  </Field>
                  <Field label="Time-travel retention (days)">
                    <Input type="number" min={0} value={String(settings.timeTravelDays ?? 7)} onChange={(_, d) => setSettings((s) => ({ ...s, timeTravelDays: Math.max(0, Number(d.value) || 0) }))} />
                  </Field>
                  <Field label="Delta auto-optimize default">
                    <Switch
                      checked={settings.deltaDefaults?.autoOptimize ?? true}
                      onChange={(_, d) => setSettings((s) => ({ ...s, deltaDefaults: { ...(s.deltaDefaults || {}), autoOptimize: d.checked } }))}
                      label={settings.deltaDefaults?.autoOptimize ?? true ? 'Enabled' : 'Disabled'}
                    />
                  </Field>
                  <Field label="Spark conf (one KEY=VALUE per line)">
                    <Textarea
                      rows={6}
                      value={settingsSparkConfText}
                      onChange={(_, d) => setSettingsSparkConfText(d.value)}
                      placeholder="spark.sql.shuffle.partitions=200"
                    />
                  </Field>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setSettingsOpen(false)} disabled={settingsBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={saveSettings} disabled={settingsBusy}>
                    {settingsBusy ? 'Saving…' : 'Save settings'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </>
      }
    />
  );
}
