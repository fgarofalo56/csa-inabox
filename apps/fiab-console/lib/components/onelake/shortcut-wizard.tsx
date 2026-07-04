'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ShortcutWizard + ShortcutListGrid + ShortcutsPanel — internal
 * (lakehouse-to-lakehouse) shortcut parity with Microsoft Fabric OneLake
 * **internal** shortcuts. NO Fabric dependency.
 *
 * Mirrors Fabric's "New shortcut → OneLake (internal)" flow:
 *   Step 1  Source       pick another lakehouse in the workspace + the ADLS
 *                        storage container that holds its data
 *   Step 2  Browse        Tables / Files tabs → navigate the source container,
 *                        select the folder/table to point at
 *   Step 3  Name + review name the shortcut, choose placement + (Tables) format
 *
 * Backend (real, per no-vaporware.md):
 *   GET  /api/items/lakehouse?workspaceId=         source lakehouses
 *   GET  /api/lakehouse/containers                 storage containers
 *   GET  /api/lakehouse/paths?container=&prefix=    folder navigation
 *   GET  /api/items/[type]/[id]/shortcuts          list (no mock array)
 *   POST /api/items/[type]/[id]/shortcuts          create (ADLS passthrough probe)
 *   POST /api/items/[type]/[id]/shortcuts/[name]/test   live ADLS HEAD → OK/Broken
 *   PATCH/DELETE /api/items/[type]/[id]/shortcuts/[name] rename / remove
 *
 * Azure-native DEFAULT — works with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tab,
  TabList,
  Textarea,
  Tooltip,
  Tree,
  TreeItem,
  TreeItemLayout,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular,
  ArrowSync16Regular,
  CheckmarkCircle16Filled,
  ChevronRight16Regular,
  Database20Regular,
  Delete16Regular,
  Document20Regular,
  DocumentTable20Regular,
  Edit16Regular,
  Eye20Regular,
  EyeOff20Regular,
  Folder20Regular,
  Key16Regular,
  PlugConnected20Regular,
  Globe20Regular,
  Person20Regular,
  Search20Regular,
  Link20Regular,
} from '@fluentui/react-icons';
import type { ShortcutTargetType } from '@/lib/azure/lakehouse-shortcuts';

// ---------------------------------------------------------------------------
// Types (mirrors lib/azure/lakehouse-shortcuts.ts — kept local to avoid a
// server-module import in a client component).
// ---------------------------------------------------------------------------
type ShortcutKind = 'files' | 'tables';
type ShortcutStatus = 'active' | 'pending' | 'error';
type ShortcutFormat = 'delta' | 'parquet' | 'csv' | 'json';

export interface ShortcutRow {
  id: string;
  name: string;
  kind: ShortcutKind;
  parentPath: string;
  fullPath: string;
  targetType: string;
  targetUri: string;
  abfssUri?: string;
  engine?: string;
  engineObject?: string;
  format?: ShortcutFormat;
  status: ShortcutStatus;
  statusDetail?: string;
}

interface LakehouseLite {
  id: string;
  displayName?: string;
  description?: string;
}

interface PathEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

interface ContainerInfo {
  name: string;
  url: string;
}

