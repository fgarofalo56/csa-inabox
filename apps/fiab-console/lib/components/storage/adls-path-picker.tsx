'use client';

/**
 * AdlsPathPicker + AdlsBrowseDialog — the shared ADLS Gen2 location picker.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * A working ADLS browser has been in the tree since the Foundry data-asset work
 * — as a PRIVATE function inside `lib/editors/foundry-sub-editors.tsx`
 * (`AdlsBrowseDialog`, ~180 lines, not exported). Every other surface that needs
 * a lake location therefore asks the user to compose an `abfss://` URI by hand;
 * check-no-freeform.mjs counts 33 `adls-uri` asks across the app. This is the
 * adoption-gap shape: the right thing existed and could not be reached.
 *
 * The private copy is NOT deleted here on purpose. `foundry-sub-editors.tsx`
 * carries 3 baselined free-text sites, and the no-freeform ratchet is
 * all-or-nothing per file — editing it to remove one function obliges fixing
 * all three, which is a different work item's job. This file is the shared
 * component that item (and the ~33 others) adopts; the private copy is deleted
 * by whichever wave next opens that editor.
 *
 * ── WHAT IT ADDS OVER THE PRIVATE ONE ───────────────────────────────────────
 *   - ANY storage account, not just the four DLZ containers. The private dialog
 *     could only walk `/api/lakehouse/containers` + `/api/lakehouse/paths`,
 *     which are hard-scoped to LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL and reject
 *     any other container by name. The account is chosen through the shared
 *     cross-subscription discovery (AzureBackedField `storage`), then walked via
 *     /api/storage/[account]/containers[/[container]/paths].
 *   - A DLZ FALLBACK. Enumerating containers needs account-scope
 *     "Storage Blob Data Reader"; plenty of estates (Gov especially) grant only
 *     container scope. When the account-scope listing is denied, the dialog
 *     falls back to the DLZ containers the deployment already knows about
 *     rather than showing a dead end.
 *   - A PRESERVED VALUE. An existing `abfss://` value is parsed back into
 *     account/container/prefix so re-opening lands where the value points, and
 *     a value that cannot be resolved is shown as stored rather than blanked.
 *
 * Azure-native only — ADLS Gen2 + the Loom BFF. No OneLake, no Fabric host
 * (`no-fabric-dependency.md`), and every URL is built from the account's own
 * data-plane host, so sovereign suffixes are preserved (`cloud-parity.md`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Caption1, Field, Input, Spinner, Breadcrumb, BreadcrumbItem, BreadcrumbButton,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Table, TableBody, TableRow, TableCell, TableHeader, TableHeaderCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Folder20Regular, FolderOpen20Regular, Document20Regular, ArrowUp20Regular,
  FolderSearch20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { AzureBackedField } from '@/lib/components/azure/azure-backed-field';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  meta: { color: tokens.colorNeutralForeground3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  tableWrap: { maxHeight: '320px', overflowY: 'auto', marginTop: tokens.spacingVerticalS },
  cell: { paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '240px' },
});

export interface AdlsLocation {
  /** `abfss://<container>@<host>/<path>` — the value surfaces store. */
  uri: string;
  account: string;
  container: string;
  path: string;
  kind: 'folder' | 'file';
}

interface ContainerRow { name: string; url: string }
interface PathRow { name: string; isDirectory: boolean; size: number }

/** Parse an `abfss://c@acct.dfs.<suffix>/path` (or https) URI back into parts. */
export function parseAdlsLocation(uri: string | undefined): { account: string; host: string; container: string; path: string } | null {
  if (!uri) return null;
  const abfss = /^abfss?:\/\/([^@/]+)@([^/]+)\/?(.*)$/i.exec(uri.trim());
  if (abfss) {
    return { container: abfss[1], host: abfss[2], account: abfss[2].split('.')[0], path: abfss[3] || '' };
  }
  const https = /^https:\/\/([^/]+)\/([^/]+)\/?(.*)$/i.exec(uri.trim());
  if (https) {
    return { host: https[1], account: https[1].split('.')[0], container: https[2], path: https[3] || '' };
  }
  return null;
}

