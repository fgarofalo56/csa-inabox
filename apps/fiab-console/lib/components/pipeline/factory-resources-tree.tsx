'use client';

/**
 * FactoryResourcesTree — the ADF-Studio "Factory Resources" navigator.
 *
 * Once a Data Factory is selected, the pipeline editor's left pane becomes this
 * typed navigator: one group per resource type with a live count and a ＋ New
 * affordance, a "Filter resources by name" box, and a top "Add new resource"
 * menu — matching the ADF Studio author pane.
 *
 * Every count comes from a real ARM list call; every create/delete hits real
 * ADF REST through the factory-level BFF routes:
 *   - Pipelines           → /api/adf/pipelines     (list/create/delete) + open on canvas
 *   - Datasets            → /api/adf/datasets       (list/create/delete)
 *   - Data flows          → /api/adf/dataflows      (list/create/delete)
 *   - Triggers            → /api/adf/triggers       (list/create/start/stop/delete)
 *   - Linked services     → /api/adf/linked-services (delegated to ManagePanel)
 *   - Integration runtimes→ /api/adf/integration-runtimes (delegated to ManagePanel)
 *   - Global parameters   → /api/adf/global-parameters (editor: add/edit/remove + PUT)
 *   - Managed private endpoints → /api/adf/managed-private-endpoints (create VNet + PEs)
 *
 * The one group Azure exposes that we don't embed inline yet — Power Query
 * (WranglingDataFlow authoring) — renders as an honest note pointing at the
 * Manage hub (its real backend still runs there); never a fake list. No mocks.
 *
 * The factory is the env-pinned default (LOOM_ADF_NAME / LOOM_DLZ_RG /
 * LOOM_SUBSCRIPTION_ID). When unconfigured the routes 503 and the whole tree
 * shows a single honest infra-gate MessageBar.
 */

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Tree, TreeItem, TreeItemLayout, type TreeOpenChangeData, type TreeItemValue,
  Button, Input, Textarea, Field, Caption1, Badge, Spinner, Dropdown, Option,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, MoreHorizontal20Regular,
  Flow20Regular, DocumentTable20Regular, DataUsage20Regular, Clock20Regular,
  Link20Regular, Server20Regular, Play16Regular, Stop16Regular, Open16Regular,
  Search20Regular, Warning20Regular, ArrowRepeatAll20Regular,
  Globe20Regular, PlugConnected20Regular, Edit16Regular,
  Code20Regular, Copy20Regular, Rename20Regular, ChevronDown20Regular, ChevronUp20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  rowActionsFor, groupActionsFor, canConfirmDelete,
  KIND_ROUTE, RESOURCE_JSON_TYPE, ALL_GROUP_VALUES,
  type RowKind, type GroupKind, type RowActionKey, type GroupActionKey,
  type RowActionDescriptor, type GroupActionDescriptor,
} from './factory-resource-actions';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalS, height: '100%', minWidth: '240px' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, width: '100%', minWidth: 0 },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flexShrink: 0 },
  leafRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%', minWidth: 0 },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flexShrink: 0 },
  // Long single-token resource names (e.g. Retail_OLTP_Mirror_…) must stay
  // readable: truncate with an ellipsis in the fixed-width nav pane, never
  // clip silently or force horizontal overflow. The full name is on a Tooltip
  // + native `title`. `minWidth:0` lets the flex child actually shrink.
  nameText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' },
  gateRow: { padding: tokens.spacingHorizontalXS },
  mpeGate: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, padding: `${tokens.spacingVerticalXS} 0` },
});

const PIPE_ROUTE = '/api/adf/pipelines';
const DS_ROUTE = '/api/adf/datasets';
const DF_ROUTE = '/api/adf/dataflows';
const TRG_ROUTE = '/api/adf/triggers';
const LS_ROUTE = '/api/adf/linked-services';
const IR_ROUTE = '/api/adf/integration-runtimes';
const CDC_ROUTE = '/api/adf/cdc';
const GP_ROUTE = '/api/adf/global-parameters';
const MPE_ROUTE = '/api/adf/managed-private-endpoints';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface NamedRow { name: string; [k: string]: unknown }

type CreatableGroup = 'pipeline' | 'dataset' | 'dataflow' | 'trigger';

// ── Right-click context-menu primitives ────────────────────────────────────
// Each tree row (and group node) is wrapped in a Fluent `Menu openOnContext`,
// so right-click anchors an ADF-Studio-parity actions menu at the cursor. The
// ordered action list per resource type comes from the pure `rowActionsFor` /
// `groupActionsFor` model (factory-resource-actions.ts) so it stays testable.

const ROW_ACTION_ICON: Record<RowActionKey, ReactElement> = {
  open: <Open16Regular />,
  bind: <Link20Regular />,
  start: <Play16Regular />,
  stop: <Stop16Regular />,
  viewJson: <Code20Regular />,
  clone: <Copy20Regular />,
  rename: <Rename20Regular />,
  edit: <Edit16Regular />,
  delete: <Delete16Regular />,
};

const GROUP_ACTION_ICON: Record<GroupActionKey, ReactElement> = {
  new: <Add20Regular />,
  refresh: <ArrowSync16Regular />,
  expandAll: <ChevronDown20Regular />,
  collapseAll: <ChevronUp20Regular />,
};

/**
 * A resource name cell: full-name Tooltip + native `title` + ellipsis
 * truncation so long single-token names (Retail_OLTP_Mirror_…) stay readable in
 * the narrow nav pane instead of clipping silently. Optionally clickable (Open).
 * Module-scope (stable identity) so it doesn't remount on every parent render.
 */
function NameCell({
  name, className, onOpen, bound,
}: {
  name: string;
  className: string;
  onOpen?: () => void;
  bound?: boolean;
}) {
  return (
    <Tooltip content={name} relationship="label">
      <span
        className={className}
        title={name}
        role={onOpen ? 'button' : undefined}
        tabIndex={onOpen ? 0 : undefined}
        style={{ cursor: onOpen ? 'pointer' : undefined, fontWeight: bound ? tokens.fontWeightSemibold : undefined }}
        onClick={onOpen}
        onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined}
      >
        {name}{bound ? ' ·' : ''}
      </span>
    </Tooltip>
  );
}

