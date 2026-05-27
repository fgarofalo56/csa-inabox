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
import {
  Badge, Body1, Button, Caption1, Spinner, Subtitle2,
  Tree, TreeItem, TreeItemLayout,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Menu, MenuTrigger, MenuList, MenuItem, MenuPopover,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, ArrowUpload20Regular, Database20Regular, Delete20Regular,
  DocumentTable20Regular, Eye20Regular, Folder20Regular, FolderAdd20Regular, Play20Regular,
  BookOpen20Regular, TableSimple20Regular,
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

interface Props { item: FabricItemType; id: string }

export function LakehouseEditor({ item, id }: Props) {
  const s = useStyles();
  const router = useRouter();
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

  // ---- container load -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    fetch('/api/lakehouse/containers')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) {
          setContainerError(j.error || 'Failed to list containers');
          setContainers([]);
          return;
        }
        setContainers(j.containers || []);
        if ((j.containers || []).length) setActiveContainer(j.containers[0].name);
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
      const j = await r.json();
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
      const j = (await r.json()) as PreviewResponse;
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
      const j = await r.json();
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
      const j = await r.json();
      if (!r.ok || j.ok === false) setActionError(j.error || `Delete failed (HTTP ${r.status})`);
      else setActionStatus(`Deleted ${entry.name} at ${new Date().toLocaleTimeString()}`);
      if (activePath?.name === entry.name) setActivePath(null);
    } catch (e: any) {
      setActionError(e?.message || String(e));
    } finally {
      refreshActive();
    }
  }, [activeContainer, activePath, refreshActive]);

  // ---- SQL tab --------------------------------------------------------
  const runSql = useCallback(async () => {
    setSqlLoading(true);
    setSqlResult(null);
    try {
      const r = await fetch(`/api/items/synapse-serverless-sql-pool/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText, database: 'master' }),
      });
      const j = (await r.json()) as PreviewResponse;
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
  function renderTreeChildren(container: string, prefix: string): JSX.Element {
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
          >
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
        { label: 'Permissions', disabled: true, title: 'ADLS ACL editor BFF not wired (deferred)' },
        { label: 'Settings', disabled: true, title: 'lakehouse settings BFF not wired (deferred)' },
      ]},
    ]},
  ], [canFileAction, uploading, onUploadClick, onNewFolder, refreshActive, hasFile, activePath, selectFile]);

  // ---- render ---------------------------------------------------------
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
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
        </div>
      }
      main={
        <>
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
                  <Caption1>Delta tables under <code>/Tables/</code></Caption1>
                  <Button appearance="outline" icon={<ArrowSync20Regular />}
                    disabled={!activeContainer}
                    onClick={() => activeContainer && loadPaths(activeContainer, 'Tables')}>
                    Refresh
                  </Button>
                </div>
                {(() => {
                  if (!activeContainer) return <Caption1>Select a container.</Caption1>;
                  const tableListing = openPrefixes[cacheKey(activeContainer, 'Tables')];
                  if (tableListing === 'loading') return <Spinner size="small" label="Listing tables…" labelPosition="after" />;
                  if (!tableListing) {
                    return (
                      <Button onClick={() => loadPaths(activeContainer, 'Tables')}>Load tables</Button>
                    );
                  }
                  if ('error' in tableListing) {
                    return (
                      <MessageBar intent="error">
                        <MessageBarBody>
                          <MessageBarTitle>Could not list tables</MessageBarTitle>
                          {tableListing.error}
                        </MessageBarBody>
                      </MessageBar>
                    );
                  }
                  const tables = (tableListing as PathEntry[]).filter(e => e.isDirectory);
                  if (tables.length === 0) {
                    return (
                      <MessageBar intent="info">
                        <MessageBarBody>
                          No Delta tables yet. From the Files tab, right-click a Parquet / CSV / JSON
                          file and choose <strong>Load to Tables (Delta)</strong> to create one.
                        </MessageBarBody>
                      </MessageBar>
                    );
                  }
                  return (
                    <Table aria-label="Tables">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Table</TableHeaderCell>
                          <TableHeaderCell>Path</TableHeaderCell>
                          <TableHeaderCell>Last modified</TableHeaderCell>
                          <TableHeaderCell></TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tables.map((t) => {
                          const tableName = leafName(t.name);
                          return (
                            <TableRow key={t.name}>
                              <TableCell><strong>{tableName}</strong></TableCell>
                              <TableCell><code style={{ fontSize: 11 }}>/{t.name}</code></TableCell>
                              <TableCell>{t.lastModified ? new Date(t.lastModified).toLocaleString() : '—'}</TableCell>
                              <TableCell>
                                <Button size="small" appearance="primary"
                                  onClick={() => {
                                    setSqlText(`-- Read Delta table\nSELECT TOP 100 *\nFROM OPENROWSET(BULK 'https://__account__.dfs.core.windows.net/${activeContainer}/${t.name}', FORMAT='DELTA') AS r;`);
                                    setTab('sql');
                                  }}>
                                  Query
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  );
                })()}
              </>
            )}

            {tab === 'shortcuts' && (
              <>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="brand">{activeContainer || 'no container'}</Badge>
                  <Caption1>OneLake shortcuts — point at external storage without copying data</Caption1>
                </div>
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Create Shortcut not wired in this deployment</MessageBarTitle>
                    OneLake shortcuts (ADLS Gen2 / S3 / GCS / Dataverse / external Fabric workspace)
                    require the Fabric REST shortcuts endpoint and Console UAMI workspace membership:
                    <ul style={{ marginTop: 6, marginBottom: 6, paddingLeft: 18 }}>
                      <li>Backend route <code>/api/items/lakehouse/[id]/shortcuts</code> (not yet implemented)</li>
                      <li>Calls Fabric REST <code>POST /v1/workspaces/{'{ws}'}/items/{'{lakehouse}'}/shortcuts</code></li>
                      <li>Requires Console UAMI as Member/Admin on the target workspace</li>
                    </ul>
                    For now create shortcuts directly in the Fabric portal: <a href="https://app.fabric.microsoft.com/" target="_blank" rel="noreferrer">app.fabric.microsoft.com</a> → Lakehouse → New shortcut.
                  </MessageBarBody>
                </MessageBar>
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
        </>
      }
    />
  );
}