// ---------------------------------------------------------------------------
const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
  grow: { flex: 1 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '8px' },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardSelected: {
    border: `2px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  browser: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    maxHeight: '260px',
    overflowY: 'auto',
  },
  crumbs: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexWrap: 'wrap',
    padding: '6px 10px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  entryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  entryRowSel: { backgroundColor: tokens.colorBrandBackground2 },
  entryName: { flex: 1, cursor: 'pointer' },
  actions: { display: 'flex', gap: '4px' },
  empty: { padding: '24px', textAlign: 'center', color: tokens.colorNeutralForeground3 },
  stepBody: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '520px' },
  // SharePoint / OneDrive browser polish ------------------------------------
  col: { display: 'flex', flexDirection: 'column', gap: '10px' },
  rowGap8: { display: 'flex', gap: '8px' },
  cardText: { minWidth: 0, display: 'flex', flexDirection: 'column' },
  truncate: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground3,
  },
  entryMeta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '10px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
  },
  spacer: { flex: 1 },
  subtle: { color: tokens.colorNeutralForeground3 },
});

function fmtBytesSp(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function fmtDateSp(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusPill(s: ShortcutStatus) {
  if (s === 'active') return <Badge appearance="filled" color="success">OK</Badge>;
  if (s === 'error') return <Badge appearance="filled" color="danger">Broken</Badge>;
  return <Badge appearance="filled" color="warning">Pending</Badge>;
}

async function jfetch<T = any>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, init);
  let body: any = {};
  try {
    body = await r.json();
  } catch {
    /* non-JSON (e.g. 404 HTML) — leave {} */
  }
  return { status: r.status, body };
}

// ===========================================================================
// Wizard
// ===========================================================================
export interface ShortcutWizardProps {
  /** Item type of the destination lakehouse (almost always 'lakehouse'). */
  itemType?: string;
  /** Destination lakehouse id (Cosmos item id / shortcut partition key). */
  lakehouseId: string;
  /** Workspace id — to list candidate source lakehouses. */
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (sc: ShortcutRow) => void;
}

export function ShortcutWizard({ itemType = 'lakehouse', lakehouseId, workspaceId, open, onClose, onCreated }: ShortcutWizardProps) {
  const styles = useStyles();
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 — source
  const [lakehouses, setLakehouses] = useState<LakehouseLite[] | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [srcLakehouse, setSrcLakehouse] = useState<string>('');
  const [srcContainer, setSrcContainer] = useState<string>('');
  const [srcLoadError, setSrcLoadError] = useState<string | null>(null);

  // Step 2 — browse
  const [kind, setKind] = useState<ShortcutKind>('files');
  const [browsePrefix, setBrowsePrefix] = useState<string>('');
  const [entries, setEntries] = useState<PathEntry[] | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>('');

  // Step 3 — name + review
  const [name, setName] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [format, setFormat] = useState<ShortcutFormat>('delta');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep(1);
    setSrcLakehouse('');
    setSrcContainer('');
    setSrcLoadError(null);
    setKind('files');
    setBrowsePrefix('');
    setEntries(null);
    setBrowseError(null);
    setSelectedPath('');
    setName('');
    setParentPath('');
    setFormat('delta');
    setSubmitError(null);
  }, []);

  // Load sources when the dialog opens.
  useEffect(() => {
    if (!open) return;
    reset();
    let cancelled = false;
    (async () => {
      setSrcLoadError(null);
      const [lh, ct] = await Promise.all([
        jfetch(`/api/items/lakehouse?workspaceId=${encodeURIComponent(workspaceId)}`),
        jfetch('/api/lakehouse/containers'),
      ]);
      if (cancelled) return;
      if (lh.body?.ok) {
        const list: LakehouseLite[] = (lh.body.items || lh.body.lakehouses || []).filter(
          (x: LakehouseLite) => x.id !== lakehouseId,
        );
        setLakehouses(list);
      } else {
        setLakehouses([]);
      }
      if (ct.body?.ok) {
        setContainers(ct.body.containers || []);
      } else {
        setContainers([]);
        setSrcLoadError(ct.body?.error || 'Could not list storage containers.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, lakehouseId, reset]);

  // Browse a container path level whenever container / prefix changes (step 2).
  const loadEntries = useCallback(
    async (container: string, prefix: string) => {
      if (!container) return;
      setBrowsing(true);
      setBrowseError(null);
      const { status, body } = await jfetch(
        `/api/lakehouse/paths?container=${encodeURIComponent(container)}&prefix=${encodeURIComponent(prefix)}`,
      );
      setBrowsing(false);
      if (body?.ok) {
        setEntries(body.paths || []);
      } else {
        setEntries([]);
        setBrowseError(body?.error || `Could not list ${container}/${prefix} (HTTP ${status}).`);
      }
    },
    [],
  );

  useEffect(() => {
    if (open && step === 2 && srcContainer) loadEntries(srcContainer, browsePrefix);
  }, [open, step, srcContainer, browsePrefix, loadEntries]);

  const leaf = (full: string) => full.split('/').filter(Boolean).pop() || full;
  const targetUri = srcContainer && selectedPath ? `internal://${srcContainer}/${selectedPath}` : '';

  const crumbs = useMemo(() => {
    const segs = browsePrefix.split('/').filter(Boolean);
    const acc: { label: string; prefix: string }[] = [{ label: srcContainer || 'root', prefix: '' }];
    let cur = '';
    for (const s of segs) {
      cur = cur ? `${cur}/${s}` : s;
      acc.push({ label: s, prefix: cur });
    }
    return acc;
  }, [browsePrefix, srcContainer]);

  const canNext1 = !!srcContainer;
  const canNext2 = !!selectedPath;
  const canSubmit = !!name.trim() && /^[A-Za-z0-9 _.-]{1,128}$/.test(name.trim()) && !!targetUri;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    const { status, body } = await jfetch(`/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(lakehouseId)}/shortcuts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        kind,
        parentPath: parentPath.trim(),
        targetType: 'internal',
        targetUri,
        format: kind === 'tables' ? format : undefined,
      }),
    });
    setSubmitting(false);
    if ((status === 200 || status === 201) && body?.ok) {
      onCreated(body.data as ShortcutRow);
      onClose();
      return;
    }
    setSubmitError(body?.hint || body?.error || `Create failed (HTTP ${status}).`);
  }, [canSubmit, itemType, lakehouseId, name, kind, parentPath, targetUri, format, onCreated, onClose]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New shortcut — internal lakehouse ({step}/3)</DialogTitle>
          <DialogContent className={styles.stepBody}>
            {/* ---------------- Step 1: source ---------------- */}
            {step === 1 && (
              <>
                <Body1>Point this lakehouse at data in another lakehouse — a zero-copy pointer on ADLS Gen2 passthrough (Console UAMI). No bytes are copied.</Body1>
                {srcLoadError && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Storage containers unavailable</MessageBarTitle>
                      {srcLoadError} Set LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL on the Console and grant the
                      UAMI &quot;Storage Blob Data Reader&quot;.
                    </MessageBarBody>
                  </MessageBar>
                )}
                <Field label="Source lakehouse (optional context)">
                  {lakehouses === null ? (
                    <Spinner size="tiny" label="Loading lakehouses…" />
                  ) : lakehouses.length === 0 ? (
                    <Caption1>No other lakehouses in this workspace — pick a storage container below.</Caption1>
                  ) : (
                    <div className={styles.cardGrid}>
                      {lakehouses.map((lh) => (
                        <div
                          key={lh.id}
                          className={`${styles.card} ${srcLakehouse === lh.id ? styles.cardSelected : ''}`}
                          onClick={() => setSrcLakehouse(lh.id)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSrcLakehouse(lh.id); }}
                        >
                          <Database20Regular />
                          <div>
                            <Body1>{lh.displayName || lh.id}</Body1>
                            {lh.description && <Caption1>{lh.description}</Caption1>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Field>
                <Field label="Storage container" required hint="The ADLS Gen2 file system the source data lives in. The shortcut resolves to internal://<container>/<path> on the primary account.">
                  <Dropdown
                    placeholder={containers === null ? 'Loading…' : 'Select a container'}
                    selectedOptions={srcContainer ? [srcContainer] : []}
                    value={srcContainer}
                    onOptionSelect={(_, d) => { setSrcContainer(d.optionValue || ''); setBrowsePrefix(''); setSelectedPath(''); }}
                  >
                    {(containers || []).map((c) => (
                      <Option key={c.name} value={c.name}>{c.name}</Option>
                    ))}
                  </Dropdown>
                </Field>
              </>
            )}

            {/* ---------------- Step 2: browse ---------------- */}
            {step === 2 && (
              <>
                <TabList selectedValue={kind} onTabSelect={(_, d) => setKind(d.value as ShortcutKind)}>
                  <Tab value="files" icon={<Folder20Regular />}>Files</Tab>
                  <Tab value="tables" icon={<DocumentTable20Regular />}>Tables</Tab>
                </TabList>
                <Caption1>
                  Navigate {srcContainer} and select the {kind === 'tables' ? 'table (Delta/Parquet) folder' : 'folder'} to point at.
                </Caption1>
                <div className={styles.browser}>
                  <div className={styles.crumbs}>
                    {crumbs.map((c, i) => (
                      <span key={c.prefix} style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                        {i > 0 && <ChevronRight16Regular />}
                        <Link onClick={() => setBrowsePrefix(c.prefix)}>{c.label}</Link>
                      </span>
                    ))}
                  </div>
                  {browsing ? (
                    <div className={styles.empty}><Spinner size="tiny" label="Listing…" /></div>
                  ) : browseError ? (
                    <div className={styles.empty}><Caption1>{browseError}</Caption1></div>
                  ) : entries && entries.length === 0 ? (
                    <div className={styles.empty}><Caption1>Empty folder. Use the breadcrumb to select a parent, or pick a different container.</Caption1></div>
                  ) : (
                    (entries || []).map((e) => (
                      <div key={e.name} className={`${styles.entryRow} ${selectedPath === e.name ? styles.entryRowSel : ''}`}>
                        {e.isDirectory ? <Folder20Regular /> : <DocumentTable20Regular />}
                        <span
                          className={styles.entryName}
                          onClick={() => (e.isDirectory ? setBrowsePrefix(e.name) : undefined)}
                          role={e.isDirectory ? 'button' : undefined}
                          tabIndex={e.isDirectory ? 0 : undefined}
                          onKeyDown={(ev) => { if (e.isDirectory && (ev.key === 'Enter' || ev.key === ' ')) setBrowsePrefix(e.name); }}
                        >
                          <Body1>{leaf(e.name)}</Body1>
                        </span>
                        <Button
                          size="small"
                          appearance={selectedPath === e.name ? 'primary' : 'secondary'}
                          onClick={() => { setSelectedPath(e.name); if (!name) setName(leaf(e.name)); }}
                        >
                          {selectedPath === e.name ? 'Selected' : 'Select'}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
                {browsePrefix && (
                  <Button
                    size="small"
                    appearance={selectedPath === browsePrefix ? 'primary' : 'secondary'}
                    onClick={() => { setSelectedPath(browsePrefix); if (!name) setName(leaf(browsePrefix)); }}
                  >
                    Use current folder ({leaf(browsePrefix)})
                  </Button>
                )}
                {selectedPath && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      Target: <span className={styles.mono}>internal://{srcContainer}/{selectedPath}</span>
                    </MessageBarBody>
                  </MessageBar>
                )}
              </>
            )}

            {/* ---------------- Step 3: name + review ---------------- */}
            {step === 3 && (
              <>
                <Field label="Shortcut name" required validationState={name && !/^[A-Za-z0-9 _.-]{1,128}$/.test(name.trim()) ? 'error' : 'none'} validationMessage={name && !/^[A-Za-z0-9 _.-]{1,128}$/.test(name.trim()) ? '1-128 chars: letters, digits, space, _ . -' : undefined}>
                  <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="partner_products" />
                </Field>
                <Field label="Placement (sub-folder under the section)" hint={`Appears at ${kind === 'tables' ? 'Tables' : 'Files'}/${parentPath ? parentPath + '/' : ''}${name || '<name>'}`}>
                  <Input value={parentPath} onChange={(_, d) => setParentPath(d.value)} placeholder="(top level)" />
                </Field>
                {kind === 'tables' && (
                  <Field label="Format" hint="The on-disk format of the target table — registers a real external table on the configured query engine.">
                    <Dropdown selectedOptions={[format]} value={format} onOptionSelect={(_, d) => setFormat((d.optionValue as ShortcutFormat) || 'delta')}>
                      <Option value="delta">Delta</Option>
                      <Option value="parquet">Parquet</Option>
                      <Option value="csv">CSV</Option>
                      <Option value="json">JSON</Option>
                    </Dropdown>
                  </Field>
                )}
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Review</MessageBarTitle>
                    Create a {kind === 'tables' ? 'Tables' : 'Files'} shortcut <b>{name || '<name>'}</b> pointing at{' '}
                    <span className={styles.mono}>{targetUri || 'internal://<container>/<path>'}</span>. Reachability is
                    verified against ADLS on the Console UAMI before the shortcut is saved.
                  </MessageBarBody>
                </MessageBar>
                {submitError && (
                  <MessageBar intent="error">
                    <MessageBarBody><MessageBarTitle>Could not create shortcut</MessageBarTitle>{submitError}</MessageBarBody>
                  </MessageBar>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            {step > 1 && <Button appearance="secondary" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>Back</Button>}
            {step < 3 ? (
              <Button
                appearance="primary"
                disabled={step === 1 ? !canNext1 : !canNext2}
                onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
              >
                Next
              </Button>
            ) : (
              <Button appearance="primary" disabled={!canSubmit || submitting} icon={submitting ? <Spinner size="tiny" /> : undefined} onClick={submit}>
                Create shortcut
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ===========================================================================
// List grid
// ===========================================================================
export interface ShortcutListGridProps {
  itemType?: string;
  lakehouseId: string;
  rows: ShortcutRow[] | null;
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}

export function ShortcutListGrid({ itemType = 'lakehouse', lakehouseId, rows, loading, error, onChanged }: ShortcutListGridProps) {
  const styles = useStyles();
  const [busy, setBusy] = useState<Record<string, 'test' | 'delete'>>({});
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<ShortcutRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const base = `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(lakehouseId)}/shortcuts`;

  const test = useCallback(async (sc: ShortcutRow) => {
    setBusy((b) => ({ ...b, [sc.id]: 'test' }));
    setRowMsg((m) => ({ ...m, [sc.id]: '' }));
    const { body } = await jfetch(`${base}/${encodeURIComponent(sc.id)}/test`, { method: 'POST' });
    setBusy((b) => { const n = { ...b }; delete n[sc.id]; return n; });
    if (body?.data) {
      setRowMsg((m) => ({ ...m, [sc.id]: body.ok ? 'Target reachable.' : (body.data.statusDetail || body.error || 'Broken.') }));
      onChanged();
    } else {
      setRowMsg((m) => ({ ...m, [sc.id]: body?.error || 'Test failed.' }));
    }
  }, [base, onChanged]);

  const remove = useCallback(async (sc: ShortcutRow) => {
    setBusy((b) => ({ ...b, [sc.id]: 'delete' }));
    const { body } = await jfetch(`${base}/${encodeURIComponent(sc.id)}`, { method: 'DELETE' });
    setBusy((b) => { const n = { ...b }; delete n[sc.id]; return n; });
    if (body?.ok) onChanged();
    else setRowMsg((m) => ({ ...m, [sc.id]: body?.error || 'Delete failed.' }));
  }, [base, onChanged]);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    setEditBusy(true);
    setEditError(null);
    const { status, body } = await jfetch(`${base}/${encodeURIComponent(editing.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: editName.trim() }),
    });
    setEditBusy(false);
    if (body?.ok) { setEditing(null); onChanged(); }
    else setEditError(body?.hint || body?.error || `Rename failed (HTTP ${status}).`);
  }, [editing, editName, base, onChanged]);

  if (loading) return <Spinner size="small" label="Loading shortcuts…" />;
  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody><MessageBarTitle>Could not load shortcuts</MessageBarTitle>{error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <div className={styles.empty}>
        <PlugConnected20Regular />
        <Body1>No shortcuts yet. Create one to surface another lakehouse&apos;s data here without copying it.</Body1>
      </div>
    );
  }

  return (
    <>
      <Table size="small" aria-label="Lakehouse shortcuts">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Path</TableHeaderCell>
            <TableHeaderCell>Source</TableHeaderCell>
            <TableHeaderCell>Kind</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((sc) => (
            <TableRow key={sc.id}>
              <TableCell>{sc.name}</TableCell>
              <TableCell><span className={styles.mono}>{sc.fullPath}</span></TableCell>
              <TableCell><span className={styles.mono}>{sc.targetUri}</span></TableCell>
              <TableCell>{sc.kind === 'tables' ? 'Tables' : 'Files'}</TableCell>
              <TableCell>
                <Tooltip content={sc.statusDetail || rowMsg[sc.id] || (sc.status === 'active' ? 'Reachable' : '')} relationship="description">
                  {statusPill(sc.status)}
                </Tooltip>
              </TableCell>
              <TableCell>
                <div className={styles.actions}>
                  <Tooltip content="Test — live ADLS HEAD against the target" relationship="label">
                    <Button size="small" appearance="subtle" icon={busy[sc.id] === 'test' ? <Spinner size="tiny" /> : <ArrowSync16Regular />} onClick={() => test(sc)} disabled={!!busy[sc.id]}>Test</Button>
                  </Tooltip>
                  <Tooltip content="Rename" relationship="label">
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label="Rename shortcut" onClick={() => { setEditing(sc); setEditName(sc.name); setEditError(null); }} disabled={!!busy[sc.id]} />
                  </Tooltip>
                  <Tooltip content="Delete (never deletes source data)" relationship="label">
                    <Button size="small" appearance="subtle" icon={busy[sc.id] === 'delete' ? <Spinner size="tiny" /> : <Delete16Regular />} aria-label="Delete shortcut" onClick={() => remove(sc)} disabled={!!busy[sc.id]} />
                  </Tooltip>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={!!editing} onOpenChange={(_, d) => { if (!d.open) setEditing(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Rename shortcut</DialogTitle>
            <DialogContent>
              <Field label="Shortcut name" required validationState={editName && !/^[A-Za-z0-9 _.-]{1,128}$/.test(editName.trim()) ? 'error' : 'none'}>
                <Input value={editName} onChange={(_, d) => setEditName(d.value)} />
              </Field>
              {editError && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}>
                  <MessageBarBody>{editError}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button appearance="primary" disabled={editBusy || !editName.trim()} icon={editBusy ? <Spinner size="tiny" /> : undefined} onClick={saveEdit}>Save</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

// ===========================================================================
// Panel (grid + New button + wizard) — the mountable surface
// ===========================================================================
export interface ShortcutsPanelProps {
  itemType?: string;
  lakehouseId: string;
  workspaceId: string;
}

export function ShortcutsPanel({ itemType = 'lakehouse', lakehouseId, workspaceId }: ShortcutsPanelProps) {
  const styles = useStyles();
  const [rows, setRows] = useState<ShortcutRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { status, body } = await jfetch(`/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(lakehouseId)}/shortcuts`);
    setLoading(false);
    if (body?.ok) setRows(body.data || []);
    else { setRows([]); setError(body?.error || `Could not load shortcuts (HTTP ${status}).`); }
  }, [itemType, lakehouseId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Body1><b>Shortcuts</b> — zero-copy pointers to other lakehouse data (Azure-native, no Fabric)</Body1>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Button appearance="secondary" icon={<ArrowSync16Regular />} onClick={load}>Refresh</Button>
          <Button appearance="primary" icon={<Add20Regular />} onClick={() => setWizardOpen(true)}>New shortcut</Button>
        </div>
      </div>
      <ShortcutListGrid itemType={itemType} lakehouseId={lakehouseId} rows={rows} loading={loading} error={error} onChanged={load} />
      <ShortcutWizard
        itemType={itemType}
        lakehouseId={lakehouseId}
        workspaceId={workspaceId}
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => load()}
      />
    </div>
  );
}

/**
 * Shortcut wizard building blocks — Azure-native parity with Fabric OneLake's
 * "New shortcut → External sources" experience, NO Fabric dependency.
 *
 * Exports (consumed by lib/editors/lakehouse-editor.tsx):
 *   - SHORTCUT_SOURCE_CARDS  : source-type catalog (label + blurb + readiness)
 *   - ShortcutSourceLogo     : inline brand SVG per source (no external/CDN fetch)
 *   - ExternalCredsForm       : structured credential form (key/secret, SA-JSON,
 *                               SAS, Synapse-Link path — NEVER a freeform JSON
 *                               blob for config) that stashes the secret into Key
 *                               Vault and surfaces ONLY the secret name
 *   - RemoteBrowseTree        : lazy, real remote-object tree over the browse BFF
 *
 * Credentials are written to Key Vault by the BFF and only the secret NAME is
 * ever held in the UI / Cosmos row. Per .claude/rules/no-vaporware.md every
 * control here calls a real backend; the only non-functional state is an honest
 * MessageBar gate. Per loom-no-freeform-config the credential inputs are typed
 * fields, not a JSON textarea (the GCS service-account file is the one exception
 * Google itself distributes as a .json — pasted whole, validated, never echoed).
 */

// ---------------------------------------------------------------------------
// Source catalog + brand logos (inline SVG — CSP-safe, no remote image fetch).
// ---------------------------------------------------------------------------

export interface ShortcutSourceCard {
  type: ShortcutTargetType;
  label: string;
  blurb: string;
  /** true ⇒ works on the Console UAMI alone; false ⇒ needs a KV credential. */
  uamiReady: boolean;
}

export const SHORTCUT_SOURCE_CARDS: ShortcutSourceCard[] = [
  { type: 'internal', label: 'Internal Loom lakehouse', blurb: 'Another medallion container in this deployment', uamiReady: true },
  { type: 'adls', label: 'ADLS Gen2 / Azure Blob', blurb: 'Any storage account the Console UAMI can read', uamiReady: true },
  { type: 'sharepoint', label: 'SharePoint / OneDrive', blurb: 'Document libraries & OneDrive folders via Microsoft Graph', uamiReady: true },
  { type: 's3', label: 'Amazon S3', blurb: 'Bucket via access key/secret or IAM role', uamiReady: false },
  { type: 'gcs', label: 'Google Cloud Storage', blurb: 'Bucket via a service-account JSON', uamiReady: false },
  { type: 'dataverse', label: 'Dataverse', blurb: 'Tables via the Synapse-Link ADLS export', uamiReady: false },
  { type: 'delta_sharing', label: 'Delta Sharing', blurb: 'Cross-tenant share via a credential file', uamiReady: false },
];

/** Inline brand logo for a shortcut source type. Pure SVG, theme-agnostic fills. */
export function ShortcutSourceLogo({ type, size = 28 }: { type: ShortcutTargetType; size?: number }) {
  const s = size;
  switch (type) {
    case 's3':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Amazon S3">
          <path d="M6 7l10-3 10 3v18l-10 3-10-3V7z" fill="#E25444" />
          <path d="M16 4v27l10-3V7L16 4z" fill="#B0341D" />
          <path d="M11 12h10v2H11zm0 4h10v2H11zm0 4h7v2h-7z" fill="#fff" />
        </svg>
      );
    case 'gcs':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Google Cloud Storage">
          <rect x="5" y="9" width="22" height="6" rx="1" fill="#4285F4" />
          <rect x="5" y="17" width="22" height="6" rx="1" fill="#AECBFA" />
          <circle cx="9" cy="12" r="1.3" fill="#fff" />
          <circle cx="9" cy="20" r="1.3" fill="#4285F4" />
        </svg>
      );
    case 'adls':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Azure Data Lake Storage">
          <path d="M16 4l11 6v12l-11 6-11-6V10l11-6z" fill="#0078D4" />
          <path d="M16 4l11 6-11 6-11-6 11-6z" fill="#50B0E8" />
          <path d="M16 16l11-6v12l-11 6V16z" fill="#005A9E" />
        </svg>
      );
    case 'dataverse':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Microsoft Dataverse">
          <path d="M16 3l11 6.5v13L16 29 5 22.5v-13L16 3z" fill="#742774" />
          <path d="M16 3l11 6.5L16 16 5 9.5 16 3z" fill="#B05CB0" />
          <ellipse cx="16" cy="12" rx="6" ry="2.4" fill="#fff" opacity="0.85" />
        </svg>
      );
    case 'delta_sharing':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Delta Sharing">
          <path d="M6 22l10-16 10 16H6z" fill="#FF3621" />
          <path d="M11 22l5-8 5 8h-10z" fill="#fff" opacity="0.9" />
        </svg>
      );
    case 'sharepoint':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="SharePoint / OneDrive">
          <circle cx="12" cy="10" r="6.5" fill="#036C70" />
          <circle cx="20.5" cy="14.5" r="6" fill="#1A9BA1" />
          <circle cx="14.5" cy="21" r="5.5" fill="#37C6D0" />
          <path d="M11 7.5h5.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2z" fill="#fff" opacity="0.92" />
          <path d="M11.4 10.6h3.6v1.1h-3.6zm0 2.1h3.6v1.1h-3.6zm0 2.1h2.4v1.1h-2.4z" fill="#036C70" />
        </svg>
      );
    case 'internal':
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Internal Loom lakehouse">
          <rect x="5" y="7" width="22" height="18" rx="2" fill="#5B5FC7" />
          <path d="M9 12h14v2H9zm0 5h14v2H9z" fill="#fff" />
        </svg>
      );
  }
}