/** Wrap a row/group in a right-click (context) menu built from action descriptors. */
function ContextMenu({
  actions, onAction, disabled, children,
}: {
  actions: Array<RowActionDescriptor | GroupActionDescriptor>;
  onAction: (key: RowActionKey | GroupActionKey) => void;
  disabled?: boolean;
  children: ReactElement;
}) {
  if (!actions.length) return children;
  return (
    <Menu openOnContext>
      <MenuTrigger disableButtonEnhancement>{children}</MenuTrigger>
      <MenuPopover>
        <MenuList>
          {actions.map((a, i) => {
            const icon = a.key in GROUP_ACTION_ICON
              ? GROUP_ACTION_ICON[a.key as GroupActionKey]
              : ROW_ACTION_ICON[a.key as RowActionKey];
            const destructive = (a as RowActionDescriptor).destructive;
            return (
              <Fragment key={a.key}>
                {destructive && i > 0 && <MenuDivider />}
                <MenuItem icon={icon} disabled={disabled} onClick={() => onAction(a.key)}>{a.label}</MenuItem>
              </Fragment>
            );
          })}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

export interface FactoryResourcesTreeProps {
  /** The currently bound pipeline name (highlighted in the tree). */
  boundPipeline: string | null;
  /** Open / bind a pipeline on the canvas (existing flow). */
  onOpenPipeline: (name: string) => void;
  /** Open the Manage hub (linked services / datasets / integration runtimes). */
  onOpenManage: () => void;
  /** Open the Change Data Capture (preview) detail panel for a CDC resource. */
  onOpenCdc?: (name: string) => void;
  /** Increment to force a refresh from the parent (e.g. after a bind/create). */
  refreshKey?: number;
}

/**
 * A typed, ADF-Studio-faithful Factory Resources navigator.
 */
export function FactoryResourcesTree({
  boundPipeline, onOpenPipeline, onOpenManage, onOpenCdc, refreshKey = 0,
}: FactoryResourcesTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pipelines, setPipelines] = useState<NamedRow[]>([]);
  const [datasets, setDatasets] = useState<NamedRow[]>([]);
  const [dataflows, setDataflows] = useState<NamedRow[]>([]);
  const [triggers, setTriggers] = useState<Array<{ name: string; type?: string; runtimeState?: string }>>([]);
  const [linkedServices, setLinkedServices] = useState<NamedRow[]>([]);
  const [runtimes, setRuntimes] = useState<NamedRow[]>([]);
  const [cdcs, setCdcs] = useState<Array<{ name: string; status?: string; mode?: string; sourceCount?: number; targetCount?: number }>>([]);
  // Global parameters — the factory's { name -> {type, value} } dict (real ARM).
  const [globalParams, setGlobalParams] = useState<Record<string, { type: string; value: unknown }>>({});
  // Managed private endpoints (+ whether the factory has a managed VNet to hold them).
  const [mpes, setMpes] = useState<Array<{ name: string; groupId?: string; connectionStatus?: string; provisioningState?: string; privateLinkResourceId?: string }>>([]);
  const [managedVnetPresent, setManagedVnetPresent] = useState(false);
  const [mvnetName, setMvnetName] = useState('default');

  const [busy, setBusy] = useState(false);

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreatableGroup | null>(null);
  const [createName, setCreateName] = useState('');
  const [createDsType, setCreateDsType] = useState('DelimitedText');
  const [createDsLinkedService, setCreateDsLinkedService] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  // ---- global parameters editor dialog ----
  const [gpOpen, setGpOpen] = useState(false);
  const [gpRows, setGpRows] = useState<Array<{ name: string; type: string; value: string }>>([]);
  const [gpError, setGpError] = useState<string | null>(null);

  // ---- managed private endpoint create dialog ----
  const [mpeOpen, setMpeOpen] = useState(false);
  const [mpeName, setMpeName] = useState('');
  const [mpeResourceId, setMpeResourceId] = useState('');
  const [mpeGroupId, setMpeGroupId] = useState('dfs');
  const [mpeError, setMpeError] = useState<string | null>(null);
  const [mpeNote, setMpeNote] = useState<string | null>(null);

  // ---- Tree expand/collapse (controlled) ----
  // ADF Studio keeps expansion per session and lets you bulk expand/collapse;
  // this Tree is controlled so the header "Expand all"/"Collapse all" buttons
  // (and the group right-click menu) can drive every group at once. Pipelines
  // opens by default, matching the previous uncontrolled behaviour.
  const [openItems, setOpenItems] = useState<TreeItemValue[]>(['g-pipelines']);
  const expandAll = useCallback(() => setOpenItems([...ALL_GROUP_VALUES]), []);
  const collapseAll = useCallback(() => setOpenItems([]), []);

  // ---- right-click actions: delete (typed-confirm), clone/rename, view JSON ----
  const [deleteTarget, setDeleteTarget] = useState<{ kind: RowKind; name: string } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [crState, setCrState] = useState<{ mode: 'clone' | 'rename'; kind: RowKind; name: string } | null>(null);
  const [crNewName, setCrNewName] = useState('');
  const [crError, setCrError] = useState<string | null>(null);

  const [jsonView, setJsonView] = useState<{ title: string; text: string } | null>(null);
  const [jsonLoading, setJsonLoading] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pr, dr, fr, tr, lr, ir, cr, gpr, mper] = await Promise.all([
        clientFetch(PIPE_ROUTE).then(readJson),
        clientFetch(DS_ROUTE).then(readJson),
        clientFetch(DF_ROUTE).then(readJson),
        clientFetch(TRG_ROUTE).then(readJson),
        clientFetch(LS_ROUTE).then(readJson),
        clientFetch(IR_ROUTE).then(readJson),
        clientFetch(CDC_ROUTE).then(readJson),
        clientFetch(GP_ROUTE).then(readJson),
        clientFetch(MPE_ROUTE).then(readJson),
      ]);
      // Any route reporting not_configured gates the whole tree (same factory).
      for (const b of [pr, dr, fr, tr, lr, ir, cr, gpr, mper]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (pr.ok) setPipelines(pr.pipelines || []); else setError(pr.error || 'failed to list pipelines');
      if (dr.ok) setDatasets(dr.datasets || []);
      if (fr.ok) setDataflows(fr.dataflows || []);
      if (tr.ok) setTriggers(tr.triggers || []);
      if (lr.ok) setLinkedServices(lr.linkedServices || []);
      if (ir.ok) setRuntimes(ir.runtimes || []);
      if (cr.ok) setCdcs(cr.cdcs || []);
      if (gpr.ok) setGlobalParams(gpr.parameters || {});
      if (mper.ok) {
        setMpes(mper.managedPrivateEndpoints || []);
        setManagedVnetPresent(!!mper.managedVnetPresent);
        setMvnetName(mper.managedVnetName || 'default');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  // ---------------------------------------------------------------
  // Create / delete actions (real REST)
  // ---------------------------------------------------------------
  const openCreate = useCallback((g: CreatableGroup) => {
    setCreateGroup(g); setCreateName(''); setCreateError(null);
    setCreateDsType('DelimitedText'); setCreateDsLinkedService(linkedServices[0]?.name as string || '');
  }, [linkedServices]);

  const submitCreate = useCallback(async () => {
    if (!createGroup || !createName.trim()) return;
    setBusy(true); setCreateError(null);
    const name = createName.trim();
    try {
      let route = PIPE_ROUTE; let payload: any = { name };
      if (createGroup === 'pipeline') { route = PIPE_ROUTE; payload = { name }; }
      else if (createGroup === 'dataflow') { route = DF_ROUTE; payload = { name }; }
      else if (createGroup === 'trigger') { route = TRG_ROUTE; payload = { name }; }
      else if (createGroup === 'dataset') {
        if (!createDsLinkedService) { setCreateError('Pick a linked service (create one in Manage first).'); setBusy(false); return; }
        route = DS_ROUTE;
        payload = {
          name,
          properties: {
            type: createDsType,
            linkedServiceName: { referenceName: createDsLinkedService, type: 'LinkedServiceReference' },
            typeProperties: {},
          },
        };
      }
      const res = await clientFetch(route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setCreateError(body.error || 'create failed'); setBusy(false); return; }
      const group = createGroup;
      setCreateGroup(null);
      await loadAll();
      // Creating a pipeline opens it straight away on the canvas (ADF Studio behaviour).
      if (group === 'pipeline') onOpenPipeline(name);
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [createGroup, createName, createDsType, createDsLinkedService, loadAll, onOpenPipeline]);

  const triggerLifecycle = useCallback(async (name: string, action: 'start' | 'stop') => {
    setBusy(true); setError(null);
    try {
      const res = await clientFetch(TRG_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, action }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || `${action} failed`); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  // Start / Stop a Change Data Capture (preview) resource (real ARM REST via
  // POST /api/adf/cdc { name, action }). Delete uses the generic `del` helper.
  const cdcLifecycle = useCallback(async (name: string, action: 'start' | 'stop') => {
    setBusy(true); setError(null);
    try {
      const res = await clientFetch(CDC_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, action }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || `${action} failed`); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  // ---------------------------------------------------------------
  // Global parameters — open the editor (rows) / save the whole set (PUT)
  // ---------------------------------------------------------------
  const openGp = useCallback(() => {
    setGpRows(Object.entries(globalParams).map(([name, spec]) => {
      const type = (spec?.type as string) || 'String';
      const value =
        spec == null ? ''
          : (type === 'Object' || type === 'Array')
            ? JSON.stringify(spec.value ?? (type === 'Array' ? [] : {}), null, 2)
            : spec.value == null ? '' : String(spec.value);
      return { name, type, value };
    }));
    setGpError(null);
    setGpOpen(true);
  }, [globalParams]);

  const saveGp = useCallback(async () => {
    setBusy(true); setGpError(null);
    const dict: Record<string, { type: string; value: unknown }> = {};
    const seen = new Set<string>();
    for (const row of gpRows) {
      const name = row.name.trim();
      if (!name) { setGpError('Every parameter needs a name.'); setBusy(false); return; }
      if (!/^[A-Za-z0-9_]{1,260}$/.test(name)) { setGpError(`Invalid name "${name}" — letters, digits, _ only (no "-").`); setBusy(false); return; }
      if (seen.has(name)) { setGpError(`Duplicate parameter name "${name}".`); setBusy(false); return; }
      seen.add(name);
      let value: unknown = row.value;
      if (row.type === 'Int' || row.type === 'Float') {
        const n = Number(row.value);
        if (!Number.isFinite(n)) { setGpError(`Parameter "${name}" value must be a number.`); setBusy(false); return; }
        value = row.type === 'Int' ? Math.trunc(n) : n;
      } else if (row.type === 'Bool') {
        value = row.value === 'true';
      } else if (row.type === 'Object' || row.type === 'Array') {
        try {
          const parsed = JSON.parse(row.value || (row.type === 'Array' ? '[]' : '{}'));
          if (row.type === 'Array' && !Array.isArray(parsed)) throw new Error('value must be a JSON array');
          if (row.type === 'Object' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) throw new Error('value must be a JSON object');
          value = parsed;
        } catch (err: any) {
          setGpError(`Parameter "${name}" (${row.type}): ${err?.message || 'invalid JSON'}`); setBusy(false); return;
        }
      } else {
        value = row.value;
      }
      dict[name] = { type: row.type, value };
    }
    try {
      const res = await clientFetch(GP_ROUTE, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parameters: dict }) });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setGpError(body.error || 'save failed'); setBusy(false); return; }
      setGpOpen(false);
      await loadAll();
    } catch (e: any) { setGpError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [gpRows, loadAll]);

  // ---------------------------------------------------------------
  // Managed private endpoints — create the managed VNet / create a PE (real ARM)
  // ---------------------------------------------------------------
  const createMvnet = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const res = await clientFetch(MPE_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create-mvnet' }) });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'failed to create managed virtual network'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  const openMpe = useCallback(() => {
    setMpeName(''); setMpeResourceId(''); setMpeGroupId('dfs'); setMpeError(null); setMpeNote(null); setMpeOpen(true);
  }, []);

  const submitMpe = useCallback(async () => {
    if (!mpeName.trim() || !mpeResourceId.trim() || !mpeGroupId.trim()) return;
    setBusy(true); setMpeError(null); setMpeNote(null);
    try {
      const res = await clientFetch(MPE_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: mpeName.trim(), privateLinkResourceId: mpeResourceId.trim(), groupId: mpeGroupId.trim() }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setMpeError(body.error || 'create failed'); setBusy(false); return; }
      // Honest Pending → approve next step; keep the dialog open to show it, then refresh the list.
      setMpeNote(body?.nextStep?.note || body?.message || 'Managed private endpoint created (Pending approval).');
      await loadAll();
    } catch (e: any) { setMpeError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [mpeName, mpeResourceId, mpeGroupId, loadAll]);

  // ---------------------------------------------------------------
  // Right-click actions — View JSON (read-only), Delete (typed-confirm),
  // Clone / Rename (real create[+delete]). All real ADF REST.
  // ---------------------------------------------------------------

  // View the resource's full ARM definition read-only. Types with a
  // resource-json getter fetch it; globalParam / MPE pass their inline object
  // (already fully loaded client-side) so no round-trip is needed.
  const openViewJson = useCallback(async (kind: RowKind, name: string, inline?: unknown) => {
    const title = `${name} — JSON`;
    if (inline !== undefined) {
      setJsonView({ title, text: JSON.stringify(inline, null, 2) });
      setJsonError(null); setJsonLoading(false);
      return;
    }
    const type = RESOURCE_JSON_TYPE[kind];
    if (!type) return;
    setJsonView({ title, text: '' }); setJsonLoading(true); setJsonError(null);
    try {
      const res = await clientFetch(`/api/adf/resource-json?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`);
      const body = await readJson(res);
      if (!body.ok) { setJsonError(body.error || 'failed to load definition'); setJsonLoading(false); return; }
      setJsonView({ title, text: JSON.stringify(body.definition ?? {}, null, 2) });
    } catch (e: any) { setJsonError(e?.message || String(e)); }
    finally { setJsonLoading(false); }
  }, []);

  const openDelete = useCallback((kind: RowKind, name: string) => {
    setDeleteTarget({ kind, name }); setDeleteConfirmText(''); setDeleteError(null);
  }, []);

  // Execute the delete only after the operator has typed the exact name
  // (canConfirmDelete gates the button). globalParam removal PUTs the set minus
  // the key; every other kind hits its DELETE route.
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const { kind, name } = deleteTarget;
    if (!canConfirmDelete(deleteConfirmText, name)) return;
    setBusy(true); setDeleteError(null);
    try {
      if (kind === 'globalParam') {
        const next: Record<string, { type: string; value: unknown }> = { ...globalParams };
        delete next[name];
        const res = await clientFetch(GP_ROUTE, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parameters: next }) });
        const body = await readJson(res);
        if (applyGate(body)) { setBusy(false); return; }
        if (!body.ok) { setDeleteError(body.error || 'delete failed'); setBusy(false); return; }
      } else {
        const route = KIND_ROUTE[kind];
        const res = await clientFetch(`${route}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
        const body = await readJson(res);
        if (applyGate(body)) { setBusy(false); return; }
        if (!body.ok) { setDeleteError(body.error || 'delete failed'); setBusy(false); return; }
      }
      setDeleteTarget(null);
      await loadAll();
    } catch (e: any) { setDeleteError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [deleteTarget, deleteConfirmText, globalParams, loadAll]);

  const openCloneRename = useCallback((mode: 'clone' | 'rename', kind: RowKind, name: string) => {
    setCrState({ mode, kind, name });
    setCrNewName(mode === 'clone' ? `${name}_copy` : name);
    setCrError(null);
  }, []);

  // Clone = fetch the full definition → create a copy under the new name.
  // Rename = clone, then delete the original once the copy lands.
  const submitCloneRename = useCallback(async () => {
    if (!crState) return;
    const { mode, kind, name } = crState;
    const newName = crNewName.trim();
    if (!newName) { setCrError('Enter a name.'); return; }
    if (mode === 'rename' && newName === name) { setCrError('Enter a name different from the current one.'); return; }
    const type = RESOURCE_JSON_TYPE[kind];
    const route = KIND_ROUTE[kind];
    if (!type) { setCrError('This resource type cannot be cloned or renamed.'); return; }
    setBusy(true); setCrError(null);
    try {
      const gres = await clientFetch(`/api/adf/resource-json?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`);
      const gbody = await readJson(gres);
      if (applyGate(gbody)) { setBusy(false); return; }
      if (!gbody.ok) { setCrError(gbody.error || 'failed to load the source definition'); setBusy(false); return; }
      const properties = gbody.definition?.properties;
      if (!properties) { setCrError('The source definition has no properties to copy.'); setBusy(false); return; }
      const cres = await clientFetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: newName, properties }) });
      const cbody = await readJson(cres);
      if (applyGate(cbody)) { setBusy(false); return; }
      if (!cbody.ok) { setCrError(cbody.error || 'create failed'); setBusy(false); return; }
      if (mode === 'rename') {
        const dres = await clientFetch(`${route}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
        const dbody = await readJson(dres);
        if (!dbody.ok) {
          setCrError(`Copied to "${newName}", but deleting the original "${name}" failed: ${dbody.error || 'delete failed'}. Both now exist — delete one manually.`);
          setBusy(false); await loadAll(); return;
        }
      }
      setCrState(null);
      await loadAll();
      if (kind === 'pipeline') onOpenPipeline(newName);
    } catch (e: any) { setCrError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [crState, crNewName, loadAll, onOpenPipeline]);

  // Dispatch a row's right-click action key to the right real handler.
  const onRowAction = useCallback((kind: RowKind, name: string, key: RowActionKey, opts?: { inline?: unknown }) => {
    switch (key) {
      case 'open':
        if (kind === 'pipeline') onOpenPipeline(name);
        else if (kind === 'cdc') onOpenCdc?.(name);
        else onOpenManage();
        break;
      case 'bind': onOpenPipeline(name); break;
      case 'start':
        if (kind === 'trigger') triggerLifecycle(name, 'start');
        else if (kind === 'cdc') cdcLifecycle(name, 'start');
        break;
      case 'stop':
        if (kind === 'trigger') triggerLifecycle(name, 'stop');
        else if (kind === 'cdc') cdcLifecycle(name, 'stop');
        break;
      case 'viewJson': openViewJson(kind, name, opts?.inline); break;
      case 'clone': openCloneRename('clone', kind, name); break;
      case 'rename': openCloneRename('rename', kind, name); break;
      case 'edit': openGp(); break;
      case 'delete': openDelete(kind, name); break;
    }
  }, [onOpenPipeline, onOpenCdc, onOpenManage, triggerLifecycle, cdcLifecycle, openViewJson, openCloneRename, openGp, openDelete]);

  const onGroupAction = useCallback((kind: GroupKind, key: GroupActionKey) => {
    switch (key) {
      case 'refresh': loadAll(); break;
      case 'expandAll': expandAll(); break;
      case 'collapseAll': collapseAll(); break;
      case 'new':
        if (kind === 'pipelines') openCreate('pipeline');
        else if (kind === 'datasets') openCreate('dataset');
        else if (kind === 'dataflows') openCreate('dataflow');
        else if (kind === 'triggers') openCreate('trigger');
        else if (kind === 'linkedServices' || kind === 'integrationRuntimes') onOpenManage();
        else if (kind === 'globalParams') openGp();
        else if (kind === 'managedPrivateEndpoints') openMpe();
        break;
    }
  }, [loadAll, expandAll, collapseAll, openCreate, onOpenManage, openGp, openMpe]);

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fPipelines = useMemo(() => pipelines.filter((p) => match(p.name)), [pipelines, f]);
  const fDatasets = useMemo(() => datasets.filter((d) => match(d.name)), [datasets, f]);
  const fDataflows = useMemo(() => dataflows.filter((d) => match(d.name)), [dataflows, f]);
  const fTriggers = useMemo(() => triggers.filter((t) => match(t.name)), [triggers, f]);
  const fLinked = useMemo(() => linkedServices.filter((l) => match(l.name)), [linkedServices, f]);
  const fRuntimes = useMemo(() => runtimes.filter((r) => match(r.name)), [runtimes, f]);
  const fCdcs = useMemo(() => cdcs.filter((c) => match(c.name)), [cdcs, f]);
  const fMpes = useMemo(() => mpes.filter((m) => match(m.name)), [mpes, f]);
  const gpEntries = useMemo(() => Object.entries(globalParams).filter(([name]) => match(name)), [globalParams, f]);

  // ---------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------

  // A group (parent) node header. Wrapped in a right-click ContextMenu exposing
  // New <type> (when creatable) + Refresh + Expand all + Collapse all, matching
  // ADF Studio's group context menu. Keeps the inline ＋ New button too.
  const groupHeader = (
    label: string, icon: React.ReactElement, count: number, groupKind: GroupKind,
    onAdd?: () => void, addTitle?: string,
  ) => (
    <TreeItemLayout iconBefore={icon}>
      <ContextMenu
        actions={groupActionsFor(groupKind, { canCreate: !!onAdd })}
        onAction={(k) => onGroupAction(groupKind, k as GroupActionKey)}
      >
        <span className={s.groupLayout}>
          <span className={s.nameText} title={`${label} (${count})`}>{label} ({count})</span>
          <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
            {onAdd && (
              <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
                <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
              </Tooltip>
            )}
          </span>
        </span>
      </ContextMenu>
    </TreeItemLayout>
  );

  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>Factory Resources</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Data Factory not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> (plus <code>LOOM_SUBSCRIPTION_ID</code>, <code>LOOM_DLZ_RG</code>,{' '}
            <code>LOOM_ADF_NAME</code>) so the Loom console can reach a real Azure Data Factory. The navigator
            stays here; resources appear once the factory is reachable. The Loom UAMI needs{' '}
            <strong>Data Factory Contributor</strong> on that factory.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Factory Resources</span>
        <span style={{ display: 'flex', gap: tokens.spacingHorizontalXXS }}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="Add new resource" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="Add new resource" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Flow20Regular />} onClick={() => openCreate('pipeline')}>Pipeline</MenuItem>
                <MenuItem icon={<DataUsage20Regular />} onClick={() => openCreate('dataflow')}>Data flow</MenuItem>
                <MenuItem icon={<DocumentTable20Regular />} onClick={() => openCreate('dataset')}>Dataset</MenuItem>
                <MenuItem icon={<Clock20Regular />} onClick={() => openCreate('trigger')}>Trigger</MenuItem>
                <MenuItem icon={<Link20Regular />} onClick={onOpenManage}>Linked service…</MenuItem>
                <MenuItem icon={<Server20Regular />} onClick={onOpenManage}>Integration runtime…</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Expand all groups" relationship="label">
            <Button size="small" appearance="subtle" icon={<ChevronDown20Regular />} onClick={expandAll} aria-label="Expand all groups" />
          </Tooltip>
          <Tooltip content="Collapse all groups" relationship="label">
            <Button size="small" appearance="subtle" icon={<ChevronUp20Regular />} onClick={collapseAll} aria-label="Collapse all groups" />
          </Tooltip>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadAll} disabled={loading} aria-label="Refresh resources" />
          </Tooltip>
        </span>
      </div>

      <Field>
        <Input
          size="small"
          contentBefore={<Search20Regular />}
          placeholder="Filter resources by name"
          value={filter}
          onChange={(_, d) => setFilter(d.value)}
        />
      </Field>

      {loading && <div style={{ padding: tokens.spacingVerticalS }}><Spinner size="tiny" label="Loading factory resources…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Factory error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree
          aria-label="Factory resources"
          openItems={openItems}
          onOpenChange={(_e, data: TreeOpenChangeData) => setOpenItems(Array.from(data.openItems))}
        >
          {/* Pipelines */}
          <TreeItem itemType="branch" value="g-pipelines">
            {groupHeader('Pipelines', <Flow20Regular />, pipelines.length, 'pipelines', () => openCreate('pipeline'), 'New pipeline')}
            <Tree>
              {fPipelines.length === 0 && <TreeItem itemType="leaf" value="p-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No pipelines'}</Caption1></TreeItemLayout></TreeItem>}
              {fPipelines.map((p) => (
                <TreeItem key={p.name} itemType="leaf" value={`p-${p.name}`}>
                  <TreeItemLayout iconBefore={<Flow20Regular />}>
                    <ContextMenu actions={rowActionsFor('pipeline')} onAction={(k) => onRowAction('pipeline', p.name, k as RowActionKey)} disabled={busy}>
                      <span className={s.leafRow}>
                        <NameCell className={s.nameText} name={p.name} bound={boundPipeline === p.name} onOpen={() => onOpenPipeline(p.name)} />
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          {typeof p.activities === 'number' && <Caption1>{p.activities as number} act</Caption1>}
                          <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenPipeline(p.name)} aria-label={`Open ${p.name}`} /></Tooltip>
                          <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => openDelete('pipeline', p.name)} aria-label={`Delete ${p.name}`} /></Tooltip>
                        </span>
                      </span>
                    </ContextMenu>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Datasets */}
          <TreeItem itemType="branch" value="g-datasets">
            {groupHeader('Datasets', <DocumentTable20Regular />, datasets.length, 'datasets', () => openCreate('dataset'), 'New dataset')}
            <Tree>
              {fDatasets.length === 0 && <TreeItem itemType="leaf" value="d-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No datasets'}</Caption1></TreeItemLayout></TreeItem>}
              {fDatasets.map((d) => (
                <TreeItem key={d.name} itemType="leaf" value={`d-${d.name}`}>
                  <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                    <ContextMenu actions={rowActionsFor('dataset')} onAction={(k) => onRowAction('dataset', d.name, k as RowActionKey)} disabled={busy}>
                      <span className={s.leafRow}>
                        <NameCell className={s.nameText} name={d.name} onOpen={onOpenManage} />
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          <Tooltip content="Edit in Manage" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={onOpenManage} aria-label={`Edit ${d.name}`} /></Tooltip>
                          <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => openDelete('dataset', d.name)} aria-label={`Delete ${d.name}`} /></Tooltip>
                        </span>
                      </span>
                    </ContextMenu>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Data flows */}
          <TreeItem itemType="branch" value="g-dataflows">
            {groupHeader('Data flows', <DataUsage20Regular />, dataflows.length, 'dataflows', () => openCreate('dataflow'), 'New data flow')}
            <Tree>
              {fDataflows.length === 0 && <TreeItem itemType="leaf" value="f-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No data flows'}</Caption1></TreeItemLayout></TreeItem>}
              {fDataflows.map((d) => (
                <TreeItem key={d.name} itemType="leaf" value={`f-${d.name}`}>
                  <TreeItemLayout iconBefore={<DataUsage20Regular />}>
                    <ContextMenu actions={rowActionsFor('dataflow')} onAction={(k) => onRowAction('dataflow', d.name, k as RowActionKey)} disabled={busy}>
                      <span className={s.leafRow}>
                        <NameCell className={s.nameText} name={d.name} onOpen={onOpenManage} />
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          {typeof d.type === 'string' && <Caption1>{(d.type as string).replace('DataFlow', '')}</Caption1>}
                          <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => openDelete('dataflow', d.name)} aria-label={`Delete ${d.name}`} /></Tooltip>
                        </span>
                      </span>
                    </ContextMenu>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Triggers */}
          <TreeItem itemType="branch" value="g-triggers">
            {groupHeader('Triggers', <Clock20Regular />, triggers.length, 'triggers', () => openCreate('trigger'), 'New trigger')}
            <Tree>
              {fTriggers.length === 0 && <TreeItem itemType="leaf" value="t-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No triggers'}</Caption1></TreeItemLayout></TreeItem>}
              {fTriggers.map((t) => (
                <TreeItem key={t.name} itemType="leaf" value={`t-${t.name}`}>
                  <TreeItemLayout iconBefore={<Clock20Regular />}>
                    <ContextMenu actions={rowActionsFor('trigger', { running: t.runtimeState === 'Started' })} onAction={(k) => onRowAction('trigger', t.name, k as RowActionKey)} disabled={busy}>
                      <span className={s.leafRow}>
                        <NameCell className={s.nameText} name={t.name} />
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          <Badge size="small" appearance="filled" color={t.runtimeState === 'Started' ? 'success' : t.runtimeState === 'Stopped' ? 'informative' : 'warning'}>{t.runtimeState || '—'}</Badge>
                          {t.runtimeState === 'Started'
                            ? <Tooltip content="Stop" relationship="label"><Button size="small" appearance="subtle" icon={<Stop16Regular />} disabled={busy} onClick={() => triggerLifecycle(t.name, 'stop')} aria-label={`Stop ${t.name}`} /></Tooltip>
                            : <Tooltip content="Start" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy} onClick={() => triggerLifecycle(t.name, 'start')} aria-label={`Start ${t.name}`} /></Tooltip>}
                          <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => openDelete('trigger', t.name)} aria-label={`Delete ${t.name}`} /></Tooltip>
                        </span>
                      </span>
                    </ContextMenu>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Linked services (managed in the Manage hub) */}
          <TreeItem itemType="branch" value="g-linked">
            {groupHeader('Linked services', <Link20Regular />, linkedServices.length, 'linkedServices', onOpenManage, 'New linked service (Manage hub)')}
            <Tree>
              {fLinked.length === 0 && <TreeItem itemType="leaf" value="l-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No linked services'}</Caption1></TreeItemLayout></TreeItem>}
              {fLinked.map((l) => (
                <TreeItem key={l.name} itemType="leaf" value={`l-${l.name}`}>
                  <TreeItemLayout iconBefore={<Link20Regular />}>
                    <ContextMenu actions={rowActionsFor('linkedService')} onAction={(k) => onRowAction('linkedService', l.name, k as RowActionKey)} disabled={busy}>
                      <span className={s.leafRow}>
                        <NameCell className={s.nameText} name={l.name} onOpen={onOpenManage} />
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>{typeof (l.properties as any)?.type === 'string' && <Caption1>{(l.properties as any).type}</Caption1>}</span>
                      </span>
                    </ContextMenu>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Integration runtimes (managed in the Manage hub) */}
          <TreeItem itemType="branch" value="g-runtimes">
            {groupHeader('Integration runtimes', <Server20Regular />, runtimes.length, 'integrationRuntimes', onOpenManage, 'New integration runtime (Manage hub)')}
            <Tree>
              {fRuntimes.length === 0 && <TreeItem itemType="leaf" value="r-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No integration runtimes'}</Caption1></TreeItemLayout></TreeItem>}
              {fRuntimes.map((r) => (
                <TreeItem key={r.name} itemType="leaf" value={`r-${r.name}`}>
                  <TreeItemLayout iconBefore={<Server20Regular />}>
                    <ContextMenu actions={rowActionsFor('integrationRuntime')} onAction={(k) => onRowAction('integrationRuntime', r.name, k as RowActionKey)} disabled={busy}>
                      <span className={s.leafRow}>
                        <NameCell className={s.nameText} name={r.name} onOpen={onOpenManage} />
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>{typeof r.type === 'string' && <Caption1>{r.type as string}</Caption1>}{typeof r.state === 'string' && <Badge size="small" appearance="outline">{r.state as string}</Badge>}</span>
                      </span>
                    </ContextMenu>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Change Data Capture (preview) — real ADF adfcdcs resources.
              The "(preview)" suffix matches ADF Studio's own label (the CDC
              feature is still tagged preview in the portal). Start/Stop hit
              real ARM REST; Open inspects the source→target mapping + live
              status before executing (the "preview CDC output" workflow). */}
          <TreeItem itemType="branch" value="g-cdc">
            {groupHeader('Change Data Capture (preview)', <ArrowRepeatAll20Regular />, cdcs.length, 'cdc')}
            <Tree>
              {fCdcs.length === 0 && <TreeItem itemType="leaf" value="c-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No CDC resources'}</Caption1></TreeItemLayout></TreeItem>}
              {fCdcs.map((c) => {
                const running = (c.status || '').toLowerCase() === 'running';
                const transitioning = ['starting', 'stopping'].includes((c.status || '').toLowerCase());
                const color = running ? 'success' : (c.status || '').toLowerCase() === 'stopped' ? 'informative' : transitioning ? 'warning' : 'danger';
                return (
                  <TreeItem key={c.name} itemType="leaf" value={`c-${c.name}`}>
                    <TreeItemLayout iconBefore={<ArrowRepeatAll20Regular />}>
                      <ContextMenu actions={rowActionsFor('cdc', { running })} onAction={(k) => onRowAction('cdc', c.name, k as RowActionKey)} disabled={busy || transitioning}>
                        <span className={s.leafRow}>
                          <NameCell className={s.nameText} name={c.name} onOpen={onOpenCdc ? () => onOpenCdc(c.name) : undefined} />
                          <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                            {typeof c.targetCount === 'number' && <Caption1>{(c.sourceCount ?? 0)}→{c.targetCount} tbl</Caption1>}
                            <Badge size="small" appearance="filled" color={color}>{c.status || '—'}</Badge>
                            {running
                              ? <Tooltip content="Stop" relationship="label"><Button size="small" appearance="subtle" icon={<Stop16Regular />} disabled={busy || transitioning} onClick={() => cdcLifecycle(c.name, 'stop')} aria-label={`Stop ${c.name}`} /></Tooltip>
                              : <Tooltip content="Start" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy || transitioning} onClick={() => cdcLifecycle(c.name, 'start')} aria-label={`Start ${c.name}`} /></Tooltip>}
                            {onOpenCdc && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenCdc(c.name)} aria-label={`Open ${c.name}`} /></Tooltip>}
                            <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => openDelete('cdc', c.name)} aria-label={`Delete ${c.name}`} /></Tooltip>
                          </span>
                        </span>
                      </ContextMenu>
                    </TreeItemLayout>
                  </TreeItem>
                );
              })}
            </Tree>
          </TreeItem>

          {/* Global parameters — factory-level globalParameters (real ARM). The
              whole set is edited in one dialog (add/edit/remove) and PUT back. */}
          <TreeItem itemType="branch" value="g-globalparams">
            <TreeItemLayout iconBefore={<Globe20Regular />}>
              <ContextMenu actions={groupActionsFor('globalParams', { canCreate: true })} onAction={(k) => onGroupAction('globalParams', k as GroupActionKey)}>
                <span className={s.groupLayout}>
                  <span className={s.nameText} title={`Global parameters (${Object.keys(globalParams).length})`}>Global parameters ({Object.keys(globalParams).length})</span>
                  <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
                    <Tooltip content="Edit global parameters" relationship="label">
                      <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={openGp} disabled={busy} aria-label="Edit global parameters" />
                    </Tooltip>
                  </span>
                </span>
              </ContextMenu>
            </TreeItemLayout>
            <Tree>
              {gpEntries.length === 0 && <TreeItem itemType="leaf" value="gp-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No global parameters — Edit to add'}</Caption1></TreeItemLayout></TreeItem>}
              {gpEntries.map(([name, spec]) => (
                <TreeItem key={name} itemType="leaf" value={`gp-${name}`}>
                  <TreeItemLayout iconBefore={<Globe20Regular />}>
                    <ContextMenu actions={rowActionsFor('globalParam')} onAction={(k) => onRowAction('globalParam', name, k as RowActionKey, { inline: spec })} disabled={busy}>
                      <span className={s.leafRow}>
                        <NameCell className={s.nameText} name={name} onOpen={openGp} />
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          <Caption1>{(spec?.type as string) || 'String'}</Caption1>
                          <Tooltip content="Edit" relationship="label"><Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={openGp} disabled={busy} aria-label={`Edit ${name}`} /></Tooltip>
                        </span>
                      </span>
                    </ContextMenu>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Managed private endpoints — factory managed VNet PEs (real ARM). New
              PEs land Pending; the resource owner must approve. When the factory
              has no managed VNet, an honest inline "create it" affordance shows. */}
          <TreeItem itemType="branch" value="g-mpe">
            <TreeItemLayout iconBefore={<PlugConnected20Regular />}>
              <ContextMenu actions={groupActionsFor('managedPrivateEndpoints', { canCreate: managedVnetPresent })} onAction={(k) => onGroupAction('managedPrivateEndpoints', k as GroupActionKey)}>
                <span className={s.groupLayout}>
                  <span className={s.nameText} title={`Managed private endpoints (${mpes.length})`}>Managed private endpoints ({mpes.length})</span>
                  <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
                    {managedVnetPresent && (
                      <Tooltip content="New managed private endpoint" relationship="label">
                        <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={openMpe} disabled={busy} aria-label="New managed private endpoint" />
                      </Tooltip>
                    )}
                  </span>
                </span>
              </ContextMenu>
            </TreeItemLayout>
            <Tree>
              {!managedVnetPresent && (
                <TreeItem itemType="leaf" value="mpe-gate">
                  <TreeItemLayout>
                    <span className={s.mpeGate}>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        This factory has no managed virtual network. Create one to add managed private endpoints for private access to PE-locked sources.
                      </Caption1>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={createMvnet} disabled={busy}>Create managed virtual network</Button>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              )}
              {managedVnetPresent && fMpes.length === 0 && <TreeItem itemType="leaf" value="mpe-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No managed private endpoints'}</Caption1></TreeItemLayout></TreeItem>}
              {managedVnetPresent && fMpes.map((m) => {
                const st = m.connectionStatus || 'Pending';
                const color = st === 'Approved' ? 'success' : (st === 'Rejected' || st === 'Disconnected') ? 'danger' : 'warning';
                return (
                  <TreeItem key={m.name} itemType="leaf" value={`mpe-${m.name}`}>
                    <TreeItemLayout iconBefore={<PlugConnected20Regular />}>
                      <ContextMenu actions={rowActionsFor('managedPrivateEndpoint')} onAction={(k) => onRowAction('managedPrivateEndpoint', m.name, k as RowActionKey, { inline: m })} disabled={busy}>
                        <span className={s.leafRow}>
                          <NameCell className={s.nameText} name={m.name} />
                          <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                            {m.groupId && <Caption1>{m.groupId}</Caption1>}
                            <Badge size="small" appearance="filled" color={color}>{st}</Badge>
                            <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => openDelete('managedPrivateEndpoint', m.name)} aria-label={`Delete ${m.name}`} /></Tooltip>
                          </span>
                        </span>
                      </ContextMenu>
                    </TreeItemLayout>
                  </TreeItem>
                );
              })}
            </Tree>
          </TreeItem>

          {/* Honest note — the one remaining Azure group we don't embed inline yet. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet embedded</TreeItemLayout>
            <Tree>
              {[
                ['Power Query', 'WranglingDataFlow authoring (Power Query Online mashup editor) is not embedded in this navigator yet. Power Query / Dataflow Gen2 still runs on the real Wrangling Data Flow backend — author and run it from the Manage hub.'],
              ].map(([label, why]) => (
                <TreeItem key={label} itemType="leaf" value={`nw-${label}`}>
                  <Tooltip content={why} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{label}</span>{' '}
                      <Badge size="small" appearance="tint" color="informative">Manage hub</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        </Tree>
      </div>

      {/* Create dialog (pipeline / dataflow / trigger / dataset) */}
      <Dialog open={createGroup !== null} onOpenChange={(_, d) => { if (!d.open) setCreateGroup(null); }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'pipeline' ? 'pipeline' : createGroup === 'dataflow' ? 'data flow' : createGroup === 'dataset' ? 'dataset' : 'trigger'}
            </DialogTitle>
            <DialogContent>
              <Field label="Name" required>
                <Input value={createName} onChange={(_, d) => setCreateName(d.value)} placeholder="my_resource" />
              </Field>
              {createGroup === 'dataset' && (
                <>
                  <Field label="Type" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown value={createDsType} selectedOptions={[createDsType]} onOptionSelect={(_, d) => setCreateDsType(d.optionValue || 'DelimitedText')}>
                      {['DelimitedText', 'Json', 'Parquet', 'Binary', 'AzureSqlTable'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Linked service" required style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown
                      placeholder={linkedServices.length ? 'Select a linked service' : 'No linked services — create one in Manage'}
                      value={createDsLinkedService} selectedOptions={createDsLinkedService ? [createDsLinkedService] : []}
                      onOptionSelect={(_, d) => setCreateDsLinkedService(d.optionValue || '')}
                      disabled={!linkedServices.length}
                    >
                      {linkedServices.map((l) => <Option key={l.name} value={l.name} text={l.name}>{l.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    Refine location/format and schema in the Manage hub after creation.
                  </Caption1>
                </>
              )}
              {createGroup === 'dataflow' && (
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                  Creates an empty Mapping Data Flow. Edit the data flow definition — add sources,
                  transformations, and sinks — in the Manage hub data flow JSON editor.
                </Caption1>
              )}
              {createGroup === 'trigger' && (
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                  Creates a daily Schedule trigger (Stopped). Wire it to a pipeline from that pipeline&apos;s
                  Triggers panel, then Start it.
                </Caption1>
              )}
              {createError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateGroup(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCreate} disabled={busy || !createName.trim()}>{busy ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Global parameters editor — add / edit / remove; Save PUTs the whole set. */}
      <Dialog open={gpOpen} onOpenChange={(_, d) => { if (!d.open) setGpOpen(false); }}>
        <DialogSurface style={{ maxWidth: 760 }}>
          <DialogBody>
            <DialogTitle>Global parameters</DialogTitle>
            <DialogContent>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                Factory-level parameters referenced in pipelines via <code>@pipeline().globalParameters.NAME</code>.
                Names use letters, digits and underscore (no &ldquo;-&rdquo;).
              </Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                {gpRows.length > 0 && (
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                    <span style={{ flex: '1 1 30%' }}><Caption1>Name</Caption1></span>
                    <span style={{ flex: '0 0 110px' }}><Caption1>Type</Caption1></span>
                    <span style={{ flex: '1 1 45%' }}><Caption1>Value</Caption1></span>
                    <span style={{ flex: '0 0 32px' }} />
                  </div>
                )}
                {gpRows.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No parameters yet. Add one below.</Caption1>}
                {gpRows.map((row, i) => (
                  <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start' }}>
                    <span style={{ flex: '1 1 30%' }}>
                      <Input value={row.name} placeholder="paramName" onChange={(_, d) => setGpRows((rows) => rows.map((r, idx) => idx === i ? { ...r, name: d.value } : r))} />
                    </span>
                    <span style={{ flex: '0 0 110px' }}>
                      <Dropdown value={row.type} selectedOptions={[row.type]} onOptionSelect={(_, d) => setGpRows((rows) => rows.map((r, idx) => idx === i ? { ...r, type: d.optionValue || 'String' } : r))}>
                        {['String', 'Int', 'Float', 'Bool', 'Object', 'Array'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                      </Dropdown>
                    </span>
                    <span style={{ flex: '1 1 45%' }}>
                      {row.type === 'Bool' ? (
                        <Dropdown value={row.value === 'true' ? 'true' : 'false'} selectedOptions={[row.value === 'true' ? 'true' : 'false']} onOptionSelect={(_, d) => setGpRows((rows) => rows.map((r, idx) => idx === i ? { ...r, value: d.optionValue || 'false' } : r))}>
                          <Option value="true" text="true">true</Option>
                          <Option value="false" text="false">false</Option>
                        </Dropdown>
                      ) : (row.type === 'Object' || row.type === 'Array') ? (
                        <Textarea value={row.value} placeholder={row.type === 'Array' ? '[ "a", "b" ]' : '{ "k": "v" }'} onChange={(_, d) => setGpRows((rows) => rows.map((r, idx) => idx === i ? { ...r, value: d.value } : r))} />
                      ) : (
                        <Input type={row.type === 'Int' || row.type === 'Float' ? 'number' : 'text'} value={row.value} onChange={(_, d) => setGpRows((rows) => rows.map((r, idx) => idx === i ? { ...r, value: d.value } : r))} />
                      )}
                    </span>
                    <span style={{ flex: '0 0 32px' }}>
                      <Tooltip content="Remove parameter" relationship="label">
                        <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => setGpRows((rows) => rows.filter((_, idx) => idx !== i))} aria-label="Remove parameter" />
                      </Tooltip>
                    </span>
                  </div>
                ))}
                <div>
                  <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={() => setGpRows((rows) => [...rows, { name: '', type: 'String', value: '' }])}>Add parameter</Button>
                </div>
              </div>
              {gpError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{gpError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setGpOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={saveGp} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Managed private endpoint create — real ARM; PE lands Pending → owner approves. */}
      <Dialog open={mpeOpen} onOpenChange={(_, d) => { if (!d.open) setMpeOpen(false); }}>
        <DialogSurface style={{ maxWidth: 580 }}>
          <DialogBody>
            <DialogTitle>New managed private endpoint</DialogTitle>
            <DialogContent>
              <Field label="Name" required>
                <Input value={mpeName} onChange={(_, d) => setMpeName(d.value)} placeholder="mpe-lake-dfs" disabled={!!mpeNote} />
              </Field>
              <Field label="Target resource ID" required style={{ marginTop: tokens.spacingVerticalS }}>
                <Input value={mpeResourceId} onChange={(_, d) => setMpeResourceId(d.value)} placeholder="/subscriptions/…/providers/Microsoft.Storage/storageAccounts/…" disabled={!!mpeNote} />
              </Field>
              <Field label="Sub-resource (groupId)" required style={{ marginTop: tokens.spacingVerticalS }}>
                <Dropdown value={mpeGroupId} selectedOptions={[mpeGroupId]} onOptionSelect={(_, d) => setMpeGroupId(d.optionValue || 'dfs')} disabled={!!mpeNote}>
                  {['dfs', 'blob', 'sqlServer', 'vault', 'table', 'queue', 'file', 'namespace', 'sites'].map((gid) => <Option key={gid} value={gid} text={gid}>{gid}</Option>)}
                </Dropdown>
              </Field>
              <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                Created in managed virtual network <code>{mvnetName}</code>. Choose the target sub-resource:
                <code> dfs</code>/<code>blob</code> for ADLS/Storage, <code>sqlServer</code> for Azure SQL,
                <code> vault</code> for Key Vault. The endpoint is created <strong>Pending</strong> — the resource owner must approve the
                connection before it carries traffic.
              </Caption1>
              {mpeError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{mpeError}</MessageBarBody></MessageBar>}
              {mpeNote && <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Created — approval required</MessageBarTitle>{mpeNote}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setMpeOpen(false)} disabled={busy}>{mpeNote ? 'Close' : 'Cancel'}</Button>
              {!mpeNote && <Button appearance="primary" onClick={submitMpe} disabled={busy || !mpeName.trim() || !mpeResourceId.trim()}>{busy ? 'Creating…' : 'Create'}</Button>}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Delete confirm — typed-name gate. Every destructive action funnels here
          (per no-vaporware.md); the primary button unlocks only when the typed
          text matches the resource name exactly (canConfirmDelete). */}
      <Dialog open={deleteTarget !== null} onOpenChange={(_, d) => { if (!d.open && !busy) { setDeleteTarget(null); } }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>Delete {deleteTarget?.kind === 'globalParam' ? 'global parameter' : deleteTarget?.kind}</DialogTitle>
            <DialogContent>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                This permanently deletes <strong>{deleteTarget?.name}</strong> from the Data Factory. This can&apos;t be
                undone, and any pipeline/dataset that references it may break. Type the name to confirm.
              </Caption1>
              <Field label={`Type "${deleteTarget?.name ?? ''}" to confirm`} required>
                <Input
                  value={deleteConfirmText}
                  onChange={(_, d) => setDeleteConfirmText(d.value)}
                  placeholder={deleteTarget?.name ?? ''}
                  onKeyDown={(e) => { if (e.key === 'Enter' && deleteTarget && canConfirmDelete(deleteConfirmText, deleteTarget.name)) confirmDelete(); }}
                />
              </Field>
              {deleteError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Delete failed</MessageBarTitle>{deleteError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeleteTarget(null)} disabled={busy}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={confirmDelete}
                disabled={busy || !deleteTarget || !canConfirmDelete(deleteConfirmText, deleteTarget.name)}
              >
                {busy ? 'Deleting…' : 'Delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Clone / Rename — fetches the full definition, then creates a copy under
          the new name (Rename additionally deletes the original). Real ADF REST. */}
      <Dialog open={crState !== null} onOpenChange={(_, d) => { if (!d.open && !busy) { setCrState(null); } }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>{crState?.mode === 'rename' ? 'Rename' : 'Clone'} {crState?.kind}</DialogTitle>
            <DialogContent>
              <Field label="New name" required>
                <Input
                  value={crNewName}
                  onChange={(_, d) => setCrNewName(d.value)}
                  placeholder="my_resource"
                  onKeyDown={(e) => { if (e.key === 'Enter' && crNewName.trim()) submitCloneRename(); }}
                />
              </Field>
              <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                {crState?.mode === 'rename'
                  ? 'Rename copies the definition to the new name, then deletes the original. References to the old name elsewhere are NOT auto-updated — fix them after renaming.'
                  : 'Clone creates an independent copy of the definition under the new name.'}
              </Caption1>
              {crError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>{crState?.mode === 'rename' ? 'Rename failed' : 'Clone failed'}</MessageBarTitle>{crError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCrState(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCloneRename} disabled={busy || !crNewName.trim()}>
                {busy ? 'Working…' : crState?.mode === 'rename' ? 'Rename' : 'Clone'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* View JSON — read-only ARM definition (the ADF Studio "{} Code" view). */}
      <Dialog open={jsonView !== null} onOpenChange={(_, d) => { if (!d.open) setJsonView(null); }}>
        <DialogSurface style={{ maxWidth: 760 }}>
          <DialogBody>
            <DialogTitle>{jsonView?.title ?? 'JSON'}</DialogTitle>
            <DialogContent>
              {jsonLoading && <div style={{ padding: tokens.spacingVerticalS }}><Spinner size="tiny" label="Loading definition…" /></div>}
              {jsonError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Failed to load</MessageBarTitle>{jsonError}</MessageBarBody></MessageBar>}
              {!jsonLoading && !jsonError && jsonView && (
                <Textarea
                  readOnly
                  aria-label="Resource definition JSON (read-only)"
                  value={jsonView.text}
                  style={{ width: '100%', minHeight: '360px', fontFamily: tokens.fontFamilyMonospace }}
                />
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setJsonView(null)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
