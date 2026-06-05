'use client';

/**
 * /workspaces — rich workspace browser.
 *
 * Features:
 *   - Tile / list view toggle (persisted in localStorage `loom.workspaces.viewMode.v1`)
 *   - Live search across name + description (debounced 150ms)
 *   - Sort menu: Name a-z/z-a, Created newest/oldest, Last accessed
 *     newest/oldest, Item count most/least (persisted)
 *   - Filter menu: capacity (none / shared / dedicated), domain (dynamic
 *     from data), owner (Me / All); filter chips render below the toolbar
 *   - Pin toggle per workspace (persisted in localStorage
 *     `loom.workspaces.pinned.v1`); pinned float to the top of either
 *     view, separated by a divider
 *   - Color-coded tile icons:
 *       has capacity   -> blue
 *       domain-tagged  -> purple
 *       neither        -> green
 *   - Item count fetched via /api/workspaces?count=true (single aggregate)
 *
 * BFF contract: this page reads from /api/workspaces?count=true. The
 * underlying route is the same — it just adds an `itemCount` field per
 * workspace. No mock data.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Body1,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Caption1,
  Checkbox,
  MessageBar,
  MessageBarBody,
  Select,
  Menu,
  MenuItem,
  MenuItemRadio,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Textarea,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
  useId,
} from '@fluentui/react-components';
import {
  Add24Regular,
  ArrowSort20Regular,
  Apps20Regular,
  Building20Regular,
  ChevronDown16Regular,
  Database20Regular,
  Dismiss12Regular,
  Filter20Regular,
  Folder20Regular,
  Grid20Regular,
  List20Regular,
  Open16Regular,
  Pin16Filled,
  PinOff16Regular,
  Search20Regular,
  Delete20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import {
  bulkDeleteWorkspaces,
  createWorkspace,
  getWorkspaceAdminStatus,
  listWorkspacesWithCounts,
  type BulkDeleteResult,
  type Workspace,
} from '@/lib/api/workspaces';
import { useMutation } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// localStorage helpers (safe SSR — return defaults until client mounts)
// ---------------------------------------------------------------------------

const LS_VIEW = 'loom.workspaces.viewMode.v1';
const LS_PINNED = 'loom.workspaces.pinned.v1';
const LS_SORT = 'loom.workspaces.sortMode.v1';

type ViewMode = 'tile' | 'list';
type SortMode =
  | 'lastAccessed-desc'
  | 'lastAccessed-asc'
  | 'name-asc'
  | 'name-desc'
  | 'created-desc'
  | 'created-asc'
  | 'itemCount-desc'
  | 'itemCount-asc';

function readLS<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore (quota / private mode) */
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '14px' },

  toolbar: {
    display: 'flex',
    gap: '10px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  toolbarSpacer: { flex: 1 },

  search: { flex: '1 1 280px', minWidth: '200px', maxWidth: '420px' },

  viewToggle: {
    display: 'inline-flex',
    borderRadius: '6px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
  },
  viewToggleBtn: {
    border: 'none',
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    padding: '6px 10px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '13px',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  viewToggleBtnActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
  },

  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    alignItems: 'center',
    minHeight: '24px',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    paddingTop: '3px',
    paddingBottom: '3px',
    paddingLeft: '8px',
    paddingRight: '6px',
    borderRadius: '12px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontSize: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  chipBtn: {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    display: 'inline-flex',
    alignItems: 'center',
    padding: 0,
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  clearAllBtn: {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: tokens.colorBrandForeground1,
    fontSize: '12px',
    fontWeight: 600,
    padding: '3px 6px',
  },

  // Section header (Pinned / All)
  sectionHead: {
    fontSize: '11px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    marginTop: '4px',
    marginBottom: '6px',
  },
  divider: {
    height: '1px',
    backgroundColor: tokens.colorNeutralStroke2,
    marginTop: '14px',
    marginBottom: '14px',
  },

  // Tile view
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '14px',
  },
  tile: {
    position: 'relative',
    paddingTop: '16px',
    paddingRight: '16px',
    paddingBottom: '16px',
    paddingLeft: '16px',
    borderRadius: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minHeight: '150px',
    cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
    ':hover': {
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  tileHeader: { display: 'flex', alignItems: 'flex-start', gap: '12px' },
  iconBox: {
    width: '40px',
    height: '40px',
    borderRadius: '8px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconBoxBlue: {
    backgroundColor: tokens.colorPaletteBlueBackground2,
    color: tokens.colorPaletteBlueForeground2,
  },
  iconBoxPurple: {
    backgroundColor: tokens.colorPalettePurpleBackground2,
    color: tokens.colorPalettePurpleForeground2,
  },
  iconBoxGreen: {
    backgroundColor: tokens.colorPaletteGreenBackground2,
    color: tokens.colorPaletteGreenForeground2,
  },
  tileTitleCol: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  tileName: {
    fontSize: '15px',
    fontWeight: 600,
    lineHeight: 1.3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tileDesc: {
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
    lineHeight: 1.45,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  tileMeta: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    alignItems: 'center',
    marginTop: 'auto',
  },
  pinBtn: {
    position: 'absolute',
    top: '8px',
    right: '8px',
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    padding: '4px',
    borderRadius: '6px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
  pinBtnActive: { color: tokens.colorBrandForeground1 },

  // List view
  tableWrap: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rowName: {
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    ':hover': { color: tokens.colorBrandForeground1, textDecoration: 'underline' },
  },
  rowDesc: { color: tokens.colorNeutralForeground2, fontSize: '12px' },
  selectCol: { width: '36px', paddingLeft: '10px', paddingRight: '0px' },
  selectTileBox: {
    position: 'absolute',
    top: '8px',
    left: '8px',
    zIndex: 1,
  },
  tileSelected: {
    boxShadow: `0 0 0 2px ${tokens.colorBrandStroke1}`,
  },
  bulkBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
    padding: '8px 12px',
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  bulkBarSpacer: { flex: 1 },
  pinCol: { width: '36px', paddingLeft: '10px', paddingRight: '0px' },
  countCol: { width: '90px' },
  dateCol: { width: '150px' },
  actionsCol: { width: '120px', textAlign: 'right' },
  inlineBtn: {
    border: 'none',
    background: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px',
    borderRadius: '4px',
    ':hover': {
      color: tokens.colorBrandForeground1,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },

  // Empty states
  empty: {
    paddingTop: '32px',
    paddingRight: '32px',
    paddingBottom: '32px',
    paddingLeft: '32px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: '12px',
    lineHeight: 1.6,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    alignItems: 'center',
  },

  formCol: { display: 'flex', flexDirection: 'column', gap: '12px' },
});

// ---------------------------------------------------------------------------
// Sort options table
// ---------------------------------------------------------------------------

const SORT_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: 'lastAccessed-desc', label: 'Last accessed (newest)' },
  { value: 'lastAccessed-asc', label: 'Last accessed (oldest)' },
  { value: 'name-asc', label: 'Name (A-Z)' },
  { value: 'name-desc', label: 'Name (Z-A)' },
  { value: 'created-desc', label: 'Created (newest)' },
  { value: 'created-asc', label: 'Created (oldest)' },
  { value: 'itemCount-desc', label: 'Item count (most)' },
  { value: 'itemCount-asc', label: 'Item count (least)' },
];

function sortLabel(mode: SortMode): string {
  return SORT_OPTIONS.find(o => o.value === mode)?.label ?? '';
}

// ---------------------------------------------------------------------------
// Sort + filter logic
// ---------------------------------------------------------------------------

type CapacityFilter = 'none' | 'shared' | 'dedicated';
type OwnerFilter = 'me' | 'all';

function capacityBucket(c?: string | null): CapacityFilter {
  if (!c) return 'none';
  // Heuristic: F-skus / dedicated names go to "dedicated"; everything else
  // (including "shared", "trial") goes to "shared".
  const v = c.trim().toLowerCase();
  if (!v) return 'none';
  if (/^f\d+/.test(v) || v.includes('dedicated') || v.includes('premium')) return 'dedicated';
  return 'shared';
}

function compareSort(a: Workspace, b: Workspace, mode: SortMode): number {
  switch (mode) {
    case 'name-asc':
      return a.name.localeCompare(b.name);
    case 'name-desc':
      return b.name.localeCompare(a.name);
    case 'created-desc':
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    case 'created-asc':
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    case 'itemCount-desc':
      return (b.itemCount ?? 0) - (a.itemCount ?? 0);
    case 'itemCount-asc':
      return (a.itemCount ?? 0) - (b.itemCount ?? 0);
    case 'lastAccessed-asc': {
      const av = a.lastAccessedAt ?? a.createdAt ?? '';
      const bv = b.lastAccessedAt ?? b.createdAt ?? '';
      return av.localeCompare(bv);
    }
    case 'lastAccessed-desc':
    default: {
      const av = a.lastAccessedAt ?? a.createdAt ?? '';
      const bv = b.lastAccessedAt ?? b.createdAt ?? '';
      return bv.localeCompare(av);
    }
  }
}

// ---------------------------------------------------------------------------
// CreateWorkspaceDialog — preserved from prior pane, slightly trimmed
// ---------------------------------------------------------------------------

interface CapacityLite { id: string; displayName: string; sku: string; state?: string }
interface DomainLite { id: string; name: string; description?: string }

function CreateWorkspaceDialog({ onCreated }: { onCreated?: () => void }) {
  const styles = useStyles();
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [capacity, setCapacity] = useState('');
  const [domain, setDomain] = useState('');

  // Load real Fabric capacities the UAMI can see + Loom-managed domains.
  // Both are best-effort — if the upstream returns an error (Power BI
  // tenant SP not granted, Cosmos not provisioned, etc.) the field falls
  // back to a free-text Input so the user isn't blocked.
  const capacitiesQ = useQuery({
    queryKey: ['capacities'],
    queryFn: async (): Promise<{ ok: boolean; capacities?: CapacityLite[]; error?: string }> => {
      const r = await fetch('/api/loom/capacities');
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : { ok: false, error: `HTTP ${r.status}` };
    },
    enabled: open,
    retry: false,
    staleTime: 60_000,
  });
  const domainsQ = useQuery({
    queryKey: ['domains'],
    queryFn: async (): Promise<{ ok: boolean; domains?: DomainLite[]; error?: string }> => {
      const r = await fetch('/api/admin/domains');
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : { ok: false, error: `HTTP ${r.status}` };
    },
    enabled: open,
    retry: false,
    staleTime: 60_000,
  });
  const capacities = capacitiesQ.data?.capacities || [];
  const domains = domainsQ.data?.domains || [];
  const capacityFallback = capacitiesQ.isError || (capacitiesQ.data?.ok === false);
  const domainFallback = domainsQ.isError || (domainsQ.data?.ok === false);

  const mut = useMutation({
    mutationFn: () =>
      createWorkspace({
        name,
        description: description || undefined,
        capacity: capacity || undefined,
        domain: domain || undefined,
      }),
    onSuccess: ws => {
      qc.invalidateQueries({ queryKey: ['workspaces', 'withCounts'] });
      setOpen(false);
      setName('');
      setDescription('');
      setCapacity('');
      setDomain('');
      onCreated?.();
      router.push(`/workspaces/${ws.id}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<Add24Regular />}>
          New workspace
        </Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogContent>
            <div className={styles.formCol}>
              <Field label="Name" required>
                <Input
                  value={name}
                  onChange={(_, d) => setName(d.value)}
                  placeholder="Sales analytics"
                />
              </Field>
              <Field label="Description">
                <Textarea
                  value={description}
                  onChange={(_, d) => setDescription(d.value)}
                  rows={2}
                />
              </Field>
              <Field label="Capacity (optional)" hint={
                capacityFallback
                  ? 'Could not load Fabric capacities — falling back to free-text. Reason: ' +
                    (capacitiesQ.data?.error || (capacitiesQ.error as Error)?.message || 'unknown')
                  : capacities.length === 0 && !capacitiesQ.isLoading
                    ? 'No capacities returned — UAMI may need Capacity Admin role; falling back to free-text.'
                    : 'Picks a real Fabric / Power BI Premium capacity. Assignment is queued until the workspace gets its first PBI-backed artifact.'
              }>
                {capacityFallback || (capacities.length === 0 && !capacitiesQ.isLoading) ? (
                  <Input
                    value={capacity}
                    onChange={(_, d) => setCapacity(d.value)}
                    placeholder="F64"
                  />
                ) : (
                  <Select value={capacity} onChange={(_, d) => setCapacity(d.value)} disabled={capacitiesQ.isLoading}>
                    <option value="">— None —</option>
                    {capacities.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName} ({c.sku}{c.state ? ` · ${c.state}` : ''})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Domain (optional)" hint={
                domainFallback
                  ? 'Could not load domains — falling back to free-text. Reason: ' +
                    (domainsQ.data?.error || (domainsQ.error as Error)?.message || 'unknown')
                  : domains.length === 0 && !domainsQ.isLoading
                    ? 'No domains yet — go to Admin → Domains to create one; falling back to free-text.'
                    : 'Picks a Loom-managed business domain. On save, the workspace auto-registers in Purview + publishes to the data marketplace.'
              }>
                {domainFallback || (domains.length === 0 && !domainsQ.isLoading) ? (
                  <Input
                    value={domain}
                    onChange={(_, d) => setDomain(d.value)}
                    placeholder="Sales"
                  />
                ) : (
                  <Select value={domain} onChange={(_, d) => setDomain(d.value)} disabled={domainsQ.isLoading}>
                    <option value="">— None —</option>
                    {domains.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </Select>
                )}
              </Field>
              {(capacity || domain) && (
                <Caption1 style={{ color: 'var(--colorNeutralForeground3, #707070)' }}>
                  When you save: Capacity is assigned via the Fabric REST <code>assignToCapacity</code>{' '}
                  (queued until your first PBI-backed artifact creates the underlying Fabric group),
                  and Domain triggers a Purview catalog register + marketplace publish. Both run as
                  best-effort — the workspace itself is always persisted; the binding status appears
                  on the workspace settings drawer after create.
                </Caption1>
              )}
              {mut.error && (
                <MessageBar intent="error">
                  <MessageBarBody>{(mut.error as Error).message}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={!name.trim() || mut.isPending}
              onClick={() => mut.mutate()}
            >
              {mut.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkspacesPage() {
  const styles = useStyles();
  const router = useRouter();
  const qc = useQueryClient();
  const searchId = useId('ws-search');

  // ----- persisted state -----
  const [viewMode, setViewMode] = useState<ViewMode>('tile');
  const [sortMode, setSortMode] = useState<SortMode>('lastAccessed-desc');
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  // ----- in-session state -----
  const [searchRaw, setSearchRaw] = useState('');
  const [search, setSearch] = useState(''); // debounced
  const [capacityFilters, setCapacityFilters] = useState<Set<CapacityFilter>>(new Set());
  const [domainFilters, setDomainFilters] = useState<Set<string>>(new Set());
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');

  // Hydrate persisted state on mount
  useEffect(() => {
    const v = readLS<ViewMode>(LS_VIEW, 'tile');
    if (v === 'tile' || v === 'list') setViewMode(v);
    const s = readLS<SortMode>(LS_SORT, 'lastAccessed-desc');
    if (SORT_OPTIONS.some(o => o.value === s)) setSortMode(s);
    const p = readLS<string[]>(LS_PINNED, []);
    if (Array.isArray(p)) setPinned(new Set(p));
    setHydrated(true);
  }, []);

  // Debounce search input
  useEffect(() => {
    const h = window.setTimeout(() => setSearch(searchRaw.trim().toLowerCase()), 150);
    return () => window.clearTimeout(h);
  }, [searchRaw]);

  // Persist view/sort/pinned on change (only after hydration to avoid
  // overwriting saved state with the SSR defaults on first render)
  useEffect(() => {
    if (hydrated) writeLS(LS_VIEW, viewMode);
  }, [viewMode, hydrated]);
  useEffect(() => {
    if (hydrated) writeLS(LS_SORT, sortMode);
  }, [sortMode, hydrated]);
  useEffect(() => {
    if (hydrated) writeLS(LS_PINNED, Array.from(pinned));
  }, [pinned, hydrated]);

  // ----- data -----
  const { data, isLoading, error } = useQuery<Workspace[]>({
    queryKey: ['workspaces', 'withCounts'],
    queryFn: listWorkspacesWithCounts,
  });
  const unauth = error && (error as any)?.message?.includes('401');

  // Domain options dynamically pulled from the data
  const domainOptions = useMemo(() => {
    const set = new Set<string>();
    for (const w of data ?? []) if (w.domain) set.add(w.domain);
    return Array.from(set).sort();
  }, [data]);

  // ----- pin handlers -----
  const togglePin = useCallback((id: string) => {
    setPinned(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ----- admin probe (drives the bulk-delete affordances) -----
  // Same server truth as every admin route: GET /api/workspaces/bulk-delete
  // returns isTenantAdmin(session). Non-admins never see multi-select.
  const { data: adminStatus } = useQuery({
    queryKey: ['workspaces', 'admin-status'],
    queryFn: getWorkspaceAdminStatus,
    staleTime: 5 * 60 * 1000,
  });
  const isAdmin = adminStatus?.isAdmin === true;

  // ----- multi-select state -----
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkDeleteResult | null>(null);

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Non-admins can never accumulate a selection / open the confirm dialog.
  useEffect(() => {
    if (!isAdmin) {
      setSelectMode(false);
      setSelected(new Set());
      setConfirmOpen(false);
    }
  }, [isAdmin]);

  // ----- filter + sort pipeline -----
  const visible = useMemo(() => {
    let rows = data ?? [];
    if (search) {
      rows = rows.filter(
        w =>
          w.name.toLowerCase().includes(search) ||
          (w.description ?? '').toLowerCase().includes(search),
      );
    }
    if (capacityFilters.size > 0) {
      rows = rows.filter(w => capacityFilters.has(capacityBucket(w.capacity)));
    }
    if (domainFilters.size > 0) {
      rows = rows.filter(w => w.domain && domainFilters.has(w.domain));
    }
    // Owner filter: "me" matches workspaces the current session created.
    // We don't know the current upn/email/oid here without an extra fetch;
    // until then "me" is best-effort: nothing should match unless we can
    // pull it from the session. The /api/auth/me endpoint exposes this, so
    // we lazy-load it below.
    return rows;
  }, [data, search, capacityFilters, domainFilters]);

  // Fetch current user (for owner filter)
  const { data: me } = useQuery<{ upn?: string; email?: string; oid?: string }>({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        const r = await fetch('/api/auth/me', { credentials: 'include' });
        if (!r.ok) return {};
        return await r.json();
      } catch {
        return {};
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  const visibleOwned = useMemo(() => {
    if (ownerFilter !== 'me') return visible;
    const me1 = (me?.upn ?? me?.email ?? me?.oid ?? '').toLowerCase();
    if (!me1) return visible;
    return visible.filter(w => (w.createdBy ?? '').toLowerCase() === me1);
  }, [visible, ownerFilter, me]);

  const sorted = useMemo(() => {
    const copy = [...visibleOwned];
    copy.sort((a, b) => compareSort(a, b, sortMode));
    return copy;
  }, [visibleOwned, sortMode]);

  const pinnedRows = useMemo(() => sorted.filter(w => pinned.has(w.id)), [sorted, pinned]);
  const unpinnedRows = useMemo(() => sorted.filter(w => !pinned.has(w.id)), [sorted, pinned]);

  // ----- bulk-select helpers (operate over currently-visible rows) -----
  // "Test" = the workspaces UAT/E2E runs leave behind. Matched by common
  // throwaway prefixes so an admin can clear them in one click.
  const TEST_RE = /^(uat-|e2e-|test-|tmp-|temp-|scratch-|playwright-|ci-)/i;
  const visibleIds = useMemo(() => sorted.map(w => w.id), [sorted]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
  const someVisibleSelected = visibleIds.some(id => selected.has(id));
  const testRows = useMemo(() => sorted.filter(w => TEST_RE.test(w.name)), [sorted]);

  const selectAllVisible = useCallback(() => {
    setSelected(prev => {
      const next = new Set(prev);
      if (visibleIds.every(id => next.has(id))) {
        // toggle off
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }, [visibleIds]);

  const selectTest = useCallback(() => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const w of testRows) next.add(w.id);
      return next;
    });
    setSelectMode(true);
  }, [testRows]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // ----- bulk delete -----
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of data ?? []) m.set(w.id, w.name);
    return m;
  }, [data]);

  const bulkMut = useMutation({
    mutationFn: (ids: string[]) => bulkDeleteWorkspaces(ids),
    onSuccess: result => {
      setBulkResult(result);
      setConfirmOpen(false);
      // Drop successfully-deleted ids from the selection; keep failures so the
      // admin can see + retry them.
      setSelected(prev => {
        const next = new Set(prev);
        for (const id of result.deleted) next.delete(id);
        return next;
      });
      if (result.deleted.length === 0) setSelectMode(true);
      qc.invalidateQueries({ queryKey: ['workspaces', 'withCounts'] });
    },
  });

  // ----- filter chip helpers -----
  const totalFilterCount =
    capacityFilters.size + domainFilters.size + (ownerFilter === 'me' ? 1 : 0);
  const clearAll = useCallback(() => {
    setCapacityFilters(new Set());
    setDomainFilters(new Set());
    setOwnerFilter('all');
    setSearchRaw('');
  }, []);

  const removeCapacity = (c: CapacityFilter) =>
    setCapacityFilters(prev => {
      const n = new Set(prev);
      n.delete(c);
      return n;
    });
  const removeDomain = (d: string) =>
    setDomainFilters(prev => {
      const n = new Set(prev);
      n.delete(d);
      return n;
    });

  // ----- render helpers -----
  const renderTile = (ws: Workspace) => (
    <div
      key={ws.id}
      className={mergeClasses(styles.tile, selectMode && selected.has(ws.id) && styles.tileSelected)}
      onClick={() => {
        if (selectMode) toggleSelect(ws.id);
        else router.push(`/workspaces/${ws.id}`);
      }}
      role="link"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (selectMode) toggleSelect(ws.id);
          else router.push(`/workspaces/${ws.id}`);
        }
      }}
    >
      {selectMode && isAdmin && (
        <div className={styles.selectTileBox} onClick={e => e.stopPropagation()}>
          <Checkbox
            checked={selected.has(ws.id)}
            onChange={() => toggleSelect(ws.id)}
            aria-label={`Select ${ws.name}`}
          />
        </div>
      )}
      <button
        type="button"
        className={mergeClasses(styles.pinBtn, pinned.has(ws.id) && styles.pinBtnActive)}
        aria-label={pinned.has(ws.id) ? `Unpin ${ws.name}` : `Pin ${ws.name}`}
        aria-pressed={pinned.has(ws.id)}
        onClick={e => {
          e.stopPropagation();
          togglePin(ws.id);
        }}
      >
        {pinned.has(ws.id) ? <Pin16Filled /> : <PinOff16Regular />}
      </button>
      <div className={styles.tileHeader}>
        <span
          className={mergeClasses(
            styles.iconBox,
            ws.capacity
              ? styles.iconBoxBlue
              : ws.domain
                ? styles.iconBoxPurple
                : styles.iconBoxGreen,
          )}
          aria-hidden
        >
          {ws.capacity ? (
            <Database20Regular />
          ) : ws.domain ? (
            <Building20Regular />
          ) : (
            <Folder20Regular />
          )}
        </span>
        <div className={styles.tileTitleCol}>
          <div className={styles.tileName} title={ws.name}>{ws.name}</div>
          {ws.description && <div className={styles.tileDesc}>{ws.description}</div>}
        </div>
      </div>
      <div className={styles.tileMeta}>
        {typeof ws.itemCount === 'number' && (
          <Badge appearance="tint" color="informative" icon={<Apps20Regular />}>
            {ws.itemCount} {ws.itemCount === 1 ? 'item' : 'items'}
          </Badge>
        )}
        {ws.capacity && (
          <Badge appearance="outline" color="brand">
            {ws.capacity}
          </Badge>
        )}
        {ws.domain && (
          <Badge appearance="outline" color="severe">
            {ws.domain}
          </Badge>
        )}
        <span>
          {ws.lastAccessedAt
            ? `Opened ${new Date(ws.lastAccessedAt).toLocaleDateString()}`
            : `Created ${new Date(ws.createdAt).toLocaleDateString()}`}
        </span>
      </div>
    </div>
  );

  const renderList = (rows: Workspace[]) => (
    <div className={styles.tableWrap}>
      <Table size="small" aria-label="Workspaces">
        <TableHeader>
          <TableRow>
            {selectMode && isAdmin && (
              <TableHeaderCell className={styles.selectCol}>
                <Checkbox
                  checked={allVisibleSelected ? true : someVisibleSelected ? 'mixed' : false}
                  onChange={selectAllVisible}
                  aria-label="Select all visible workspaces"
                />
              </TableHeaderCell>
            )}
            <TableHeaderCell className={styles.pinCol} aria-label="Pin" />
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Description</TableHeaderCell>
            <TableHeaderCell className={styles.countCol}>Items</TableHeaderCell>
            <TableHeaderCell className={styles.dateCol}>Created</TableHeaderCell>
            <TableHeaderCell className={styles.dateCol}>Last accessed</TableHeaderCell>
            <TableHeaderCell className={styles.actionsCol}>Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(ws => (
            <TableRow key={ws.id} appearance={selectMode && selected.has(ws.id) ? 'brand' : undefined}>
              {selectMode && isAdmin && (
                <TableCell className={styles.selectCol}>
                  <Checkbox
                    checked={selected.has(ws.id)}
                    onChange={() => toggleSelect(ws.id)}
                    aria-label={`Select ${ws.name}`}
                  />
                </TableCell>
              )}
              <TableCell className={styles.pinCol}>
                <button
                  type="button"
                  className={mergeClasses(styles.inlineBtn, pinned.has(ws.id) && styles.pinBtnActive)}
                  aria-label={pinned.has(ws.id) ? `Unpin ${ws.name}` : `Pin ${ws.name}`}
                  aria-pressed={pinned.has(ws.id)}
                  onClick={() => togglePin(ws.id)}
                >
                  {pinned.has(ws.id) ? <Pin16Filled /> : <PinOff16Regular />}
                </button>
              </TableCell>
              <TableCell>
                <Link href={`/workspaces/${ws.id}`} className={styles.rowName}>
                  {ws.name}
                </Link>
              </TableCell>
              <TableCell>
                <span className={styles.rowDesc}>{ws.description ?? '—'}</span>
              </TableCell>
              <TableCell className={styles.countCol}>
                {typeof ws.itemCount === 'number' ? ws.itemCount : '—'}
              </TableCell>
              <TableCell className={styles.dateCol}>
                {ws.createdAt ? new Date(ws.createdAt).toLocaleDateString() : '—'}
              </TableCell>
              <TableCell className={styles.dateCol}>
                {ws.lastAccessedAt ? new Date(ws.lastAccessedAt).toLocaleDateString() : '—'}
              </TableCell>
              <TableCell className={styles.actionsCol}>
                <Tooltip content="Open" relationship="label">
                  <Link href={`/workspaces/${ws.id}`} className={styles.inlineBtn} aria-label={`Open ${ws.name}`}>
                    <Open16Regular />
                  </Link>
                </Tooltip>
                <Menu>
                  <MenuTrigger disableButtonEnhancement>
                    <button
                      type="button"
                      className={styles.inlineBtn}
                      aria-label={`More actions for ${ws.name}`}
                    >
                      <ChevronDown16Regular />
                    </button>
                  </MenuTrigger>
                  <MenuPopover>
                    <MenuList>
                      <MenuItem onClick={() => router.push(`/workspaces/${ws.id}`)}>Open</MenuItem>
                      <MenuItem onClick={() => router.push(`/workspaces/${ws.id}?settings=1`)}>Settings</MenuItem>
                      <MenuItem onClick={() => togglePin(ws.id)}>
                        {pinned.has(ws.id) ? 'Unpin' : 'Pin'}
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
  );

  const renderSection = (rows: Workspace[]) =>
    viewMode === 'tile' ? (
      <div className={styles.grid}>{rows.map(renderTile)}</div>
    ) : (
      renderList(rows)
    );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const headerActions = <CreateWorkspaceDialog onCreated={() => qc.invalidateQueries({ queryKey: ['workspaces', 'withCounts'] })} />;

  return (
    <PageShell
      title="Workspaces"
      subtitle="A workspace is where you collaborate on items — lakehouses, notebooks, warehouses, reports, and everything else."
      actions={headerActions}
    >
      <div className={styles.root}>
        {/* Toolbar */}
        <div className={styles.toolbar} role="toolbar" aria-label="Workspace browser toolbar">
          <Input
            id={searchId}
            className={styles.search}
            placeholder="Search workspaces…"
            value={searchRaw}
            onChange={(_, d) => setSearchRaw(d.value)}
            contentBefore={<Search20Regular />}
            aria-label="Search workspaces"
          />

          {/* Sort menu */}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button icon={<ArrowSort20Regular />} appearance="subtle">
                {`Sort: ${sortLabel(sortMode)}`}
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList
                checkedValues={{ sort: [sortMode] }}
                onCheckedValueChange={(_, d) => {
                  const next = (d.checkedItems?.[0] as SortMode) ?? sortMode;
                  setSortMode(next);
                }}
              >
                {SORT_OPTIONS.map(opt => (
                  <MenuItemRadio key={opt.value} name="sort" value={opt.value}>
                    {opt.label}
                  </MenuItemRadio>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>

          {/* Filter menu */}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button icon={<Filter20Regular />} appearance="subtle">
                {totalFilterCount > 0 ? `Filter (${totalFilterCount})` : 'Filter'}
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList
                checkedValues={{
                  capacity: Array.from(capacityFilters),
                  domain: Array.from(domainFilters),
                  owner: [ownerFilter],
                }}
                onCheckedValueChange={(_, d) => {
                  if (d.name === 'capacity') {
                    setCapacityFilters(new Set((d.checkedItems ?? []) as CapacityFilter[]));
                  } else if (d.name === 'domain') {
                    setDomainFilters(new Set((d.checkedItems ?? []) as string[]));
                  } else if (d.name === 'owner') {
                    setOwnerFilter((d.checkedItems?.[0] as OwnerFilter) ?? 'all');
                  }
                }}
              >
                <MenuItem disabled>Capacity</MenuItem>
                <MenuItemCheckbox name="capacity" value="none">None</MenuItemCheckbox>
                <MenuItemCheckbox name="capacity" value="shared">Shared</MenuItemCheckbox>
                <MenuItemCheckbox name="capacity" value="dedicated">Dedicated</MenuItemCheckbox>
                {domainOptions.length > 0 && <MenuItem disabled>Domain</MenuItem>}
                {domainOptions.map(d => (
                  <MenuItemCheckbox key={d} name="domain" value={d}>
                    {d}
                  </MenuItemCheckbox>
                ))}
                <MenuItem disabled>Owner</MenuItem>
                <MenuItemRadio name="owner" value="all">All</MenuItemRadio>
                <MenuItemRadio name="owner" value="me">Me</MenuItemRadio>
              </MenuList>
            </MenuPopover>
          </Menu>

          {/* Admin: multi-select toggle + one-click test selection */}
          {isAdmin && (
            <>
              <Button
                appearance={selectMode ? 'primary' : 'subtle'}
                aria-pressed={selectMode}
                onClick={() => {
                  setSelectMode(s => {
                    const next = !s;
                    if (!next) setSelected(new Set());
                    return next;
                  });
                }}
              >
                {selectMode ? 'Done selecting' : 'Select'}
              </Button>
              {testRows.length > 0 && (
                <Tooltip
                  content={`Select ${testRows.length} test workspace${testRows.length === 1 ? '' : 's'} (uat-/e2e-/test-/tmp-…)`}
                  relationship="label"
                >
                  <Button appearance="subtle" onClick={selectTest}>
                    {`Select test (${testRows.length})`}
                  </Button>
                </Tooltip>
              )}
            </>
          )}

          <div className={styles.toolbarSpacer} />

          {/* View mode toggle */}
          <div className={styles.viewToggle} role="group" aria-label="View mode">
            <button
              type="button"
              className={mergeClasses(
                styles.viewToggleBtn,
                viewMode === 'tile' && styles.viewToggleBtnActive,
              )}
              aria-pressed={viewMode === 'tile'}
              aria-label="Tile view"
              onClick={() => setViewMode('tile')}
            >
              <Grid20Regular />
              <span>Tiles</span>
            </button>
            <button
              type="button"
              className={mergeClasses(
                styles.viewToggleBtn,
                viewMode === 'list' && styles.viewToggleBtnActive,
              )}
              aria-pressed={viewMode === 'list'}
              aria-label="List view"
              onClick={() => setViewMode('list')}
            >
              <List20Regular />
              <span>List</span>
            </button>
          </div>
        </div>

        {/* Filter chips */}
        {(totalFilterCount > 0 || search) && (
          <div className={styles.chipRow} aria-label="Active filters">
            {search && (
              <span className={styles.chip}>
                Search: "{searchRaw}"
                <button
                  type="button"
                  aria-label="Clear search"
                  className={styles.chipBtn}
                  onClick={() => setSearchRaw('')}
                >
                  <Dismiss12Regular />
                </button>
              </span>
            )}
            {Array.from(capacityFilters).map(c => (
              <span key={`cap-${c}`} className={styles.chip}>
                Capacity: {c}
                <button
                  type="button"
                  aria-label={`Remove capacity filter ${c}`}
                  className={styles.chipBtn}
                  onClick={() => removeCapacity(c)}
                >
                  <Dismiss12Regular />
                </button>
              </span>
            ))}
            {Array.from(domainFilters).map(d => (
              <span key={`dom-${d}`} className={styles.chip}>
                Domain: {d}
                <button
                  type="button"
                  aria-label={`Remove domain filter ${d}`}
                  className={styles.chipBtn}
                  onClick={() => removeDomain(d)}
                >
                  <Dismiss12Regular />
                </button>
              </span>
            ))}
            {ownerFilter === 'me' && (
              <span className={styles.chip}>
                Owner: Me
                <button
                  type="button"
                  aria-label="Remove owner filter"
                  className={styles.chipBtn}
                  onClick={() => setOwnerFilter('all')}
                >
                  <Dismiss12Regular />
                </button>
              </span>
            )}
            <button type="button" className={styles.clearAllBtn} onClick={clearAll}>
              Clear all
            </button>
          </div>
        )}

        {/* Bulk action bar (admin + select mode) */}
        {isAdmin && selectMode && (
          <div className={styles.bulkBar} role="region" aria-label="Bulk actions">
            <Checkbox
              checked={allVisibleSelected ? true : someVisibleSelected ? 'mixed' : false}
              onChange={selectAllVisible}
              label={allVisibleSelected ? 'Deselect all' : 'Select all visible'}
            />
            <span>{`${selected.size} selected`}</span>
            {selected.size > 0 && (
              <Button appearance="subtle" size="small" onClick={clearSelection}>
                Clear
              </Button>
            )}
            <div className={styles.bulkBarSpacer} />
            <Button
              appearance="primary"
              icon={<Delete20Regular />}
              disabled={selected.size === 0 || bulkMut.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              {`Delete selected (${selected.size})`}
            </Button>
          </div>
        )}

        {/* Bulk-delete result */}
        {bulkResult && (
          <MessageBar intent={bulkResult.failed.length > 0 ? 'warning' : 'success'}>
            <MessageBarBody>
              Deleted {bulkResult.deleted.length} workspace
              {bulkResult.deleted.length === 1 ? '' : 's'}.
              {bulkResult.failed.length > 0 && (
                <> {bulkResult.failed.length} failed: {bulkResult.failed
                  .map(f => `${nameById.get(f.id) ?? f.id} (${f.error})`)
                  .join(', ')}.</>
              )}
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Confirm dialog */}
        <Dialog open={confirmOpen} onOpenChange={(_, d) => setConfirmOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{`Delete ${selected.size} workspace${selected.size === 1 ? '' : 's'}?`}</DialogTitle>
              <DialogContent>
                <div className={styles.formCol}>
                  <Body1>
                    This permanently deletes the selected workspaces and every item inside them
                    (lakehouses, notebooks, reports, etc.) from Cosmos. This cannot be undone.
                  </Body1>
                  <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {Array.from(selected).slice(0, 50).map(id => (
                        <li key={id}>{nameById.get(id) ?? id}</li>
                      ))}
                    </ul>
                    {selected.size > 50 && (
                      <Caption1>…and {selected.size - 50} more.</Caption1>
                    )}
                  </div>
                  {bulkMut.error && (
                    <MessageBar intent="error">
                      <MessageBarBody>{(bulkMut.error as Error).message}</MessageBarBody>
                    </MessageBar>
                  )}
                </div>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary" disabled={bulkMut.isPending}>
                    Cancel
                  </Button>
                </DialogTrigger>
                <Button
                  appearance="primary"
                  icon={<Delete20Regular />}
                  disabled={selected.size === 0 || bulkMut.isPending}
                  onClick={() => {
                    setBulkResult(null);
                    bulkMut.mutate(Array.from(selected));
                  }}
                >
                  {bulkMut.isPending ? 'Deleting…' : `Delete ${selected.size}`}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        {/* Unauth / error / loading */}
        {unauth && <SignInRequired subject="workspaces" />}
        {isLoading && <Spinner label="Loading workspaces…" />}
        {error && !unauth && (
          <MessageBar intent="error">
            <MessageBarBody>
              Failed to load workspaces: {(error as Error).message}
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Empty state — no workspaces at all */}
        {!isLoading && !error && data && data.length === 0 && (
          <div className={styles.empty}>
            <Body1>
              No workspaces yet. Click <b>+ New workspace</b> to create your first one.
            </Body1>
            <Body1>
              A workspace is a Cosmos-backed container that owns items, permissions, and SCM bindings.
            </Body1>
          </div>
        )}

        {/* Empty after filtering */}
        {!isLoading && !error && data && data.length > 0 && sorted.length === 0 && (
          <div className={styles.empty}>
            <Body1>No workspaces match these filters.</Body1>
            <Button appearance="primary" onClick={clearAll}>
              Clear filters
            </Button>
          </div>
        )}

        {/* Pinned section */}
        {pinnedRows.length > 0 && (
          <>
            <div className={styles.sectionHead}>Pinned</div>
            {renderSection(pinnedRows)}
            <div className={styles.divider} />
            <div className={styles.sectionHead}>All workspaces</div>
          </>
        )}

        {/* Unpinned section (or all rows if nothing is pinned) */}
        {unpinnedRows.length > 0 && renderSection(unpinnedRows)}
      </div>
    </PageShell>
  );
}