// ---------------------------------------------------------------------------
// ExternalCredsForm — structured credential capture + KV stash.
// ---------------------------------------------------------------------------

export type CredSourceType = 's3' | 'gcs' | 'adls' | 'dataverse';

export interface ExternalCredsState {
  /** S3/GCS bucket. */
  bucket?: string;
  /** AWS region (S3). */
  region?: string;
  /** ADLS storage account (browse on UAMI — no KV secret). */
  account?: string;
  /** ADLS container/filesystem. */
  container?: string;
  /** KV secret NAME after a successful stash (never the value). */
  secretName?: string;
  /** Path the user picked in the browse tree (relative to the source root). */
  selectedPath?: string;
}

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'us-gov-west-1', 'us-gov-east-1',
  'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1',
];

interface ExternalCredsFormProps {
  sourceType: CredSourceType;
  lakehouseId: string;
  /** Shortcut name — used for the deterministic KV secret name. */
  shortcutName: string;
  value: ExternalCredsState;
  onChange: (next: ExternalCredsState) => void;
}

/**
 * Renders the typed credential inputs for one external source and a
 * "Save to Key Vault" action. On success the credential value is written to KV
 * and the form keeps ONLY the returned secret name; the raw value is dropped
 * from component state immediately.
 */
export function ExternalCredsForm({ sourceType, lakehouseId, shortcutName, value, onChange }: ExternalCredsFormProps) {
  // Local, ephemeral credential material — cleared as soon as it is stashed.
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [s3Mode, setS3Mode] = useState<'keys' | 'role'>('keys');
  const [saJson, setSaJson] = useState('');
  const [sasToken, setSasToken] = useState('');
  const [dvPath, setDvPath] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback((patch: Partial<ExternalCredsState>) => onChange({ ...value, ...patch }), [onChange, value]);

  const stash = useCallback(async () => {
    setBusy(true); setError(null);
    let secretValue = '';
    if (sourceType === 's3') {
      secretValue = s3Mode === 'role' ? roleArn.trim() : `${accessKeyId.trim()}:${secretKey}`;
    } else if (sourceType === 'gcs') {
      secretValue = saJson.trim();
    } else if (sourceType === 'adls') {
      secretValue = sasToken.trim();
    } else {
      secretValue = dvPath.trim();
    }
    try {
      const r = await clientFetch('/api/lakehouse/shortcuts/credentials', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId, name: shortcutName || sourceType, sourceType, secretValue }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) throw new Error(j?.error || j?.hint || `HTTP ${r.status}`);
      // Drop the raw material from memory; keep only the secret name.
      setSecretKey(''); setSaJson(''); setSasToken('');
      set({ secretName: j.data.secretName });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [sourceType, s3Mode, roleArn, accessKeyId, secretKey, saJson, sasToken, dvPath, lakehouseId, shortcutName, set]);

  const canStash =
    sourceType === 's3'
      ? (s3Mode === 'role' ? roleArn.trim().length > 0 : accessKeyId.trim().length > 0 && secretKey.length > 0)
      : sourceType === 'gcs'
      ? saJson.trim().length > 0
      : sourceType === 'adls'
      ? sasToken.trim().length > 0
      : dvPath.trim().length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalMNudge }}>
      {sourceType === 's3' && (
        <>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
            <Field label="Bucket" required style={{ flex: 2 }}>
              <Input value={value.bucket || ''} onChange={(_, d) => set({ bucket: d.value })} placeholder="my-bucket" />
            </Field>
            <Field label="Region" required style={{ flex: 1 }}>
              <Dropdown
                value={value.region || 'us-east-1'}
                selectedOptions={[value.region || 'us-east-1']}
                onOptionSelect={(_, d) => set({ region: d.optionValue || 'us-east-1' })}
              >
                {AWS_REGIONS.map((rg) => <Option key={rg} value={rg}>{rg}</Option>)}
              </Dropdown>
            </Field>
          </div>
          <Field label="Authentication">
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
              <Button size="small" appearance={s3Mode === 'keys' ? 'primary' : 'outline'} onClick={() => setS3Mode('keys')}>Access key / secret</Button>
              <Button size="small" appearance={s3Mode === 'role' ? 'primary' : 'outline'} onClick={() => setS3Mode('role')}>IAM role ARN (Unity Catalog)</Button>
            </div>
          </Field>
          {s3Mode === 'keys' ? (
            <>
              <Field label="Access key ID" required>
                <Input value={accessKeyId} onChange={(_, d) => setAccessKeyId(d.value)} placeholder="AKIA…" disabled={!!value.secretName} />
              </Field>
              <Field label="Secret access key" required>
                <Input
                  type={showSecret ? 'text' : 'password'}
                  value={secretKey}
                  onChange={(_, d) => setSecretKey(d.value)}
                  disabled={!!value.secretName}
                  contentAfter={
                    <Button appearance="transparent" size="small" icon={showSecret ? <EyeOff20Regular /> : <Eye20Regular />} onClick={() => setShowSecret((v) => !v)} aria-label="Toggle secret visibility" />
                  }
                />
              </Field>
            </>
          ) : (
            <Field label="IAM role ARN" required hint="arn:aws:iam::<acct>:role/<name> — assumed by Unity Catalog (browse uses keys; role binds at create)">
              <Input value={roleArn} onChange={(_, d) => setRoleArn(d.value)} placeholder="arn:aws:iam::123456789012:role/loom-s3-read" disabled={!!value.secretName} />
            </Field>
          )}
        </>
      )}

      {sourceType === 'gcs' && (
        <>
          <Field label="Bucket" required>
            <Input value={value.bucket || ''} onChange={(_, d) => set({ bucket: d.value })} placeholder="my-gcs-bucket" />
          </Field>
          <Field label="Service-account JSON" required hint="Paste the service-account key file (.json) — stored in Key Vault, never echoed.">
            <Textarea value={saJson} onChange={(_, d) => setSaJson(d.value)} rows={5} placeholder={'{ "type": "service_account", "client_email": "…", "private_key": "-----BEGIN PRIVATE KEY-----…" }'} disabled={!!value.secretName} resize="vertical" />
          </Field>
        </>
      )}

      {sourceType === 'adls' && (
        <>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
            <Field label="Storage account" required style={{ flex: 1 }} hint="Account name (browse runs on the Console UAMI)">
              <Input value={value.account || ''} onChange={(_, d) => set({ account: d.value })} placeholder="contosolake" />
            </Field>
            <Field label="Container / filesystem" required style={{ flex: 1 }}>
              <Input value={value.container || ''} onChange={(_, d) => set({ container: d.value })} placeholder="landing" />
            </Field>
          </div>
          <Field label="SAS token (optional)" hint="Only needed for accounts the UAMI cannot reach — stored in Key Vault, never echoed.">
            <Input type={showSecret ? 'text' : 'password'} value={sasToken} onChange={(_, d) => setSasToken(d.value)} disabled={!!value.secretName}
              contentAfter={<Button appearance="transparent" size="small" icon={showSecret ? <EyeOff20Regular /> : <Eye20Regular />} onClick={() => setShowSecret((v) => !v)} aria-label="Toggle secret visibility" />} />
          </Field>
        </>
      )}

      {sourceType === 'dataverse' && (
        <Field label="Synapse-Link export path" required hint="abfss://<container>@<account>.dfs.core.windows.net/<path> that Azure Synapse Link for Dataverse writes tables to — stored in Key Vault.">
          <Input value={dvPath} onChange={(_, d) => setDvPath(d.value)} placeholder="abfss://dataverse@contosolake.dfs.core.windows.net/exports" disabled={!!value.secretName} />
        </Field>
      )}

      {/* Stash / stashed status */}
      {value.secretName ? (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Credential stored</MessageBarTitle>
            Saved as Key Vault secret <code>{value.secretName}</code>. The shortcut keeps only this name — the value is never stored in Cosmos or shown again.
            {' '}
            <Button size="small" appearance="transparent" onClick={() => set({ secretName: undefined })}>Replace…</Button>
          </MessageBarBody>
        </MessageBar>
      ) : sourceType === 'adls' ? (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          ADLS browses on the Console UAMI — save a SAS only for accounts the UAMI cannot read.
          {(value.account && value.container) ? '' : ' Enter account + container to browse.'}
        </Caption1>
      ) : (
        <div>
          <Button appearance="primary" size="small" icon={busy ? <Spinner size="tiny" /> : <Key16Regular />} disabled={!canStash || busy} onClick={stash}>
            {busy ? 'Saving…' : 'Save credential to Key Vault'}
          </Button>
        </div>
      )}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RemoteBrowseTree — lazy, real remote-object tree over the browse BFF.
