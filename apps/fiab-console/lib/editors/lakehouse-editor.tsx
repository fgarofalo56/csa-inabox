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

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Files', actions: [{ label: 'Upload file' }, { label: 'New folder' }, { label: 'Refresh' }] },
    { label: 'Query', actions: [{ label: 'Preview' }, { label: 'Query this file' }] },
    { label: 'Manage', actions: [{ label: 'Permissions' }, { label: 'Settings' }] },
  ]},
];

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
    try {
      const fd = new FormData();
      fd.set('container', activeContainer);
      fd.set('path', targetPath);
      fd.set('file', file);
      const r = await fetch('/api/lakehouse/upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        setActionError(j.error || `Upload failed (HTTP ${r.status})`);
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
    try {
      const qs = new URLSearchParams({ container: activeContainer, path: targetPath });
      const r = await fetch(`/api/lakehouse/path?${qs.toString()}`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok || j.ok === false) setActionError(j.error || `Mkdir failed (HTTP ${r.status})`);
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
    try {
      const qs = new URLSearchParams({
        container: activeContainer,
        path: entry.name,
        recursive: entry.isDirectory ? 'true' : 'false',
      });
      const r = await fetch(`/api/lakehouse/path?${qs.toString()}`, { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok || j.ok === false) setActionError(j.error || `Delete failed (HTTP ${r.status})`);
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

  // ---- render ---------------------------------------------------------
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={RIBBON}
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
              <Tab value="preview">Preview</Tab>
              <Tab value="sql">SQL</Tab>
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
