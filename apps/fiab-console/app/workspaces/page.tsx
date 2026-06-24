'use client';

/**
 * /workspaces — rich workspace browser, built on the shared Loom UI primitives.
 *
 * Layout (Web 3.0 standard, see docs/fiab/design/ui-web3-guide.md):
 *   - PageShell header + New-workspace action (CreateWorkspaceDialog).
 *   - Toolbar: debounced SearchBox + Sort menu + Filter menu + admin
 *     multi-select controls on the left, a Tile | List ViewToggle on the right.
 *   - Filter chips row + (admin) bulk-action bar.
 *   - Sectioned results: a "Pinned" Section floats pinned workspaces above an
 *     "All workspaces" Section. Each Section renders the active view:
 *       tile  -> TileGrid + ItemTile
 *       list  -> LoomDataTable (per-column sort + filter, resizable columns)
 *
 * Persisted in localStorage: view mode, sort mode, pinned set.
 *
 * Data is real: GET /api/workspaces?count=true (listWorkspacesWithCounts) for
 * the rows, GET /api/workspaces/bulk-delete for the admin probe, /api/auth/me
 * for the "owner: me" filter. Workspaces are Loom-native, Cosmos-backed — no
 * Fabric dependency; capacity/domain bindings are optional + best-effort.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Menu,
  MenuItem,
  MenuItemCheckbox,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Select,
  Spinner,
  Text,
  Textarea,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Add24Regular,
  ArrowSort20Regular,
  Apps20Regular,
  Delete20Regular,
  Dismiss12Regular,
  Filter20Regular,
  MoreHorizontal20Regular,
  Pin16Filled,
  PinOff16Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import {
  bulkDeleteWorkspaces,
  createWorkspace,
  getWorkspaceAdminStatus,
  listWorkspacesWithCounts,
  type BulkDeleteResult,
  type Workspace,
} from '@/lib/api/workspaces';

// ---------------------------------------------------------------------------
// localStorage helpers (safe SSR — return defaults until client mounts)
// ---------------------------------------------------------------------------

const LS_VIEW = 'loom.workspaces.viewMode.v1';
const LS_PINNED = 'loom.workspaces.pinned.v1';
const LS_SORT = 'loom.workspaces.sortMode.v1';

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
// Page-level styles (only what the primitives don't supply: chips, bulk bar,
// empty states, the create-dialog form column)
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
    minHeight: '24px',
    marginBottom: tokens.spacingVerticalM,
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusCircular,
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
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
  },
  bulkBar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    marginBottom: tokens.spacingVerticalM,
  },
  bulkBarSpacer: { flex: 1 },
  nameCell: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  nameChip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusMedium,
    flexShrink: 0,
  },
  actionsCell: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
  },
  empty: {
    paddingTop: tokens.spacingVerticalXXXL,
    paddingRight: tokens.spacingHorizontalXXL,
    paddingBottom: tokens.spacingVerticalXXXL,
    paddingLeft: tokens.spacingHorizontalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    lineHeight: 1.6,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    alignItems: 'center',
  },
  emptyIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '56px',
    height: '56px',
    borderRadius: tokens.borderRadiusCircular,
    marginBottom: tokens.spacingVerticalXS,
  },
  emptyHint: {
    color: tokens.colorNeutralForeground3,
  },
  dialogHint: {
    color: tokens.colorNeutralForeground3,
  },
  formCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
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
// CreateWorkspaceDialog — preserved verbatim (real capacities/domains, with an
// honest free-text fallback when the upstream API is unavailable)
// ---------------------------------------------------------------------------

interface CapacityLite { id: string; displayName: string; sku: string; state?: string }
type DomainTier = 'tenant-admin' | 'domain-admin' | 'domain-contributor' | null;
interface DomainLite { id: string; name: string; description?: string; callerTier?: DomainTier }

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
      const r = await clientFetch('/api/loom/capacities');
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
      const r = await clientFetch('/api/admin/domains');
      const ct = r.headers.get('content-type') || '';
      return ct.includes('application/json') ? r.json() : { ok: false, error: `HTTP ${r.status}` };
    },
    enabled: open,
    retry: false,
    staleTime: 60_000,
  });
  const capacities = capacitiesQ.data?.capacities || [];
  // D2: only offer domains the caller administers (tenant-admin / domain-admin /
  // domain-contributor). A user can only place a new workspace in a domain they
  // have a tier on — tenant admins see all. callerTier comes from GET
  // /api/admin/domains. When the field is absent (older API), fall back to
  // showing all returned domains rather than hiding them.
  const allDomains = domainsQ.data?.domains || [];
  const domains = allDomains.some((d) => d.callerTier !== undefined)
    ? allDomains.filter((d) => d.callerTier != null)
    : allDomains;
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
                <Caption1 className={styles.dialogHint}>
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

  // ----- persisted state -----
  const [view, setView] = useState<LoomView>('tile');
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
    const v = readLS<LoomView>(LS_VIEW, 'tile');
    if (v === 'tile' || v === 'list') setView(v);
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
    if (hydrated) writeLS(LS_VIEW, view);
  }, [view, hydrated]);
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
  // Any authenticated user can bulk-delete the workspaces they OWN (the list is
  // already scoped to their own workspaces); tenant admins can delete anything.
  const canBulkDelete = adminStatus?.canBulkDelete === true || isAdmin;

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
    if (!canBulkDelete) {
      setSelectMode(false);
      setSelected(new Set());
      setConfirmOpen(false);
    }
  }, [canBulkDelete]);

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
    return rows;
  }, [data, search, capacityFilters, domainFilters]);

  // Fetch current user (for owner filter)
  const { data: me } = useQuery<{ upn?: string; email?: string; oid?: string }>({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        const r = await clientFetch('/api/auth/me', { credentials: 'include' });
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

  const selectable = selectMode && canBulkDelete;

  const openWorkspace = useCallback(
    (ws: Workspace) => {
      if (selectable) toggleSelect(ws.id);
      else router.push(`/workspaces/${ws.id}`);
    },
    [selectable, toggleSelect, router],
  );

  // ----- per-workspace kebab menu (Open / Settings / Pin·Unpin) -----
  const workspaceMenu = useCallback(
    (ws: Workspace) => (
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            appearance="subtle"
            size="small"
            icon={<MoreHorizontal20Regular />}
            aria-label={`More actions for ${ws.name}`}
          />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem onClick={() => router.push(`/workspaces/${ws.id}`)}>Open</MenuItem>
            <MenuItem onClick={() => router.push(`/workspaces/${ws.id}?settings=1`)}>Settings</MenuItem>
            <MenuItem
              icon={pinned.has(ws.id) ? <Pin16Filled /> : <PinOff16Regular />}
              onClick={() => togglePin(ws.id)}
            >
              {pinned.has(ws.id) ? 'Unpin' : 'Pin'}
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    ),
    [router, pinned, togglePin],
  );

  // ----- tile renderer -----
  const renderTile = useCallback(
    (ws: Workspace) => {
      const isPinned = pinned.has(ws.id);
      const isSelected = selectable && selected.has(ws.id);
      const footer = (
        <>
          {typeof ws.itemCount === 'number' && (
            <Badge appearance="tint" color="informative" icon={<Apps20Regular />}>
              {ws.itemCount} {ws.itemCount === 1 ? 'item' : 'items'}
            </Badge>
          )}
          {ws.capacity && (
            <Badge appearance="outline" color="brand">{ws.capacity}</Badge>
          )}
          {ws.domain && (
            <Badge appearance="outline" color="severe">{ws.domain}</Badge>
          )}
        </>
      );
      return (
        <ItemTile
          key={ws.id}
          type="workspace"
          title={ws.name}
          subtitle={ws.description || 'Workspace'}
          meta={
            ws.lastAccessedAt
              ? `Opened ${new Date(ws.lastAccessedAt).toLocaleDateString()}`
              : `Created ${new Date(ws.createdAt).toLocaleDateString()}`
          }
          selected={!!isSelected}
          badge={
            isPinned ? (
              <Badge size="small" appearance="tint" color="brand" icon={<Pin16Filled />}>
                Pinned
              </Badge>
            ) : undefined
          }
          overflowMenu={
            selectable ? (
              <Checkbox
                checked={selected.has(ws.id)}
                onChange={() => toggleSelect(ws.id)}
                aria-label={`Select ${ws.name}`}
              />
            ) : (
              workspaceMenu(ws)
            )
          }
          footer={footer}
          onClick={() => openWorkspace(ws)}
        />
      );
    },
    [pinned, selectable, selected, toggleSelect, workspaceMenu, openWorkspace],
  );

  // ----- list columns (LoomDataTable) -----
  const columns = useMemo<LoomColumn<Workspace>[]>(() => {
    const cols: LoomColumn<Workspace>[] = [];
    if (selectable) {
      cols.push({
        key: '__select',
        label: '',
        sortable: false,
        filterable: false,
        width: 44,
        minWidth: 44,
        render: (w) => (
          <span onClick={(e) => e.stopPropagation()} role="presentation">
            <Checkbox
              checked={selected.has(w.id)}
              onChange={() => toggleSelect(w.id)}
              aria-label={`Select ${w.name}`}
            />
          </span>
        ),
      });
    }
    cols.push(
      {
        key: 'name',
        label: 'Name',
        sortable: true,
        filterable: true,
        filterType: 'text',
        width: 280,
        getValue: (w) => w.name,
        render: (w) => {
          const visual = itemVisual('workspace');
          return (
            <span className={styles.nameCell}>
              <span
                className={styles.nameChip}
                style={{ backgroundColor: `${visual.color}1f` }}
                aria-hidden
              >
                <visual.icon style={{ width: 16, height: 16, color: visual.color }} />
              </span>
              {pinned.has(w.id) && (
                <Pin16Filled style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} aria-label="Pinned" />
              )}
              <Text weight="semibold">{w.name}</Text>
            </span>
          );
        },
      },
      {
        key: 'description',
        label: 'Description',
        sortable: true,
        filterable: true,
        filterType: 'text',
        width: 300,
        getValue: (w) => w.description ?? '',
        render: (w) => <Text>{w.description || '—'}</Text>,
      },
      {
        key: 'items',
        label: 'Items',
        sortable: true,
        filterable: false,
        width: 90,
        getValue: (w) => w.itemCount ?? 0,
        render: (w) => (typeof w.itemCount === 'number' ? String(w.itemCount) : '—'),
      },
      {
        key: 'created',
        label: 'Created',
        sortable: true,
        filterable: true,
        filterType: 'date',
        width: 160,
        getValue: (w) => w.createdAt ?? '',
        render: (w) => (w.createdAt ? new Date(w.createdAt).toLocaleDateString() : '—'),
      },
      {
        key: 'lastAccessed',
        label: 'Last accessed',
        sortable: true,
        filterable: true,
        filterType: 'date',
        width: 160,
        getValue: (w) => w.lastAccessedAt ?? '',
        render: (w) => (w.lastAccessedAt ? new Date(w.lastAccessedAt).toLocaleDateString() : '—'),
      },
      {
        key: '__actions',
        label: 'Actions',
        sortable: false,
        filterable: false,
        width: 120,
        render: (w) => (
          <span className={styles.actionsCell} onClick={(e) => e.stopPropagation()} role="presentation">
            <Tooltip content={pinned.has(w.id) ? 'Unpin' : 'Pin'} relationship="label">
              <Button
                appearance="subtle"
                size="small"
                aria-label={pinned.has(w.id) ? `Unpin ${w.name}` : `Pin ${w.name}`}
                aria-pressed={pinned.has(w.id)}
                icon={
                  pinned.has(w.id) ? (
                    <Pin16Filled style={{ color: tokens.colorBrandForeground1 }} />
                  ) : (
                    <PinOff16Regular />
                  )
                }
                onClick={() => togglePin(w.id)}
              />
            </Tooltip>
            {workspaceMenu(w)}
          </span>
        ),
      },
    );
    return cols;
  }, [selectable, selected, pinned, toggleSelect, togglePin, workspaceMenu, styles]);

  // ----- render a collection in the active view -----
  const renderCollection = (rows: Workspace[]) =>
    view === 'tile' ? (
      <TileGrid>{rows.map(renderTile)}</TileGrid>
    ) : (
      <LoomDataTable
        columns={columns}
        rows={rows}
        getRowId={(w) => w.id}
        onRowClick={openWorkspace}
        ariaLabel="Workspaces"
        empty="No workspaces match these filters."
      />
    );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const headerActions = (
    <CreateWorkspaceDialog onCreated={() => qc.invalidateQueries({ queryKey: ['workspaces', 'withCounts'] })} />
  );

  return (
    <PageShell
      title="Workspaces"
      subtitle="A workspace is where you collaborate on items — lakehouses, notebooks, warehouses, reports, and everything else."
      actions={headerActions}
    >
      {/* Toolbar: search + sort + filter + admin select (left), view toggle (right) */}
      <Toolbar
        search={searchRaw}
        onSearch={setSearchRaw}
        searchPlaceholder="Search workspaces…"
        actions={<ViewToggle value={view} onChange={setView} ariaLabel="Workspace view" />}
      >
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
      </Toolbar>

      {/* Filter chips */}
      {totalFilterCount > 0 && (
        <div className={styles.chipRow} aria-label="Active filters">
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
      {selectable && (
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
          <MessageBarBody style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>
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
                  <ul style={{ margin: 0, paddingLeft: 18, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
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
          {(() => {
            const v = itemVisual('workspace');
            return (
              <span
                className={styles.emptyIcon}
                style={{ backgroundColor: `${v.color}1f` }}
                aria-hidden
              >
                <v.icon style={{ width: 28, height: 28, color: v.color }} />
              </span>
            );
          })()}
          <Body1>
            No workspaces yet. Click <b>+ New workspace</b> to create your first one.
          </Body1>
          <Caption1 className={styles.emptyHint}>
            A workspace is a Cosmos-backed container that owns items, permissions, and SCM bindings.
          </Caption1>
          <CreateWorkspaceDialog
            onCreated={() => qc.invalidateQueries({ queryKey: ['workspaces', 'withCounts'] })}
          />
        </div>
      )}

      {/* Empty after filtering */}
      {!isLoading && !error && data && data.length > 0 && sorted.length === 0 && (
        <div className={styles.empty}>
          <span className={styles.emptyIcon} style={{ backgroundColor: tokens.colorNeutralBackground3 }} aria-hidden>
            <Filter20Regular style={{ width: 26, height: 26, color: tokens.colorNeutralForeground3 }} />
          </span>
          <Body1>No workspaces match these filters.</Body1>
          <Button appearance="primary" onClick={clearAll}>
            Clear filters
          </Button>
        </div>
      )}

      {/* Pinned section (floats above All when anything is pinned) */}
      {pinnedRows.length > 0 && (
        <Section title="Pinned">{renderCollection(pinnedRows)}</Section>
      )}

      {/* All workspaces (or the only section when nothing is pinned) */}
      {unpinnedRows.length > 0 && (
        <Section title={pinnedRows.length > 0 ? 'All workspaces' : 'Workspaces'}>
          {renderCollection(unpinnedRows)}
        </Section>
      )}
    </PageShell>
  );
}