// ---------------------------------------------------------------------------

interface RemoteEntryUi {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  lastModified?: string;
}

interface RemoteBrowseTreeProps {
  sourceType: CredSourceType;
  /** S3/GCS bucket. */
  bucket?: string;
  /** AWS region (S3). */
  region?: string;
  /** ADLS account + container. */
  account?: string;
  container?: string;
  /** KV secret name (s3/gcs/dataverse). */
  kvSecret?: string;
  /** Called when the user clicks a folder or file in the tree. */
  onSelect: (path: string, isDirectory: boolean) => void;
  selectedPath?: string;
}

function fmtBytes(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

/**
 * Lazily lists one level at a time from the browse BFF, rendering an expandable
 * Fluent tree of the real remote objects. Folders fetch their children on first
 * expand; clicking any node selects it as the shortcut target sub-path.
 */
export function RemoteBrowseTree(props: RemoteBrowseTreeProps) {
  const { sourceType, bucket, region, account, container, kvSecret, onSelect, selectedPath } = props;
  const [childrenByPrefix, setChildrenByPrefix] = useState<Record<string, RemoteEntryUi[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());

  const ready =
    sourceType === 'adls'
      ? !!account && !!container
      : sourceType === 'dataverse'
      ? !!kvSecret
      : !!bucket && !!kvSecret;

  const fetchLevel = useCallback(async (prefix: string) => {
    setLoading((s) => new Set(s).add(prefix));
    setErrors((e) => { const n = { ...e }; delete n[prefix]; return n; });
    try {
      const qs = new URLSearchParams({ sourceType, prefix });
      if (bucket) qs.set('bucket', bucket);
      if (region) qs.set('region', region);
      if (account) qs.set('account', account);
      if (container) qs.set('container', container);
      if (kvSecret) qs.set('kvSecret', kvSecret);
      const r = await clientFetch(`/api/lakehouse/shortcuts/browse?${qs.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) throw new Error(j?.error || j?.hint || `HTTP ${r.status}`);
      setChildrenByPrefix((c) => ({ ...c, [prefix]: (j.data?.entries || []) as RemoteEntryUi[] }));
    } catch (e: any) {
      setErrors((er) => ({ ...er, [prefix]: e?.message || String(e) }));
    } finally {
      setLoading((s) => { const n = new Set(s); n.delete(prefix); return n; });
    }
  }, [sourceType, bucket, region, account, container, kvSecret]);

  // Root load when the inputs become ready (and reset when they change).
  useEffect(() => {
    setChildrenByPrefix({}); setErrors({}); setOpenItems(new Set());
    if (ready) fetchLevel('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sourceType, bucket, region, account, container, kvSecret]);

  const renderLevel = (prefix: string): React.ReactNode => {
    if (errors[prefix]) {
      return (
        <TreeItem itemType="leaf" value={`err-${prefix}`}>
          <TreeItemLayout><Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{errors[prefix]}</Caption1></TreeItemLayout>
        </TreeItem>
      );
    }
    const rows = childrenByPrefix[prefix];
    if (rows === undefined) {
      return (
        <TreeItem itemType="leaf" value={`load-${prefix}`}>
          <TreeItemLayout><Spinner size="tiny" label="Loading…" labelPosition="after" /></TreeItemLayout>
        </TreeItem>
      );
    }
    if (rows.length === 0) {
      return (
        <TreeItem itemType="leaf" value={`empty-${prefix}`}>
          <TreeItemLayout><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No objects</Caption1></TreeItemLayout>
        </TreeItem>
      );
    }
    return rows.map((e) =>
      e.isDirectory ? (
        <TreeItem key={e.path} itemType="branch" value={e.path}>
          <TreeItemLayout
            iconBefore={<Folder20Regular />}
            onClick={() => onSelect(e.path, true)}
            style={selectedPath === e.path ? { fontWeight: 600, color: tokens.colorBrandForeground1 } : undefined}
          >
            {e.name}
          </TreeItemLayout>
          <Tree>
            {loading.has(e.path)
              ? <TreeItem itemType="leaf" value={`load-${e.path}`}><TreeItemLayout><Spinner size="tiny" /></TreeItemLayout></TreeItem>
              : renderLevel(e.path)}
          </Tree>
        </TreeItem>
      ) : (
        <TreeItem key={e.path} itemType="leaf" value={e.path}>
          <TreeItemLayout
            iconBefore={<Document20Regular />}
            onClick={() => onSelect(e.path, false)}
            aside={<Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{fmtBytes(e.size)}</Caption1>}
            style={selectedPath === e.path ? { fontWeight: 600, color: tokens.colorBrandForeground1 } : undefined}
          >
            {e.name}
          </TreeItemLayout>
        </TreeItem>
      ),
    );
  };

  if (!ready) {
    return (
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        {sourceType === 'adls'
          ? 'Enter a storage account and container to browse.'
          : 'Save the credential to Key Vault and set the bucket to browse.'}
      </Caption1>
    );
  }

  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: tokens.spacingVerticalSNudge, maxHeight: 240, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, marginBottom: tokens.spacingVerticalXS }}>
        <Caption1 style={{ flex: 1, color: tokens.colorNeutralForeground3 }}>
          {selectedPath ? <>Target: <code>{selectedPath || '(root)'}</code></> : 'Click a folder or file to set the target'}
        </Caption1>
        <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={() => fetchLevel('')} aria-label="Refresh">Refresh</Button>
        {selectedPath !== undefined && <Badge appearance="tint" color="brand" icon={<CheckmarkCircle16Filled />}>selected</Badge>}
      </div>
      <Tree
        aria-label="Remote objects"
        openItems={openItems}
        onOpenChange={(_, data) => {
          setOpenItems(new Set(data.openItems as Set<string>));
          const v = data.value as string;
          if (data.open && v && childrenByPrefix[v] === undefined && !loading.has(v)) fetchLevel(v);
        }}
      >
        {renderLevel('')}
      </Tree>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SharePointBrowser — site/OneDrive → drive → folder navigation over Microsoft
// Graph. Azure-native parity with Fabric OneLake's OneDrive/SharePoint shortcut
// browse, NO Fabric dependency. Every call hits the real Graph BFF
// (/api/lakehouse/shortcuts/sharepoint); the only non-functional state is the
// honest 503 gate naming LOOM_SHAREPOINT_SHORTCUTS_ENABLED + the Graph app-roles.
// ---------------------------------------------------------------------------

interface SpSite { id: string; displayName: string; webUrl?: string; name?: string }
interface SpDrive { id: string; name: string; driveType?: string; webUrl?: string; owner?: string }
interface SpItem { id: string; name: string; path: string; isFolder: boolean; size?: number; lastModified?: string; webUrl?: string }

export interface SharePointSelection {
  driveId: string;
  driveName: string;
  /** Drive-relative path of the selected folder/file ('' = drive root). */
  path: string;
  isFolder: boolean;
}

export interface SharePointBrowserProps {
  /** Called whenever the user picks a folder/file (or the drive root). */
  onSelect: (sel: SharePointSelection) => void;
  /** Current selection (drive id + path) for highlight. */
  selected?: { driveId: string; path: string };
}

const SP_BASE = '/api/lakehouse/shortcuts/sharepoint';

/**
 * Three-stage Graph navigator: (1) pick a source — a SharePoint site (searched
 * by keyword), your OneDrive, or paste a link; (2) pick the document library
 * (drive) on a site; (3) drill the folder tree and Select a folder/file.
 */
export function SharePointBrowser({ onSelect, selected }: SharePointBrowserProps) {
  const styles = useStyles();
  const [mode, setMode] = useState<'site' | 'onedrive' | 'link'>('site');

  // Site search
  const [siteQuery, setSiteQuery] = useState('');
  const [sites, setSites] = useState<SpSite[] | null>(null);
  const [siteBusy, setSiteBusy] = useState(false);
  const [activeSite, setActiveSite] = useState<SpSite | null>(null);

  // Drives (site libraries or OneDrive)
  const [drives, setDrives] = useState<SpDrive[] | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const [activeDrive, setActiveDrive] = useState<SpDrive | null>(null);

  // Folder tree
  const [prefix, setPrefix] = useState('');
  const [items, setItems] = useState<SpItem[] | null>(null);
  const [itemsBusy, setItemsBusy] = useState(false);

  // Paste a link
  const [link, setLink] = useState('');

  const [gate, setGate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (qs: string): Promise<any> => {
    setError(null);
    const { status, body } = await jfetch(`${SP_BASE}?${qs}`);
    if (status === 503) { setGate(body?.error || 'SharePoint shortcuts are not configured.'); return null; }
    setGate(null);
    if (!body?.ok) { setError(body?.error || `Request failed (HTTP ${status}).`); return null; }
    return body.data;
  }, []);

  const searchSites = useCallback(async () => {
    setSiteBusy(true);
    const d = await call(`action=sites&q=${encodeURIComponent(siteQuery)}`);
    setSiteBusy(false);
    if (d) setSites(d.sites || []);
  }, [call, siteQuery]);

  const openSite = useCallback(async (site: SpSite) => {
    setActiveSite(site); setActiveDrive(null); setItems(null); setPrefix('');
    setDriveBusy(true);
    const d = await call(`action=siteDrives&siteId=${encodeURIComponent(site.id)}`);
    setDriveBusy(false);
    if (d) setDrives(d.drives || []);
  }, [call]);

  const openOneDrive = useCallback(async () => {
    setMode('onedrive'); setActiveSite(null); setActiveDrive(null); setItems(null); setPrefix('');
    setDriveBusy(true);
    const d = await call('action=userDrives');
    setDriveBusy(false);
    if (d) setDrives(d.drives || []);
  }, [call]);

  const openDrive = useCallback(async (drive: SpDrive, px = '') => {
    setActiveDrive(drive); setPrefix(px);
    setItemsBusy(true);
    const d = await call(`action=children&driveId=${encodeURIComponent(drive.id)}&prefix=${encodeURIComponent(px)}`);
    setItemsBusy(false);
    if (d) setItems(d.entries || []);
  }, [call]);

  const resolveLink = useCallback(async () => {
    if (!link.trim()) return;
    setItemsBusy(true);
    const d = await call(`action=resolveUrl&url=${encodeURIComponent(link.trim())}`);
    setItemsBusy(false);
    if (d?.item) {
      const it = d.item as SpItem;
      onSelect({ driveId: d.driveId, driveName: 'Shared item', path: it.path, isFolder: it.isFolder });
    }
  }, [call, link, onSelect]);

  const crumbs = useMemo(() => {
    const segs = prefix.split('/').filter(Boolean);
    const acc: { label: string; prefix: string }[] = [{ label: activeDrive?.name || 'root', prefix: '' }];
    let cur = '';
    for (const sgmt of segs) { cur = cur ? `${cur}/${sgmt}` : sgmt; acc.push({ label: sgmt, prefix: cur }); }
    return acc;
  }, [prefix, activeDrive]);

  if (gate) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>SharePoint / OneDrive shortcuts not configured</MessageBarTitle>
          {gate}
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={styles.col}>
      <TabList selectedValue={mode} onTabSelect={(_, d) => {
        const m = d.value as 'site' | 'onedrive' | 'link';
        setMode(m); setError(null);
        if (m === 'onedrive') openOneDrive();
        if (m !== 'onedrive') { setDrives(null); setActiveDrive(null); setItems(null); }
      }}>
        <Tab value="site" icon={<Globe20Regular />}>SharePoint site</Tab>
        <Tab value="onedrive" icon={<Person20Regular />}>My OneDrive</Tab>
        <Tab value="link" icon={<Link20Regular />}>Paste a link</Tab>
      </TabList>

      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      {mode === 'link' && (
        <>
          <Field label="SharePoint / OneDrive link" hint="Paste a sharing link or the page URL of a folder or file.">
            <Input
              value={link}
              onChange={(_, d) => setLink(d.value)}
              placeholder="https://contoso.sharepoint.com/sites/Finance/Shared%20Documents/Reports"
              onKeyDown={(e) => { if (e.key === 'Enter') resolveLink(); }}
              contentAfter={<Button size="small" appearance="primary" icon={<Link20Regular />} onClick={resolveLink} disabled={!link.trim() || itemsBusy}>Resolve</Button>}
            />
          </Field>
          {itemsBusy && <Spinner size="tiny" label="Resolving link…" />}
          {selected?.driveId && (
            <MessageBar intent="success"><MessageBarBody>Linked item selected. Continue to name + place the shortcut.</MessageBarBody></MessageBar>
          )}
        </>
      )}

      {mode === 'site' && (
        <Field label="Find a SharePoint site">
          <div className={styles.rowGap8}>
            <Input
              className={styles.grow}
              value={siteQuery}
              onChange={(_, d) => setSiteQuery(d.value)}
              placeholder="Search sites by name (e.g. Finance)"
              contentBefore={<Search20Regular />}
              onKeyDown={(e) => { if (e.key === 'Enter') searchSites(); }}
            />
            <Button appearance="primary" icon={<Search20Regular />} onClick={searchSites} disabled={siteBusy}>Search</Button>
          </div>
        </Field>
      )}

      {/* Site results */}
      {mode === 'site' && (siteBusy ? (
        <Spinner size="tiny" label="Searching sites…" />
      ) : sites && sites.length === 0 ? (
        <div className={styles.empty}>
          <Globe20Regular />
          <Body1>No sites matched &quot;{siteQuery}&quot;. Try a different keyword.</Body1>
        </div>
      ) : sites ? (
        <div className={styles.cardGrid}>
          {sites.map((site) => (
            <div
              key={site.id}
              className={`${styles.card} ${activeSite?.id === site.id ? styles.cardSelected : ''}`}
              role="button" tabIndex={0}
              aria-pressed={activeSite?.id === site.id}
              onClick={() => openSite(site)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openSite(site); }}
            >
              <Globe20Regular />
              <div className={styles.cardText}>
                <Body1>{site.displayName}</Body1>
                {site.webUrl && <Caption1 className={styles.truncate}>{site.webUrl}</Caption1>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          <Search20Regular />
          <Body1>Search for a SharePoint site by name to list its document libraries.</Body1>
        </div>
      ))}

      {/* Drives (document libraries or OneDrive) */}
      {(mode === 'onedrive' || (mode === 'site' && activeSite)) && (
        driveBusy ? (
          <Spinner size="tiny" label="Loading document libraries…" />
        ) : drives && drives.length === 0 ? (
          <Caption1>No document libraries found.</Caption1>
        ) : drives ? (
          <Field label={mode === 'onedrive' ? 'OneDrive' : `Document library — ${activeSite?.displayName}`}>
            <div className={styles.cardGrid}>
              {drives.map((dr) => (
                <div
                  key={dr.id}
                  className={`${styles.card} ${activeDrive?.id === dr.id ? styles.cardSelected : ''}`}
                  role="button" tabIndex={0}
                  aria-pressed={activeDrive?.id === dr.id}
                  onClick={() => openDrive(dr)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openDrive(dr); }}
                >
                  <Folder20Regular />
                  <div className={styles.cardText}>
                    <Body1>{dr.name}</Body1>
                    <Caption1 className={styles.subtle}>{dr.driveType === 'personal' ? 'OneDrive' : 'Document library'}</Caption1>
                  </div>
                </div>
              ))}
            </div>
          </Field>
        ) : null
      )}

      {/* Folder browser for the active drive */}
      {activeDrive && (
        <div className={styles.browser}>
          <div className={styles.crumbs}>
            {crumbs.map((c, i) => (
              <span key={c.prefix} style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                {i > 0 && <ChevronRight16Regular />}
                <Link onClick={() => openDrive(activeDrive, c.prefix)}>{c.label}</Link>
              </span>
            ))}
            <span className={styles.spacer} />
            <Button
              size="small"
              appearance={selected?.driveId === activeDrive.id && selected?.path === prefix ? 'primary' : 'secondary'}
              onClick={() => onSelect({ driveId: activeDrive.id, driveName: activeDrive.name, path: prefix, isFolder: true })}
            >
              {selected?.driveId === activeDrive.id && selected?.path === prefix ? 'Folder selected' : 'Use this folder'}
            </Button>
          </div>
          {itemsBusy ? (
            <div className={styles.empty}><Spinner size="tiny" label="Listing…" /></div>
          ) : items && items.length === 0 ? (
            <div className={styles.empty}><Caption1>Empty folder. Use &quot;Use this folder&quot; above to point the shortcut here.</Caption1></div>
          ) : (
            (items || []).map((it) => {
              const isSel = selected?.driveId === activeDrive.id && selected?.path === it.path;
              const meta = [fmtBytesSp(it.size), fmtDateSp(it.lastModified)].filter(Boolean);
              return (
                <div key={it.id} className={`${styles.entryRow} ${isSel ? styles.entryRowSel : ''}`}>
                  {it.isFolder ? <Folder20Regular /> : <Document20Regular />}
                  <span
                    className={styles.entryName}
                    onClick={() => (it.isFolder ? openDrive(activeDrive, it.path) : undefined)}
                    role={it.isFolder ? 'button' : undefined}
                    tabIndex={it.isFolder ? 0 : undefined}
                    onKeyDown={(ev) => { if (it.isFolder && (ev.key === 'Enter' || ev.key === ' ')) openDrive(activeDrive, it.path); }}
                  >
                    <Body1>{it.name}</Body1>
                  </span>
                  {meta.length > 0 && <span className={styles.entryMeta}>{meta.join(' · ')}</span>}
                  <Button
                    size="small"
                    appearance={isSel ? 'primary' : 'secondary'}
                    onClick={() => onSelect({ driveId: activeDrive.id, driveName: activeDrive.name, path: it.path, isFolder: it.isFolder })}
                  >
                    {isSel ? 'Selected' : 'Select'}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      )}

      {selected?.driveId && (
        <MessageBar intent="info">
          <MessageBarBody>
            Target: <span className={styles.mono}>sharepoint://{selected.driveId}/{selected.path}</span>
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
