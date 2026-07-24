'use client';
/**
 * LakehouseEditor — ADLS Gen2 browser + OPENROWSET preview, Delta catalog,
 * shortcuts, schemas, history, permissions, settings, and share — 100% Azure-
 * native, no Fabric dependency.
 *
 * REFACTORED (WS-11.1): bounded contexts extracted to sibling modules:
 *   panes/  — FilesPane, TablesPane, PreviewPane, SqlPane, HistoryPane,
 *             SchemasPane, ShortcutsPane
 *   dialogs/ — ContextMenu, LabelDialog, ReferencePickerDialog, PropertiesDialog,
 *              ShareDialog, DataAgentDialog, MoveTableDialog, SemanticModelGateDialog,
 *              ShortcutWizardDialog, PermissionsDialog, SettingsDialog
 *   hooks/   — useLakehousePermissions, useLakehouseSettings,
 *              useLakehouseShortcuts, useLakehouseSecondary
 *
 * This shell owns core nav, file ops, upload/download, rendering the explorer
 * leftPanel and tab strip, ribbon, and the context provider.
 * Zero behavior change.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { clientFetch } from '@/lib/client-fetch';
import { useConfirm } from '@/lib/components/confirm-dialog';
import { getItem, type WorkspaceItem } from '@/lib/api/workspaces';
import type { LakehouseContent } from '@/lib/apps/content-bundles/types';
import {
  Badge, Body1, Button, Caption1, Spinner, Subtitle2,
  Tree, TreeItem, TreeItemLayout,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Menu, MenuTrigger, MenuList, MenuItem, MenuPopover,
  Tooltip, Link, Toaster, Toast, ToastTitle, useToastController, useId,
  Breadcrumb, BreadcrumbItem, BreadcrumbButton, BreadcrumbDivider,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, ArrowUpload20Regular, Database20Regular, Delete20Regular,
  DocumentTable20Regular, Eye20Regular, Folder20Regular, FolderAdd20Regular, Play20Regular,
  BookOpen20Regular, TableSimple20Regular, TableSimple20Filled,
  ArrowDownload20Regular, Info20Regular, LinkMultiple20Regular,
  Add20Regular, CloudLink20Regular, ErrorCircle20Filled,
  FolderArrowUp20Regular, ShieldTask20Regular,
  Wrench20Regular, History20Regular, Copy20Regular, Sparkle20Regular,
  MoreHorizontal20Regular, DatabaseLink20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { CopilotBuilderPane } from '@/lib/components/shared/copilot-builder-pane';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { EntityDiagram } from '@/lib/components/shared/entity-diagram';
import { DeltaMaintenanceDialog } from '../components/delta-maintenance-dialog';
import { TierDialog, type BlobAccessTier } from '@/lib/components/onelake/tier-dialog';
import { parseDdlColumns } from '@/lib/azure/delta-maintenance';
import { LoadToTableWizard } from '../components/load-to-table-wizard';
import { OneLakeSecurityTab } from '../components/onelake-security-tab';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useJobsStore } from '@/lib/state/jobs-store';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import { DeltaPreviewGrid, type ColStat } from '../components/delta-preview-grid';
import {
  useStyles, leafName, collectEntries, formatCell, parseJsonOrError, FileGlyph,
} from './shared';
import type {
  ContainerInfo, PathEntry, ReferenceLakehouse, PreviewResponse, UploadItem, MipLabelOption,
} from './shared';
import type { LiveCatalogTable } from './types';
import { LakehouseEditorContext } from './lakehouse-editor-context';
import type { LakehouseEditorCtx } from './lakehouse-editor-context';
import { useLakehousePermissions } from './hooks/use-lakehouse-permissions';
import { useLakehouseSettings } from './hooks/use-lakehouse-settings';
import { useLakehouseShortcuts } from './hooks/use-lakehouse-shortcuts';
import { useLakehouseSecondary } from './hooks/use-lakehouse-secondary';
// ── Panes ────────────────────────────────────────────────────────────────────
import { FilesPane } from './panes/files-pane';
import { TablesPane } from './panes/tables-pane';
import { PreviewPane } from './panes/preview-pane';
import { SqlPane } from './panes/sql-pane';
import { HistoryPane } from './panes/history-pane';
import { SchemasPane } from './panes/schemas-pane';
import { ShortcutsPane } from './panes/shortcuts-pane';
import { InteropPane } from './panes/interop-pane';
// ── Dialogs ──────────────────────────────────────────────────────────────────
import {
  ContextMenu, LabelDialog, ReferencePickerDialog, PropertiesDialog,
  ShareDialog, DataAgentDialog, MoveTableDialog, SemanticModelGateDialog,
} from './dialogs/small-dialogs';
import { ShortcutWizardDialog } from './dialogs/shortcut-wizard-dialog';
import { PermissionsDialog } from './dialogs/permissions-dialog';
import { SettingsDialog } from './dialogs/settings-dialog';

interface Props { item: FabricItemType; id: string }

export function LakehouseEditor({ item, id }: Props) {
  const s = useStyles();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const router = useRouter();

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

  const seededTableInfo = useMemo(() => {
    const prov = (itemQ.data?.state as any)?.provisioning;
    const sec = (prov?.secondaryIds || {}) as Record<string, string>;
    const container = typeof sec.container === 'string' ? sec.container : null;
    const rootPath = typeof sec.rootPath === 'string' ? sec.rootPath : null;
    const seeded = String(sec.seededTables || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!container || !rootPath || !seeded.length) return null;
    const schemasEnabledBundle = lhContent?.schemasEnabled === true;
    return seeded.map((name) => {
      const def = bundleDeltaTables.find((t) => t.name === name || leafName(t.name) === name);
      const schema = schemasEnabledBundle ? String(def?.schema || 'dbo') : '';
      const csvPath = schema
        ? `${rootPath}/Tables/${schema}/${name}/${name}.csv`
        : `${rootPath}/Tables/${name}/${name}.csv`;
      return { name, container, csvPath, rowCount: def?.sampleRows?.length ?? null };
    });
  }, [itemQ.data, bundleDeltaTables, lhContent]);

  // ── Core state ────────────────────────────────────────────────────────────
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [containerError, setContainerError] = useState<string | null>(null);
  const [activeContainer, setActiveContainer] = useState<string | null>(null);
  const [openPrefixes, setOpenPrefixes] = useState<Record<string, PathEntry[] | 'loading' | { error: string }>>({});
  const [activePath, setActivePath] = useState<PathEntry | null>(null);
  const [tab, setTab] = useState<string>('files');
  // FLAG0 (n1-lakehouse-interop-tab) — default-ON kill switch for the N1
  // Interop tab. OFF hides the tab on the next render; already-emitted Iceberg
  // metadata stays in the lake and external engines keep reading it.
  const interopTabOn = useRuntimeFlag('n1-lakehouse-interop-tab');
  useEffect(() => {
    // Kill-switch flipped OFF while the tab was open: fall back to Files so the
    // pane area is never blank.
    if (!interopTabOn && tab === 'interop') setTab('files');
  }, [interopTabOn, tab]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewMode, setPreviewMode] = useState<'file' | 'table'>('file');
  const [columnStats, setColumnStats] = useState<Record<string, ColStat> | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsJobId, setStatsJobId] = useState<string | null>(null);
  const statsTargetRef = useRef<{ container: string; path: string } | null>(null);
  const deepLinkRef = useRef<{ container: string; path: string } | null>(null);
  const [sqlText, setSqlText] = useState<string>(
    `-- Select a file in the Files tab and click "Query this file"\n-- to populate this editor with a Synapse Serverless OPENROWSET.`,
  );
  const [sqlResult, setSqlResult] = useState<PreviewResponse | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<{ done: number; total: number } | null>(null);
  const [mipStatus, setMipStatus] = useState<string | null>(null);
  const [mipLabelName, setMipLabelName] = useState<string | null>(null);
  const [labelDlgOpen, setLabelDlgOpen] = useState(false);
  const [labelDlgEntry, setLabelDlgEntry] = useState<PathEntry | null>(null);
  const [mipLabels, setMipLabels] = useState<MipLabelOption[] | null>(null);
  const [mipLabelsLoading, setMipLabelsLoading] = useState(false);
  const [mipLabelsError, setMipLabelsError] = useState<string | null>(null);
  const [chosenLabelId, setChosenLabelId] = useState<string>('');
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxEntry, setCtxEntry] = useState<PathEntry | null>(null);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const lttToasterId = useId('ltt-toaster');
  const { dispatchToast } = useToastController(lttToasterId);
  const [lttOpen, setLttOpen] = useState(false);
  const [lttEntry, setLttEntry] = useState<PathEntry | null>(null);
  const [tierDlgOpen, setTierDlgOpen] = useState(false);
  const [tierDlgEntry, setTierDlgEntry] = useState<PathEntry | null>(null);
  const [fileTiers, setFileTiers] = useState<Record<string, string>>({});
  const [propsEntry, setPropsEntry] = useState<PathEntry | null>(null);
  const [maintainOpen, setMaintainOpen] = useState(false);
  const [maintainTable, setMaintainTable] = useState('');
  const [semanticModelGateOpen, setSemanticModelGateOpen] = useState(false);
  const [liveTables, setLiveTables] = useState<LiveCatalogTable[] | null>(null);
  const [liveTablesLoading, setLiveTablesLoading] = useState(false);
  const [liveTablesError, setLiveTablesError] = useState<string | null>(null);
  const [liveTablesGate, setLiveTablesGate] = useState<string | null>(null);
  const [schemasEnabled, setSchemasEnabled] = useState(false);

  // ── Jobs store ────────────────────────────────────────────────────────────
  const jobs = useJobsStore((st) => st.jobs);
  const startUpload = useJobsStore((st) => st.startUpload);
  const recordLoadToTable = useJobsStore((st) => st.recordLoadToTable);
  const runningUploads = activeContainer
    ? jobs.filter((j) => j.kind === 'upload' && j.status === 'running' && j.container === activeContainer)
    : [];
  const uploading = runningUploads.length > 0 || uploadQueue !== null;

  // ── Core callbacks declared before hooks (hooks capture them) ────────────
  const cacheKey = useCallback((container: string, prefix: string) => `${container}::${prefix}`, []);

  const loadPaths = useCallback(async (container: string, prefix: string) => {
    const key = cacheKey(container, prefix);
    setOpenPrefixes((p) => ({ ...p, [key]: 'loading' }));
    try {
      const qs = new URLSearchParams({ container, prefix });
      const r = await clientFetch(`/api/lakehouse/paths?${qs.toString()}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; paths?: PathEntry[] }>(r, 'List paths');
      setOpenPrefixes((p) => ({
        ...p,
        [key]: j.ok ? (j.paths as PathEntry[]) : { error: j.error || `HTTP ${r.status}` },
      }));
    } catch (e: any) {
      setOpenPrefixes((p) => ({ ...p, [key]: { error: e?.message || String(e) } }));
    }
  }, [cacheKey]);

  // ── Domain hooks ──────────────────────────────────────────────────────────
  const perms = useLakehousePermissions({ activeContainer, confirm });
  const settings_ = useLakehouseSettings({ activeContainer, schemasEnabled, setSchemasEnabled, setActionStatus });
  const sec = useLakehouseSecondary({
    id, isNewItem, activeContainer, shortcutLakehouseId: activeContainer || id,
    schemasEnabled, setSchemasEnabled, loadPaths, confirm, itemQ, maintainTable, tab,
  });
  const sc_ = useLakehouseShortcuts({
    shortcutLakehouseId: activeContainer || id,
    schemasEnabled, containers, schemas: sec.schemas,
    bundleShortcuts, loadSchemas: sec.loadSchemas, confirm, setSqlText, setTab, tab,
  });

  // ── Derived values (need hook results) ───────────────────────────────────
  const isReferenceLakehouse = (itemQ.data?.state as any)?.isReference === true;
  const shortcutLakehouseId = activeContainer || id;
  const lakehouseName: string =
    (itemQ.data?.displayName) || (settings_.settings.displayName) || activeContainer || id;
  const maintainColumns = useMemo(() => {
    const def = bundleDeltaTables.find((t) => t.name === maintainTable || leafName(t.name) === maintainTable);
    return def?.ddl ? parseDdlColumns(def.ddl) : [];
  }, [bundleDeltaTables, maintainTable]);

  // ── Live Delta catalog ────────────────────────────────────────────────────
  const loadLiveTables = useCallback(async () => {
    const workspaceId = itemQ.data?.workspaceId;
    if (!id || id === 'new' || !workspaceId) return;
    setLiveTablesLoading(true); setLiveTablesError(null); setLiveTablesGate(null);
    try {
      const r = await clientFetch(
        `/api/lakehouse/tables?lakehouseId=${encodeURIComponent(id)}&workspaceId=${encodeURIComponent(workspaceId)}&rowCounts=true`,
      );
      const j = await parseJsonOrError<{ ok: boolean; tables?: LiveCatalogTable[]; gate?: string; error?: string }>(r, 'List tables');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setLiveTables(j.tables || []);
      setLiveTablesGate(j.gate || null);
    } catch (e: any) { setLiveTablesError(e?.message || String(e)); }
    finally { setLiveTablesLoading(false); }
  }, [id, itemQ.data?.workspaceId]);

  useEffect(() => {
    if (tab === 'tables' && activeContainer) loadLiveTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeContainer, id, itemQ.data?.workspaceId]);

  // ── Context menu + tier helpers ───────────────────────────────────────────
  const openContextMenu = useCallback((e: React.MouseEvent, entry: PathEntry) => {
    e.preventDefault(); e.stopPropagation();
    setCtxEntry(entry); setCtxPos({ x: e.clientX, y: e.clientY }); setCtxOpen(true);
  }, []);
  const openTierDialog = useCallback((entry: PathEntry) => {
    setTierDlgEntry(entry); setTierDlgOpen(true);
  }, []);
  const onTierChanged = useCallback((entry: PathEntry, newTier: BlobAccessTier) => {
    if (!activeContainer) return;
    setFileTiers((prev) => ({ ...prev, [`${activeContainer}::${entry.name}`]: newTier }));
  }, [activeContainer]);

  // ── File navigation ───────────────────────────────────────────────────────
  const refreshActive = useCallback(() => {
    if (!activeContainer) return;
    const prefix = activePath?.isDirectory ? activePath.name : '';
    loadPaths(activeContainer, prefix);
    loadPaths(activeContainer, '');
  }, [activeContainer, activePath, loadPaths]);

  const goToPrefix = useCallback((prefix: string) => {
    if (!activeContainer) return;
    setActivePath(prefix ? { name: prefix, isDirectory: true, size: 0 } : null);
    loadPaths(activeContainer, prefix);
  }, [activeContainer, loadPaths]);

  const selectFile = useCallback(async (entry: PathEntry, opts?: { top?: number; format?: string }) => {
    setActivePath(entry); setActionError(null);
    if (entry.isDirectory) {
      if (activeContainer) loadPaths(activeContainer, entry.name);
      return;
    }
    if (!activeContainer) return;
    const bulkUrl = `https://__account__.dfs.core.windows.net/${activeContainer}/${entry.name}`;
    setSqlText(
      `SELECT TOP 100 *\nFROM OPENROWSET(BULK '${bulkUrl}', FORMAT = 'PARQUET') AS r;\n-- Note: the BFF rewrites the host. Use the Preview tab for an authenticated run.`,
    );
    setPreview(null); setPreviewLoading(true); setColumnStats(null);
    setStatsError(null); setStatsLoading(false); setStatsJobId(null);
    try {
      const sp = new URLSearchParams(window.location.search);
      sp.set('tab', 'preview'); sp.set('container', activeContainer); sp.set('path', entry.name);
      window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
    } catch { /* non-browser */ }
    try {
      const qs = new URLSearchParams({ container: activeContainer, path: entry.name });
      if (opts?.top) qs.set('top', String(opts.top));
      if (opts?.format) qs.set('format', opts.format);
      let j: PreviewResponse;
      for (let attempt = 0; ; attempt++) {
        const r = await clientFetch(`/api/lakehouse/preview?${qs.toString()}`);
        j = await parseJsonOrError<PreviewResponse>(r, 'Preview');
        if (j.ok || !j.transient || attempt >= 3) break;
        setPreview({ ...j, message: j.error });
        await new Promise((res) => setTimeout(res, Math.min(j.retryAfterMs ?? 10_000, 30_000)));
      }
      setPreview(j!);
      if (j!.sql) setSqlText(j!.sql);
      if (j!.ok && (j!.columns?.length ?? 0) > 0) {
        statsTargetRef.current = { container: activeContainer, path: entry.name };
        setStatsLoading(true);
        try {
          const sQs = new URLSearchParams({ container: activeContainer, path: entry.name });
          const sr = await clientFetch(`/api/lakehouse/table-stats?${sQs.toString()}`);
          const sj = await parseJsonOrError<{ ok: boolean; error?: string; jobId?: string }>(sr, 'Column stats');
          if (sj.ok && sj.jobId) setStatsJobId(sj.jobId);
          else { setStatsLoading(false); setStatsError(sj.error || 'Stats job could not start.'); }
        } catch (e: any) { setStatsLoading(false); setStatsError(e?.message || String(e)); }
      }
    } catch (e: any) { setPreview({ ok: false, error: e?.message || String(e) }); }
    finally { setPreviewLoading(false); }
  }, [activeContainer, loadPaths]);

  const previewTable = useCallback((relPath: string) => {
    setPreviewMode('table');
    void selectFile({ name: relPath, isDirectory: false, size: 0 }, { top: 1000, format: 'DELTA' });
    setTab('preview');
  }, [selectFile]);

  const loadCopilotDraft = useCallback(async () => {
    try {
      const r = await clientFetch(`/api/items/lakehouse/${encodeURIComponent(id)}/assist?action=doc`);
      const j = await r.json().catch(() => ({}));
      const draft = typeof j?.doc?.query === 'string' ? j.doc.query : '';
      if (draft) { setSqlText(draft); setTab('sql'); }
    } catch { /* best-effort */ }
  }, [id]);

  // ── SQL ───────────────────────────────────────────────────────────────────
  const runSql = useCallback(async () => {
    setSqlLoading(true); setSqlResult(null);
    try {
      const r = await clientFetch(`/api/items/lakehouse/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText, database: 'master' }),
      });
      const j = await parseJsonOrError<PreviewResponse>(r, 'SQL query');
      setSqlResult(j);
    } catch (e: any) { setSqlResult({ ok: false, error: e?.message || String(e) }); }
    finally { setSqlLoading(false); }
  }, [id, sqlText]);

  // ── File ops ──────────────────────────────────────────────────────────────
  const onUploadClick = useCallback(() => fileInputRef.current?.click(), []);
  const onFolderUploadClick = useCallback(() => folderInputRef.current?.click(), []);

  const onOpenInNotebook = useCallback((entry: PathEntry) => {
    if (!activeContainer) return;
    const ext = entry.name.split('.').pop()?.toLowerCase();
    const isDelta = ext === 'delta' || entry.name.endsWith('_delta_log');
    const fmt = isDelta ? 'delta' : ext === 'parquet' ? 'parquet' : ext === 'csv' ? 'csv' : ext === 'json' ? 'json' : 'parquet';
    const bulk = `abfss://${activeContainer}@__accountname__.dfs.core.windows.net/${entry.name}`;
    const code = [
      `# Auto-generated from Lakehouse — ${activeContainer}/${entry.name}`,
      `df = spark.read.format("${fmt}")${fmt === 'csv' ? '.option("header", "true").option("inferSchema", "true")' : ''}.load("${bulk}")`,
      `display(df.limit(100))`,
      `print(f"Loaded {df.count()} rows from ${bulk}")`,
    ].join('\n');
    try {
      localStorage.setItem('loom.notebook.prefill', JSON.stringify({
        source: 'lakehouse', container: activeContainer, path: entry.name, code,
      }));
    } catch {}
    router.push(`/items/notebook/new?lakehouse=${encodeURIComponent(activeContainer)}&path=${encodeURIComponent(entry.name)}`);
  }, [activeContainer, router]);

  const onLoadToTables = useCallback((entry: PathEntry) => {
    if (!activeContainer || entry.isDirectory) return;
    setLttEntry(entry); setLttOpen(true);
  }, [activeContainer]);

  const uploadOne = useCallback(async (targetPath: string, file: File): Promise<string | null> => {
    if (!activeContainer) return 'No active container';
    try {
      const fd = new FormData();
      fd.set('container', activeContainer); fd.set('path', targetPath); fd.set('file', file);
      const r = await clientFetch('/api/lakehouse/upload', { method: 'POST', body: fd });
      const ct = r.headers.get('content-type') || '';
      let j: any = null; let bodyText: string | null = null;
      if (ct.includes('application/json')) { try { j = await r.json(); } catch {} }
      if (!j) { try { bodyText = (await r.text()).slice(0, 240); } catch {} }
      if (!r.ok || j?.ok === false) {
        return j?.error
          || (r.status === 413 ? `${leafName(targetPath)}: file too large. Max 4 GB.`
          : r.status === 502 ? `${leafName(targetPath)}: upstream storage error (502).`
          : r.status === 401 ? 'Sign in expired. Reload and re-authenticate.'
          : `${leafName(targetPath)}: upload failed (HTTP ${r.status}).${bodyText ? ` Server said: ${bodyText}` : ''}`);
      }
      return null;
    } catch (e: any) { return `${leafName(targetPath)}: ${e?.message || String(e)}`; }
  }, [activeContainer]);

  const uploadItems = useCallback(async (items: UploadItem[]) => {
    if (!activeContainer || !items.length) return;
    const basePrefix = activePath?.isDirectory ? `${activePath.name.replace(/\/+$/, '')}/` : '';
    setActionError(null); setActionStatus(null); setUploadQueue({ done: 0, total: items.length });
    let firstError: string | null = null; let okCount = 0;
    for (let i = 0; i < items.length; i++) {
      const { relativePath, file } = items[i];
      const targetPath = `${basePrefix}${relativePath.replace(/^\/+/, '')}`;
      const err = await uploadOne(targetPath, file);
      if (err) { if (!firstError) firstError = err; } else { okCount++; }
      setUploadQueue({ done: i + 1, total: items.length });
    }
    setUploadQueue(null);
    if (firstError) {
      setActionError(items.length > 1 ? `${okCount}/${items.length} uploaded. First failure — ${firstError}` : firstError);
    } else {
      setActionStatus(`Uploaded ${okCount} file${okCount === 1 ? '' : 's'} at ${new Date().toLocaleTimeString()}`);
    }
    refreshActive();
  }, [activeContainer, activePath, uploadOne, refreshActive]);

  const onUploadChange = useCallback(async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files || []) as File[];
    ev.target.value = '';
    if (!files.length || !activeContainer) return;
    if (files.length === 1) {
      const file = files[0];
      const prefix = activePath?.isDirectory ? activePath.name : '';
      const targetPath = prefix ? `${prefix.replace(/\/+$/, '')}/${file.name}` : file.name;
      setActionError(null);
      startUpload({
        lakehouseName, container: activeContainer, path: targetPath, file,
        onDone: ({ ok, error }) => { if (ok) refreshActive(); else if (error) setActionError(error); },
      });
      setTimeout(refreshActive, 500);
      return;
    }
    await uploadItems(files.map((f) => ({ relativePath: f.name, file: f })));
  }, [activeContainer, activePath, startUpload, lakehouseName, uploadItems, refreshActive]);

  const onFolderInputChange = useCallback(async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files || []) as File[];
    ev.target.value = '';
    if (!files.length || !activeContainer) return;
    await uploadItems(files.map((f) => ({ relativePath: (f as any).webkitRelativePath || f.name, file: f })));
  }, [activeContainer, uploadItems]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!activeContainer) return; e.preventDefault(); setIsDragOver(true);
  }, [activeContainer]);
  const onDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragOver(false); }, []);
  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false);
    if (!activeContainer) return;
    const dtItems = Array.from(e.dataTransfer.items || []) as DataTransferItem[];
    const entries = dtItems
      .filter((it) => it.kind === 'file')
      .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
      .filter((en): en is FileSystemEntry => !!en);
    let items: UploadItem[] = [];
    if (entries.length) {
      items = (await Promise.all(entries.map((en) => collectEntries(en)))).flat();
    } else {
      items = (Array.from(e.dataTransfer.files || []) as File[]).map((f) => ({ relativePath: f.name, file: f }));
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
    setActionError(null); setActionStatus(null);
    try {
      const qs = new URLSearchParams({ container: activeContainer, path: targetPath });
      const r = await clientFetch(`/api/lakehouse/path?${qs.toString()}`, { method: 'POST' });
      const j = await parseJsonOrError<{ ok?: boolean; error?: string }>(r, 'Create folder');
      if (!r.ok || j.ok === false) setActionError(j.error || `Mkdir failed (HTTP ${r.status})`);
      else setActionStatus(`Folder ${targetPath} created at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) { setActionError(e?.message || String(e)); }
    finally { refreshActive(); }
  }, [activeContainer, activePath, refreshActive]);

  const onDelete = useCallback(async (entry: PathEntry) => {
    if (!activeContainer) return;
    const ok = await confirm({
      title: `Delete ${entry.name}${entry.isDirectory ? ' (recursive)' : ''}?`,
      body: entry.isDirectory
        ? 'This recursively deletes the folder and everything under it. This cannot be undone.'
        : 'This deletes the file. This cannot be undone.',
      danger: true, confirmLabel: 'Delete',
    });
    if (!ok) return;
    setActionError(null); setActionStatus(null);
    try {
      const qs = new URLSearchParams({ container: activeContainer, path: entry.name, recursive: entry.isDirectory ? 'true' : 'false' });
      const r = await clientFetch(`/api/lakehouse/path?${qs.toString()}`, { method: 'DELETE' });
      const j = await parseJsonOrError<{ ok?: boolean; error?: string }>(r, 'Delete');
      if (!r.ok || j.ok === false) setActionError(j.error || `Delete failed (HTTP ${r.status})`);
      else setActionStatus(`Deleted ${entry.name} at ${new Date().toLocaleTimeString()}`);
      if (activePath?.name === entry.name) setActivePath(null);
    } catch (e: any) { setActionError(e?.message || String(e)); }
    finally { refreshActive(); }
  }, [activeContainer, activePath, refreshActive, confirm]);

  const onDownload = useCallback(async (
    entry: PathEntry,
    label?: MipLabelOption & { method?: 'Standard' | 'Privileged' },
  ) => {
    if (!activeContainer || entry.isDirectory) return;
    setMipStatus(null); setMipLabelName(null);
    const params: Record<string, string> = { container: activeContainer, path: entry.name };
    const labelName = label?.displayName ?? label?.name ?? label?.id ?? '';
    if (label?.id) { params.labelId = label.id; params.labelName = labelName; if (label.method) params.labelMethod = label.method; }
    try {
      const r = await clientFetch(`/api/lakehouse/download?${new URLSearchParams(params).toString()}`);
      if (!r.ok) { const j = await r.json().catch(() => null); setActionError(j?.error || `Download failed (HTTP ${r.status}).`); return; }
      setMipStatus(r.headers.get('x-loom-mip-status'));
      const lbl = r.headers.get('x-loom-mip-label');
      if (lbl) { try { setMipLabelName(decodeURIComponent(lbl)); } catch { setMipLabelName(lbl); } }
      const blob = await r.blob();
      if (typeof window !== 'undefined') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = leafName(entry.name);
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      }
    } catch (e: any) { setActionError(e?.message || String(e)); }
  }, [activeContainer]);

  const openLabelDialog = useCallback(async (entry: PathEntry) => {
    setLabelDlgEntry(entry); setLabelDlgOpen(true); setChosenLabelId(''); setMipLabelsError(null);
    if (mipLabels) return;
    setMipLabelsLoading(true);
    try {
      const r = await clientFetch('/api/admin/security/mip/labels');
      const j = await parseJsonOrError<{ ok?: boolean; error?: string; labels?: MipLabelOption[]; hint?: any }>(r, 'List sensitivity labels');
      if (!r.ok || j.ok === false) {
        const hint = (j as any)?.hint?.followUp || (j as any)?.hint?.bicepStatus;
        setMipLabelsError(j.error || hint || `Sensitivity labels unavailable (HTTP ${r.status}).`);
      } else {
        const labels = (j.labels || []).filter((l) => l.isAppliable !== false);
        setMipLabels(labels);
        if (!labels.length) setMipLabelsError('No appliable sensitivity labels are published to this tenant.');
      }
    } catch (e: any) { setMipLabelsError(e?.message || String(e)); }
    finally { setMipLabelsLoading(false); }
  }, [mipLabels]);

  const confirmLabelDownload = useCallback(async () => {
    if (!labelDlgEntry || !chosenLabelId) return;
    const chosen = (mipLabels || []).find((l) => l.id === chosenLabelId);
    const name = chosen?.displayName || chosen?.name || chosenLabelId;
    setLabelDlgOpen(false);
    await onDownload(labelDlgEntry, { id: chosenLabelId, name, method: 'Standard' });
  }, [labelDlgEntry, chosenLabelId, mipLabels, onDownload]);

  // ── Effects ───────────────────────────────────────────────────────────────
  // Container load
  useEffect(() => {
    let cancelled = false;
    clientFetch('/api/lakehouse/containers')
      .then((r) => parseJsonOrError<{ ok: boolean; error?: string; containers?: ContainerInfo[] }>(r, 'List containers'))
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) { setContainerError(j.error || 'Failed to list containers'); setContainers([]); return; }
        setContainers(j.containers || []);
        if ((j.containers || []).length) setActiveContainer(j.containers![0].name);
      })
      .catch((e) => { if (!cancelled) { setContainerError(String(e)); setContainers([]); } });
    return () => { cancelled = true; };
  }, []);

  // Auto-load root listing when active container changes
  useEffect(() => {
    if (!activeContainer) return;
    const key = cacheKey(activeContainer, '');
    if (openPrefixes[key] === undefined) loadPaths(activeContainer, '');
  }, [activeContainer, loadPaths, openPrefixes, cacheKey]);

  // Resolve schemasEnabled on container change (authoritative from settings doc)
  useEffect(() => {
    if (!activeContainer) return;
    let cancelled = false;
    if (lhContent?.schemasEnabled) setSchemasEnabled(true);
    clientFetch(`/api/lakehouse/settings?container=${encodeURIComponent(activeContainer)}`)
      .then((r) => parseJsonOrError<{ ok: boolean; settings?: { schemasEnabled?: boolean } }>(r, 'Load settings'))
      .then((j) => { if (!cancelled && j.ok && typeof j.settings?.schemasEnabled === 'boolean') setSchemasEnabled(j.settings.schemasEnabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeContainer, lhContent?.schemasEnabled]);

  // Column stats polling
  useEffect(() => {
    if (!statsJobId) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      const target = statsTargetRef.current;
      const qs = new URLSearchParams({ jobId: statsJobId });
      if (target) { qs.set('container', target.container); qs.set('path', target.path); }
      try {
        const r = await clientFetch(`/api/lakehouse/table-stats?${qs.toString()}`);
        const j = await parseJsonOrError<{ ok: boolean; status?: string; error?: string; jobId?: string; stats?: Record<string, ColStat> }>(r, 'Column stats');
        if (cancelled) return;
        if (j.status === 'available' && j.stats) { setColumnStats(j.stats); setStatsLoading(false); setStatsJobId(null); }
        else if (!j.ok || j.status === 'error') { setStatsError(j.error || 'Column statistics job failed.'); setStatsLoading(false); setStatsJobId(null); }
        else if (j.jobId && j.jobId !== statsJobId) setStatsJobId(j.jobId);
      } catch (e: any) { if (cancelled) return; setStatsError(e?.message || String(e)); setStatsLoading(false); setStatsJobId(null); }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [statsJobId]);

  // Deep-link restore on first mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const dCont = sp.get('container'); const dPath = sp.get('path');
    if (sp.get('tab') === 'preview' && dCont && dPath) { deepLinkRef.current = { container: dCont, path: dPath }; setTab('preview'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // F6 keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F6' || lttOpen || !activeContainer || !activePath || activePath.isDirectory) return;
      e.preventDefault(); setLttEntry(activePath); setLttOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeContainer, activePath, lttOpen]);

  // ── Derived listings ──────────────────────────────────────────────────────
  const currentPrefix = useMemo(() => (activePath?.isDirectory ? activePath.name : ''), [activePath]);
  const currentListing = useMemo(() => {
    if (!activeContainer) return null;
    return openPrefixes[cacheKey(activeContainer, currentPrefix)] ?? null;
  }, [openPrefixes, activeContainer, currentPrefix, cacheKey]);

  // ── Ribbon ────────────────────────────────────────────────────────────────
  const canFileAction = !!activeContainer;
  const hasFile = !!activePath && !activePath.isDirectory;
  const writeBlocked = !canFileAction || isReferenceLakehouse;
  const writeTitle = isReferenceLakehouse
    ? 'Read-only — reference lakehouse (write operations disabled)'
    : !canFileAction ? 'Select a container first' : undefined;
  const notebookHref = activeContainer ? `/items/notebook/new?lakehouse=${encodeURIComponent(activeContainer)}` : '/items/notebook/new';

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Refresh', actions: [{ label: 'Refresh', icon: <ArrowSync20Regular />, onClick: writeBlocked ? undefined : refreshActive, disabled: writeBlocked, title: writeTitle }] },
      { label: 'Get data', actions: [{ label: 'Get data', disabled: writeBlocked, title: writeTitle, dropdownItems: [
        { label: uploading ? `Uploading (${runningUploads.length})…` : 'Upload', icon: <ArrowUpload20Regular />, onClick: writeBlocked ? undefined : onUploadClick, disabled: writeBlocked, title: writeTitle },
        { label: 'Upload folder', icon: <FolderArrowUp20Regular />, onClick: writeBlocked ? undefined : onFolderUploadClick, disabled: writeBlocked, title: writeTitle },
        { label: 'New folder', icon: <FolderAdd20Regular />, onClick: writeBlocked ? undefined : onNewFolder, disabled: writeBlocked, title: writeTitle },
        { label: 'New shortcut', icon: <LinkMultiple20Regular />, onClick: writeBlocked ? undefined : () => { setTab('shortcuts'); sc_.openShortcutWizard(); }, disabled: writeBlocked, title: writeTitle },
        { label: 'New dataflow', icon: <Database20Regular />, onClick: () => router.push('/items/dataflow/new') },
        { label: 'New pipeline', icon: <Database20Regular />, onClick: () => router.push('/items/data-pipeline/new') },
        { label: 'New notebook', icon: <BookOpen20Regular />, onClick: () => router.push(notebookHref) },
        { label: 'Copy activity', icon: <ArrowDownload20Regular />, onClick: () => router.push('/items/copy-job/new') },
      ]}] },
      { label: 'Analyze data', actions: [{ label: 'Analyze data', dropdownItems: [
        { label: 'SQL endpoint', icon: <Database20Regular />, onClick: () => setTab('sql') },
        { label: 'New notebook', icon: <BookOpen20Regular />, onClick: () => router.push(notebookHref) },
        { label: 'Existing notebook', icon: <BookOpen20Regular />, onClick: () => router.push('/items/notebook/new') },
      ]}] },
      { label: 'Data model', actions: [{ label: 'New semantic model', icon: <TableSimple20Regular />, onClick: () => setSemanticModelGateOpen(true), title: 'DirectLake semantic model requires Power BI / Fabric capacity — see the dialog for the Azure-native path' }] },
      { label: 'Query', actions: [
        { label: 'Preview', icon: <Eye20Regular />, onClick: hasFile ? () => { if (activePath) { selectFile(activePath); setTab('preview'); } } : undefined, disabled: !hasFile },
        { label: 'Query this file', icon: <Play20Regular />, onClick: hasFile ? () => { if (activePath) { selectFile(activePath); setTab('sql'); } } : undefined, disabled: !hasFile },
      ] },
      { label: 'Tables', actions: [{ label: 'Load to table', onClick: hasFile ? () => { if (activePath) onLoadToTables(activePath); } : undefined, disabled: !hasFile, title: hasFile ? 'Load this file into a managed Delta table (F6)' : 'Select a file first' }] },
      { label: 'Protect', actions: [{ label: 'Download with label', onClick: hasFile ? () => { if (activePath) openLabelDialog(activePath); } : undefined, disabled: !hasFile, title: hasFile ? 'Stamp a MIP sensitivity label on download' : 'Select a file first' }] },
      { label: 'Manage', actions: [
        { label: 'Settings', icon: <Info20Regular />, onClick: writeBlocked ? undefined : settings_.openSettings, disabled: writeBlocked, title: writeTitle },
        { label: 'Permissions', icon: <LinkMultiple20Regular />, onClick: activeContainer ? perms.openPerms : undefined, disabled: !activeContainer, title: !activeContainer ? 'Select a container first' : undefined },
        { label: 'Share', icon: <Add20Regular />, onClick: activeContainer ? () => { sec.setShareError(null); sec.setShareSuccess(null); sec.setShareOpen(true); } : undefined, disabled: !activeContainer, title: !activeContainer ? 'Select a container first' : undefined },
        { label: 'Maintain…', icon: <Wrench20Regular />, onClick: (tab === 'tables' && maintainTable) ? () => setMaintainOpen(true) : undefined, disabled: !(tab === 'tables' && maintainTable), title: !(tab === 'tables' && maintainTable) ? 'Select a table in the Tables tab first' : 'OPTIMIZE / VACUUM / ZORDER BY' },
        { label: 'OneLake security', icon: <ShieldTask20Regular />, onClick: () => setTab('security'), title: 'Manage OneLake data-access roles + row/column security for this lakehouse' },
        ...(interopTabOn ? [{ label: 'Interop (Iceberg)', icon: <DatabaseLink20Regular />, onClick: () => setTab('interop'), title: 'Expose Delta tables to Trino / Spark / DuckDB / Snowflake as Apache Iceberg — zero copy, same files' }] : []),
      ] },
      { label: 'AI', actions: [{ label: 'Add to data agent', icon: <Sparkle20Regular />, onClick: () => { void sec.openAddToAgent(); }, title: 'Ground a data agent on this lakehouse (Fabric "Add to AI skill")' }] },
    ] },
  ], [
    writeBlocked, writeTitle, canFileAction, uploading, runningUploads.length,
    onUploadClick, onFolderUploadClick, onNewFolder, refreshActive, sc_.openShortcutWizard, router,
    notebookHref, hasFile, activePath, selectFile, onLoadToTables, openLabelDialog,
    activeContainer, perms.openPerms, settings_.openSettings, tab, maintainTable,
    sec.openAddToAgent, sec.setShareOpen, sec.setShareError, sec.setShareSuccess,
    interopTabOn,
  ]);

  // ── Tree renderers ────────────────────────────────────────────────────────
  function renderTreeChildren(container: string, prefix: string): React.ReactElement {
    const state = openPrefixes[cacheKey(container, prefix)];
    if (state === undefined) return (
      <TreeItem itemType="leaf" value={`${container}-${prefix}-unloaded`} onClick={() => loadPaths(container, prefix)}>
        <TreeItemLayout>Click to load…</TreeItemLayout>
      </TreeItem>
    );
    if (state === 'loading') return (
      <TreeItem itemType="leaf" value={`${container}-${prefix}-loading`}>
        <TreeItemLayout><Spinner size="tiny" /> Loading…</TreeItemLayout>
      </TreeItem>
    );
    if (!Array.isArray(state)) return (
      <TreeItem itemType="leaf" value={`${container}-${prefix}-err`}>
        <TreeItemLayout>Error: {state.error}</TreeItemLayout>
      </TreeItem>
    );
    if (state.length === 0) return (
      <TreeItem itemType="leaf" value={`${container}-${prefix}-empty`}>
        <TreeItemLayout><Caption1>(empty)</Caption1></TreeItemLayout>
      </TreeItem>
    );
    return (
      <>
        {state.map((entry) => entry.isDirectory ? (
          <TreeItem key={`${container}-${entry.name}`} itemType="branch" value={`${container}-${entry.name}`}
            onClick={() => selectFile(entry)} onContextMenu={(e) => openContextMenu(e, entry)}>
            <TreeItemLayout iconBefore={<FileGlyph name={entry.name} isDirectory />}>{leafName(entry.name)}</TreeItemLayout>
            <Tree>{renderTreeChildren(container, entry.name)}</Tree>
          </TreeItem>
        ) : (
          <TreeItem key={`${container}-${entry.name}`} itemType="leaf" value={`${container}-${entry.name}`}
            onClick={() => selectFile(entry)} onContextMenu={(e) => openContextMenu(e, entry)}>
            <TreeItemLayout iconBefore={<FileGlyph name={entry.name} isDirectory={false} />}>{leafName(entry.name)}</TreeItemLayout>
          </TreeItem>
        ))}
      </>
    );
  }

  function renderRefTreeChildren(ref: { id: string; displayName: string; containers: string[]; account?: string; reachable?: boolean }, container: string, prefix: string): React.ReactElement {
    const key = `ref::${ref.id}::${container}::${prefix}`;
    const state = sec.refOpenPrefixes[key];
    const base = `ref-${ref.id}-${container}-${prefix}`;
    if (state === undefined) return (
      <TreeItem itemType="leaf" value={`${base}-unloaded`} onClick={() => sec.loadRefPaths(ref.id, container, prefix)}>
        <TreeItemLayout>Click to load…</TreeItemLayout>
      </TreeItem>
    );
    if (state === 'loading') return (
      <TreeItem itemType="leaf" value={`${base}-loading`}><TreeItemLayout><Spinner size="tiny" /> Loading…</TreeItemLayout></TreeItem>
    );
    if (!Array.isArray(state)) return (
      <TreeItem itemType="leaf" value={`${base}-err`}><TreeItemLayout><Caption1>Error: {state.error}</Caption1></TreeItemLayout></TreeItem>
    );
    if (state.length === 0) return (
      <TreeItem itemType="leaf" value={`${base}-empty`}><TreeItemLayout><Caption1>(empty)</Caption1></TreeItemLayout></TreeItem>
    );
    return (
      <>
        {state.map((entry) => entry.isDirectory ? (
          <TreeItem key={`ref-${ref.id}-${entry.name}`} itemType="branch" value={`ref-${ref.id}-${entry.name}`}
            onClick={() => sec.selectRefFile(ref as any, container, entry)}>
            <TreeItemLayout iconBefore={<FileGlyph name={entry.name} isDirectory />}>{leafName(entry.name)}</TreeItemLayout>
            <Tree>{renderRefTreeChildren(ref, container, entry.name)}</Tree>
          </TreeItem>
        ) : (
          <TreeItem key={`ref-${ref.id}-${entry.name}`} itemType="leaf" value={`ref-${ref.id}-${entry.name}`}
            onClick={() => sec.selectRefFile(ref as any, container, entry)}>
            <TreeItemLayout iconBefore={<FileGlyph name={entry.name} isDirectory={false} />}>{leafName(entry.name)}</TreeItemLayout>
          </TreeItem>
        ))}
      </>
    );
  }

  // ── Context value ─────────────────────────────────────────────────────────
  const ctxValue: LakehouseEditorCtx = {
    id, isNewItem, itemQ, lhContent, bundleFolders, bundleDeltaTables, bundleShortcuts, hasBundle,
    seededTableInfo, lakehouseName, shortcutLakehouseId, isReferenceLakehouse,
    containers, containerError, activeContainer, setActiveContainer,
    openPrefixes, activePath, setActivePath,
    tab, setTab,
    preview, setPreview, previewLoading, setPreviewLoading,
    previewMode, setPreviewMode, columnStats, statsLoading, statsError,
    sqlText, setSqlText, sqlResult, setSqlResult, sqlLoading, setSqlLoading, runSql,
    actionError, setActionError, actionStatus, setActionStatus,
    fileInputRef, folderInputRef, isDragOver, setIsDragOver,
    uploadQueue, uploading, jobs: jobs as any, startUpload, recordLoadToTable, runningUploads,
    mipStatus, mipLabelName, labelDlgOpen, setLabelDlgOpen, labelDlgEntry, setLabelDlgEntry,
    mipLabels, mipLabelsLoading, mipLabelsError, chosenLabelId, setChosenLabelId,
    ctxOpen, setCtxOpen, ctxEntry, setCtxEntry, ctxPos,
    lttOpen, setLttOpen, lttEntry, setLttEntry, lttToasterId,
    tierDlgOpen, setTierDlgOpen, tierDlgEntry, fileTiers,
    propsEntry, setPropsEntry,
    maintainOpen, setMaintainOpen, maintainTable, setMaintainTable, maintainColumns,
    semanticModelGateOpen, setSemanticModelGateOpen,
    liveTables, liveTablesLoading, liveTablesError, liveTablesGate, loadLiveTables,
    schemasEnabled, setSchemasEnabled,
    loadPaths, cacheKey, refreshActive, selectFile, previewTable, goToPrefix, currentPrefix, currentListing,
    openContextMenu, openTierDialog, onTierChanged,
    onUploadClick, onFolderUploadClick, onNewFolder, onDelete, onDownload,
    onOpenInNotebook, onLoadToTables, openLabelDialog, confirmLabelDownload,
    uploadOne, uploadItems, onUploadChange, onFolderInputChange, onDragOver, onDragLeave, onDrop,
    // Permissions hook
    ...perms,
    renderPrincipalPicker: () => <></>,
    // Settings hook
    ...settings_,
    // Secondary hook (history, schemas, refs, share, DA)
    ...sec,
    // Shortcuts hook
    ...sc_,
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <LakehouseEditorContext.Provider value={ctxValue}>
      <ItemEditorChrome splitKeyPrefix={item.slug} item={item} id={id} ribbon={ribbon}
        leftPanel={
          <div className={s.treePad}>
            <Caption1 style={{ display: 'block', padding: `${tokens.spacingVerticalXXS} 0 ${tokens.spacingVerticalS}`, fontWeight: tokens.fontWeightBold }}>
              <Database20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
              {itemQ.data?.displayName ?? 'Primary lakehouse'}
            </Caption1>
            {containers === null && <Spinner size="tiny" label="Loading containers…" labelPosition="after" />}
            {containerError && (
              <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Cannot list containers</MessageBarTitle>{containerError}</MessageBarBody></MessageBar>
            )}
            {containers && containers.length === 0 && !containerError && (
              <Caption1>No containers visible to BFF identity. Confirm LOOM_*_URL env vars + Storage Blob Data Contributor role.</Caption1>
            )}
            {containers && containers.length > 0 && (
              <Tree aria-label="Lakehouse containers" defaultOpenItems={containers.map((c) => `c-${c.name}`)}>
                {containers.map((c) => (
                  <TreeItem key={c.name} itemType="branch" value={`c-${c.name}`}
                    onClick={() => { setActiveContainer(c.name); setActivePath(null); }}>
                    <TreeItemLayout iconBefore={<Database20Regular />}>
                      {c.name}{activeContainer === c.name && ' ·'}
                    </TreeItemLayout>
                    <Tree>{renderTreeChildren(c.name, '')}</Tree>
                  </TreeItem>
                ))}
              </Tree>
            )}
            {/* Live Delta catalog tree */}
            {activeContainer && (liveTables !== null || liveTablesLoading || liveTablesError) && (
              <Tree aria-label="Live Delta catalog" defaultOpenItems={['live-tables', `live-schema-${activeContainer}`]} style={{ marginTop: tokens.spacingVerticalM }}>
                <TreeItem itemType="branch" value="live-tables">
                  <TreeItemLayout iconBefore={<TableSimple20Regular />} aside={liveTablesLoading ? <Spinner size="extra-tiny" /> : (
                    <Button appearance="subtle" size="small" icon={<ArrowSync20Regular />} aria-label="Refresh live tables" onClick={(e) => { e.stopPropagation(); loadLiveTables(); }} />
                  )}>Tables (live)</TreeItemLayout>
                  <Tree>
                    {liveTablesError && (
                      <TreeItem itemType="leaf" value="live-tables-error">
                        <TreeItemLayout iconBefore={<ErrorCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />}>{liveTablesError}</TreeItemLayout>
                      </TreeItem>
                    )}
                    {!liveTablesError && liveTables !== null && liveTables.length === 0 && (
                      <TreeItem itemType="leaf" value="live-tables-empty">
                        <TreeItemLayout iconBefore={<Info20Regular />}>No Delta tables in /{activeContainer}/Tables/ yet</TreeItemLayout>
                      </TreeItem>
                    )}
                    {(Object.entries(
                      (liveTables || []).reduce<Record<string, LiveCatalogTable[]>>((acc, t) => { (acc[t.schema] ??= []).push(t); return acc; }, {}),
                    ) as [string, LiveCatalogTable[]][]).map(([schema, schemaTables]) => (
                      <TreeItem key={schema} itemType="branch" value={`live-schema-${schema}`}>
                        <TreeItemLayout iconBefore={<Database20Regular />}>{schema} ({schemaTables.length})</TreeItemLayout>
                        <Tree>
                          {schemaTables.map((t) => (
                            <TreeItem key={t.adlsPath} itemType="leaf" value={`live-tbl-${t.adlsPath}`}
                              title={`${t.format} · ${t.status}${typeof t.latestVersion === 'number' ? ` · v${t.latestVersion}` : ''}`}
                              onClick={() => setTab('tables')}>
                              <TreeItemLayout
                                iconBefore={t.format === 'delta' ? <TableSimple20Filled style={{ color: tokens.colorPaletteBlueForeground2, flexShrink: 0 }} /> : <Folder20Regular style={{ color: tokens.colorPaletteMarigoldForeground2, flexShrink: 0 }} />}
                                aside={t.status === 'broken' ? <Badge appearance="tint" color="danger" size="small">broken</Badge> : t.status === 'empty' ? <Badge appearance="tint" color="warning" size="small">empty</Badge> : t.format !== 'delta' ? <Badge appearance="outline" size="small">{t.format}</Badge> : null}
                                actions={
                                  <Menu><MenuTrigger disableButtonEnhancement>
                                    <Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} aria-label={`Actions for table ${t.name}`} onClick={(e) => e.stopPropagation()} />
                                  </MenuTrigger><MenuPopover><MenuList>
                                    <MenuItem icon={<TableSimple20Regular />} onClick={() => setTab('tables')}>Open in Tables tab</MenuItem>
                                    <MenuItem icon={<Copy20Regular />} onClick={() => { void navigator.clipboard?.writeText(t.adlsPath); }}>Copy path</MenuItem>
                                    {typeof t.latestVersion === 'number' && (
                                      <MenuItem icon={<History20Regular />} onClick={() => sec.openTableHistory(t.adlsPath)}>Table history…</MenuItem>
                                    )}
                                  </MenuList></MenuPopover></Menu>
                                }
                              >{t.name}</TreeItemLayout>
                            </TreeItem>
                          ))}
                        </Tree>
                      </TreeItem>
                    ))}
                  </Tree>
                </TreeItem>
              </Tree>
            )}
            {/* Bundle structure tree */}
            {hasBundle && (
              <Tree aria-label="Planned lakehouse structure from app bundle" defaultOpenItems={['bundle', 'bundle-folders', 'bundle-tables', 'bundle-shortcuts']} style={{ marginTop: tokens.spacingVerticalM }}>
                <TreeItem itemType="branch" value="bundle">
                  <TreeItemLayout iconBefore={<Database20Regular />}>Starter structure (app bundle)</TreeItemLayout>
                  <Tree>
                    {bundleFolders.length > 0 && (
                      <TreeItem itemType="branch" value="bundle-folders">
                        <TreeItemLayout iconBefore={<Folder20Regular />}>Folders ({bundleFolders.length})</TreeItemLayout>
                        <Tree>{bundleFolders.map((f) => (<TreeItem key={f.path} itemType="leaf" value={`bf-${f.path}`} title={f.description}><TreeItemLayout iconBefore={<Folder20Regular />}>{f.path}</TreeItemLayout></TreeItem>))}</Tree>
                      </TreeItem>
                    )}
                    {bundleDeltaTables.length > 0 && (
                      <TreeItem itemType="branch" value="bundle-tables">
                        <TreeItemLayout iconBefore={<TableSimple20Regular />}>Delta tables ({bundleDeltaTables.length})</TreeItemLayout>
                        <Tree>{bundleDeltaTables.map((t) => (<TreeItem key={t.name} itemType="leaf" value={`bt-${t.name}`} onClick={() => setTab('tables')}><TreeItemLayout iconBefore={<DocumentTable20Regular />}>{t.name}</TreeItemLayout></TreeItem>))}</Tree>
                      </TreeItem>
                    )}
                    {bundleShortcuts.length > 0 && (
                      <TreeItem itemType="branch" value="bundle-shortcuts">
                        <TreeItemLayout iconBefore={<LinkMultiple20Regular />}>Shortcuts ({bundleShortcuts.length})</TreeItemLayout>
                        <Tree>{bundleShortcuts.map((sc) => (<TreeItem key={sc.name} itemType="leaf" value={`bs-${sc.name}`} title={sc.target} onClick={() => setTab('shortcuts')}><TreeItemLayout iconBefore={<CloudLink20Regular />}>{sc.name}</TreeItemLayout></TreeItem>))}</Tree>
                      </TreeItem>
                    )}
                  </Tree>
                </TreeItem>
              </Tree>
            )}
            {/* Reference lakehouses */}
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalL, padding: `${tokens.spacingVerticalXS} 0` }}>
              <Caption1 style={{ flex: 1, fontWeight: tokens.fontWeightSemibold }}>
                <LinkMultiple20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />References
              </Caption1>
              <Tooltip content={isNewItem ? 'Save the lakehouse first' : 'Add an in-workspace lakehouse to browse side-by-side'} relationship="label">
                <Button appearance="subtle" size="small" icon={<Add20Regular />} disabled={isNewItem}
                  onClick={() => { sec.loadReferences?.(); sec.setPickerOpen(true); }} aria-label="Add reference lakehouse" />
              </Tooltip>
            </div>
            {sec.refsLoading && <Spinner size="tiny" label="Loading references…" labelPosition="after" />}
            {sec.refsError && <MessageBar intent="error"><MessageBarBody>{sec.refsError}</MessageBarBody></MessageBar>}
            {sec.references !== null && sec.references.length === 0 && !sec.refsLoading && (
              <Caption1 style={{ display: 'block', padding: `0 ${tokens.spacingHorizontalXS}`, color: tokens.colorNeutralForeground3 }}>
                No references. Click + to browse another lakehouse in this workspace side-by-side.
              </Caption1>
            )}
            {sec.references !== null && sec.references.length > 0 && (
              <Tree aria-label="Reference lakehouses">
                {sec.references.map((ref) => (
                  <TreeItem key={ref.id} itemType="branch" value={`refroot-${ref.id}`}>
                    <TreeItemLayout iconBefore={<Database20Regular />} aside={
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                        <Badge appearance="outline" size="small" color="informative">ref</Badge>
                        {!ref.reachable && (
                          <Tooltip relationship="label" content="The Console UAMI cannot reach this lakehouse's containers. Grant it Storage Blob Data Reader on the referenced storage account.">
                            <ErrorCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />
                          </Tooltip>
                        )}
                        <Tooltip relationship="label" content="Remove reference">
                          <Button appearance="subtle" size="small" aria-label={`Remove ${ref.displayName}`}
                            onClick={(e) => { e.stopPropagation(); sec.removeReference(ref.id); }}>×</Button>
                        </Tooltip>
                      </span>
                    }>{ref.displayName}</TreeItemLayout>
                    <Tree>
                      {ref.containers.map((c) => (
                        <TreeItem key={`refc-${ref.id}-${c}`} itemType="branch" value={`refc-${ref.id}-${c}`} onClick={() => sec.loadRefPaths(ref.id, c, '')}>
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
            <TeachingBanner
              surfaceKey="lakehouse-analyze"
              title="Analyze your data"
              message="Explore this lakehouse in a notebook, query it through the SQL analytics endpoint, or stream it into an eventhouse endpoint — all on Azure, no Fabric required."
              learnMoreHref="https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-delta-lake-overview"
            />
            {/* Reference preview inline banner */}
            {sec.refSelection && (
              <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground2 }}>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="informative" icon={<LinkMultiple20Regular />}>Reference · read-only</Badge>
                  <Subtitle2>{sec.refSelection.displayName}</Subtitle2>
                  <Caption1>· {sec.refSelection.container}/{leafName(sec.refSelection.entry.name)}</Caption1>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginLeft: 'auto' }}>
                    <Tooltip relationship="label" content="Write actions are disabled on reference lakehouses.">
                      <span><Button appearance="primary" icon={<ArrowUpload20Regular />} disabled>Upload</Button></span>
                    </Tooltip>
                    <Tooltip relationship="label" content="Write actions are disabled on reference lakehouses.">
                      <span><Button appearance="outline" icon={<FolderAdd20Regular />} disabled>New folder</Button></span>
                    </Tooltip>
                    <Tooltip relationship="label" content="Write actions are disabled on reference lakehouses.">
                      <span><Button appearance="outline" icon={<Delete20Regular />} disabled>Delete</Button></span>
                    </Tooltip>
                    <Button appearance="subtle" onClick={() => { sec.setRefSelection(null); sec.setRefPreview(null); }}>Close</Button>
                  </div>
                </div>
                {sec.refPreviewLoading && <Spinner size="small" label="Running OPENROWSET…" labelPosition="after" />}
                {!sec.refPreviewLoading && sec.refPreview && !sec.refPreview.ok && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Preview failed</MessageBarTitle>{sec.refPreview.error}</MessageBarBody></MessageBar>
                )}
                {!sec.refPreviewLoading && sec.refPreview?.ok && (sec.refPreview.columns?.length ?? 0) > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Reference preview rows" size="small">
                      <TableHeader><TableRow>{(sec.refPreview.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
                      <TableBody>{(sec.refPreview.rows || []).map((row, i) => (
                        <TableRow key={i}>{(sec.refPreview!.columns || []).map((_, j) => <TableCell key={j} className={s.cell}>{formatCell((row as unknown[])[j])}</TableCell>)}</TableRow>
                      ))}</TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
            {/* Tab strip */}
            <div className={s.tabs}>
              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
                <Tab value="files" icon={<DocumentTable20Regular />}>Files</Tab>
                <Tab value="tables" icon={<TableSimple20Regular />}>Tables</Tab>
                <Tab value="entity" icon={<TableSimple20Regular />}>Entity diagram</Tab>
                <Tab value="history" icon={<History20Regular />}>History</Tab>
                <Tab value="schemas" icon={<Database20Regular />}>Schemas</Tab>
                <Tab value="preview" icon={<Eye20Regular />}>Preview</Tab>
                <Tab value="sql" icon={<Play20Regular />}>SQL</Tab>
                <Tab value="shortcuts" icon={<CloudLink20Regular />}>Shortcuts</Tab>
                {interopTabOn && <Tab value="interop" icon={<DatabaseLink20Regular />}>Interop</Tab>}
                <Tab value="security" icon={<ShieldTask20Regular />}>Security</Tab>
                <Tab value="copilot" icon={<Sparkle20Regular />}>Copilot</Tab>
              </TabList>
            </div>
            {/* Tab panes */}
            <div className={s.pad}>
              {tab === 'files' && <FilesPane />}
              {tab === 'tables' && <TablesPane />}
              {tab === 'preview' && <PreviewPane />}
              {tab === 'sql' && <SqlPane />}
              {tab === 'history' && <HistoryPane />}
              {tab === 'schemas' && <SchemasPane />}
              {tab === 'shortcuts' && <ShortcutsPane />}
              {tab === 'interop' && interopTabOn && <InteropPane />}
              {tab === 'security' && <OneLakeSecurityTab itemId={id} itemType="lakehouse" container={activeContainer || 'gold'} />}
              {tab === 'copilot' && (
                <CopilotBuilderPane
                  endpoint={`/api/items/lakehouse/${id}/assist`}
                  title="Copilot — query the lakehouse in natural language"
                  intro="Describe the data you want and Copilot proposes a read-only SQL SELECT grounded on this lakehouse's real Delta tables. Review the plan, then Apply to save a reversible draft you can run in the SQL tab (Synapse serverless over Delta). Azure-native — no Microsoft Fabric required."
                  fieldLabel="Ask Copilot for a query"
                  fieldHint="Plain English. Copilot grounds the SELECT in the real Delta table names and waits for your approval before saving."
                  placeholder={'e.g. "Show total revenue by product category for the last 90 days from the gold sales table."'}
                  onApplied={loadCopilotDraft}
                />
              )}
              {tab === 'entity' && (
                <EntityDiagram
                  source={{ kind: 'lakehouse', itemId: id, workspaceId: itemQ.data?.workspaceId, containers: activeContainer || undefined }}
                  height={560}
                  resizeStorageKey="lakehouse-entity"
                />
              )}
            </div>
            {/* Dialogs */}
            {confirmDialog}
            <ContextMenu />
            <LabelDialog />
            <PropertiesDialog />
            <SemanticModelGateDialog />
            <ShareDialog />
            <DataAgentDialog />
            <MoveTableDialog />
            <ShortcutWizardDialog />
            <PermissionsDialog />
            <SettingsDialog />
            <ReferencePickerDialog />
            <DeltaMaintenanceDialog
              open={maintainOpen}
              onOpenChange={setMaintainOpen}
              container={activeContainer || ''}
              tableName={maintainTable}
              columns={maintainColumns}
            />
            <TierDialog
              open={tierDlgOpen}
              onOpenChange={setTierDlgOpen}
              container={activeContainer || ''}
              path={tierDlgEntry?.name ?? ''}
              onTierChanged={(newTier) => { if (tierDlgEntry) onTierChanged(tierDlgEntry, newTier); }}
            />
            {/* Load to Table wizard + toast */}
            <Toaster toasterId={lttToasterId} />
            {lttEntry && (
              <LoadToTableWizard
                open={lttOpen}
                onOpenChange={setLttOpen}
                container={activeContainer || ''}
                path={lttEntry.name}
                onJobSubmitted={({ jobId, tableName }) => {
                  const sessId = jobId.split('.')[0];
                  if (activeContainer) recordLoadToTable({ lakehouseName, container: activeContainer, tableName });
                  dispatchToast(
                    <Toast>
                      <ToastTitle action={<Link href="/monitor">View in Monitor</Link>}>
                        Load to table started · job {sessId} — table &ldquo;{tableName}&rdquo;
                      </ToastTitle>
                    </Toast>,
                    { intent: 'success' },
                  );
                }}
              />
            )}
            {/* Hidden file inputs (rendered here so refs are stable) */}
            <input ref={fileInputRef} type="file" hidden multiple onChange={onUploadChange} aria-label={`Upload file to ${lakehouseName} lakehouse`} />
            <input ref={folderInputRef} type="file" hidden multiple
              {...{ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>}
              onChange={onFolderInputChange} />
          </>
        }
      />
    </LakehouseEditorContext.Provider>
  );
}
