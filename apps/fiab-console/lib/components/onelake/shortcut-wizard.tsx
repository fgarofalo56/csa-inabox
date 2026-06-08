'use client';

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
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular,
  ArrowSync16Regular,
  ChevronRight16Regular,
  Database20Regular,
  Delete16Regular,
  DocumentTable20Regular,
  Edit16Regular,
  Folder20Regular,
  PlugConnected20Regular,
} from '@fluentui/react-icons';

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
});

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
                      <span key={c.prefix} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
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
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => { setEditing(sc); setEditName(sc.name); setEditError(null); }} disabled={!!busy[sc.id]} />
                  </Tooltip>
                  <Tooltip content="Delete (never deletes source data)" relationship="label">
                    <Button size="small" appearance="subtle" icon={busy[sc.id] === 'delete' ? <Spinner size="tiny" /> : <Delete16Regular />} onClick={() => remove(sc)} disabled={!!busy[sc.id]} />
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
                <MessageBar intent="error" style={{ marginTop: 8 }}>
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
        <div style={{ display: 'flex', gap: 8 }}>
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
