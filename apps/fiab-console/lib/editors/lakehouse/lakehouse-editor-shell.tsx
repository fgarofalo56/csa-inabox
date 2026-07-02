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
 *
 * Extracted verbatim from lakehouse-editor.tsx (behavior-preserving split —
 * zero logic change). Shared types/helpers/useStyles live in ./shared.
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
  Input, Field, Switch, Dropdown, Option, Textarea, Checkbox, Tooltip,
  Toaster, Toast, ToastTitle, useToastController, useId, Link,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, ArrowUpload20Regular, Database20Regular, Delete20Regular,
  DocumentTable20Regular, Eye20Regular, Folder20Regular, FolderAdd20Regular, Play20Regular,
  BookOpen20Regular, TableSimple20Regular,
  ArrowDownload20Regular, Info20Regular, LinkMultiple20Regular,
  Add20Regular, CloudLink20Regular, CheckmarkCircle20Filled, ErrorCircle20Filled, Clock20Regular,
  FolderArrowUp20Regular, ShieldTask20Regular,
  Wrench20Regular,
  History20Regular,
  CloudArrowUp20Regular,
  Copy20Regular,
  Sparkle20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { OpenInPbiDesktopButton } from '../components/open-in-pbi-desktop-button';
import { EmptyState } from '@/lib/components/empty-state';
import { DeltaMaintenanceDialog } from '../components/delta-maintenance-dialog';
import { TierDialog, type BlobAccessTier } from '@/lib/components/onelake/tier-dialog';
import { parseDdlColumns } from '@/lib/azure/delta-maintenance';
import { sparkConfigWarnings, cloudFabricNote } from '../lakehouse-spark-conf';
import { LoadToTableWizard } from '../components/load-to-table-wizard';
import { OneLakeSecurityTab } from '../components/onelake-security-tab';
import {
  SHORTCUT_SOURCE_CARDS, ShortcutSourceLogo, ExternalCredsForm, RemoteBrowseTree, SharePointBrowser,
  type ExternalCredsState, type CredSourceType, type SharePointSelection,
} from '@/lib/components/onelake/shortcut-wizard';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { OnelakeRlsPredicateEditor } from '@/lib/panes/onelake-security-tab';
import { useJobsStore } from '@/lib/state/jobs-store';
import { DeltaPreviewGrid, type ColStat } from '../components/delta-preview-grid';
import {
  useStyles, formatBytes, leafName, collectEntries, formatCell, parseJsonOrError,
} from './shared';
import type {
  ContainerInfo, PathEntry, ReferenceLakehouse, RefSelection, PreviewResponse,
  HistoryRow, UploadItem, MipLabelOption,
} from './shared';

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
  // F3 — Fluent DataGrid preview: File/Table mode toggle + async column stats.
  const [previewMode, setPreviewMode] = useState<'file' | 'table'>('file');
  const [columnStats, setColumnStats] = useState<Record<string, ColStat> | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsJobId, setStatsJobId] = useState<string | null>(null);
  // The container+path the stats job is for — passed on every poll so the BFF
  // can (re)submit the Spark statement statelessly once the pool warms.
  const statsTargetRef = useRef<{ container: string; path: string } | null>(null);
  // Deep-link restore target captured on first mount (?tab=preview&container=&path=).
  const deepLinkRef = useRef<{ container: string; path: string } | null>(null);
  const [sqlText, setSqlText] = useState<string>(
    `-- Select a file in the Files tab and click "Query this file"\n-- to populate this editor with a Synapse Serverless OPENROWSET.`,
  );
  const [sqlResult, setSqlResult] = useState<PreviewResponse | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  // ---- History tab (Delta time travel) --------------------------------
  const [historyTable, setHistoryTable] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryRow[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRestoring, setHistoryRestoring] = useState<number | null>(null);
  const [historyRestoreMsg, setHistoryRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [historyPreviewVersion, setHistoryPreviewVersion] = useState<number | null>(null);
  const [historyPreviewResult, setHistoryPreviewResult] = useState<PreviewResponse | null>(null);
  const [historyPreviewLoading, setHistoryPreviewLoading] = useState(false);
  // F10 — upload jobs live in the module-scope jobs-store so they survive item
  // tab switches (component unmount). `uploading` is DERIVED from the store's
  // running jobs for the active container, not local state — subscribing to
  // `jobs` keeps the ribbon/badge live across navigations.
  const jobs = useJobsStore((st) => st.jobs);
  const startUpload = useJobsStore((st) => st.startUpload);
  const recordLoadToTable = useJobsStore((st) => st.recordLoadToTable);
  const runningUploads = activeContainer
    ? jobs.filter((j) => j.kind === 'upload' && j.status === 'running' && j.container === activeContainer)
    : [];
  const [actionError, setActionError] = useState<string | null>(null);
  // Phase 4.5 — positive feedback for upload / mkdir / delete so the user
  // can tell the operation actually hit ADLS. Mirrors the "Saved at HH:MM:SS"
  // pattern used by the document editors (notebook, pipeline, dataflow, etc.).
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Folder drag-and-drop + batch upload progress (F5).
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<{ done: number; total: number } | null>(null);
  // `uploading` is DERIVED — true while the jobs-store has a running upload for
  // the active container (F10 background single-file upload) OR while the inline
  // batch uploader (F5 folder drag-and-drop) is draining its queue.
  const uploading = runningUploads.length > 0 || uploadQueue !== null;

  // MIP sensitivity-label-on-download (F5). `mipStatus` is the x-loom-mip-status
  // header echoed by /api/lakehouse/download; the UI maps it to a MessageBar.
  const [mipStatus, setMipStatus] = useState<string | null>(null);
  const [mipLabelName, setMipLabelName] = useState<string | null>(null);
  // "Download with sensitivity label" picker dialog.
  const [labelDlgOpen, setLabelDlgOpen] = useState(false);
  const [labelDlgEntry, setLabelDlgEntry] = useState<PathEntry | null>(null);
  const [mipLabels, setMipLabels] = useState<MipLabelOption[] | null>(null);
  const [mipLabelsLoading, setMipLabelsLoading] = useState(false);
  const [mipLabelsError, setMipLabelsError] = useState<string | null>(null);
  const [chosenLabelId, setChosenLabelId] = useState<string>('');

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
  interface PermAssignment { id: string; principalId: string; principalType?: string; roleName?: string; upn?: string }
  interface PermRole { name: string; id: string }
  const [permsOpen, setPermsOpen] = useState(false);
  const [permsRows, setPermsRows] = useState<PermAssignment[]>([]);
  const [permsRoles, setPermsRoles] = useState<PermRole[]>([]);
  const [permsBusy, setPermsBusy] = useState(false);
  const [permsError, setPermsError] = useState<string | null>(null);
  const [newPrincipalId, setNewPrincipalId] = useState('');
  const [newPrincipalType, setNewPrincipalType] = useState<'User' | 'Group' | 'ServicePrincipal'>('User');
  const [newRole, setNewRole] = useState('Storage Blob Data Reader');

  // ---- SQL-plane permissions (Table / Column / Row tabs) ----
  // Real Synapse Dedicated SQL pool GRANT SELECT + CREATE SECURITY POLICY —
  // Azure-native, no Fabric dependency. Principals resolve to UPN (the SQL
  // users are CREATE USER … FROM EXTERNAL PROVIDER).
  type PermsTab = 'object' | 'table' | 'column' | 'row';
  const [permsTab, setPermsTab] = useState<PermsTab>('object');
  const [sqlGate, setSqlGate] = useState<{ missing: string; hint: string } | null>(null);
  interface SqlGrant { principal: string; principalType: string; schema: string; table: string; column: string | null; permissionName: string }
  const [sqlGrants, setSqlGrants] = useState<SqlGrant[]>([]);
  interface SqlTableRef { objectId: number; schema: string; name: string; type: string }
  const [sqlTables, setSqlTables] = useState<SqlTableRef[]>([]);
  const [selTableId, setSelTableId] = useState<number | null>(null);
  interface SqlColRef { columnId: number; name: string; dataType: string }
  const [sqlCols, setSqlCols] = useState<SqlColRef[]>([]);
  const [selColIds, setSelColIds] = useState<number[]>([]);
  interface RlsPolicy { policyObjectId: number; policySchema: string; policyName: string; schema: string; table: string; isEnabled: boolean; functionSchema: string; functionName: string }
  const [rlsPolicies, setRlsPolicies] = useState<RlsPolicy[]>([]);
  const [rlsFilterColId, setRlsFilterColId] = useState<number | null>(null);
  const [rlsSubject, setRlsSubject] = useState<'USER_NAME()' | 'SUSER_SNAME()'>('USER_NAME()');
  // Principal picker (Entra user search → UPN) for the SQL-plane tabs.
  interface ResolvedPrincipal { id: string; displayName: string; upn: string }
  const [principalQuery, setPrincipalQuery] = useState('');
  const [principalResults, setPrincipalResults] = useState<ResolvedPrincipal[]>([]);
  const [selectedPrincipal, setSelectedPrincipal] = useState<ResolvedPrincipal | null>(null);
  const [principalBusy, setPrincipalBusy] = useState(false);

  // Settings dialog state — Loom-side lakehouse defaults persisted in
  // Cosmos `tenant-settings`, consumed by Notebook + Preview editors.
  interface LakehouseSettings {
    displayName?: string; description?: string; defaultSparkPool?: string;
    sparkConfig?: Record<string, string>;
    timeTravelDays?: number;
    deltaDefaults?: { autoOptimize?: boolean; tableProperties?: Record<string, string> };
    schemasEnabled?: boolean;
    liquidClustering?: { tableName: string; columns: string[] };
    icebergExpose?: { enabled: boolean; tableName: string; schemaName?: string };
    fabricToggles?: { vorder: boolean; autotune: boolean; nativeExecution: boolean };
  }
  interface IcebergEndpoint {
    abfss: string;
    httpsTablePath: string;
    httpsMetadataFolder: string;
    azureMetadataFolder: string;
    format: 'iceberg-v2';
    via: 'delta-uniform';
  }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<LakehouseSettings>({});
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSparkConfText, setSettingsSparkConfText] = useState('');
  // Liquid-clustering form state (Fabric F12 parity → real ALTER TABLE … CLUSTER BY)
  const [lcTableName, setLcTableName] = useState('');
  const [lcColumns, setLcColumns] = useState('');          // comma-separated input
  const [lcApplied, setLcApplied] = useState<boolean | null>(null);
  const [lcSql, setLcSql] = useState<string | null>(null);
  const [lcGate, setLcGate] = useState<string | null>(null);
  const [lcError, setLcError] = useState<string | null>(null);
  // Expose-as-Iceberg form state (Fabric OneLake "Iceberg V2 endpoint" parity →
  // real Delta Lake UniForm ALTER TABLE on the Azure-native path).
  const [icebergEnabled, setIcebergEnabled] = useState(false);
  const [icebergTable, setIcebergTable] = useState('');
  const [icebergSchema, setIcebergSchema] = useState('');     // when schemas enabled
  const [icebergEndpoint, setIcebergEndpoint] = useState<IcebergEndpoint | null>(null);
  const [icebergApplied, setIcebergApplied] = useState<boolean | null>(null);
  const [icebergSql, setIcebergSql] = useState<string | null>(null);
  const [icebergGate, setIcebergGate] = useState<string | null>(null);
  const [icebergError, setIcebergError] = useState<string | null>(null);
  // Cloud boundary (commercial | gcc | gcch | il5) — drives honest per-cloud
  // disclosures for the Fabric-only acceleration gates.
  const [cloud, setCloud] = useState<'commercial' | 'gcc' | 'gcch' | 'il5'>('commercial');
  // Real deployed Synapse Spark pools — bind the "Default Spark pool" field to
  // an enumerated picker (no freeform compute input) per the UI-parity rule.
  const [sparkPools, setSparkPools] = useState<{ name: string }[] | null>(null);

  // ---- Delta maintenance dialog (OPTIMIZE / VACUUM / ZORDER BY) ----
  const [maintainOpen, setMaintainOpen] = useState(false);
  const [maintainTable, setMaintainTable] = useState('');

  // ---- Add-to-data-agent dialog (Fabric "Add to AI skill / data agent") ----
  // Lists the caller's real data-agent items, lets them pick one (or jump to
  // create a new one), then PATCHes its sources to add THIS lakehouse as a
  // grounded source — real Cosmos-backed routes, no mock.
  interface DaAgentRow { id: string; displayName: string; state?: { sources?: unknown[] } }
  const [daOpen, setDaOpen] = useState(false);
  const [daAgents, setDaAgents] = useState<DaAgentRow[] | null>(null);
  const [daLoadErr, setDaLoadErr] = useState<string | null>(null);
  const [daSel, setDaSel] = useState<string>('');
  const [daBusy, setDaBusy] = useState(false);
  const [daMsg, setDaMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  // Resolve ZORDER candidate columns from the installed bundle's DDL (available
  // even before the live ADLS schema is read). Falls back to [] when unknown.
  const maintainColumns = useMemo(() => {
    const def = bundleDeltaTables.find((t) => t.name === maintainTable || leafName(t.name) === maintainTable);
    return def?.ddl ? parseDdlColumns(def.ddl) : [];
  }, [bundleDeltaTables, maintainTable]);

  // F10 — human-readable lakehouse name for background-job toasts + a11y labels.
  // Priority: WorkspaceItem.displayName (Cosmos) > LakehouseSettings.displayName
  // (Settings dialog) > active medallion container key > item id. Computed every
  // render so the toast names the lakehouse the user is actually looking at.
  const lakehouseName: string =
    (itemQ.data?.displayName)
    || (settings.displayName)
    || activeContainer
    || id;

  // Share dialog state — Azure RBAC role assignment at the container scope.
  // Mirrors Fabric's "Share" affordance (Loom-native, no Fabric workspace).
  // Reuses the existing /api/lakehouse/permissions POST route.
  const [shareOpen, setShareOpen] = useState(false);
  const [sharePrincipal, setSharePrincipal] = useState('');
  const [sharePrincipalType, setSharePrincipalType] = useState<'User' | 'Group' | 'ServicePrincipal'>('User');
  const [shareRole, setShareRole] = useState('Storage Blob Data Reader');
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareSuccess, setShareSuccess] = useState<string | null>(null);

  // Semantic model honest-gate dialog. DirectLake (Fabric) has no Azure-native
  // 1:1 (it needs a Fabric/Power BI capacity); the dialog documents the
  // Azure-native equivalent path instead of pretending to provision one.
  const [semanticModelGateOpen, setSemanticModelGateOpen] = useState(false);

  // Reference-lakehouse flag — when this lakehouse was attached as a secondary
  // read-only source ("Add lakehouses" in the Explorer sidebar), write
  // operations (Get data, Settings, Refresh) gray out, matching Fabric.
  const isReferenceLakehouse = (itemQ.data?.state as any)?.isReference === true;

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

  // Load to Table (F6) wizard state + toast.
  const lttToasterId = useId('ltt-toaster');
  const { dispatchToast } = useToastController(lttToasterId);
  const [lttOpen, setLttOpen] = useState(false);
  const [lttEntry, setLttEntry] = useState<PathEntry | null>(null);

  // Storage-tier (Hot/Cool/Cold) dialog state + per-file tier cache.
  const [tierDlgOpen, setTierDlgOpen] = useState(false);
  const [tierDlgEntry, setTierDlgEntry] = useState<PathEntry | null>(null);
  // key = `${container}::${path}`, value = tier string ('Hot' | 'Cool' | 'Cold' | 'Archive')
  const [fileTiers, setFileTiers] = useState<Record<string, string>>({});

  const openContextMenu = useCallback((e: React.MouseEvent, entry: PathEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxEntry(entry);
    setCtxPos({ x: e.clientX, y: e.clientY });
    setCtxOpen(true);
  }, []);

  const openTierDialog = useCallback((entry: PathEntry) => {
    setTierDlgEntry(entry);
    setTierDlgOpen(true);
  }, []);

  const onTierChanged = useCallback((entry: PathEntry, newTier: BlobAccessTier) => {
    if (!activeContainer) return;
    const key = `${activeContainer}::${entry.name}`;
    setFileTiers((prev) => ({ ...prev, [key]: newTier }));
  }, [activeContainer]);

  // ---- Shortcuts tab (Azure-native, NO Fabric dependency) ----
  // A shortcut is a named, zero-copy pointer that surfaces external data as a
  // folder under Files or a table under Tables. ADLS Gen2 + internal Loom
  // lakehouse resolve on the Console UAMI; Tables register a real external table
  // (Synapse Serverless preferred, Databricks UC otherwise). S3/GCS/Dataverse
  // render the create form and honest-gate on submit. Registry is the Cosmos
  // `lakehouse-shortcuts` container. See docs/fiab/design/lakehouse-shortcuts.md.
  type ShortcutTargetType = 'adls' | 'internal' | 's3' | 'gcs' | 'dataverse' | 'delta_sharing' | 'sharepoint';
  type ShortcutKind = 'files' | 'tables';
  interface ShortcutRow {
    id: string; lakehouseId: string; name: string; kind: ShortcutKind;
    parentPath: string; fullPath: string; targetType: ShortcutTargetType;
    targetUri: string; abfssUri?: string; engine?: 'synapse' | 'databricks' | 'none';
    engineObject?: string; format?: string; status: 'active' | 'pending' | 'error';
    statusDetail?: string; createdBy: string; createdAt: string;
  }
  // In-tenant ADLS/Blob account picker (vs typing the abfss URI) + external SAS.
  const [scAdlsMode, setScAdlsMode] = useState<'picker' | 'external'>('picker');
  const [storageAccts, setStorageAccts] = useState<Array<{ name: string; dfsHost?: string; blobHost?: string; isHns: boolean; resourceGroup?: string }>>([]);
  const [storageAcctsLoading, setStorageAcctsLoading] = useState(false);
  const [scAcctHost, setScAcctHost] = useState(''); // selected dfs/blob host
  const [scAdlsContainer, setScAdlsContainer] = useState('');
  const [scAdlsPath, setScAdlsPath] = useState('');
  const [shortcuts, setShortcuts] = useState<ShortcutRow[] | null>(null);
  const [shortcutsBusy, setShortcutsBusy] = useState(false);
  // Selected row drives the F11 "Retry selected broken shortcut" keybinding.
  const [selectedShortcut, setSelectedShortcut] = useState<ShortcutRow | null>(null);
  const [shortcutsError, setShortcutsError] = useState<string | null>(null);
  const [scWizardOpen, setScWizardOpen] = useState(false);
  const [scStep, setScStep] = useState<1 | 2 | 3>(1);
  const [scType, setScType] = useState<ShortcutTargetType>('internal');
  const [scTargetUri, setScTargetUri] = useState('');
  const [scInternalContainer, setScInternalContainer] = useState('');
  const [scInternalPath, setScInternalPath] = useState('');
  const [scKvSecret, setScKvSecret] = useState('');
  // External ADLS Gen2 (URI + SAS) — let the operator paste a SAS and stash it to
  // Key Vault inline (only the returned secret NAME is kept). Mirrors the
  // credentialed-source ExternalCredsForm stash, but for the typed-URI external mode.
  const [scExtSas, setScExtSas] = useState('');
  const [scExtSasBusy, setScExtSasBusy] = useState(false);
  const [scExtSasErr, setScExtSasErr] = useState<string | null>(null);
  // External-source (S3/GCS/ADLS/Dataverse) structured creds + browse selection.
  // The credential value is written to Key Vault by the BFF; only the secret
  // NAME (extCreds.secretName) is ever held here or persisted on the row.
  const [extCreds, setExtCreds] = useState<ExternalCredsState>({ region: 'us-east-1' });
  // SharePoint / OneDrive selection (driveId + drive-relative path) resolved via
  // Microsoft Graph on the Console UAMI — no Key Vault credential.
  const [scSpSelection, setScSpSelection] = useState<SharePointSelection | null>(null);
  const [scName, setScName] = useState('');
  const [scKind, setScKind] = useState<ShortcutKind>('files');
  const [scParentPath, setScParentPath] = useState('');
  const [scFormat, setScFormat] = useState<'delta' | 'parquet' | 'csv' | 'json'>('delta');
  const [scSubmitting, setScSubmitting] = useState(false);
  const [scSubmitError, setScSubmitError] = useState<string | null>(null);
  // Schema shortcut entry (F9) — when registering a Tables shortcut on a
  // schema-enabled lakehouse, target a named schema (dropdown, never freeform).
  const [scTargetSchema, setScTargetSchema] = useState<string>('dbo');

  // ---- Schemas tab (F9 — multi-schema namespace, Azure-native, NO Fabric) ----
  // A schema is a named namespace; tables live under Tables/<schema>/<table>/ and
  // are queryable via the 4-part name workspace.lakehouse.schema.table. 'dbo' is
  // the immutable default. CREATE/ALTER/DROP SCHEMA + ALTER TABLE … RENAME TO run
  // on a Synapse Spark pool via Livy; the Cosmos `lakehouse-schemas` registry is
  // the source of truth. See app/api/lakehouse/schemas/route.ts.
  interface SchemaRow {
    id: string; lakehouseId: string; name: string; description?: string;
    isDefault: boolean; status: 'active' | 'pending' | 'error'; statusDetail?: string;
    createdBy?: string; createdAt?: string;
  }
  const [schemasEnabled, setSchemasEnabled] = useState<boolean>(false);
  const [schemas, setSchemas] = useState<SchemaRow[] | null>(null);
  const [schemasBusy, setSchemasBusy] = useState(false);
  const [schemasError, setSchemasError] = useState<string | null>(null);
  // New schema dialog
  const [newSchemaOpen, setNewSchemaOpen] = useState(false);
  const [newSchemaName, setNewSchemaName] = useState('');
  const [newSchemaDesc, setNewSchemaDesc] = useState('');
  const [newSchemaBusy, setNewSchemaBusy] = useState(false);
  const [newSchemaError, setNewSchemaError] = useState<string | null>(null);
  // Move-table dialog
  const [moveTableOpen, setMoveTableOpen] = useState(false);
  const [moveTableName, setMoveTableName] = useState('');
  const [moveTableFrom, setMoveTableFrom] = useState('dbo');
  const [moveTableTo, setMoveTableTo] = useState('');
  const [moveTableBusy, setMoveTableBusy] = useState(false);
  const [moveTableError, setMoveTableError] = useState<string | null>(null);
  const [moveTableStatus, setMoveTableStatus] = useState<string | null>(null);

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

  // ---- History (Delta time travel) callbacks --------------------------
  const loadHistory = useCallback(async (tablePath: string) => {
    if (!activeContainer) return;
    setHistoryLoading(true);
    setHistoryError(null);
    setHistoryRows(null);
    setHistoryRestoreMsg(null);
    setHistoryPreviewResult(null);
    try {
      const qs = new URLSearchParams({ container: activeContainer, tablePath });
      const r = await fetch(`/api/lakehouse/history?${qs.toString()}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; versions?: HistoryRow[] }>(r, 'Load history');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setHistoryRows(j.versions || []);
    } catch (e: any) {
      setHistoryError(e?.message || String(e));
      setHistoryRows([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [activeContainer]);

  const restoreToVersion = useCallback(async (tablePath: string, version: number) => {
    if (!activeContainer) return;
    // eslint-disable-next-line no-alert
    const confirmed = typeof window !== 'undefined'
      ? window.confirm(`Restore table "${leafName(tablePath)}" to version ${version}? This overwrites the current table state with version ${version}. Ensure the data files for that version have not been removed by VACUUM.`)
      : false;
    if (!confirmed) return;
    setHistoryRestoring(version);
    setHistoryRestoreMsg(null);
    try {
      const r = await fetch('/api/lakehouse/history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ container: activeContainer, tablePath, version, action: 'restore' }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; gated?: boolean; hint?: string }>(r, 'Restore');
      if (!j.ok) {
        setHistoryRestoreMsg({ ok: false, text: j.gated ? `Not available: ${j.hint}` : (j.error || 'Restore failed') });
      } else {
        setHistoryRestoreMsg({ ok: true, text: `Table restored to version ${version} at ${new Date().toLocaleTimeString()}` });
        await loadHistory(tablePath);
      }
    } catch (e: any) {
      setHistoryRestoreMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setHistoryRestoring(null);
    }
  }, [activeContainer, loadHistory]);

  const previewAsOf = useCallback(async (tablePath: string, version: number) => {
    if (!activeContainer) return;
    setHistoryPreviewLoading(true);
    setHistoryPreviewVersion(version);
    setHistoryPreviewResult(null);
    try {
      const r = await fetch('/api/lakehouse/history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ container: activeContainer, tablePath, version, action: 'preview' }),
      });
      const j = await parseJsonOrError<PreviewResponse & { gated?: boolean; hint?: string }>(r, 'Preview as of');
      if (!j.ok && (j as any).gated) {
        setHistoryPreviewResult({ ok: false, error: `Not available: ${(j as any).hint}` });
      } else {
        setHistoryPreviewResult(j);
      }
    } catch (e: any) {
      setHistoryPreviewResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setHistoryPreviewLoading(false);
    }
  }, [activeContainer]);

  const openTableHistory = useCallback((tablePath: string) => {
    setHistoryTable(tablePath);
    setHistoryRows(null);
    setHistoryRestoreMsg(null);
    setHistoryPreviewResult(null);
    loadHistory(tablePath);
    setTab('history');
  }, [loadHistory]);

  const resetWizard = useCallback((presetKind?: ShortcutKind, presetParent?: string) => {
    setScStep(1); setScType('internal'); setScTargetUri('');
    setScInternalContainer(''); setScInternalPath(''); setScKvSecret('');
    setScName(''); setScKind(presetKind || 'files'); setScParentPath(presetParent || '');
    setScFormat('delta'); setScSubmitError(null); setScTargetSchema('dbo');
    setExtCreds({ region: 'us-east-1' });
    setScSpSelection(null);
    setScExtSas(''); setScExtSasBusy(false); setScExtSasErr(null);
  }, []);

  // Stash a pasted SAS into Key Vault for the external ADLS (URI + SAS) mode and
  // keep only the returned secret NAME. Real backend (credentials BFF) — the SAS
  // value never lands in Cosmos or the shortcut row.
  const stashExternalSas = useCallback(async () => {
    if (!scExtSas.trim() || !shortcutLakehouseId) return;
    setScExtSasBusy(true); setScExtSasErr(null);
    try {
      const r = await fetch('/api/lakehouse/shortcuts/credentials', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: shortcutLakehouseId, name: scName.trim() || 'ext-adls', sourceType: 'adls', secretValue: scExtSas.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) throw new Error(j?.error || j?.hint || `HTTP ${r.status}`);
      setScExtSas('');
      setScKvSecret(j.data?.secretName || '');
    } catch (e: any) {
      setScExtSasErr(e?.message || String(e));
    } finally {
      setScExtSasBusy(false);
    }
  }, [scExtSas, shortcutLakehouseId, scName]);

  const openShortcutWizard = useCallback((presetKind?: ShortcutKind, presetParent?: string) => {
    resetWizard(presetKind, presetParent);
    setScWizardOpen(true);
  }, [resetWizard]);

  const submitShortcut = useCallback(async () => {
    if (!shortcutLakehouseId || !scName.trim()) return;
    setScSubmitting(true); setScSubmitError(null);
    // Resolve targetUri from the per-source fields.
    let targetUri = scTargetUri.trim();
    let credentialRef: { kind: string; keyVaultSecret: string } | undefined;
    if (scType === 'internal') {
      const c = scInternalContainer.trim();
      const p = scInternalPath.trim().replace(/^\/+/, '');
      targetUri = `internal://${c}${p ? `/${p}` : ''}`;
    } else if (scType === 'adls' && scAdlsMode === 'picker' && scAcctHost) {
      // Build abfss from the picked account + container + path (no typed URI).
      const c = scAdlsContainer.trim();
      const p = (extCreds.selectedPath || scAdlsPath).trim().replace(/^\/+/, '');
      targetUri = `abfss://${c}@${scAcctHost}/${p}`;
    } else if (scType === 's3' || scType === 'gcs') {
      // External object store: target built from the browse selection; the
      // credential lives in Key Vault (only its NAME travels with the row).
      const scheme = scType === 's3' ? 's3' : 'gs';
      const key = (extCreds.selectedPath || '').replace(/^\/+/, '');
      targetUri = `${scheme}://${(extCreds.bucket || '').trim()}/${key}`;
      credentialRef = extCreds.secretName
        ? { kind: scType === 's3' ? 'awsKeys' : 'gcsServiceAccount', keyVaultSecret: extCreds.secretName }
        : undefined;
    } else if (scType === 'dataverse') {
      // Dataverse binds via the Synapse-Link export path stored in Key Vault.
      const sub = (extCreds.selectedPath || 'tables').replace(/^\/+/, '');
      targetUri = `dataverse://${sub}`;
      credentialRef = extCreds.secretName ? { kind: 'sas', keyVaultSecret: extCreds.secretName } : undefined;
    } else if (scType === 'sharepoint') {
      // SharePoint / OneDrive resolves on the UAMI via Microsoft Graph — the
      // target is sharepoint://<driveId>/<path>; no Key Vault credential.
      if (scSpSelection) {
        targetUri = `sharepoint://${scSpSelection.driveId}/${(scSpSelection.path || '').replace(/^\/+/, '')}`;
      }
    } else if (scType === 'adls' && scAdlsMode === 'external') {
      credentialRef = scKvSecret.trim() ? { kind: 'sas', keyVaultSecret: scKvSecret.trim() } : undefined;
    } else if (scType === 'delta_sharing') {
      credentialRef = scKvSecret.trim() ? { kind: 'deltaSharing', keyVaultSecret: scKvSecret.trim() } : undefined;
    }
    // F9 — on a schema-enabled lakehouse a Tables shortcut lands inside its
    // target schema folder (Tables/<schema>/<name>), mirroring Fabric's schema
    // shortcut. This is a real registry effect (fullPath includes the schema).
    const effectiveParent = schemasEnabled && scKind === 'tables'
      ? [scTargetSchema, scParentPath.trim()].filter(Boolean).join('/')
      : scParentPath.trim();
    try {
      const r = await fetch('/api/lakehouse/shortcuts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lakehouseId: shortcutLakehouseId, name: scName.trim(), kind: scKind,
          parentPath: effectiveParent, targetType: scType, targetUri,
          format: scKind === 'tables' ? scFormat : undefined, credentialRef,
          schemaName: schemasEnabled && scKind === 'tables' ? scTargetSchema : undefined,
        }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; hint?: string }>(r, 'Create shortcut');
      if (!j.ok) throw new Error(j.hint || j.error || `HTTP ${r.status}`);
      setScWizardOpen(false);
      await loadShortcuts();
    } catch (e: any) { setScSubmitError(e?.message || String(e)); }
    finally { setScSubmitting(false); }
  }, [shortcutLakehouseId, scName, scTargetUri, scType, scAdlsMode, scAcctHost, scAdlsContainer, scAdlsPath, scInternalContainer, scInternalPath, scKvSecret, scKind, scParentPath, scFormat, schemasEnabled, scTargetSchema, extCreds, scSpSelection, loadShortcuts]);

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

  // Query THROUGH a shortcut (Files or non-engine internal/adls) — the
  // zero-copy parity action with Fabric's "query a shortcut". A Tables shortcut
  // bound to an engine queries its registered object (handled inline below); a
  // Files shortcut has no SQL object, so we resolve its stored abfss target to a
  // real Synapse Serverless OPENROWSET. The serverless /query route executes the
  // SQL verbatim, so the BULK URL must carry the REAL storage account host
  // (taken from the shortcut's resolved abfssUri) — not a placeholder.
  const queryShortcut = useCallback((sc: ShortcutRow) => {
    // abfss://<container>@<account>.dfs.core.windows.net/<path>
    //   → https://<account>.dfs.core.windows.net/<container>/<path>  (OPENROWSET BULK)
    const toBulk = (uri?: string): string | null => {
      if (!uri) return null;
      const m = uri.match(/^abfss:\/\/([^@]+)@([^/]+)\/(.*)$/i);
      if (m) return `https://${m[2]}/${m[1]}/${m[3].replace(/\/+$/, '')}`;
      return null;
    };
    const base = toBulk(sc.abfssUri);
    if (!base) {
      // No resolved physical path yet (e.g. an external-cloud shortcut, or a
      // row created before reachability was proven). Run Test to resolve it.
      setShortcutsError(
        `Shortcut "${sc.name}" has no resolved ADLS path to query directly (target type ${sc.targetType}). ` +
        `Run Test to resolve it, or — for an external-cloud source — register it as a Tables shortcut so it gets a SQL object.`,
      );
      return;
    }
    const fmt = (sc.format || '').toLowerCase();
    let bulk = base;
    let clause: string;
    if (fmt === 'delta') { clause = "FORMAT='DELTA'"; }
    else if (fmt === 'parquet') { bulk = `${base}/*.parquet`; clause = "FORMAT='PARQUET'"; }
    else { bulk = `${base}/*.csv`; clause = "FORMAT='CSV', PARSER_VERSION='2.0', HEADER_ROW=TRUE"; }
    setSqlText(
      `-- Query THROUGH shortcut '${sc.name}' (${sc.fullPath}) — zero-copy.\n` +
      `-- Resolves the shortcut target ${sc.targetUri} to its physical path.\n` +
      `-- Adjust FORMAT (CSV / PARQUET / DELTA) if the source data differs.\n` +
      `SELECT TOP 100 *\nFROM OPENROWSET(BULK '${bulk}', ${clause}) AS r;`,
    );
    setTab('sql');
  }, []);

  // Load shortcuts when the tab is opened or the container changes.
  useEffect(() => {
    if (tab === 'shortcuts' && shortcutLakehouseId) loadShortcuts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, shortcutLakehouseId]);

  // ---- Schemas (F9) ---------------------------------------------------
  const loadSchemas = useCallback(async () => {
    if (!shortcutLakehouseId) return;
    setSchemasBusy(true); setSchemasError(null);
    try {
      const r = await fetch(`/api/lakehouse/schemas?lakehouseId=${encodeURIComponent(shortcutLakehouseId)}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; schemas?: SchemaRow[] }>(r, 'List schemas');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSchemas(j.schemas || []);
    } catch (e: any) { setSchemasError(e?.message || String(e)); setSchemas([]); }
    finally { setSchemasBusy(false); }
  }, [shortcutLakehouseId]);

  const createSchema = useCallback(async () => {
    if (!shortcutLakehouseId || !newSchemaName.trim()) return;
    setNewSchemaBusy(true); setNewSchemaError(null);
    try {
      const r = await fetch('/api/lakehouse/schemas', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: shortcutLakehouseId, name: newSchemaName.trim(), description: newSchemaDesc.trim() || undefined }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; hint?: string }>(r, 'Create schema');
      // The row persists even on an honest Spark gate (503) — close + refresh so
      // the new (pending) schema appears in the catalog immediately.
      if (!j.ok && r.status !== 503) throw new Error(j.hint || j.error || `HTTP ${r.status}`);
      setNewSchemaOpen(false); setNewSchemaName(''); setNewSchemaDesc('');
      await loadSchemas();
    } catch (e: any) { setNewSchemaError(e?.message || String(e)); }
    finally { setNewSchemaBusy(false); }
  }, [shortcutLakehouseId, newSchemaName, newSchemaDesc, loadSchemas]);

  const deleteSchema = useCallback(async (name: string) => {
    if (!shortcutLakehouseId) return;
    // eslint-disable-next-line no-alert
    const ok = typeof window !== 'undefined'
      ? window.confirm(`Delete schema "${name}"? This runs DROP SCHEMA … CASCADE and removes the catalog entry.`)
      : false;
    if (!ok) return;
    setSchemasBusy(true); setSchemasError(null);
    try {
      const r = await fetch(`/api/lakehouse/schemas?lakehouseId=${encodeURIComponent(shortcutLakehouseId)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Delete schema');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSchemas();
    } catch (e: any) { setSchemasError(e?.message || String(e)); }
    finally { setSchemasBusy(false); }
  }, [shortcutLakehouseId, loadSchemas]);

  // ---- listing helpers ------------------------------------------------
  // NOTE: declared here (before submitMoveTable / the auto-load effect) so the
  // const is initialized before any hook references it on first render.
  // Referencing it later in the body would be a temporal-dead-zone crash.
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

  const openMoveTable = useCallback((tableName: string, fromSchema: string) => {
    setMoveTableName(tableName); setMoveTableFrom(fromSchema || 'dbo');
    setMoveTableTo(''); setMoveTableError(null); setMoveTableStatus(null);
    setMoveTableOpen(true);
    if (schemas === null) loadSchemas();
  }, [schemas, loadSchemas]);

  const submitMoveTable = useCallback(async () => {
    if (!shortcutLakehouseId || !moveTableName.trim() || !moveTableTo.trim()) return;
    setMoveTableBusy(true); setMoveTableError(null);
    try {
      const r = await fetch('/api/lakehouse/schemas', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: shortcutLakehouseId, tableName: moveTableName.trim(), fromSchema: moveTableFrom, toSchema: moveTableTo.trim() }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; hint?: string; data?: { namespace?: string } }>(r, 'Move table');
      if (!j.ok) throw new Error(j.hint || j.error || `HTTP ${r.status}`);
      setMoveTableStatus(`Moved to ${moveTableTo.trim()} — queryable as ${j.data?.namespace || `${shortcutLakehouseId}.${moveTableTo.trim()}.${moveTableName.trim()}`}`);
      // Refresh the Tables listing so the table appears under its new schema.
      if (activeContainer) loadPaths(activeContainer, 'Tables');
    } catch (e: any) { setMoveTableError(e?.message || String(e)); }
    finally { setMoveTableBusy(false); }
  }, [shortcutLakehouseId, moveTableName, moveTableFrom, moveTableTo, activeContainer, loadPaths]);

  // Load schemas when the Schemas tab opens or the lakehouse changes.
  useEffect(() => {
    if (tab === 'schemas' && shortcutLakehouseId) loadSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, shortcutLakehouseId]);

  // Populate the schema dropdown for the shortcut wizard (schema-enabled lakehouse).
  useEffect(() => {
    if (scWizardOpen && schemasEnabled && schemas === null && shortcutLakehouseId) loadSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scWizardOpen, schemasEnabled, schemas, shortcutLakehouseId]);

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
    setPermsTab('object');
    setPermsError(null);
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

  // ---- SQL-plane permission loaders / mutators (Table / Column / Row) ----
  const loadSqlPerms = useCallback(async (t: PermsTab) => {
    if (t === 'object') return;
    setPermsBusy(true); setPermsError(null); setSqlGate(null);
    try {
      if (t === 'row') {
        const r = await fetch(`/api/lakehouse/permissions?tab=row`);
        const j = await r.json();
        if (j.gate) { setSqlGate({ missing: j.missing, hint: j.hint }); return; }
        if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setRlsPolicies(j.policies || []);
      } else {
        const r = await fetch(`/api/lakehouse/permissions?tab=${t}`);
        const j = await r.json();
        if (j.gate) { setSqlGate({ missing: j.missing, hint: j.hint }); return; }
        if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setSqlGrants(j.grants || []);
      }
      // Shared table picker source.
      const tr = await fetch(`/api/lakehouse/permissions?tab=${t}&list=tables`);
      const tj = await tr.json();
      if (tj.gate) { setSqlGate({ missing: tj.missing, hint: tj.hint }); return; }
      if (tj.ok) setSqlTables(tj.tables || []);
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, []);

  const loadSqlColumns = useCallback(async (objectId: number) => {
    try {
      const r = await fetch(`/api/lakehouse/permissions?tab=column&list=columns&objectId=${objectId}`);
      const j = await r.json();
      if (j.ok) setSqlCols(j.columns || []);
    } catch { /* surfaced when the grant is attempted */ }
  }, []);

  // Debounced Entra user search → UPN for the SQL-plane principal picker.
  useEffect(() => {
    if (permsTab === 'object') return;
    const q = principalQuery.trim();
    if (q.length < 2) { setPrincipalResults([]); return; }
    const h = setTimeout(async () => {
      setPrincipalBusy(true);
      try {
        const r = await fetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&kind=user`);
        const j = await r.json();
        setPrincipalResults(
          (j.results || [])
            .filter((p: any) => p.upn)
            .map((p: any) => ({ id: p.id, displayName: p.displayName, upn: p.upn })),
        );
      } catch { setPrincipalResults([]); }
      finally { setPrincipalBusy(false); }
    }, 300);
    return () => clearTimeout(h);
  }, [principalQuery, permsTab]);

  const selectPermsTab = useCallback((t: PermsTab) => {
    setPermsTab(t);
    setPermsError(null);
    setSelTableId(null); setSqlCols([]); setSelColIds([]); setRlsFilterColId(null);
    setSelectedPrincipal(null); setPrincipalQuery(''); setPrincipalResults([]);
    if (t === 'object') loadPerms(); else loadSqlPerms(t);
  }, [loadPerms, loadSqlPerms]);

  const onPickTable = useCallback((objectId: number | null) => {
    setSelTableId(objectId);
    setSelColIds([]); setSqlCols([]); setRlsFilterColId(null);
    if (objectId != null) loadSqlColumns(objectId);
  }, [loadSqlColumns]);

  const grantSqlTable = useCallback(async () => {
    if (!selectedPrincipal || selTableId == null) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await fetch('/api/lakehouse/permissions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'table', upn: selectedPrincipal.upn, objectId: selTableId }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms('table');
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [selectedPrincipal, selTableId, loadSqlPerms]);

  const grantSqlColumn = useCallback(async () => {
    if (!selectedPrincipal || selTableId == null || selColIds.length === 0) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await fetch('/api/lakehouse/permissions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'column', upn: selectedPrincipal.upn, objectId: selTableId, columnIds: selColIds }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms('column');
      setSelColIds([]);
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [selectedPrincipal, selTableId, selColIds, loadSqlPerms]);

  const createRls = useCallback(async () => {
    if (selTableId == null || rlsFilterColId == null) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await fetch('/api/lakehouse/permissions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'row', objectId: selTableId, filterColumnId: rlsFilterColId, subject: rlsSubject }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms('row');
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [selTableId, rlsFilterColId, rlsSubject, loadSqlPerms]);

  const revokeSqlGrant = useCallback(async (g: SqlGrant) => {
    const tbl = sqlTables.find((t) => t.schema === g.schema && t.name === g.table);
    if (!tbl) { setPermsError(`Could not resolve object_id for ${g.schema}.${g.table}`); return; }
    setPermsBusy(true); setPermsError(null);
    try {
      let columnIds: number[] = [];
      if (g.column) {
        const cr = await fetch(`/api/lakehouse/permissions?tab=column&list=columns&objectId=${tbl.objectId}`);
        const cj = await cr.json();
        const hit = (cj.columns || []).find((c: any) => c.name === g.column);
        if (hit) columnIds = [hit.columnId];
      }
      const r = await fetch(`/api/lakehouse/permissions?tab=${g.column ? 'column' : 'table'}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upn: g.principal, objectId: tbl.objectId, columnIds }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms(g.column ? 'column' : 'table');
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [sqlTables, loadSqlPerms]);

  const dropRls = useCallback(async (p: RlsPolicy) => {
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await fetch(`/api/lakehouse/permissions?tab=row&policyObjectId=${p.policyObjectId}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms('row');
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [loadSqlPerms]);

  const toggleCol = useCallback((columnId: number, checked: boolean) => {
    setSelColIds((prev) => (checked ? Array.from(new Set([...prev, columnId])) : prev.filter((c) => c !== columnId)));
  }, []);

  // Shared Entra user → UPN picker used by the Table / Column tabs.
  const renderPrincipalPicker = useCallback(() => (
    <Field label="Principal (Entra user)" required>
      {selectedPrincipal ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Badge appearance="tint" color="brand">{selectedPrincipal.upn}</Badge>
          <Button size="small" appearance="subtle" onClick={() => { setSelectedPrincipal(null); setPrincipalQuery(''); }}>Change</Button>
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <Input
            value={principalQuery}
            onChange={(_, d) => setPrincipalQuery(d.value)}
            placeholder="Search by name or UPN…"
            contentAfter={principalBusy ? <Spinner size="extra-tiny" /> : undefined}
          />
          {principalResults.length > 0 && (
            <div style={{ position: 'absolute', zIndex: 10, top: '100%', left: 0, right: 0, maxHeight: 200, overflow: 'auto', background: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusMedium, boxShadow: tokens.shadow8 }}>
              {principalResults.map((p) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setSelectedPrincipal(p); setPrincipalResults([]); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { setSelectedPrincipal(p); setPrincipalResults([]); } }}
                  style={{ padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, cursor: 'pointer' }}
                  className={s.rowHover}
                >
                  <Body1>{p.displayName}</Body1>
                  <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{p.upn}</Caption1>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Field>
  ), [selectedPrincipal, principalQuery, principalBusy, principalResults, s.rowHover]);

  // Share — grant a principal RBAC access to this container. Mirrors Fabric's
  // "Share" affordance via Azure RBAC (the same /api/lakehouse/permissions POST
  // backing the Permissions dialog). No Fabric workspace involved.
  const grantShare = useCallback(async () => {
    if (!activeContainer || !sharePrincipal.trim()) return;
    setShareBusy(true); setShareError(null); setShareSuccess(null);
    try {
      const r = await fetch(`/api/lakehouse/permissions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          container: activeContainer,
          principalId: sharePrincipal.trim(),
          principalType: sharePrincipalType,
          role: shareRole,
        }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Share');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setShareSuccess(`Granted ${shareRole} to ${sharePrincipal.trim()} at ${new Date().toLocaleTimeString()}.`);
      setSharePrincipal('');
    } catch (e: any) { setShareError(e?.message || String(e)); }
    finally { setShareBusy(false); }
  }, [activeContainer, sharePrincipal, sharePrincipalType, shareRole]);

  const loadSettings = useCallback(async () => {
    if (!activeContainer) return;
    setSettingsBusy(true); setSettingsError(null);
    try {
      const r = await fetch(`/api/lakehouse/settings?container=${encodeURIComponent(activeContainer)}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; cloud?: typeof cloud; settings?: LakehouseSettings; icebergEndpoint?: IcebergEndpoint }>(r, 'Load settings');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSettings(j.settings || {});
      setSchemasEnabled(j.settings?.schemasEnabled ?? false);
      if (j.cloud) setCloud(j.cloud);
      const cfg = j.settings?.sparkConfig || {};
      setSettingsSparkConfText(Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join('\n'));
      setLcTableName(j.settings?.liquidClustering?.tableName || '');
      setLcColumns((j.settings?.liquidClustering?.columns || []).join(', '));
      setLcApplied(null); setLcSql(null); setLcGate(null); setLcError(null);
      setIcebergEnabled(j.settings?.icebergExpose?.enabled ?? false);
      setIcebergTable(j.settings?.icebergExpose?.tableName || '');
      setIcebergSchema(j.settings?.icebergExpose?.schemaName || '');
      setIcebergEndpoint(j.icebergEndpoint || null);
      setIcebergApplied(null); setIcebergSql(null); setIcebergGate(null); setIcebergError(null);
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

  // Resolve schemasEnabled for the active container without opening Settings —
  // the Tables/Schemas tabs need it. Bundle's schemasEnabled is the install-time
  // default; the persisted settings doc (if any) is authoritative.
  useEffect(() => {
    if (!activeContainer) return;
    let cancelled = false;
    if (lhContent?.schemasEnabled) setSchemasEnabled(true);
    fetch(`/api/lakehouse/settings?container=${encodeURIComponent(activeContainer)}`)
      .then((r) => parseJsonOrError<{ ok: boolean; settings?: { schemasEnabled?: boolean } }>(r, 'Load settings'))
      .then((j) => { if (!cancelled && j.ok && typeof j.settings?.schemasEnabled === 'boolean') setSchemasEnabled(j.settings.schemasEnabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeContainer, lhContent?.schemasEnabled]);

  const saveSettings = useCallback(async () => {
    if (!activeContainer) return;
    setSettingsBusy(true); setSettingsError(null);
    setLcApplied(null); setLcSql(null); setLcGate(null); setLcError(null);
    setIcebergApplied(null); setIcebergSql(null); setIcebergGate(null); setIcebergError(null);
    try {
      const sparkConfig: Record<string, string> = {};
      for (const line of settingsSparkConfText.split(/\r?\n/)) {
        const t = line.trim(); if (!t || t.startsWith('#')) continue;
        const idx = t.indexOf('=');
        if (idx > 0) sparkConfig[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
      }
      const trimmedTable = lcTableName.trim();
      const liquidClustering = trimmedTable
        ? { tableName: trimmedTable, columns: lcColumns.split(',').map((c) => c.trim()).filter(Boolean) }
        : undefined;
      const icebergTbl = icebergTable.trim();
      const icebergExpose = icebergTbl
        ? {
            enabled: icebergEnabled,
            tableName: icebergTbl,
            schemaName: schemasEnabled && icebergSchema.trim() ? icebergSchema.trim() : undefined,
          }
        : undefined;
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
          schemasEnabled: settings.schemasEnabled ?? false,
          liquidClustering,
          icebergExpose,
          fabricToggles: settings.fabricToggles,
        }),
      });
      const j = await parseJsonOrError<{
        ok: boolean; error?: string; settings?: LakehouseSettings;
        clusteringApplied?: boolean; clusteringSql?: string;
        clusteringGate?: string; clusteringError?: string;
        icebergApplied?: boolean; icebergSql?: string;
        icebergGate?: string; icebergError?: string;
        icebergEndpoint?: IcebergEndpoint;
      }>(r, 'Save settings');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSettings(j.settings || settings);
      setSchemasEnabled(j.settings?.schemasEnabled ?? settings.schemasEnabled ?? false);
      setLcApplied(j.clusteringApplied ?? null);
      setLcSql(j.clusteringSql || null);
      setLcGate(j.clusteringGate || null);
      setLcError(j.clusteringError || null);
      setIcebergApplied(j.icebergApplied ?? null);
      setIcebergSql(j.icebergSql || null);
      setIcebergGate(j.icebergGate || null);
      setIcebergError(j.icebergError || null);
      if (j.icebergEndpoint) setIcebergEndpoint(j.icebergEndpoint);
      setActionStatus(`Lakehouse settings saved at ${new Date().toLocaleTimeString()}`);
      // Keep the dialog open when clustering / iceberg needs the user's
      // attention (gate or error) so the MessageBar is visible; else close.
      if (!j.clusteringGate && !j.clusteringError && !j.icebergGate && !j.icebergError) setSettingsOpen(false);
    } catch (e: any) { setSettingsError(e?.message || String(e)); }
    finally { setSettingsBusy(false); }
  }, [activeContainer, settings, settingsSparkConfText, lcTableName, lcColumns, icebergEnabled, icebergTable, icebergSchema, schemasEnabled]);

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
  // (cacheKey + loadPaths are declared earlier in the component body, above
  // submitMoveTable, to avoid a temporal-dead-zone reference on first render.)

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

  // ---- column-stats polling ------------------------------------------
  // Poll the async Spark summary job every 3s, following whatever jobId the
  // route hands back (it changes once a warming pool becomes idle and the
  // statement is submitted). Stops on available / error / unmount.
  useEffect(() => {
    if (!statsJobId) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      const target = statsTargetRef.current;
      const qs = new URLSearchParams({ jobId: statsJobId });
      if (target) { qs.set('container', target.container); qs.set('path', target.path); }
      try {
        const r = await fetch(`/api/lakehouse/table-stats?${qs.toString()}`);
        const j = await parseJsonOrError<{ ok: boolean; status?: string; error?: string; jobId?: string; stats?: Record<string, ColStat> }>(r, 'Column stats');
        if (cancelled) return;
        if (j.status === 'available' && j.stats) {
          setColumnStats(j.stats);
          setStatsLoading(false);
          setStatsJobId(null);
        } else if (!j.ok || j.status === 'error') {
          setStatsError(j.error || 'Column statistics job failed.');
          setStatsLoading(false);
          setStatsJobId(null);
        } else if (j.jobId && j.jobId !== statsJobId) {
          // Pool warmed up — follow the new jobId (statement now running).
          setStatsJobId(j.jobId);
        }
        // status 'running' / 'warming' with same jobId → keep polling.
      } catch (e: any) {
        if (cancelled) return;
        setStatsError(e?.message || String(e));
        setStatsLoading(false);
        setStatsJobId(null);
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [statsJobId]);

  // ---- deep-link restore ---------------------------------------------
  // On first mount, if ?tab=preview&container=&path= is present, capture it and
  // jump to the Preview tab. The selection is restored once containers settle.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const dCont = sp.get('container');
    const dPath = sp.get('path');
    if (sp.get('tab') === 'preview' && dCont && dPath) {
      deepLinkRef.current = { container: dCont, path: dPath };
      setTab('preview');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- selection / preview -------------------------------------------
  // `opts` lets callers preview a managed Delta TABLE (format='DELTA') at the
  // Fabric 1000-row sample cap — the per-table "Preview" action below passes
  // { top: 1000, format: 'DELTA' }; file previews fall back to detect + 100.
  const selectFile = useCallback(async (entry: PathEntry, opts?: { top?: number; format?: string }) => {
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
    setColumnStats(null);
    setStatsError(null);
    setStatsLoading(false);
    setStatsJobId(null);
    // Deep-link: reflect the current selection in the URL so the table can be
    // re-opened directly. history.replaceState avoids a Next navigation/refetch.
    try {
      const sp = new URLSearchParams(window.location.search);
      sp.set('tab', 'preview');
      sp.set('container', activeContainer);
      sp.set('path', entry.name);
      window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
    } catch { /* non-browser / no history — ignore */ }
    try {
      const qs = new URLSearchParams({ container: activeContainer, path: entry.name });
      if (opts?.top) qs.set('top', String(opts.top));
      if (opts?.format) qs.set('format', opts.format);
      const r = await fetch(`/api/lakehouse/preview?${qs.toString()}`);
      const j = await parseJsonOrError<PreviewResponse>(r, 'Preview');
      setPreview(j);
      if (j.sql) {
        setSqlText(j.sql);
      }
      // Kick off the async column-summary Spark job (non-blocking). Only for
      // tabular previews that actually returned columns.
      if (j.ok && (j.columns?.length ?? 0) > 0) {
        statsTargetRef.current = { container: activeContainer, path: entry.name };
        setStatsLoading(true);
        try {
          const sQs = new URLSearchParams({ container: activeContainer, path: entry.name });
          const sr = await fetch(`/api/lakehouse/table-stats?${sQs.toString()}`);
          const sj = await parseJsonOrError<{ ok: boolean; error?: string; jobId?: string; code?: string }>(sr, 'Column stats');
          if (sj.ok && sj.jobId) {
            setStatsJobId(sj.jobId);
          } else {
            setStatsLoading(false);
            setStatsError(sj.error || 'Stats job could not start.');
          }
        } catch (e: any) {
          setStatsLoading(false);
          setStatsError(e?.message || String(e));
        }
      }
    } catch (e: any) {
      setPreview({ ok: false, error: e?.message || String(e) });
    } finally {
      setPreviewLoading(false);
    }
  }, [activeContainer, loadPaths]);

  // Once the deep-linked container is active, load its preview + stats.
  useEffect(() => {
    const dl = deepLinkRef.current;
    if (!dl || containers === null) return;
    if (activeContainer !== dl.container) {
      if ((containers || []).some((c) => c.name === dl.container)) setActiveContainer(dl.container);
      return;
    }
    deepLinkRef.current = null;
    void selectFile({ name: dl.path, isDirectory: false, size: 0 });
  }, [containers, activeContainer, selectFile]);

  // Preview a managed Delta table at the Fabric 1000-row cap. `relPath` is the
  // table directory relative to the container (e.g. Tables/customers); forcing
  // FORMAT='DELTA' makes the Serverless OPENROWSET read the Delta log, not a
  // single file. Reuses the shared DeltaPreviewGrid on the Preview tab.
  const previewTable = useCallback((relPath: string) => {
    setPreviewMode('table');
    void selectFile({ name: relPath, isDirectory: false, size: 0 }, { top: 1000, format: 'DELTA' });
    setTab('preview');
  }, [selectFile]);

  // Open the Add-to-data-agent dialog: load the caller's real data agents.
  const openAddToAgent = useCallback(async () => {
    setDaOpen(true); setDaMsg(null); setDaSel(''); setDaAgents(null); setDaLoadErr(null);
    try {
      const r = await fetch('/api/items/data-agent');
      const j = await parseJsonOrError<{ ok: boolean; items?: DaAgentRow[]; error?: string }>(r, 'List data agents');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setDaAgents(j.items || []);
    } catch (e: any) { setDaLoadErr(e?.message || String(e)); }
  }, []);

  // Add THIS lakehouse as a grounded source on the selected data agent (real PATCH).
  const addToAgent = useCallback(async () => {
    const agent = (daAgents || []).find((a) => a.id === daSel);
    if (!agent) return;
    setDaBusy(true); setDaMsg(null);
    try {
      const lhName = itemQ.data?.displayName || `lakehouse-${id}`;
      const sourceId = `lakehouse:${id}`;
      const existing = Array.isArray(agent.state?.sources) ? agent.state!.sources! : [];
      if (existing.some((s: any) => s?.id === sourceId)) {
        setDaMsg({ intent: 'success', text: `${lhName} is already a source on ${agent.displayName}.` });
        setDaBusy(false); return;
      }
      const src = { id: sourceId, type: 'lakehouse', name: lhName, tables: maintainTable || '', instructions: '', description: `Lakehouse ${lhName} (${id})`, examples: [] };
      const nextState = { ...(agent.state || {}), sources: [...existing, src] };
      const r = await fetch(`/api/items/data-agent/${agent.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: nextState }),
      });
      const j = await parseJsonOrError<{ ok?: boolean; error?: string }>(r, 'Add source');
      if (j.error || j.ok === false) throw new Error(j.error || 'PATCH failed');
      setDaMsg({ intent: 'success', text: `Added ${lhName} to ${agent.displayName}. Open the agent's Build tab to ground it.` });
      setDaAgents((prev) => (prev || []).map((a) => a.id === agent.id ? { ...a, state: nextState } : a));
    } catch (e: any) { setDaMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setDaBusy(false); }
  }, [daAgents, daSel, itemQ.data?.displayName, id, maintainTable]);

  // ---- file actions ---------------------------------------------------
  const onUploadClick = useCallback(() => fileInputRef.current?.click(), []);
  const onFolderUploadClick = useCallback(() => folderInputRef.current?.click(), []);

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

  /** Load a file as a managed Delta table via the no-code Load to Table (F6) wizard. */
  const onLoadToTables = useCallback((entry: PathEntry) => {
    if (!activeContainer || entry.isDirectory) return;
    setLttEntry(entry);
    setLttOpen(true);
  }, [activeContainer]);

  // F6 — Load the selected file to a Delta table (matches Fabric's keyboard affordance).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F6') return;
      if (lttOpen) return;
      if (!activeContainer || !activePath || activePath.isDirectory) return;
      e.preventDefault();
      setLttEntry(activePath);
      setLttOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeContainer, activePath, lttOpen]);

  /**
   * Upload one file to ADLS. Returns null on success or an error string.
   * ADLS HNS auto-creates parent directories on the DFS PUT path, so a
   * multi-segment `targetPath` (folder/sub/file.txt) preserves the tree.
   */
  const uploadOne = useCallback(async (targetPath: string, file: File): Promise<string | null> => {
    if (!activeContainer) return 'No active container';
    try {
      const fd = new FormData();
      fd.set('container', activeContainer);
      fd.set('path', targetPath);
      fd.set('file', file);
      const r = await fetch('/api/lakehouse/upload', { method: 'POST', body: fd });
      const ct = r.headers.get('content-type') || '';
      let j: any = null;
      let bodyText: string | null = null;
      if (ct.includes('application/json')) {
        try { j = await r.json(); } catch { /* fall through to text */ }
      }
      if (!j) { try { bodyText = (await r.text()).slice(0, 240); } catch { /* ignore */ } }
      if (!r.ok || j?.ok === false) {
        return j?.error
          || (r.status === 413 ? `${leafName(targetPath)}: file too large (${file.size.toLocaleString()} bytes). Max 4 GB.`
          : r.status === 502 ? `${leafName(targetPath)}: upstream storage error (502). Check ADLS network/role assignments.`
          : r.status === 401 ? `Sign in expired. Reload and re-authenticate.`
          : `${leafName(targetPath)}: upload failed (HTTP ${r.status}).${bodyText ? ` Server said: ${bodyText}` : ''}`);
      }
      return null;
    } catch (e: any) {
      return `${leafName(targetPath)}: ${e?.message || String(e)}`;
    }
  }, [activeContainer]);

  /**
   * Batch upload — preserves each item's tree-relative path under the current
   * folder. Drives the inline progress bar and reports the first failure.
   */
  const uploadItems = useCallback(async (items: UploadItem[]) => {
    if (!activeContainer || !items.length) return;
    const basePrefix = activePath?.isDirectory ? `${activePath.name.replace(/\/+$/, '')}/` : '';
    setActionError(null);
    setActionStatus(null);
    setUploadQueue({ done: 0, total: items.length });
    let firstError: string | null = null;
    let okCount = 0;
    for (let i = 0; i < items.length; i++) {
      const { relativePath, file } = items[i];
      const targetPath = `${basePrefix}${relativePath.replace(/^\/+/, '')}`;
      const err = await uploadOne(targetPath, file);
      if (err) { if (!firstError) firstError = err; } else { okCount++; }
      setUploadQueue({ done: i + 1, total: items.length });
    }
    setUploadQueue(null);
    if (firstError) {
      setActionError(
        items.length > 1
          ? `${okCount}/${items.length} uploaded. First failure — ${firstError}`
          : firstError,
      );
    } else {
      setActionStatus(`Uploaded ${okCount} file${okCount === 1 ? '' : 's'} at ${new Date().toLocaleTimeString()}`);
    }
    refreshActive();
  }, [activeContainer, activePath, uploadOne, refreshActive]);

  // File picker → a single file uses the F10 background jobs-store upload (the
  // fetch is owned in the module-scope store, so switching item tabs mid-upload
  // does NOT cancel it and the global toaster confirms on completion). A
  // multi-select picks the inline batch uploader with its own progress bar.
  const onUploadChange = useCallback(async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    if (!files.length || !activeContainer) return;
    if (files.length === 1) {
      const file = files[0];
      const prefix = activePath?.isDirectory ? activePath.name : '';
      const targetPath = prefix ? `${prefix.replace(/\/+$/, '')}/${file.name}` : file.name;
      setActionError(null);
      startUpload({
        lakehouseName,
        container: activeContainer,
        path: targetPath,
        file,
        onDone: ({ ok, error }) => {
          if (ok) refreshActive();
          else if (error) setActionError(error);
        },
      });
      // Refresh the listing optimistically once the ADLS append+flush has likely
      // propagated (P99 ~200ms) so the new file appears without a manual refresh.
      setTimeout(refreshActive, 500);
      return;
    }
    await uploadItems(files.map((f) => ({ relativePath: f.name, file: f })));
  }, [activeContainer, activePath, startUpload, lakehouseName, uploadItems, refreshActive]);

  // Folder picker (webkitdirectory) → preserves the folder tree via
  // webkitRelativePath (e.g. "myfolder/sub/file.txt").
  const onFolderInputChange = useCallback(async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    if (!files.length || !activeContainer) return;
    await uploadItems(
      files.map((f) => ({ relativePath: (f as any).webkitRelativePath || f.name, file: f })),
    );
  }, [activeContainer, uploadItems]);

  // Drag-and-drop onto the Files tab — folders preserve their tree via the
  // webkit Entries API; loose files upload flat.
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!activeContainer) return;
    e.preventDefault();
    setIsDragOver(true);
  }, [activeContainer]);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);
  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!activeContainer) return;
    const dtItems = Array.from(e.dataTransfer.items || []);
    const entries = dtItems
      .filter((it) => it.kind === 'file')
      .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
      .filter((en): en is FileSystemEntry => !!en);
    let items: UploadItem[] = [];
    if (entries.length) {
      items = (await Promise.all(entries.map((en) => collectEntries(en)))).flat();
    } else {
      // Browsers without the Entries API — fall back to flat files.
      items = Array.from(e.dataTransfer.files || []).map((f) => ({ relativePath: f.name, file: f }));
    }
    if (items.length) await uploadItems(items);
  }, [activeContainer, uploadItems]);

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

  /**
   * Download a file's bytes via the ADLS passthrough route. Uses fetch + a blob
   * (not window.open) so we can read the `x-loom-mip-status` response header and
   * report whether the MIP sensitivity label was stamped. An optional
   * `labelId`/`labelName` stamps the bytes with the CHOSEN label; otherwise the
   * proxy applies the file's Purview-catalog label when one exists.
   */
  const onDownload = useCallback(async (
    entry: PathEntry,
    label?: { id: string; name: string; method?: 'Standard' | 'Privileged' },
  ) => {
    if (!activeContainer || entry.isDirectory) return;
    setMipStatus(null);
    setMipLabelName(null);
    const params: Record<string, string> = { container: activeContainer, path: entry.name };
    if (label?.id) {
      params.labelId = label.id;
      params.labelName = label.name;
      if (label.method) params.labelMethod = label.method;
    }
    const qs = new URLSearchParams(params);
    try {
      const r = await fetch(`/api/lakehouse/download?${qs.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        setActionError(j?.error || `Download failed (HTTP ${r.status}).`);
        return;
      }
      setMipStatus(r.headers.get('x-loom-mip-status'));
      const lbl = r.headers.get('x-loom-mip-label');
      if (lbl) { try { setMipLabelName(decodeURIComponent(lbl)); } catch { setMipLabelName(lbl); } }
      const blob = await r.blob();
      if (typeof window !== 'undefined') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = leafName(entry.name);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e: any) {
      setActionError(e?.message || String(e));
    }
  }, [activeContainer]);

  // ---- "Download with sensitivity label" picker -------------------------
  const openLabelDialog = useCallback(async (entry: PathEntry) => {
    setLabelDlgEntry(entry);
    setLabelDlgOpen(true);
    setChosenLabelId('');
    setMipLabelsError(null);
    if (mipLabels) return; // labels already loaded
    setMipLabelsLoading(true);
    try {
      const r = await fetch('/api/admin/security/mip/labels');
      const j = await parseJsonOrError<{ ok?: boolean; error?: string; labels?: MipLabelOption[]; hint?: any }>(r, 'List sensitivity labels');
      if (!r.ok || j.ok === false) {
        // 503 → MIP not configured. Surface the hint's followUp when present.
        const hint = (j as any)?.hint?.followUp || (j as any)?.hint?.bicepStatus;
        setMipLabelsError(j.error || hint || `Sensitivity labels unavailable (HTTP ${r.status}).`);
      } else {
        const labels = (j.labels || []).filter((l) => l.isAppliable !== false);
        setMipLabels(labels);
        if (!labels.length) setMipLabelsError('No appliable sensitivity labels are published to this tenant.');
      }
    } catch (e: any) {
      setMipLabelsError(e?.message || String(e));
    } finally {
      setMipLabelsLoading(false);
    }
  }, [mipLabels]);

  const confirmLabelDownload = useCallback(async () => {
    if (!labelDlgEntry || !chosenLabelId) return;
    const chosen = (mipLabels || []).find((l) => l.id === chosenLabelId);
    const name = chosen?.displayName || chosen?.name || chosenLabelId;
    setLabelDlgOpen(false);
    await onDownload(labelDlgEntry, { id: chosenLabelId, name, method: 'Standard' });
  }, [labelDlgEntry, chosenLabelId, mipLabels, onDownload]);

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
  // Pre-attached secondary (reference) lakehouses are read-only — write
  // commands gray out, matching Fabric's behavior when you "Add lakehouses".
  const writeBlocked = !canFileAction || isReferenceLakehouse;
  const writeTitle = isReferenceLakehouse
    ? 'Read-only — reference lakehouse (write operations disabled)'
    : !canFileAction ? 'Select a container first' : undefined;
  const notebookHref = activeContainer
    ? `/items/notebook/new?lakehouse=${encodeURIComponent(activeContainer)}`
    : '/items/notebook/new';
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Refresh', actions: [
        {
          label: 'Refresh', icon: <ArrowSync20Regular />,
          onClick: writeBlocked ? undefined : refreshActive,
          disabled: writeBlocked, title: writeTitle,
        },
      ]},
      { label: 'Get data', actions: [
        {
          label: 'Get data', disabled: writeBlocked, title: writeTitle,
          dropdownItems: [
            {
              // F10 — Upload is NOT disabled while another upload is in flight:
              // the jobs store supports concurrent uploads, so the user can queue
              // more files. The label surfaces the running count.
              label: uploading ? `Uploading (${runningUploads.length})…` : 'Upload', icon: <ArrowUpload20Regular />,
              onClick: writeBlocked ? undefined : onUploadClick,
              disabled: writeBlocked, title: writeTitle,
            },
            {
              // F5 — folder upload preserves the dropped/selected tree via the
              // webkitdirectory picker and the inline batch uploader.
              label: 'Upload folder', icon: <FolderArrowUp20Regular />,
              onClick: writeBlocked ? undefined : onFolderUploadClick,
              disabled: writeBlocked, title: writeTitle,
            },
            {
              label: 'New folder', icon: <FolderAdd20Regular />,
              onClick: writeBlocked ? undefined : onNewFolder,
              disabled: writeBlocked, title: writeTitle,
            },
            {
              label: 'New shortcut', icon: <LinkMultiple20Regular />,
              onClick: writeBlocked ? undefined : () => { setTab('shortcuts'); openShortcutWizard(); },
              disabled: writeBlocked, title: writeTitle,
            },
            {
              label: 'New dataflow', icon: <Database20Regular />,
              onClick: () => router.push('/items/dataflow/new'),
            },
            {
              label: 'New pipeline', icon: <Database20Regular />,
              onClick: () => router.push('/items/data-pipeline/new'),
            },
            {
              label: 'New notebook', icon: <BookOpen20Regular />,
              onClick: () => router.push(notebookHref),
            },
            {
              label: 'Copy activity', icon: <ArrowDownload20Regular />,
              onClick: () => router.push('/items/copy-job/new'),
            },
          ],
        },
      ]},
      { label: 'Analyze data', actions: [
        {
          label: 'Analyze data',
          dropdownItems: [
            {
              label: 'SQL endpoint', icon: <Database20Regular />,
              onClick: () => setTab('sql'),
            },
            {
              label: 'New notebook', icon: <BookOpen20Regular />,
              onClick: () => router.push(notebookHref),
            },
            {
              label: 'Existing notebook', icon: <BookOpen20Regular />,
              onClick: () => router.push('/items/notebook/new'),
            },
          ],
        },
      ]},
      { label: 'Data model', actions: [
        {
          label: 'New semantic model', icon: <TableSimple20Regular />,
          onClick: () => setSemanticModelGateOpen(true),
          title: 'DirectLake semantic model requires Power BI / Fabric capacity — see the dialog for the Azure-native path',
        },
      ]},
      { label: 'Query', actions: [
        { label: 'Preview', icon: <Eye20Regular />, onClick: hasFile ? () => { if (activePath) { selectFile(activePath); setTab('preview'); } } : undefined, disabled: !hasFile },
        { label: 'Query this file', icon: <Play20Regular />, onClick: hasFile ? () => { if (activePath) { selectFile(activePath); setTab('sql'); } } : undefined, disabled: !hasFile },
      ]},
      { label: 'Tables', actions: [
        { label: 'Load to table', onClick: hasFile ? () => { if (activePath) onLoadToTables(activePath); } : undefined, disabled: !hasFile, title: hasFile ? 'Load this file into a managed Delta table (F6)' : 'Select a file first' },
      ]},
      { label: 'Protect', actions: [
        { label: 'Download with label', onClick: hasFile ? () => { if (activePath) openLabelDialog(activePath); } : undefined, disabled: !hasFile, title: hasFile ? 'Stamp a MIP sensitivity label on download' : 'Select a file first' },
      ]},
      { label: 'Manage', actions: [
        {
          label: 'Settings', icon: <Info20Regular />,
          onClick: writeBlocked ? undefined : openSettings,
          disabled: writeBlocked, title: writeTitle,
        },
        {
          label: 'Permissions', icon: <LinkMultiple20Regular />,
          onClick: activeContainer ? openPerms : undefined,
          disabled: !activeContainer, title: !activeContainer ? 'Select a container first' : undefined,
        },
        {
          label: 'Share', icon: <Add20Regular />,
          onClick: activeContainer ? () => { setShareError(null); setShareSuccess(null); setShareOpen(true); } : undefined,
          disabled: !activeContainer, title: !activeContainer ? 'Select a container first' : undefined,
        },
        {
          label: 'Maintain…', icon: <Wrench20Regular />,
          onClick: (tab === 'tables' && maintainTable) ? () => setMaintainOpen(true) : undefined,
          disabled: !(tab === 'tables' && maintainTable),
          title: !(tab === 'tables' && maintainTable) ? 'Select a table in the Tables tab first' : 'OPTIMIZE / VACUUM / ZORDER BY',
        },
        {
          label: 'OneLake security', icon: <ShieldTask20Regular />,
          onClick: () => setTab('security'),
          title: 'Manage OneLake data-access roles + row/column security for this lakehouse',
        },
      ]},
      { label: 'AI', actions: [
        {
          label: 'Add to data agent', icon: <Sparkle20Regular />,
          onClick: () => { void openAddToAgent(); },
          title: 'Ground a data agent on this lakehouse (Fabric "Add to AI skill")',
        },
      ]},
    ]},
  ], [
    writeBlocked, writeTitle, canFileAction, uploading, runningUploads.length,
    onUploadClick, onFolderUploadClick, onNewFolder, refreshActive, openShortcutWizard, router,
    notebookHref, hasFile, activePath, selectFile, onLoadToTables, openLabelDialog,
    activeContainer, openPerms, openSettings, tab, maintainTable, openAddToAgent,
  ]);

  // ---- render ---------------------------------------------------------
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          {/* Primary lakehouse — always bold to distinguish it from references. */}
          <Caption1 style={{ display: 'block', padding: `${tokens.spacingVerticalXXS} 0 ${tokens.spacingVerticalS}`, fontWeight: tokens.fontWeightBold }}>
            <Database20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
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
            <Tree aria-label="Live Delta catalog" defaultOpenItems={['live-tables', `live-schema-${activeContainer}`]} style={{ marginTop: tokens.spacingVerticalM }}>
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
              style={{ marginTop: tokens.spacingVerticalM }}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalL, padding: `${tokens.spacingVerticalXS} 0` }}>
            <Caption1 style={{ flex: 1, fontWeight: tokens.fontWeightSemibold }}>
              <LinkMultiple20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
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
            <Caption1 style={{ display: 'block', padding: `0 ${tokens.spacingHorizontalXS}`, color: tokens.colorNeutralForeground3 }}>
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
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
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
            <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground2 }}>
              <div className={s.toolbar}>
                <Badge appearance="filled" color="informative" icon={<LinkMultiple20Regular />}>Reference · read-only</Badge>
                <Subtitle2>{refSelection.displayName}</Subtitle2>
                <Caption1>· {refSelection.container}/{leafName(refSelection.entry.name)}</Caption1>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginLeft: 'auto' }}>
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
              <Tab value="files" icon={<DocumentTable20Regular />}>Files</Tab>
              <Tab value="tables" icon={<TableSimple20Regular />}>Tables</Tab>
              <Tab value="history" icon={<History20Regular />}>History</Tab>
              <Tab value="schemas" icon={<Database20Regular />}>Schemas</Tab>
              <Tab value="preview" icon={<Eye20Regular />}>Preview</Tab>
              <Tab value="sql" icon={<Play20Regular />}>SQL</Tab>
              <Tab value="shortcuts" icon={<CloudLink20Regular />}>Shortcuts</Tab>
              <Tab value="security" icon={<ShieldTask20Regular />}>Security</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            {tab === 'security' && (
              <OneLakeSecurityTab itemId={id} itemType="lakehouse" container={activeContainer || 'gold'} />
            )}
            {tab === 'files' && (
              <>
                {/* F10 — visually-hidden live region so screen readers announce
                    background upload progress to the active lakehouse, polled
                    independent of which tab the sighted user is on. */}
                <div
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)', clipPath: 'inset(50%)' }}
                >
                  {uploading ? `Uploading ${runningUploads.length} file${runningUploads.length === 1 ? '' : 's'} to ${lakehouseName} lakehouse, please wait…` : ''}
                </div>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="brand">{activeContainer || 'no container'}</Badge>
                  <Caption1>path: <strong>/{currentPrefix || ''}</strong></Caption1>
                  <Button appearance="primary" icon={<ArrowUpload20Regular />} disabled={!activeContainer} onClick={onUploadClick}>
                    {uploading ? `Uploading (${runningUploads.length})…` : 'Upload file'}
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    hidden
                    multiple
                    onChange={onUploadChange}
                    aria-label={`Upload file to ${lakehouseName} lakehouse`}
                  />
                  <Button appearance="outline" icon={<FolderArrowUp20Regular />} disabled={!activeContainer || uploading} onClick={onFolderUploadClick}>
                    Upload folder
                  </Button>
                  {/* webkitdirectory makes the picker select a folder; the
                      browser fills webkitRelativePath so the tree is preserved. */}
                  <input
                    ref={folderInputRef}
                    type="file"
                    hidden
                    multiple
                    // @ts-expect-error -- non-standard directory-picker attributes
                    webkitdirectory=""
                    directory=""
                    onChange={onFolderInputChange}
                  />
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
                {uploading && uploadQueue && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <Spinner size="tiny" />{' '}Uploading {uploadQueue.done} / {uploadQueue.total} file{uploadQueue.total === 1 ? '' : 's'}…
                    </MessageBarBody>
                  </MessageBar>
                )}
                {/* MIP sensitivity-label-on-download outcome (F5). The proxy
                    echoes x-loom-mip-status; map it to an honest MessageBar.
                    The download itself always succeeds regardless of status. */}
                {mipStatus === 'stamped' && (
                  <MessageBar intent="success" icon={<ShieldTask20Regular />}>
                    <MessageBarBody>
                      <MessageBarTitle>Sensitivity label applied</MessageBarTitle>
                      {mipLabelName ? <>“{mipLabelName}” was </> : 'The label was '}
                      embedded in the downloaded file (MSIP metadata). Reopen the file in Office/Acrobat to verify the label bar.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {mipStatus === 'no-label' && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>No sensitivity label</MessageBarTitle>
                      This file has no sensitivity label in the Microsoft Purview catalog (it may not have been scanned yet). Use <b>Download with label</b> to choose one explicitly. The file was downloaded as-is.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {mipStatus === 'not-configured' && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>MIP label lookup unavailable</MessageBarTitle>
                      Microsoft Purview is not wired in this deployment, so no catalog label could be looked up. Set <code>LOOM_PURVIEW_ACCOUNT</code> (see <code>platform/fiab/bicep/modules/admin-plane/catalog.bicep</code>) and grant the Console UAMI a Purview <em>Data Reader</em> role (<code>scripts/csa-loom/grant-purview-datamap-role.sh ROLE=data-reader</code>), or use <b>Download with label</b> to stamp a chosen label. The file downloaded without a stamp.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {(mipStatus === 'no-xmp-stream' || mipStatus === 'pdf-insufficient-xmp-padding' || mipStatus === 'ooxml-zip64-unsupported' || mipStatus === 'ooxml-parse-failed') && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Label could not be embedded in this file</MessageBarTitle>
                      {mipStatus === 'no-xmp-stream' && 'This PDF has no XMP metadata packet to stamp into. '}
                      {mipStatus === 'pdf-insufficient-xmp-padding' && 'This PDF\'s XMP packet has no spare padding to stamp into without re-flowing the file. '}
                      {mipStatus === 'ooxml-zip64-unsupported' && 'This Office file uses the ZIP64 container, which the in-proxy stamper does not modify. '}
                      {mipStatus === 'ooxml-parse-failed' && 'This Office file could not be parsed as a standard OPC package. '}
                      The file downloaded unchanged — no partial or fake stamp was written.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {mipStatus === 'error' && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Label lookup failed</MessageBarTitle>
                      Purview is configured but the label lookup failed (the file still downloaded). Confirm the Console UAMI holds a Purview <em>Data Reader</em> role on the root collection (<code>scripts/csa-loom/grant-purview-datamap-role.sh ROLE=data-reader</code>).
                    </MessageBarBody>
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
                  <div
                    className={s.tableWrap}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    style={isDragOver ? {
                      outline: `2px dashed ${tokens.colorBrandStroke1}`,
                      outlineOffset: -2,
                      backgroundColor: tokens.colorNeutralBackground2,
                    } : undefined}
                  >
                    {isDragOver && (
                      <div style={{ padding: tokens.spacingVerticalS, textAlign: 'center', color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold }}>
                        Drop files or a folder to upload into /{currentPrefix || ''} (folder tree preserved)
                      </div>
                    )}
                    <Table aria-label="Lakehouse paths" size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Name</TableHeaderCell>
                          <TableHeaderCell>Tier (preview)</TableHeaderCell>
                          <TableHeaderCell>Size</TableHeaderCell>
                          <TableHeaderCell>Modified</TableHeaderCell>
                          <TableHeaderCell>Actions</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {currentListing.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={5}>
                              <div style={{ padding: tokens.spacingVerticalXXL, textAlign: 'center' }}>
                                <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>
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
                            <TableCell className={s.cell}>
                              {!entry.isDirectory && (() => {
                                const t = fileTiers[`${activeContainer}::${entry.name}`] ?? entry.tier;
                                if (!t) return <Badge appearance="outline" size="small" color="subtle">—</Badge>;
                                const color = t === 'Hot' ? 'brand' : t === 'Cool' ? 'informative' : t === 'Cold' ? 'subtle' : 'warning';
                                return <Badge appearance="tint" size="small" color={color}>{t}</Badge>;
                              })()}
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
                                    {!entry.isDirectory && (
                                      <MenuItem icon={<ArrowDownload20Regular />} onClick={() => onDownload(entry)}>
                                        Download
                                      </MenuItem>
                                    )}
                                    {!entry.isDirectory && (
                                      <MenuItem icon={<ShieldTask20Regular />} onClick={() => openLabelDialog(entry)}>
                                        Download with label…
                                      </MenuItem>
                                    )}
                                    {!entry.isDirectory && (
                                      <MenuItem icon={<CloudArrowUp20Regular />} onClick={() => openTierDialog(entry)}>
                                        Change tier…
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
                            <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalM }}>
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
                                      <TableCell><code style={{ fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.ddl}</code></TableCell>
                                      <TableCell className={s.cell}>{t.sampleRows?.length ?? 0}</TableCell>
                                      <TableCell>
                                        <Menu>
                                          <MenuTrigger disableButtonEnhancement>
                                            <Button appearance="subtle" size="small">…</Button>
                                          </MenuTrigger>
                                          <MenuPopover>
                                            <MenuList>
                                              <MenuItem icon={<Play20Regular />}
                                                onClick={() => {
                                                  setSqlText(`-- Read Delta table (once materialized under Tables/${t.name})\nSELECT TOP 100 *\nFROM OPENROWSET(BULK 'https://__account__.dfs.core.windows.net/${activeContainer || '<container>'}/Tables/${t.name}', FORMAT='DELTA') AS r;`);
                                                  setTab('sql');
                                                }}>
                                                Query template
                                              </MenuItem>
                                              <MenuItem icon={<History20Regular />}
                                                disabled={!activeContainer}
                                                onClick={() => openTableHistory(`Tables/${t.name}`)}>
                                                History (time travel)
                                              </MenuItem>
                                              <MenuItem icon={<Wrench20Regular />}
                                                disabled={!activeContainer}
                                                title={!activeContainer ? 'Select a container first' : 'OPTIMIZE / VACUUM / ZORDER BY'}
                                                onClick={() => { setMaintainTable(t.name); setMaintainOpen(true); }}>
                                                Maintain…
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
                          </>
                        )}
                      </>
                    );
                  }
                  // F9 — schema-enabled lakehouse: the Tables/ children are
                  // schema folders; tables live one level deeper under
                  // Tables/<schema>/. Render schema groups, each lazily loading
                  // its tables, with a "Move to schema…" action per table.
                  if (schemasEnabled) {
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                        <Caption1>
                          Schema-enabled lakehouse — tables are grouped by schema. Manage schemas in the <strong>Schemas</strong> tab.
                        </Caption1>
                        {tables.map((schemaDir) => {
                          const schemaName = leafName(schemaDir.name);
                          const childKey = cacheKey(activeContainer, schemaDir.name);
                          const childListing = openPrefixes[childKey];
                          const childTables = childListing && childListing !== 'loading' && !('error' in (childListing as any))
                            ? (childListing as PathEntry[]).filter((e) => e.isDirectory) : [];
                          return (
                            <div key={schemaDir.name} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS }}>
                                <Database20Regular />
                                <Subtitle2>{schemaName}</Subtitle2>
                                {schemaName === 'dbo' && <Badge appearance="tint" color="informative" size="small">default</Badge>}
                                <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />}
                                  onClick={() => loadPaths(activeContainer, schemaDir.name)} style={{ marginLeft: 'auto' }}>
                                  {childListing ? 'Refresh' : 'Load tables'}
                                </Button>
                              </div>
                              {childListing === 'loading' && <Spinner size="tiny" label="Listing tables…" labelPosition="after" />}
                              {childListing && childListing !== 'loading' && 'error' in (childListing as any) && (
                                <Caption1>{(childListing as { error: string }).error}</Caption1>
                              )}
                              {childListing && childListing !== 'loading' && !('error' in (childListing as any)) && (
                                childTables.length === 0
                                  ? <Caption1>No tables in this schema yet.</Caption1>
                                  : (
                                    <Table aria-label={`Tables in ${schemaName}`} size="small">
                                      <TableHeader>
                                        <TableRow>
                                          <TableHeaderCell>Table</TableHeaderCell>
                                          <TableHeaderCell>4-part name</TableHeaderCell>
                                          <TableHeaderCell></TableHeaderCell>
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {childTables.map((t) => {
                                          const tableName = leafName(t.name);
                                          return (
                                            <TableRow key={t.name}>
                                              <TableCell><strong>{tableName}</strong></TableCell>
                                              <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{shortcutLakehouseId}.{schemaName}.{tableName}</code></TableCell>
                                              <TableCell>
                                                <span style={{ display: 'inline-flex', gap: tokens.spacingHorizontalS }}>
                                                  <Button size="small" appearance="primary" icon={<Eye20Regular />}
                                                    title="Sample 1,000 rows"
                                                    onClick={() => previewTable(t.name)}>
                                                    Preview
                                                  </Button>
                                                  <Button size="small" appearance="outline"
                                                    onClick={() => {
                                                      setSqlText(`-- 4-part name: ${shortcutLakehouseId}.${schemaName}.${tableName}\n-- Serverless view (if registered): SELECT TOP 100 * FROM loom_lakehouse.${schemaName}.${tableName};\nSELECT TOP 100 *\nFROM OPENROWSET(BULK 'https://__account__.dfs.core.windows.net/${activeContainer}/${t.name}', FORMAT='DELTA') AS r;`);
                                                      setTab('sql');
                                                    }}>
                                                    Query
                                                  </Button>
                                                  <Button size="small" appearance="outline" icon={<TableSimple20Regular />}
                                                    onClick={() => openMoveTable(tableName, schemaName)}>
                                                    Move to schema…
                                                  </Button>
                                                  <Button size="small" appearance="outline" icon={<History20Regular />}
                                                    onClick={() => openTableHistory(t.name)}>
                                                    History
                                                  </Button>
                                                  <Button size="small" appearance="outline" icon={<Wrench20Regular />}
                                                    disabled={!activeContainer}
                                                    title={!activeContainer ? 'Select a container first' : 'OPTIMIZE / VACUUM / ZORDER BY'}
                                                    onClick={() => { setMaintainTable(t.name); setMaintainOpen(true); }}>
                                                    Maintain…
                                                  </Button>
                                                </span>
                                              </TableCell>
                                            </TableRow>
                                          );
                                        })}
                                      </TableBody>
                                    </Table>
                                  )
                              )}
                            </div>
                          );
                        })}
                      </div>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
                      {Object.entries(bySchema).map(([schema, schemaTables]) => (
                        <div key={schema}>
                          <Subtitle2 style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS }}>
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
                                      <span style={{ display: 'inline-flex', gap: tokens.spacingHorizontalS }}>
                                        <Button size="small" appearance="primary"
                                          disabled={t.format !== 'delta'}
                                          icon={<Eye20Regular />}
                                          title={t.format !== 'delta' ? 'Preview available for Delta tables' : 'Sample 1,000 rows'}
                                          onClick={() => previewTable(t.adlsPath)}>
                                          Preview
                                        </Button>
                                        <Button size="small" appearance="outline"
                                          disabled={t.format !== 'delta'}
                                          title={t.format !== 'delta' ? 'OPENROWSET DELTA query available for Delta tables' : undefined}
                                          onClick={() => {
                                            setSqlText(`-- Read Delta table ${t.schema}.${t.name}\nSELECT TOP 100 *\nFROM OPENROWSET(BULK '${t.bulkUrl}', FORMAT='DELTA') AS r;`);
                                            setTab('sql');
                                          }}>
                                          Query
                                        </Button>
                                      </span>
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

            {tab === 'history' && (
              <>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="brand">{activeContainer || 'no container'}</Badge>
                  {historyTable ? (
                    <>
                      <Caption1>Delta version history — <strong>{leafName(historyTable)}</strong> <code style={{ fontSize: tokens.fontSizeBase100 }}>/{historyTable}</code></Caption1>
                      <Button appearance="outline" icon={<ArrowSync20Regular />}
                        disabled={historyLoading || !activeContainer}
                        onClick={() => historyTable && loadHistory(historyTable)}>
                        Refresh
                      </Button>
                    </>
                  ) : (
                    <Caption1>Open the <strong>Tables</strong> tab and choose <strong>… → History (time travel)</strong> on a Delta table to view its version log, preview any version, or restore.</Caption1>
                  )}
                </div>

                {historyLoading && <Spinner size="small" label="Reading _delta_log…" labelPosition="after" />}

                {historyError && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>History error</MessageBarTitle>
                      {historyError}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {historyRestoreMsg && (
                  <MessageBar intent={historyRestoreMsg.ok ? 'success' : 'warning'}>
                    <MessageBarBody>{historyRestoreMsg.text}</MessageBarBody>
                  </MessageBar>
                )}

                {!historyLoading && historyRows !== null && historyRows.length === 0 && !historyError && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      No committed versions found under <code>{historyTable}/_delta_log/</code>. The table may not have been materialized yet, or the path is not a Delta table.
                    </MessageBarBody>
                  </MessageBar>
                )}

                {!historyLoading && historyRows !== null && historyRows.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Delta version history" size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Version</TableHeaderCell>
                          <TableHeaderCell>Timestamp</TableHeaderCell>
                          <TableHeaderCell>Operation</TableHeaderCell>
                          <TableHeaderCell>User</TableHeaderCell>
                          <TableHeaderCell>Metrics</TableHeaderCell>
                          <TableHeaderCell>Actions</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {historyRows.map((row) => (
                          <TableRow key={row.version}>
                            <TableCell className={s.cell}>{row.version}</TableCell>
                            <TableCell className={s.cell}>{row.timestamp ? new Date(row.timestamp).toLocaleString() : '—'}</TableCell>
                            <TableCell><Badge appearance="outline">{row.operation}</Badge></TableCell>
                            <TableCell className={s.cell}>{row.userName || '—'}</TableCell>
                            <TableCell className={s.cell}>
                              {[
                                row.metrics.numOutputRows != null && `${row.metrics.numOutputRows.toLocaleString()} rows`,
                                row.metrics.numFiles != null && `${row.metrics.numFiles} files`,
                                row.metrics.numRemovedFiles != null && `${row.metrics.numRemovedFiles} removed`,
                                row.metrics.numDeletedRows != null && `${row.metrics.numDeletedRows.toLocaleString()} deleted`,
                                row.metrics.numOutputBytes != null && formatBytes(row.metrics.numOutputBytes),
                              ].filter(Boolean).join(' · ') || '—'}
                            </TableCell>
                            <TableCell>
                              <Button size="small" appearance="outline" icon={<Eye20Regular />}
                                disabled={historyPreviewLoading}
                                style={{ marginRight: tokens.spacingHorizontalXS }}
                                onClick={() => historyTable && previewAsOf(historyTable, row.version)}>
                                Preview
                              </Button>
                              <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />}
                                disabled={historyRestoring === row.version}
                                onClick={() => historyTable && restoreToVersion(historyTable, row.version)}>
                                {historyRestoring === row.version ? 'Restoring…' : 'Restore'}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {historyPreviewLoading && (
                  <Spinner size="small" label={`Querying version ${historyPreviewVersion}…`} labelPosition="after" />
                )}
                {!historyPreviewLoading && historyPreviewResult && (
                  <>
                    <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>
                      Preview — {leafName(historyTable || '')} @ version {historyPreviewVersion}
                    </Subtitle2>
                    {!historyPreviewResult.ok ? (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Preview unavailable</MessageBarTitle>
                          {historyPreviewResult.error}
                        </MessageBarBody>
                      </MessageBar>
                    ) : (historyPreviewResult.columns?.length ?? 0) === 0 ? (
                      <Caption1>Query returned no columns.</Caption1>
                    ) : (
                      <div className={s.tableWrap}>
                        <Table aria-label="Preview as of version" size="small">
                          <TableHeader>
                            <TableRow>
                              {(historyPreviewResult.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(historyPreviewResult.rows || []).map((row, i) => (
                              <TableRow key={i}>
                                {(historyPreviewResult.columns || []).map((_, j) => (
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
              </>
            )}

            {tab === 'schemas' && (
              <>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="brand">{shortcutLakehouseId || 'no lakehouse'}</Badge>
                  <Caption1>
                    Multi-schema namespace — <code>workspace.lakehouse.schema.table</code>. <strong>dbo</strong> is the default (immutable).
                  </Caption1>
                  <Button appearance="primary" icon={<Add20Regular />}
                    disabled={!schemasEnabled || !shortcutLakehouseId}
                    onClick={() => { setNewSchemaName(''); setNewSchemaDesc(''); setNewSchemaError(null); setNewSchemaOpen(true); }}
                    style={{ marginLeft: 'auto' }}>
                    New schema
                  </Button>
                  <Button appearance="outline" icon={<ArrowSync20Regular />}
                    disabled={schemasBusy || !shortcutLakehouseId} onClick={loadSchemas}>
                    Refresh
                  </Button>
                </div>
                {!schemasEnabled && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Schemas are disabled for this lakehouse</MessageBarTitle>
                      Enable <strong>Schemas enabled</strong> in the Settings dialog (gear icon) to use
                      multi-schema namespaces. Schema DDL runs on a Synapse Spark pool via Livy — set
                      <code> LOOM_SYNAPSE_WORKSPACE</code> (and grant the Console UAMI Synapse Administrator)
                      to execute it. The catalog still records schemas without it.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {schemasError && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Schemas error</MessageBarTitle>{schemasError}</MessageBarBody></MessageBar>
                )}
                {schemasBusy && schemas === null && <Spinner size="small" label="Loading schemas…" labelPosition="after" />}
                {schemas !== null && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Lakehouse schemas" size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Schema</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Description</TableHeaderCell>
                          <TableHeaderCell></TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {schemas.map((sc) => (
                          <TableRow key={sc.name}>
                            <TableCell>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                                <Database20Regular />
                                <strong>{sc.name}</strong>
                                {sc.isDefault && <Badge appearance="tint" color="informative" size="small">default</Badge>}
                              </span>
                            </TableCell>
                            <TableCell>
                              {sc.status === 'active' && <Badge appearance="tint" color="success" size="small">active</Badge>}
                              {sc.status === 'pending' && <Badge appearance="tint" color="warning" size="small" title={sc.statusDetail}>pending</Badge>}
                              {sc.status === 'error' && <Badge appearance="tint" color="danger" size="small" title={sc.statusDetail}>error</Badge>}
                            </TableCell>
                            <TableCell><Caption1>{sc.description || '—'}</Caption1></TableCell>
                            <TableCell>
                              {!sc.isDefault && (
                                <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                                  disabled={schemasBusy} onClick={() => deleteSchema(sc.name)}>
                                  Delete
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'shortcuts' && (
              <div
                onKeyDown={(e) => {
                  // F11 retries the selected broken shortcut (re-test/restore).
                  if (e.key === 'F11' && selectedShortcut && selectedShortcut.status === 'error' && !shortcutsBusy) {
                    e.preventDefault();
                    testShortcut(selectedShortcut);
                  }
                }}
                style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 }}
              >
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM }}>
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
                                      <CloudLink20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
                                      <strong>{sc.name}</strong>
                                    </TableCell>
                                    <TableCell><code style={{ fontSize: tokens.fontSizeBase100, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{sc.target}</code></TableCell>
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
                          <TableRow
                            key={sc.id}
                            tabIndex={0}
                            onClick={() => setSelectedShortcut(sc)}
                            onFocus={() => setSelectedShortcut(sc)}
                            style={selectedShortcut?.id === sc.id ? { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: -2 } : undefined}
                          >
                            <TableCell>
                              <CloudLink20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
                              <strong>{sc.name}</strong>
                            </TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{sc.fullPath}</code></TableCell>
                            <TableCell>
                              <Badge appearance="outline" color={sc.targetType === 'adls' || sc.targetType === 'internal' ? 'brand' : 'warning'}>
                                {sc.targetType}
                              </Badge>
                            </TableCell>
                            <TableCell>{sc.engine && sc.engine !== 'none' ? sc.engine : '—'}</TableCell>
                            <TableCell>
                              {sc.status === 'active' && <Badge appearance="tint" color="success" icon={<CheckmarkCircle20Filled aria-hidden="true" />}>active</Badge>}
                              {sc.status === 'pending' && <Badge appearance="tint" color="warning" icon={<Clock20Regular aria-hidden="true" />} title={sc.statusDetail}>pending</Badge>}
                              {sc.status === 'error' && <Badge appearance="tint" color="danger" icon={<ErrorCircle20Filled aria-hidden="true" />} title={sc.statusDetail}>Broken</Badge>}
                            </TableCell>
                            <TableCell>
                              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' }}>
                                {sc.status === 'error' && (
                                  <Button size="small" appearance="outline" icon={<ArrowSync20Regular />}
                                    onClick={() => testShortcut(sc)} disabled={shortcutsBusy}
                                    title={`Retry — re-test the shortcut after fixing ${sc.targetType === 'delta_sharing' ? 'the Key Vault credential file' : 'the underlying issue'} (F11 on the selected row)`}>
                                    Retry
                                  </Button>
                                )}
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
                                      {!(sc.kind === 'tables' && sc.engineObject) && (
                                        <MenuItem icon={<Play20Regular />} onClick={() => queryShortcut(sc)}>Query (SQL)</MenuItem>
                                      )}
                                      <MenuItem icon={<ArrowSync20Regular />} onClick={() => testShortcut(sc)}>Test</MenuItem>
                                      <MenuItem icon={<Delete20Regular />} onClick={() => deleteShortcutRow(sc)}>Delete</MenuItem>
                                    </MenuList>
                                  </MenuPopover>
                                </Menu>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}

            {tab === 'preview' && (
              <>
                {!activePath && (
                  <EmptyState
                    icon={<Eye20Regular />}
                    title="No file selected"
                    body="Pick a Parquet, CSV, or JSON file in the Files tab to preview its first rows via OPENROWSET."
                    primaryAction={{ label: 'Go to Files', appearance: 'primary', onClick: () => setTab('files') }}
                  />
                )}
                {activePath?.isDirectory && (
                  <EmptyState
                    icon={<Folder20Regular />}
                    title={`${leafName(activePath.name)} is a folder`}
                    body="Folders can't be previewed. Select a file inside this folder to see its rows."
                    primaryAction={{ label: 'Go to Files', appearance: 'primary', onClick: () => setTab('files') }}
                  />
                )}
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
                    {!previewLoading && preview?.ok && preview.previewable === false && (
                      <MessageBar intent="info">
                        <MessageBarBody>{preview.message || 'This file type is not tabular — use Download to view it.'}</MessageBarBody>
                      </MessageBar>
                    )}
                    {!previewLoading && preview?.ok && preview.previewable !== false && (
                      (preview.columns?.length ?? 0) === 0 ? (
                        <Caption1>Query returned no rows.</Caption1>
                      ) : (
                        <DeltaPreviewGrid
                          columns={preview.columns || []}
                          rows={(preview.rows as unknown[][]) || []}
                          rowCount={preview.rowCount ?? (preview.rows?.length ?? 0)}
                          executionMs={preview.executionMs}
                          truncated={preview.truncated}
                          columnStats={columnStats}
                          statsLoading={statsLoading}
                          statsError={statsError}
                          mode={previewMode}
                          onModeChange={(m) => {
                            // Fabric's File/Table preview toggle switches the
                            // lakehouse explorer between its Files and Tables
                            // sections — navigate there so the control is live,
                            // not a cosmetic highlight.
                            setPreviewMode(m);
                            setTab(m === 'table' ? 'tables' : 'files');
                          }}
                        />
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
                  <OpenInPbiDesktopButton type="lakehouse" id={id} name={item?.displayName} />
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
                    <MenuItem icon={<ShieldTask20Regular />} onClick={() => { if (ctxEntry) openLabelDialog(ctxEntry); setCtxOpen(false); }}>Download with label…</MenuItem>
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
                      <Caption1>Choose the source to virtualize into <strong>{shortcutLakehouseId}</strong>. ADLS Gen2 and internal Loom lakehouse work on the Console UAMI; external clouds (S3, GCS, Dataverse) store credentials in Key Vault.</Caption1>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM }}>
                        {SHORTCUT_SOURCE_CARDS.map((src) => (
                          <Button
                            key={src.type}
                            appearance={scType === src.type ? 'primary' : 'outline'}
                            onClick={() => setScType(src.type)}
                            style={{ justifyContent: 'flex-start', height: 'auto', padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`, textAlign: 'left' }}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, width: '100%' }}>
                              <ShortcutSourceLogo type={src.type} size={28} />
                              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: tokens.spacingVerticalXXS, minWidth: 0 }}>
                                <span style={{ fontWeight: tokens.fontWeightSemibold }}>{src.label}</span>
                                <Caption1 style={{ color: tokens.colorNeutralForeground3, whiteSpace: 'normal' }}>{src.blurb}</Caption1>
                                <Badge appearance="tint" color={src.uamiReady ? 'success' : 'warning'} size="small">
                                  {src.uamiReady ? 'UAMI-ready' : 'Key Vault credential'}
                                </Badge>
                              </span>
                            </span>
                          </Button>
                        ))}
                      </div>
                    </>
                  )}

                  {scStep === 2 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalMNudge }}>
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
                            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
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
                                    // Always bind via the .dfs endpoint (ADLS Gen2 multi-protocol):
                                    // a blob-only account's .blob host → .dfs so the abfss URI the
                                    // backend builds parses + lists on the UAMI. Sovereign-correct
                                    // (commercial + Gov share the blob↔dfs swap).
                                    const host = a.dfsHost || (a.blobHost ? a.blobHost.replace(/\.blob\./i, '.dfs.') : '');
                                    return <Option key={a.name} value={host} text={a.name}>{a.name}{a.isHns ? ' (ADLS Gen2)' : ' (Blob)'}{a.resourceGroup ? ` · ${a.resourceGroup}` : ''}</Option>;
                                  })}
                                </Dropdown>
                              </Field>
                              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                                <Field label="Container / filesystem" required style={{ flex: 1 }}>
                                  <Input value={scAdlsContainer} onChange={(_, d) => setScAdlsContainer(d.value)} placeholder="landing" />
                                </Field>
                                <Field label="Path" hint="folder under the container (optional)" style={{ flex: 1 }}>
                                  <Input value={scAdlsPath} onChange={(_, d) => setScAdlsPath(d.value)} placeholder="eventhub-capture" />
                                </Field>
                              </div>
                              {scAcctHost && scAdlsContainer && (
                                <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                                  abfss://{scAdlsContainer}@{scAcctHost}/{(extCreds.selectedPath || scAdlsPath).replace(/^\/+/, '')}
                                </Caption1>
                              )}
                              {scAcctHost && scAdlsContainer && (
                                <Field label="Browse remote objects" hint="Click a folder or file to set the path (runs on the Console UAMI).">
                                  <RemoteBrowseTree
                                    sourceType="adls"
                                    account={scAcctHost.split('.')[0]}
                                    container={scAdlsContainer}
                                    onSelect={(path) => { setExtCreds((c) => ({ ...c, selectedPath: path })); setScAdlsPath(path); }}
                                    selectedPath={extCreds.selectedPath}
                                  />
                                </Field>
                              )}
                            </>
                          ) : (
                            <>
                              <Field label="Target URI" required
                                hint="abfss://<container>@<account>.dfs.core.windows.net/<path> — an external account the Console UAMI cannot read (authenticated by the SAS below)">
                                <Input value={scTargetUri} onChange={(_, d) => setScTargetUri(d.value)}
                                  placeholder="abfss://data@acct.dfs.core.windows.net/partner/exports" />
                              </Field>
                              <Field label="SAS token" hint="Paste the account/service SAS (read+list). Saved to Key Vault — never stored on the shortcut row or echoed.">
                                <Input type="password" value={scExtSas} onChange={(_, d) => setScExtSas(d.value)}
                                  placeholder="?sv=2024-…&ss=b&srt=co&sp=rl&sig=…"
                                  contentAfter={
                                    <Button size="small" appearance="primary" disabled={!scExtSas.trim() || scExtSasBusy}
                                      icon={scExtSasBusy ? <Spinner size="tiny" /> : undefined} onClick={stashExternalSas}>
                                      {scExtSasBusy ? 'Saving…' : 'Save to Key Vault'}
                                    </Button>
                                  } />
                              </Field>
                              {scExtSasErr && <MessageBar intent="error"><MessageBarBody>{scExtSasErr}</MessageBarBody></MessageBar>}
                              <Field label="Key Vault secret name" required hint="admin-plane Key Vault secret holding the external account's SAS/key. Auto-filled after Save, or type the name of an existing secret.">
                                <Input value={scKvSecret} onChange={(_, d) => setScKvSecret(d.value)} placeholder="shortcut-ext-adls-sas" />
                              </Field>
                              {scKvSecret && (
                                <Caption1 style={{ color: tokens.colorPaletteGreenForeground1 }}>
                                  Using Key Vault secret <code>{scKvSecret}</code> — the SAS is read server-side at create/test time.
                                </Caption1>
                              )}
                            </>
                          )}
                        </>
                      )}
                      {(scType === 's3' || scType === 'gcs' || scType === 'dataverse') && (
                        <>
                          <Field label="Shortcut name" required hint="Used to name the Key Vault secret and the shortcut.">
                            <Input value={scName} onChange={(_, d) => setScName(d.value)} placeholder={scType === 's3' ? 'partner_products' : scType === 'gcs' ? 'gcs_exports' : 'dataverse_accounts'} />
                          </Field>
                          <ExternalCredsForm
                            sourceType={scType as CredSourceType}
                            lakehouseId={shortcutLakehouseId}
                            shortcutName={scName}
                            value={extCreds}
                            onChange={setExtCreds}
                          />
                          <Field label="Browse remote objects" hint="Click a folder or file to set the shortcut target.">
                            <RemoteBrowseTree
                              sourceType={scType as CredSourceType}
                              bucket={extCreds.bucket}
                              region={extCreds.region}
                              kvSecret={extCreds.secretName}
                              onSelect={(path) => setExtCreds((c) => ({ ...c, selectedPath: path }))}
                              selectedPath={extCreds.selectedPath}
                            />
                          </Field>
                          {(scType === 's3' || scType === 'gcs') && extCreds.bucket && (
                            <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                              {scType === 's3' ? 's3' : 'gs'}://{extCreds.bucket}/{(extCreds.selectedPath || '').replace(/^\/+/, '')}
                            </Caption1>
                          )}
                        </>
                      )}
                      {scType === 'delta_sharing' && (
                        <>
                          <MessageBar intent="warning">
                            <MessageBarBody>
                              <MessageBarTitle>Delta Sharing (cross-tenant)</MessageBarTitle>
                              Authenticates with a credential file the share owner gives you via an
                              activation link. Store the raw JSON (<code>shareCredentialsVersion</code>,
                              <code> endpoint</code>, <code>bearerToken</code>, <code>expirationTime</code>) as a
                              Key Vault secret and name it below. Bearer tokens expire after at most 1 year —
                              if the share goes <strong>Broken</strong>, update the secret with a fresh file
                              and use <strong>Retry</strong>. A <em>Tables</em> shortcut registers a Databricks
                              Unity Catalog table over the <code>deltaSharing</code> provider (needs
                              LOOM_DATABRICKS_HOSTNAME); a <em>Files</em> shortcut validates the share server only.
                            </MessageBarBody>
                          </MessageBar>
                          <Field label="Share / table path" required
                            hint="delta-sharing://<share>/<schema>/<table> — from the data provider">
                            <Input value={scTargetUri} onChange={(_, d) => setScTargetUri(d.value)}
                              placeholder="delta-sharing://agency_a_perf/analytics/metrics_monthly" />
                          </Field>
                          <Field label="Key Vault secret name (credential file JSON)" required
                            hint="Holds the full credential JSON: { shareCredentialsVersion, endpoint, bearerToken, expirationTime }">
                            <Input value={scKvSecret} onChange={(_, d) => setScKvSecret(d.value)}
                              placeholder="delta-sharing-agency-a-cred" />
                          </Field>
                        </>
                      )}
                      {scType === 'sharepoint' && (
                        <>
                          <Field label="Shortcut name" required hint="Names the Files shortcut that surfaces this SharePoint/OneDrive content.">
                            <Input value={scName} onChange={(_, d) => { setScName(d.value); setScKind('files'); }} placeholder="finance_reports" />
                          </Field>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                            Browse Microsoft Graph on the Console identity — pick a SharePoint document library
                            folder/file or a OneDrive item. Content is virtualized zero-copy under <strong>Files</strong>;
                            no bytes are copied. SharePoint/OneDrive shortcuts are Files-only (Graph is a file API).
                          </Caption1>
                          <SharePointBrowser
                            onSelect={(sel) => {
                              setScSpSelection(sel);
                              setScKind('files');
                              if (!scName.trim() && sel.path) {
                                setScName((sel.path.split('/').filter(Boolean).pop() || '').replace(/[^A-Za-z0-9 _.-]/g, '_'));
                              }
                            }}
                            selected={scSpSelection ? { driveId: scSpSelection.driveId, path: scSpSelection.path } : undefined}
                          />
                        </>
                      )}
                    </div>
                  )}

                  {scStep === 3 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalMNudge }}>
                      <Field label="Section" required hint={scType === 'sharepoint' ? 'SharePoint / OneDrive content surfaces under Files (Graph is a file API).' : undefined}>
                        <Dropdown
                          selectedOptions={[scKind]}
                          value={scKind === 'tables' ? 'Tables' : 'Files'}
                          disabled={scType === 'sharepoint'}
                          onOptionSelect={(_, d) => setScKind((d.optionValue as ShortcutKind) || 'files')}
                        >
                          <Option value="files">Files</Option>
                          {scType !== 'sharepoint' && <Option value="tables">Tables</Option>}
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
                      {scKind === 'tables' && schemasEnabled && (
                        <Field label="Target schema"
                          hint="The schema-enabled lakehouse places this Tables shortcut under the chosen schema (Tables/<schema>/). 'dbo' is the default.">
                          <Dropdown
                            selectedOptions={[scTargetSchema || 'dbo']}
                            value={scTargetSchema || 'dbo'}
                            onOptionSelect={(_, d) => setScTargetSchema(d.optionValue || 'dbo')}
                          >
                            {(schemas || [{ name: 'dbo', isDefault: true } as SchemaRow]).map((sch) => (
                              <Option key={sch.name} value={sch.name}>{`${sch.name}${sch.isDefault ? ' (default)' : ''}`}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                      )}
                      <MessageBar intent="info">
                        <MessageBarBody>
                          Will create <strong>{scKind === 'tables' ? 'Tables' : 'Files'}/{[scParentPath.trim(), scName.trim()].filter(Boolean).join('/')}</strong>
                          {' '}pointing at <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{scType === 'internal' ? `internal://${scInternalContainer}${scInternalPath ? `/${scInternalPath.replace(/^\/+/, '')}` : ''}` : scType === 'sharepoint' ? (scSpSelection ? `sharepoint://${scSpSelection.driveId}/${scSpSelection.path}` : '(select a SharePoint/OneDrive item)') : (scTargetUri || '(set the target)')}</code>.
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

          {/* "Download with sensitivity label" — pick a tenant MIP label, then
              the download proxy stamps the bytes (PDF XMP / OOXML custom props). */}
          <Dialog open={labelDlgOpen} onOpenChange={(_, d) => { if (!d.open) setLabelDlgOpen(false); }}>
            <DialogSurface style={{ maxWidth: 520 }}>
              <DialogBody>
                <DialogTitle>Download with sensitivity label</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <Caption1>
                      Stamp a Microsoft Information Protection sensitivity label onto{' '}
                      <strong>{labelDlgEntry ? leafName(labelDlgEntry.name) : ''}</strong> as it downloads.
                      Supported for Office (.docx/.xlsx/.pptx) and PDF — other types download unstamped.
                    </Caption1>
                    {mipLabelsLoading && <Spinner size="small" label="Loading sensitivity labels…" labelPosition="after" />}
                    {mipLabelsError && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Sensitivity labels unavailable</MessageBarTitle>
                          {mipLabelsError}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {!mipLabelsLoading && !mipLabelsError && mipLabels && mipLabels.length > 0 && (
                      <Field label="Sensitivity label">
                        <Dropdown
                          placeholder="Select a label"
                          selectedOptions={chosenLabelId ? [chosenLabelId] : []}
                          value={(mipLabels.find((l) => l.id === chosenLabelId)?.displayName) || (mipLabels.find((l) => l.id === chosenLabelId)?.name) || ''}
                          onOptionSelect={(_, d) => setChosenLabelId(d.optionValue || '')}
                        >
                          {mipLabels.map((l) => (
                            <Option key={l.id} value={l.id} text={l.displayName || l.name || l.id}>
                              {l.displayName || l.name || l.id}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setLabelDlgOpen(false)}>Cancel</Button>
                  <Button
                    appearance="primary"
                    icon={<ShieldTask20Regular />}
                    disabled={!chosenLabelId}
                    onClick={confirmLabelDownload}
                  >
                    Download with label
                  </Button>
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
                    <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}><MessageBarBody>{refsError}</MessageBarBody></MessageBar>
                  )}
                  {(() => {
                    const referenced = new Set((references ?? []).map((r) => r.id));
                    const addable = workspaceLakehouses.filter((lh) => lh.id !== id && !referenced.has(lh.id));
                    return (
                      <Table size="small" style={{ marginTop: tokens.spacingVerticalM }} aria-label="Workspace lakehouses">
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
                                <Database20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
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
                        <TableRow><TableCell><strong>Path</strong></TableCell><TableCell className={s.cell} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>/{propsEntry.name}</TableCell></TableRow>
                        <TableRow><TableCell><strong>Container</strong></TableCell><TableCell className={s.cell}>{activeContainer}</TableCell></TableRow>
                        <TableRow><TableCell><strong>Type</strong></TableCell><TableCell>{propsEntry.isDirectory ? 'Directory' : 'File'}</TableCell></TableRow>
                        {!propsEntry.isDirectory && <TableRow><TableCell><strong>Size</strong></TableCell><TableCell className={s.cell}>{formatBytes(propsEntry.size)}</TableCell></TableRow>}
                        <TableRow><TableCell><strong>Last modified</strong></TableCell><TableCell className={s.cell}>{propsEntry.lastModified ? new Date(propsEntry.lastModified).toLocaleString() : '—'}</TableCell></TableRow>
                        {propsEntry.etag && <TableRow><TableCell><strong>ETag</strong></TableCell><TableCell className={s.cell} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{propsEntry.etag}</TableCell></TableRow>}
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
            <DialogSurface style={{ maxWidth: '1000px', width: '92vw' }}>
              <DialogBody>
                <DialogTitle>Permissions — {activeContainer}</DialogTitle>
                <DialogContent>
                  <TabList
                    selectedValue={permsTab}
                    onTabSelect={(_, d) => selectPermsTab(d.value as PermsTab)}
                    style={{ marginBottom: tokens.spacingVerticalM }}
                  >
                    <Tab value="object">Object (RBAC)</Tab>
                    <Tab value="table">Table</Tab>
                    <Tab value="column">Column</Tab>
                    <Tab value="row">Row</Tab>
                  </TabList>

                  {permsBusy && <Spinner size="tiny" label="Working…" labelPosition="after" />}
                  {permsError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Permissions error</MessageBarTitle>{permsError}</MessageBarBody></MessageBar>
                  )}
                  {permsTab !== 'object' && sqlGate && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Synapse Dedicated SQL pool not configured</MessageBarTitle>
                        Set <code>{sqlGate.missing}</code>. {sqlGate.hint}
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  {/* ── Object (container RBAC) ── */}
                  {permsTab === 'object' && (
                    <>
                      <Caption1>
                        Azure RBAC role assignments scoped to the container. Storage Blob Data
                        Reader/Contributor/Owner govern data-plane access (read/write/manage).
                      </Caption1>
                      <div style={{ overflow: 'auto', margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalM}` }}>
                        <Table aria-label="Role assignments" size="small">
                          <TableHeader><TableRow>
                            <TableHeaderCell>Principal</TableHeaderCell>
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
                                <TableCell>{r.upn ? <span>{r.upn}</span> : <code style={{ fontSize: tokens.fontSizeBase100 }}>{r.principalId?.slice(0, 8)}…</code>}</TableCell>
                                <TableCell>{r.principalType || '—'}</TableCell>
                                <TableCell>{r.roleName || '—'}</TableCell>
                                <TableCell><Button size="small" appearance="subtle" disabled={permsBusy} onClick={() => revokePerm(r.id)}>Revoke</Button></TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      <Subtitle2>Grant access</Subtitle2>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,2fr)', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS }}>
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
                      <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', justifyContent: 'flex-end' }}>
                        <Button appearance="primary" onClick={grantPerm} disabled={permsBusy || !newPrincipalId.trim()}>
                          {permsBusy ? 'Working…' : 'Grant role'}
                        </Button>
                      </div>
                    </>
                  )}

                  {/* ── Table-level SELECT ── */}
                  {permsTab === 'table' && !sqlGate && (
                    <>
                      <Caption1>
                        Object-level <code>GRANT SELECT</code> on a Synapse Dedicated SQL pool table/view.
                        Principals are Entra users (UPN); the database user is created
                        <code> FROM EXTERNAL PROVIDER</code> on first grant.
                      </Caption1>
                      <div style={{ overflow: 'auto', margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalM}` }}>
                        <Table aria-label="Table grants" size="small">
                          <TableHeader><TableRow>
                            <TableHeaderCell>Principal (UPN)</TableHeaderCell>
                            <TableHeaderCell>Schema.Table</TableHeaderCell>
                            <TableHeaderCell>Permission</TableHeaderCell>
                            <TableHeaderCell>Action</TableHeaderCell>
                          </TableRow></TableHeader>
                          <TableBody>
                            {sqlGrants.filter((g) => g.column == null).length === 0 && (
                              <TableRow><TableCell colSpan={4}><Caption1>No table-level SELECT grants.</Caption1></TableCell></TableRow>
                            )}
                            {sqlGrants.filter((g) => g.column == null).map((g, i) => (
                              <TableRow key={`${g.principal}.${g.schema}.${g.table}.${i}`}>
                                <TableCell>{g.principal}</TableCell>
                                <TableCell>{g.schema}.{g.table}</TableCell>
                                <TableCell>{g.permissionName}</TableCell>
                                <TableCell><Button size="small" appearance="subtle" disabled={permsBusy} onClick={() => revokeSqlGrant(g)}>Revoke</Button></TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      <Subtitle2>Grant table SELECT</Subtitle2>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS }}>
                        {renderPrincipalPicker()}
                        <Field label="Table / view" required>
                          <Dropdown
                            placeholder="Select a table"
                            selectedOptions={selTableId != null ? [String(selTableId)] : []}
                            value={selTableId != null ? (sqlTables.find((t) => t.objectId === selTableId) ? `${sqlTables.find((t) => t.objectId === selTableId)!.schema}.${sqlTables.find((t) => t.objectId === selTableId)!.name}` : '') : ''}
                            onOptionSelect={(_, d) => onPickTable(d.optionValue ? Number(d.optionValue) : null)}
                          >
                            {sqlTables.map((t) => (
                              <Option key={t.objectId} value={String(t.objectId)} text={`${t.schema}.${t.name}`}>{t.schema}.{t.name}{t.type === 'V' ? ' (view)' : ''}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                      </div>
                      <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', justifyContent: 'flex-end' }}>
                        <Button appearance="primary" onClick={grantSqlTable} disabled={permsBusy || !selectedPrincipal || selTableId == null}>
                          Grant SELECT
                        </Button>
                      </div>
                    </>
                  )}

                  {/* ── Column-level SELECT ── */}
                  {permsTab === 'column' && !sqlGate && (
                    <>
                      <Caption1>
                        Column-level <code>GRANT SELECT</code> restricts a principal to specific columns of a
                        table/view. Pick a table, then check the columns to expose.
                      </Caption1>
                      <div style={{ overflow: 'auto', margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalM}` }}>
                        <Table aria-label="Column grants" size="small">
                          <TableHeader><TableRow>
                            <TableHeaderCell>Principal (UPN)</TableHeaderCell>
                            <TableHeaderCell>Schema.Table</TableHeaderCell>
                            <TableHeaderCell>Column</TableHeaderCell>
                            <TableHeaderCell>Action</TableHeaderCell>
                          </TableRow></TableHeader>
                          <TableBody>
                            {sqlGrants.filter((g) => g.column != null).length === 0 && (
                              <TableRow><TableCell colSpan={4}><Caption1>No column-level SELECT grants.</Caption1></TableCell></TableRow>
                            )}
                            {sqlGrants.filter((g) => g.column != null).map((g, i) => (
                              <TableRow key={`${g.principal}.${g.schema}.${g.table}.${g.column}.${i}`}>
                                <TableCell>{g.principal}</TableCell>
                                <TableCell>{g.schema}.{g.table}</TableCell>
                                <TableCell>{g.column}</TableCell>
                                <TableCell><Button size="small" appearance="subtle" disabled={permsBusy} onClick={() => revokeSqlGrant(g)}>Revoke</Button></TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      <Subtitle2>Grant column SELECT</Subtitle2>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS }}>
                        {renderPrincipalPicker()}
                        <Field label="Table / view" required>
                          <Dropdown
                            placeholder="Select a table"
                            selectedOptions={selTableId != null ? [String(selTableId)] : []}
                            value={selTableId != null && sqlTables.find((t) => t.objectId === selTableId) ? `${sqlTables.find((t) => t.objectId === selTableId)!.schema}.${sqlTables.find((t) => t.objectId === selTableId)!.name}` : ''}
                            onOptionSelect={(_, d) => onPickTable(d.optionValue ? Number(d.optionValue) : null)}
                          >
                            {sqlTables.map((t) => (
                              <Option key={t.objectId} value={String(t.objectId)} text={`${t.schema}.${t.name}`}>{t.schema}.{t.name}{t.type === 'V' ? ' (view)' : ''}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                      </div>
                      {selTableId != null && (
                        <div style={{ marginTop: tokens.spacingVerticalM }}>
                          <Caption1>Columns to expose ({selColIds.length} selected)</Caption1>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: tokens.spacingHorizontalXS, maxHeight: 200, overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalXS }}>
                            {sqlCols.length === 0 && <Caption1>No columns.</Caption1>}
                            {sqlCols.map((c) => (
                              <Checkbox
                                key={c.columnId}
                                label={`${c.name} (${c.dataType})`}
                                checked={selColIds.includes(c.columnId)}
                                onChange={(_, d) => toggleCol(c.columnId, !!d.checked)}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                      <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', justifyContent: 'flex-end' }}>
                        <Button appearance="primary" onClick={grantSqlColumn} disabled={permsBusy || !selectedPrincipal || selTableId == null || selColIds.length === 0}>
                          Grant column SELECT
                        </Button>
                      </div>
                    </>
                  )}

                  {/* ── Row-level security ── */}
                  {permsTab === 'row' && !sqlGate && (
                    <>
                      <Caption1>
                        Row-level security applies a <code>SECURITY POLICY</code> + inline filter predicate so a
                        principal only sees rows whose filter column matches their identity. Dedicated SQL pool only.
                      </Caption1>
                      <div style={{ overflow: 'auto', margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalM}` }}>
                        <Table aria-label="Security policies" size="small">
                          <TableHeader><TableRow>
                            <TableHeaderCell>Policy</TableHeaderCell>
                            <TableHeaderCell>Target table</TableHeaderCell>
                            <TableHeaderCell>Enabled</TableHeaderCell>
                            <TableHeaderCell>Action</TableHeaderCell>
                          </TableRow></TableHeader>
                          <TableBody>
                            {rlsPolicies.length === 0 && (
                              <TableRow><TableCell colSpan={4}><Caption1>No row-level security policies.</Caption1></TableCell></TableRow>
                            )}
                            {rlsPolicies.map((p) => (
                              <TableRow key={p.policyObjectId}>
                                <TableCell>{p.policySchema}.{p.policyName}</TableCell>
                                <TableCell>{p.schema}.{p.table}</TableCell>
                                <TableCell>{p.isEnabled ? 'Yes' : 'No'}</TableCell>
                                <TableCell><Button size="small" appearance="subtle" disabled={permsBusy} onClick={() => dropRls(p)}>Drop</Button></TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      <Subtitle2>Create row-level security policy</Subtitle2>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS }}>
                        <Field label="Table" required>
                          <Dropdown
                            placeholder="Select a table"
                            selectedOptions={selTableId != null ? [String(selTableId)] : []}
                            value={selTableId != null && sqlTables.find((t) => t.objectId === selTableId) ? `${sqlTables.find((t) => t.objectId === selTableId)!.schema}.${sqlTables.find((t) => t.objectId === selTableId)!.name}` : ''}
                            onOptionSelect={(_, d) => onPickTable(d.optionValue ? Number(d.optionValue) : null)}
                          >
                            {sqlTables.filter((t) => t.type === 'U').map((t) => (
                              <Option key={t.objectId} value={String(t.objectId)} text={`${t.schema}.${t.name}`}>{t.schema}.{t.name}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                        <Field label="Filter column" required>
                          <Dropdown
                            placeholder="Select a column"
                            selectedOptions={rlsFilterColId != null ? [String(rlsFilterColId)] : []}
                            value={rlsFilterColId != null && sqlCols.find((c) => c.columnId === rlsFilterColId) ? sqlCols.find((c) => c.columnId === rlsFilterColId)!.name : ''}
                            onOptionSelect={(_, d) => setRlsFilterColId(d.optionValue ? Number(d.optionValue) : null)}
                            disabled={selTableId == null}
                          >
                            {sqlCols.map((c) => (
                              <Option key={c.columnId} value={String(c.columnId)} text={c.name}>{c.name} ({c.dataType})</Option>
                            ))}
                          </Dropdown>
                        </Field>
                        <Field label="Match against">
                          <Dropdown
                            selectedOptions={[rlsSubject]}
                            value={rlsSubject}
                            onOptionSelect={(_, d) => setRlsSubject((d.optionValue as 'USER_NAME()' | 'SUSER_SNAME()') || 'USER_NAME()')}
                          >
                            <Option value="USER_NAME()" text="USER_NAME()">USER_NAME() — DB user (UPN)</Option>
                            <Option value="SUSER_SNAME()" text="SUSER_SNAME()">SUSER_SNAME() — login name</Option>
                          </Dropdown>
                        </Field>
                      </div>
                      <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS }}>
                        Predicate: rows are visible when the filter column equals <code>{rlsSubject}</code> or the
                        caller is <code>db_owner</code>.
                      </Caption1>
                      <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', justifyContent: 'flex-end' }}>
                        <Button appearance="primary" onClick={createRls} disabled={permsBusy || selTableId == null || rlsFilterColId == null}>
                          Create policy
                        </Button>
                      </div>

                      <div style={{ marginTop: tokens.spacingVerticalXL, paddingTop: tokens.spacingVerticalL, borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
                        <OnelakeRlsPredicateEditor
                          tables={sqlTables}
                          onSaved={() => loadSqlPerms('row')}
                        />
                      </div>
                    </>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setPermsOpen(false)} disabled={permsBusy}>Close</Button>
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
                  <Field
                    label="Schemas enabled"
                    hint="Multi-schema namespace (workspace.lakehouse.schema.table). Tables live under Tables/<schema>/. Schema DDL runs on a Synapse Spark pool via Livy (LOOM_SYNAPSE_WORKSPACE). 'dbo' is always the immutable default."
                  >
                    <Switch
                      checked={settings.schemasEnabled ?? false}
                      onChange={(_, d) => setSettings((s) => ({ ...s, schemasEnabled: d.checked }))}
                      label={settings.schemasEnabled ? 'Enabled' : 'Disabled'}
                    />
                  </Field>

                  {/* ---- Liquid clustering (Fabric F12 parity → real ALTER TABLE … CLUSTER BY) ---- */}
                  <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Liquid clustering</Subtitle2>
                  <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalXS }}>
                    <MessageBarBody>
                      Liquid clustering replaces static partitioning and ZORDER. On save, Loom runs a
                      real <code>ALTER TABLE delta.`abfss://…` CLUSTER BY (&lt;columns&gt;)</code> on the
                      named Delta table via a Databricks SQL Warehouse — no Fabric dependency. Run{' '}
                      <code>OPTIMIZE</code> in a notebook afterward to re-cluster existing rows. Requires{' '}
                      <strong>LOOM_DATABRICKS_HOSTNAME</strong> to be set.
                    </MessageBarBody>
                  </MessageBar>
                  <Field label="Table to cluster" hint="Delta table under /Tables/ in this container.">
                    {(() => {
                      const listing = activeContainer ? openPrefixes[cacheKey(activeContainer, 'Tables')] : undefined;
                      const liveNames = Array.isArray(listing)
                        ? listing.filter((e) => e.isDirectory).map((e) => leafName(e.name))
                        : [];
                      const bundleNames = bundleDeltaTables.map((t) => t.name);
                      const allNames = Array.from(new Set([...liveNames, ...bundleNames])).sort();
                      if (allNames.length > 0) {
                        return (
                          <Dropdown
                            selectedOptions={lcTableName ? [lcTableName] : []}
                            value={lcTableName}
                            placeholder="Select a Delta table"
                            onOptionSelect={(_, d) => setLcTableName(d.optionValue || '')}
                          >
                            {allNames.map((n) => (<Option key={n} value={n}>{n}</Option>))}
                          </Dropdown>
                        );
                      }
                      return (
                        <Input
                          value={lcTableName}
                          onChange={(_, d) => setLcTableName(d.value)}
                          placeholder="bronze_player_profile"
                        />
                      );
                    })()}
                  </Field>
                  <Field label="Clustering columns" hint="Comma-separated, e.g. player_id, filing_timestamp. Order does not matter.">
                    <Input
                      value={lcColumns}
                      onChange={(_, d) => setLcColumns(d.value)}
                      placeholder="player_id, filing_timestamp"
                    />
                  </Field>
                  {lcGate && (
                    <MessageBar intent="warning">
                      <MessageBarBody><MessageBarTitle>Liquid clustering gate</MessageBarTitle>{lcGate}</MessageBarBody>
                    </MessageBar>
                  )}
                  {lcError && (
                    <MessageBar intent="error">
                      <MessageBarBody><MessageBarTitle>ALTER TABLE failed</MessageBarTitle>{lcError}</MessageBarBody>
                    </MessageBar>
                  )}
                  {lcApplied && (
                    <MessageBar intent="success">
                      <MessageBarBody>
                        <MessageBarTitle>Clustering applied</MessageBarTitle>
                        ALTER TABLE … CLUSTER BY ran. Run OPTIMIZE in a notebook to re-cluster existing rows.
                        {lcSql ? <><br /><code style={{ fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', display: 'block' }}>{lcSql}</code></> : null}
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  {/* ---- Expose as Iceberg (OneLake "Iceberg V2 endpoint" parity → Delta UniForm) ---- */}
                  <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>
                    Expose as Iceberg{' '}
                    <Badge appearance="tint" color="brand" size="small">Iceberg V2</Badge>
                  </Subtitle2>
                  <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalXS }}>
                    <MessageBarBody>
                      Just like Fabric OneLake, your Delta table is read by Iceberg readers — there is no
                      separate "Iceberg endpoint" to provision. On save, Loom enables{' '}
                      <strong>Delta Lake UniForm</strong> with a real{' '}
                      <code>ALTER TABLE … SET TBLPROPERTIES('delta.universalFormat.enabledFormats'='iceberg')</code>{' '}
                      via a Databricks SQL Warehouse (Azure-native, no Fabric). Delta then generates Iceberg V2{' '}
                      <code>metadata/*.metadata.json</code> alongside the Delta log, so Snowflake, Trino, Spark,
                      and other Iceberg clients can read it at the ADLS path below. Requires{' '}
                      <strong>LOOM_DATABRICKS_HOSTNAME</strong>.
                    </MessageBarBody>
                  </MessageBar>
                  <Field
                    label="Expose as Iceberg"
                    hint="Generates Iceberg V2 metadata over the selected Delta table via UniForm. Turning this off unsets the UniForm format property."
                  >
                    <Switch
                      checked={icebergEnabled}
                      onChange={(_, d) => setIcebergEnabled(d.checked)}
                      label={icebergEnabled ? 'Enabled' : 'Disabled'}
                    />
                  </Field>
                  {schemasEnabled && (
                    <Field label="Schema" hint="Schema-enabled lakehouse: the table lives under Tables/<schema>/. Defaults to dbo.">
                      <Input
                        value={icebergSchema}
                        onChange={(_, d) => setIcebergSchema(d.value)}
                        placeholder="dbo"
                      />
                    </Field>
                  )}
                  <Field label="Delta table to expose" hint="Delta table under /Tables/ in this container.">
                    {(() => {
                      const listing = activeContainer ? openPrefixes[cacheKey(activeContainer, 'Tables')] : undefined;
                      const liveNames = Array.isArray(listing)
                        ? listing.filter((e) => e.isDirectory).map((e) => leafName(e.name))
                        : [];
                      const bundleNames = bundleDeltaTables.map((t) => t.name);
                      const allNames = Array.from(new Set([...liveNames, ...bundleNames])).sort();
                      if (allNames.length > 0) {
                        return (
                          <Dropdown
                            selectedOptions={icebergTable ? [icebergTable] : []}
                            value={icebergTable}
                            placeholder="Select a Delta table"
                            onOptionSelect={(_, d) => setIcebergTable(d.optionValue || '')}
                          >
                            {allNames.map((n) => (<Option key={n} value={n}>{n}</Option>))}
                          </Dropdown>
                        );
                      }
                      return (
                        <Input
                          value={icebergTable}
                          onChange={(_, d) => setIcebergTable(d.value)}
                          placeholder="bronze_player_profile"
                        />
                      );
                    })()}
                  </Field>
                  {icebergEndpoint && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalSNudge, padding: `${tokens.spacingVerticalMNudge} ${tokens.spacingHorizontalM}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}` }}>
                      <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Iceberg endpoint (metadata path readers point at)</Caption1>
                      {([
                        ['ADLS path (abfss)', icebergEndpoint.abfss],
                        ['Iceberg catalog / metadata folder (HTTPS)', icebergEndpoint.httpsMetadataFolder],
                        ['Snowflake EXTERNAL VOLUME base (azure://)', icebergEndpoint.azureMetadataFolder],
                      ] as [string, string][]).map(([label, val]) => (
                        <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{label}</Caption1>
                          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge }}>
                            <code style={{ fontSize: tokens.fontSizeBase100, wordBreak: 'break-all', flex: 1 }}>{val}</code>
                            <Tooltip content={`Copy ${label}`} relationship="label">
                              <Button
                                size="small"
                                appearance="subtle"
                                icon={<Copy20Regular />}
                                onClick={() => { try { void navigator.clipboard?.writeText(val); setActionStatus('Copied to clipboard'); } catch { /* clipboard unavailable */ } }}
                              >
                                Copy
                              </Button>
                            </Tooltip>
                          </div>
                        </div>
                      ))}
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Format: Apache Iceberg V2 · via Delta Lake UniForm. Readers load the most recent{' '}
                        <code>.metadata.json</code> in the metadata folder.
                      </Caption1>
                    </div>
                  )}
                  {icebergGate && (
                    <MessageBar intent="warning">
                      <MessageBarBody><MessageBarTitle>Iceberg expose gate</MessageBarTitle>{icebergGate}</MessageBarBody>
                    </MessageBar>
                  )}
                  {icebergError && (
                    <MessageBar intent="error">
                      <MessageBarBody><MessageBarTitle>UniForm ALTER TABLE failed</MessageBarTitle>{icebergError}</MessageBarBody>
                    </MessageBar>
                  )}
                  {icebergApplied && (
                    <MessageBar intent="success">
                      <MessageBarBody>
                        <MessageBarTitle>Iceberg endpoint enabled</MessageBarTitle>
                        UniForm is on. Delta generates Iceberg V2 metadata after the next write transaction
                        (or immediately for existing data). If the table has deletion vectors, run{' '}
                        <code>REORG TABLE … APPLY (UPGRADE UNIFORM(ICEBERG_COMPAT_VERSION=2))</code> in a notebook.
                        {icebergSql ? <><br /><code style={{ fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', display: 'block' }}>{icebergSql}</code></> : null}
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  {/* ---- Fabric-only acceleration (honest gate, F22) ---- */}
                  <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Fabric-only acceleration (honest gate)</Subtitle2>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                    <Switch
                      checked={settings.fabricToggles?.vorder ?? false}
                      onChange={(_, d) => setSettings((s) => ({ ...s, fabricToggles: { vorder: d.checked, autotune: s.fabricToggles?.autotune ?? false, nativeExecution: s.fabricToggles?.nativeExecution ?? false } }))}
                      label="V-Order (spark.sql.parquet.vorder.default)"
                    />
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Fabric Spark only</MessageBarTitle>
                        V-Order is a write-time Parquet layout optimization available exclusively on Fabric
                        Spark runtimes. On the Azure-native path (Synapse Spark / Databricks), OPTIMIZE runs
                        standard Delta compaction without V-Order encoding — this toggle is persisted but has
                        no effect on Azure.{cloudFabricNote(cloud)}
                      </MessageBarBody>
                    </MessageBar>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                    <Switch
                      checked={settings.fabricToggles?.autotune ?? false}
                      onChange={(_, d) => setSettings((s) => ({ ...s, fabricToggles: { vorder: s.fabricToggles?.vorder ?? false, autotune: d.checked, nativeExecution: s.fabricToggles?.nativeExecution ?? false } }))}
                      label="Autotune (spark.ms.autotune.enabled)"
                    />
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Fabric Spark only</MessageBarTitle>
                        Autotune is a Fabric ML-based query optimizer compatible only with Fabric Runtime 1.2.
                        The key <code>spark.ms.autotune.enabled</code> is silently ignored on Azure Synapse
                        Spark pools and Databricks clusters.{cloudFabricNote(cloud)}
                      </MessageBarBody>
                    </MessageBar>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                    <Switch
                      checked={settings.fabricToggles?.nativeExecution ?? false}
                      onChange={(_, d) => setSettings((s) => ({ ...s, fabricToggles: { vorder: s.fabricToggles?.vorder ?? false, autotune: s.fabricToggles?.autotune ?? false, nativeExecution: d.checked } }))}
                      label="Native execution engine (Velox / Apache Gluten)"
                    />
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Fabric Spark only</MessageBarTitle>
                        The native execution engine (Velox + Apache Gluten vectorized C++) is exclusive to
                        Fabric Spark Runtime 1.3 and 2.0 — enabled at the Fabric capacity/runtime layer, not
                        via a Spark config key. It has no effect on Azure Synapse Spark or Databricks. This
                        toggle records intent for when the lakehouse is accessed from a Fabric Spark session.
                        {cloudFabricNote(cloud)}
                      </MessageBarBody>
                    </MessageBar>
                  </div>

                  <Field
                    label="Spark conf (one KEY=VALUE per line)"
                    hint="Keys under spark.ms.* or spark.sql.parquet.vorder.* are Fabric-only and have no effect on the Azure-native Spark path."
                  >
                    <Textarea
                      rows={6}
                      value={settingsSparkConfText}
                      onChange={(_, d) => setSettingsSparkConfText(d.value)}
                      placeholder={'spark.sql.shuffle.partitions=200\nspark.executor.memory=4g'}
                    />
                  </Field>
                  {sparkConfigWarnings(settingsSparkConfText).map((w, i) => (
                    <MessageBar key={`${w.intent}-${i}`} intent={w.intent}>
                      <MessageBarBody><MessageBarTitle>{w.title}</MessageBarTitle>{w.body}</MessageBarBody>
                    </MessageBar>
                  ))}
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

          <DeltaMaintenanceDialog
            open={maintainOpen}
            onOpenChange={setMaintainOpen}
            container={activeContainer || ''}
            tableName={maintainTable}
            columns={maintainColumns}
          />

          {/* Add-to-data-agent dialog — Fabric "Add to AI skill / data agent". */}
          <Dialog open={daOpen} onOpenChange={(_, d) => setDaOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 520 }}>
              <DialogBody>
                <DialogTitle>Add lakehouse to a data agent</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <Body1>
                      Ground a data agent on <strong>{itemQ.data?.displayName || `lakehouse-${id}`}</strong> so it
                      can answer natural-language questions over its Delta tables. Open the agent&apos;s Build tab
                      after adding to pick tables and write grounding instructions.
                    </Body1>
                    {daLoadErr && (
                      <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not list data agents</MessageBarTitle>{daLoadErr}</MessageBarBody></MessageBar>
                    )}
                    {daMsg && (
                      <MessageBar intent={daMsg.intent}><MessageBarBody>{daMsg.text}</MessageBarBody></MessageBar>
                    )}
                    {daAgents === null && !daLoadErr && <Spinner size="tiny" label="Loading data agents…" labelPosition="after" />}
                    {daAgents !== null && daAgents.length === 0 && (
                      <MessageBar intent="info"><MessageBarBody>No data agents yet. Create one, then return to add this lakehouse as a source.</MessageBarBody></MessageBar>
                    )}
                    {daAgents !== null && daAgents.length > 0 && (
                      <Field label="Data agent">
                        <Dropdown
                          placeholder="Select a data agent"
                          selectedOptions={daSel ? [daSel] : []}
                          value={daAgents.find((a) => a.id === daSel)?.displayName || ''}
                          onOptionSelect={(_, d) => setDaSel(d.optionValue || '')}
                        >
                          {daAgents.map((a) => <Option key={a.id} value={a.id}>{a.displayName}</Option>)}
                        </Dropdown>
                      </Field>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" icon={<Add20Regular />} onClick={() => router.push('/items/data-agent/new')}>New data agent</Button>
                  <Button appearance="subtle" onClick={() => setDaOpen(false)}>Close</Button>
                  <Button appearance="primary" disabled={!daSel || daBusy} icon={daBusy ? <Spinner size="tiny" /> : <Sparkle20Regular />} onClick={() => void addToAgent()}>Add as source</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* New schema dialog (F9) — name = letters/digits/underscores; 'dbo' reserved. */}
          <Dialog open={newSchemaOpen} onOpenChange={(_, d) => setNewSchemaOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 480 }}>
              <DialogBody>
                <DialogTitle>New schema</DialogTitle>
                <DialogContent>
                  <Field label="Schema name" required
                    hint="Letters, digits, and underscores only. 'dbo' is reserved (the immutable default).">
                    <Input
                      value={newSchemaName}
                      onChange={(_, d) => setNewSchemaName(d.value)}
                      placeholder="marketing"
                    />
                  </Field>
                  <Field label="Description">
                    <Input value={newSchemaDesc} onChange={(_, d) => setNewSchemaDesc(d.value)} placeholder="Marketing-domain tables" />
                  </Field>
                  <MessageBar intent="info">
                    <MessageBarBody>
                      Runs <code>CREATE SCHEMA IF NOT EXISTS</code> on the Synapse Spark pool via Livy and adds it to the catalog.
                      Tables placed here are addressable as <code>{shortcutLakehouseId}.{newSchemaName || '<schema>'}.&lt;table&gt;</code>.
                    </MessageBarBody>
                  </MessageBar>
                  {newSchemaError && <MessageBar intent="error"><MessageBarBody>{newSchemaError}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setNewSchemaOpen(false)} disabled={newSchemaBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={createSchema}
                    disabled={newSchemaBusy || !newSchemaName.trim() || !/^[A-Za-z0-9_]+$/.test(newSchemaName) || newSchemaName === 'dbo'}>
                    {newSchemaBusy ? 'Creating…' : 'Create'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Share dialog — Azure RBAC role assignment at the container scope.
              Loom-native mirror of Fabric's "Share" affordance; reuses the
              same /api/lakehouse/permissions POST as the Permissions dialog.
              No Fabric workspace required. */}
          <Dialog open={shareOpen} onOpenChange={(_, d) => {
            setShareOpen(d.open);
            if (!d.open) { setSharePrincipal(''); setShareError(null); setShareSuccess(null); }
          }}>
            <DialogSurface style={{ maxWidth: '560px' }}>
              <DialogBody>
                <DialogTitle>Share — {activeContainer || 'lakehouse'}</DialogTitle>
                <DialogContent>
                  <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                    Grant a user, group, or service principal access to this lakehouse
                    container via Azure RBAC. Provide the Entra ID object id of the
                    recipient. Sharing is applied directly on the storage scope — no
                    Fabric or Power BI workspace is involved.
                  </Caption1>
                  {shareError && (
                    <MessageBar intent="error">
                      <MessageBarBody><MessageBarTitle>Share failed</MessageBarTitle>{shareError}</MessageBarBody>
                    </MessageBar>
                  )}
                  {shareSuccess && (
                    <MessageBar intent="success">
                      <MessageBarBody>{shareSuccess}</MessageBarBody>
                    </MessageBar>
                  )}
                  <Field label="Principal object id" required hint="Entra ID user, group, or service principal object id (GUID)">
                    <Input
                      value={sharePrincipal}
                      onChange={(_, d) => setSharePrincipal(d.value)}
                      placeholder="11111111-2222-3333-4444-555555555555"
                    />
                  </Field>
                  <Field label="Principal type" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown
                      selectedOptions={[sharePrincipalType]}
                      value={sharePrincipalType}
                      onOptionSelect={(_, d) => setSharePrincipalType((d.optionValue as any) || 'User')}
                    >
                      <Option value="User">User</Option>
                      <Option value="Group">Group</Option>
                      <Option value="ServicePrincipal">Service principal</Option>
                    </Dropdown>
                  </Field>
                  <Field label="Permission level" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown
                      selectedOptions={[shareRole]}
                      value={shareRole}
                      onOptionSelect={(_, d) => setShareRole(d.optionValue || shareRole)}
                    >
                      <Option value="Storage Blob Data Reader">Read (Storage Blob Data Reader)</Option>
                      <Option value="Storage Blob Data Contributor">Read + Write (Storage Blob Data Contributor)</Option>
                      <Option value="Storage Blob Data Owner">Full control (Storage Blob Data Owner)</Option>
                    </Dropdown>
                  </Field>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" disabled={shareBusy} onClick={() => setShareOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={shareBusy || !sharePrincipal.trim()} onClick={grantShare}>
                    {shareBusy ? 'Granting…' : 'Grant access'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Move table to schema dialog (F9) — ALTER TABLE … RENAME TO via Livy. */}
          <Dialog open={moveTableOpen} onOpenChange={(_, d) => setMoveTableOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 480 }}>
              <DialogBody>
                <DialogTitle>Move table to schema</DialogTitle>
                <DialogContent>
                  <Field label="Table">
                    <Input value={moveTableName} readOnly />
                  </Field>
                  <Field label="From schema">
                    <Input value={moveTableFrom} readOnly />
                  </Field>
                  <Field label="To schema" required hint="Pick the destination schema. Create new schemas in the Schemas tab.">
                    <Dropdown
                      selectedOptions={moveTableTo ? [moveTableTo] : []}
                      value={moveTableTo}
                      placeholder="Select a schema"
                      onOptionSelect={(_, d) => setMoveTableTo(d.optionValue || '')}
                    >
                      {(schemas || []).filter((sch) => sch.name !== moveTableFrom).map((sch) => (
                        <Option key={sch.name} value={sch.name}>{`${sch.name}${sch.isDefault ? ' (default)' : ''}`}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <MessageBar intent="info">
                    <MessageBarBody>
                      Runs <code>ALTER TABLE {moveTableFrom}.{moveTableName} RENAME TO {moveTableTo || '<schema>'}.{moveTableName}</code> on the Spark pool.
                      The table stays queryable via its new 4-part name.
                    </MessageBarBody>
                  </MessageBar>
                  {moveTableStatus && <MessageBar intent="success"><MessageBarBody>{moveTableStatus}</MessageBarBody></MessageBar>}
                  {moveTableError && <MessageBar intent="error"><MessageBarBody>{moveTableError}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setMoveTableOpen(false)} disabled={moveTableBusy}>Close</Button>
                  <Button appearance="primary" onClick={submitMoveTable}
                    disabled={moveTableBusy || !moveTableTo.trim() || moveTableTo === moveTableFrom}>
                    {moveTableBusy ? 'Moving…' : 'Move'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* New semantic model — honest gate. In Fabric this creates a
              DirectLake Power BI model over the lakehouse Delta tables, which
              requires a Fabric/Power BI capacity. There is no Azure-native 1:1
              (per no-fabric-dependency.md the lakehouse itself is 100% Azure-
              native, but DirectLake specifically needs a capacity). The dialog
              documents the supported Azure-native reporting path instead. */}
          <Dialog open={semanticModelGateOpen} onOpenChange={(_, d) => setSemanticModelGateOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '600px' }}>
              <DialogBody>
                <DialogTitle>New semantic model</DialogTitle>
                <DialogContent>
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Requires Power BI / Fabric capacity</MessageBarTitle>
                      In Microsoft Fabric, a Lakehouse semantic model uses{' '}
                      <strong>DirectLake</strong> storage mode — the model reads Delta
                      Parquet directly from OneLake without import. That path needs a
                      Fabric capacity (F2+) and the Lakehouse SQL analytics endpoint, so
                      it has no Azure-native 1:1 and is intentionally not provisioned here.
                      <br /><br />
                      <strong>Azure-native path (no Fabric capacity):</strong> connect
                      Power BI Desktop to this lakehouse over the Synapse Serverless SQL
                      endpoint (<code>&lt;workspace&gt;-ondemand.sql.azuresynapse.net</code>)
                      using Import or DirectQuery, then publish. Or use{' '}
                      <strong>Analyze data &rarr; SQL endpoint</strong> on this ribbon to
                      query the Delta tables with T-SQL and build reports from there.
                    </MessageBarBody>
                  </MessageBar>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
                    If your org runs a Fabric capacity alongside Loom, set{' '}
                    <code>LOOM_LAKEHOUSE_BACKEND=fabric</code> with a bound workspace to
                    enable the native "New semantic model" command — it stays strictly
                    opt-in and never gates the default Azure-native lakehouse.
                  </Caption1>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setSemanticModelGateOpen(false)}>Close</Button>
                  <Button
                    appearance="primary"
                    icon={<Database20Regular />}
                    onClick={() => { setSemanticModelGateOpen(false); setTab('sql'); }}
                  >
                    Open SQL endpoint
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Load to Table (F6) wizard + job toast */}
          <Toaster toasterId={lttToasterId} />
          {lttEntry && (
            <LoadToTableWizard
              open={lttOpen}
              onOpenChange={setLttOpen}
              container={activeContainer || ''}
              path={lttEntry.name}
              onJobSubmitted={({ jobId, tableName, rowCount }) => {
                const sessId = jobId.split('.')[0];
                // F10 — record the load-to-table hand-off in the jobs store so the
                // background-job registry + per-lakehouse toast continuity name the
                // originating lakehouse (survives tab switch / component unmount).
                if (activeContainer) {
                  recordLoadToTable({ lakehouseName, container: activeContainer, tableName });
                }
                dispatchToast(
                  <Toast>
                    <ToastTitle
                      action={<Link href="/monitor">View in Monitor</Link>}
                    >
                      Load to table started · job {sessId} — table “{tableName}”
                      {typeof rowCount === 'number' ? ` (${rowCount} rows)` : ''} materializing as Delta.
                    </ToastTitle>
                  </Toast>,
                  { intent: 'success', timeout: 12000 },
                );
                // Refresh the Tables tab so the new table shows up.
                if (activeContainer) loadPaths(activeContainer, 'Tables');
              }}
            />
          )}

          {/* Storage-tier (Hot/Cool/Cold) dialog */}
          {tierDlgEntry && activeContainer && (
            <TierDialog
              open={tierDlgOpen}
              onOpenChange={setTierDlgOpen}
              container={activeContainer}
              path={tierDlgEntry.name}
              onTierChanged={(t) => onTierChanged(tierDlgEntry, t)}
            />
          )}
        </>
      }
    />
  );
}