/** Compose the canonical abfss URI for a container/host/path triple. */
export function toAbfss(container: string, host: string, path: string): string {
  return `abfss://${container}@${host}/${(path || '').replace(/^\/+/, '')}`;
}

/**
 * The browse dialog: account → containers → paths, emitting an abfss URI.
 * `initialUri` primes the walk so re-opening an existing value lands on it.
 */
export function AdlsBrowseDialog({
  open, onClose, onPick, initialUri, mode = 'any',
}: {
  open: boolean;
  onClose: () => void;
  onPick: (loc: AdlsLocation) => void;
  initialUri?: string;
  /** Which leaf kinds may be selected. Folders are always selectable. */
  mode?: 'folder' | 'file' | 'any';
}) {
  const s = useStyles();
  const parsed = useMemo(() => parseAdlsLocation(initialUri), [initialUri]);
  const [account, setAccount] = useState(parsed?.account || '');
  const [host, setHost] = useState(parsed?.host || '');
  const [containers, setContainers] = useState<ContainerRow[] | null>(null);
  const [containersError, setContainersError] = useState<string | null>(null);
  const [containersFallback, setContainersFallback] = useState(false);
  const [container, setContainer] = useState(parsed?.container || '');
  const [manualContainer, setManualContainer] = useState('');
  const [prefix, setPrefix] = useState(parsed?.path || '');
  const [entries, setEntries] = useState<PathRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);

  /**
   * Containers for the chosen account. Account-scope listing first; on a denial
   * (a container-scope-only grant, common in Gov) fall back to the DLZ
   * containers this deployment already knows — the alternative is a dead end.
   */
  const loadContainers = useCallback(async (acct: string) => {
    if (!acct) { setContainers(null); return; }
    setContainers(null); setContainersError(null); setContainersFallback(false);
    try {
      const r = await clientFetch(`/api/storage/${encodeURIComponent(acct)}/containers`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.containers)) {
        setContainers(j.containers);
        if (j.host) setHost(j.host);
        return;
      }
      // Denied / failed — try the DLZ containers before giving up.
      const dlz = await clientFetch('/api/lakehouse/containers');
      const dj = await dlz.json();
      const rows: ContainerRow[] = (dj?.containers || []).filter(
        (c: ContainerRow) => (c.url || '').toLowerCase().includes(`//${acct.toLowerCase()}.`),
      );
      if (rows.length) {
        setContainers(rows);
        setContainersFallback(true);
        const h = /^https:\/\/([^/]+)/i.exec(rows[0].url || '');
        if (h) setHost(h[1]);
        setContainersError(j?.error || null);
        return;
      }
      setContainers([]);
      setContainersError(j?.error || `Could not list containers on '${acct}'.`);
    } catch (e: any) {
      setContainers([]);
      setContainersError(e?.message || String(e));
    }
  }, []);

  const loadPaths = useCallback(async (acct: string, cont: string, p: string) => {
    setLoading(true); setPathError(null);
    try {
      const qs = new URLSearchParams({ prefix: p });
      const r = await clientFetch(
        `/api/storage/${encodeURIComponent(acct)}/containers/${encodeURIComponent(cont)}/paths?${qs.toString()}`,
      );
      const j = await r.json();
      if (j?.ok) setEntries(j.paths || []);
      else { setEntries([]); setPathError(j?.error || `Listing failed (HTTP ${r.status}).`); }
    } catch (e: any) {
      setEntries([]);
      setPathError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const p = parseAdlsLocation(initialUri);
    setAccount(p?.account || '');
    setHost(p?.host || '');
    setContainer(p?.container || '');
    setPrefix(p?.path || '');
    setEntries([]);
    setPathError(null);
    if (p?.account) {
      void loadContainers(p.account);
      if (p.container) void loadPaths(p.account, p.container, p.path || '');
    } else {
      setContainers(null);
    }
  }, [open, initialUri, loadContainers, loadPaths]);

  const effectiveHost = host || (account ? `${account}.dfs.core.windows.net` : '');
  const pick = (path: string, kind: 'folder' | 'file') => {
    onPick({ uri: toAbfss(container, effectiveHost, path), account, container, path, kind });
  };
  const goUp = () => {
    const next = prefix.split('/').filter(Boolean).slice(0, -1).join('/');
    setPrefix(next);
    void loadPaths(account, container, next);
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: '760px' }}>
        <DialogBody>
          <DialogTitle>Browse ADLS Gen2</DialogTitle>
          <DialogContent>
            <AzureBackedField
              kind="storage"
              label="Storage account"
              surface="ADLS browser"
              value={account}
              onChange={(v) => {
                setAccount(v || '');
                setContainer('');
                setPrefix('');
                setEntries([]);
                if (v) void loadContainers(v);
              }}
            />

            {account && !container && (
              <>
                {containersFallback && (
                  <MessageBar intent="info" layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>Showing this deployment&apos;s known containers</MessageBarTitle>
                      Listing every container on <code>{account}</code> was denied, so these are the DLZ containers
                      Loom already has a URL for. Grant the Console identity &quot;Storage Blob Data Reader&quot; at
                      ACCOUNT scope to see all of them.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {containers === null ? (
                  <div className={s.row}><Spinner size="tiny" label="Listing containers…" /></div>
                ) : containers.length ? (
                  <div className={s.tableWrap}>
                    <Table size="small">
                      <TableHeader>
                        <TableRow><TableHeaderCell>Container</TableHeaderCell><TableHeaderCell>Account</TableHeaderCell></TableRow>
                      </TableHeader>
                      <TableBody>
                        {containers.map((c) => (
                          <TableRow
                            key={c.name}
                            style={{ cursor: 'pointer' }}
                            onClick={() => {
                              setContainer(c.name);
                              setPrefix('');
                              const h = /^https:\/\/([^/]+)/i.exec(c.url || '');
                              if (h) setHost(h[1]);
                              void loadPaths(account, c.name, '');
                            }}
                          >
                            <TableCell className={s.cell}><FolderOpen20Regular /> <strong>{c.name}</strong></TableCell>
                            <TableCell className={s.cell}>{account}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <>
                    <MessageBar intent="warning" layout="multiline">
                      <MessageBarBody>
                        <MessageBarTitle>No containers could be listed on {account}</MessageBarTitle>
                        {containersError || 'The listing returned nothing.'} Grant the Loom Console identity
                        (LOOM_UAMI_CLIENT_ID) the &quot;Storage Blob Data Reader&quot; role at account scope to
                        enumerate them. If you already know the container, open it directly below.
                      </MessageBarBody>
                    </MessageBar>
                    {/* The escape hatch — a container this caller cannot enumerate
                        but CAN read. Without it the denial above is a dead end,
                        which auto-bind-by-default.md forbids outright. */}
                    <Field label="Open a container by name" hint="Used only when enumeration is denied; the name is not verified until it opens.">
                      <div className={s.row}>
                        <Input
                          className={s.grow}
                          value={manualContainer}
                          onChange={(_, d) => setManualContainer(d.value)}
                          aria-label="Container to open"
                        />
                        <Button
                          appearance="primary"
                          disabled={!manualContainer.trim()}
                          onClick={() => {
                            const c = manualContainer.trim().toLowerCase();
                            setContainer(c);
                            setPrefix('');
                            void loadPaths(account, c, '');
                          }}
                        >
                          Open
                        </Button>
                      </div>
                    </Field>
                  </>
                )}
              </>
            )}

            {account && container && (
              <>
                <div className={s.toolbar}>
                  <Breadcrumb>
                    <BreadcrumbItem>
                      <BreadcrumbButton onClick={() => { setContainer(''); setPrefix(''); setEntries([]); }}>
                        {container}
                      </BreadcrumbButton>
                    </BreadcrumbItem>
                    {prefix.split('/').filter(Boolean).map((seg) => (
                      <BreadcrumbItem key={seg}><BreadcrumbButton>{seg}</BreadcrumbButton></BreadcrumbItem>
                    ))}
                  </Breadcrumb>
                  {prefix && <Button size="small" icon={<ArrowUp20Regular />} onClick={goUp}>Up</Button>}
                  <Button size="small" appearance="primary" onClick={() => pick(prefix, 'folder')}>
                    Use this folder
                  </Button>
                </div>
                {pathError && (
                  <MessageBar intent="error" layout="multiline">
                    <MessageBarBody><MessageBarTitle>Could not list this path</MessageBarTitle>{pathError}</MessageBarBody>
                  </MessageBar>
                )}
                {loading ? (
                  <div className={s.row}><Spinner size="tiny" label="Listing…" /></div>
                ) : (
                  <div className={s.tableWrap}>
                    <Table size="small">
                      <TableBody>
                        {entries.length === 0 && (
                          <TableRow><TableCell className={s.cell}>This folder is empty.</TableCell></TableRow>
                        )}
                        {entries.map((e) => {
                          const leaf = e.name.split('/').pop() || e.name;
                          const selectable = e.isDirectory || mode !== 'folder';
                          return (
                            <TableRow key={e.name}>
                              <TableCell className={s.cell}>
                                {e.isDirectory
                                  ? (
                                    <Button
                                      size="small" appearance="subtle" icon={<Folder20Regular />}
                                      onClick={() => { setPrefix(e.name); void loadPaths(account, container, e.name); }}
                                    >
                                      {leaf}
                                    </Button>
                                  )
                                  : <span><Document20Regular /> {leaf}</span>}
                              </TableCell>
                              <TableCell className={s.cell}>
                                {e.isDirectory ? 'folder' : `${(e.size / 1024).toFixed(1)} KB`}
                              </TableCell>
                              <TableCell className={s.cell}>
                                {selectable && (
                                  <Button size="small" onClick={() => pick(e.name, e.isDirectory ? 'folder' : 'file')}>
                                    Select
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * The field a surface embeds: the current location shown as a RECEIPT (a
 * read-only display, never an ask) plus the Browse button that opens the
 * dialog. A stored value that no longer resolves is still shown — it is the
 * user's data, and blanking it is how a Save silently erases a binding.
 */
export function AdlsPathPicker({
  value, onChange, label = 'Lake location', mode = 'any', hint,
}: {
  value?: string;
  onChange: (loc: AdlsLocation | null) => void;
  label?: string;
  mode?: 'folder' | 'file' | 'any';
  hint?: string;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => parseAdlsLocation(value), [value]);

  return (
    <div className={s.root}>
      <Field label={label} hint={hint}>
        <div className={s.row}>
          <Input className={s.grow} readOnly value={value || ''} placeholder="No location selected" aria-label={`${label} (selected)`} />
          <Button icon={<FolderSearch20Regular />} onClick={() => setOpen(true)}>Browse</Button>
          {value && <Button appearance="subtle" onClick={() => onChange(null)}>Clear</Button>}
        </div>
      </Field>
      {value && !parsed && (
        <Caption1 className={s.meta}>
          Stored value kept as-is — it is not an <code>abfss://</code> or https lake URI, so Browse cannot start from it.
        </Caption1>
      )}
      {parsed && (
        <Caption1 className={s.meta}>
          {parsed.account} · {parsed.container}{parsed.path ? ` · ${parsed.path}` : ''}
        </Caption1>
      )}
      <AdlsBrowseDialog
        open={open}
        initialUri={value}
        mode={mode}
        onClose={() => setOpen(false)}
        onPick={(loc) => { setOpen(false); onChange(loc); }}
      />
    </div>
  );
}
