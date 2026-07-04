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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Textarea, Field, Caption1, Badge, Spinner, Dropdown, Option,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
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
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalS, height: '100%', minWidth: '240px' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  leafRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  gateRow: { padding: '4px 8px' },
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

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pr, dr, fr, tr, lr, ir, cr, gpr, mper] = await Promise.all([
        fetch(PIPE_ROUTE).then(readJson),
        fetch(DS_ROUTE).then(readJson),
        fetch(DF_ROUTE).then(readJson),
        fetch(TRG_ROUTE).then(readJson),
        fetch(LS_ROUTE).then(readJson),
        fetch(IR_ROUTE).then(readJson),
        fetch(CDC_ROUTE).then(readJson),
        fetch(GP_ROUTE).then(readJson),
        fetch(MPE_ROUTE).then(readJson),
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
      const res = await fetch(route, {
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

  const del = useCallback(async (route: string, name: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${route}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  const triggerLifecycle = useCallback(async (name: string, action: 'start' | 'stop') => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(TRG_ROUTE, {
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
      const res = await fetch(CDC_ROUTE, {
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
      const res = await fetch(GP_ROUTE, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parameters: dict }) });
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
      const res = await fetch(MPE_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create-mvnet' }) });
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
      const res = await fetch(MPE_ROUTE, {
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
  const groupHeader = (
    label: string, icon: React.ReactElement, count: number,
    onAdd?: () => void, addTitle?: string,
  ) => (
    <TreeItemLayout iconBefore={icon}>
      <span className={s.groupLayout}>
        <span>{label} ({count})</span>
        <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
          {onAdd && (
            <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
            </Tooltip>
          )}
        </span>
      </span>
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
        <Tree aria-label="Factory resources" defaultOpenItems={['g-pipelines']}>
          {/* Pipelines */}
          <TreeItem itemType="branch" value="g-pipelines">
            {groupHeader('Pipelines', <Flow20Regular />, pipelines.length, () => openCreate('pipeline'), 'New pipeline')}
            <Tree>
              {fPipelines.length === 0 && <TreeItem itemType="leaf" value="p-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No pipelines'}</Caption1></TreeItemLayout></TreeItem>}
              {fPipelines.map((p) => (
                <TreeItem key={p.name} itemType="leaf" value={`p-${p.name}`}>
                  <TreeItemLayout iconBefore={<Flow20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: 'pointer', fontWeight: boundPipeline === p.name ? tokens.fontWeightSemibold : undefined }}
                        onClick={() => onOpenPipeline(p.name)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenPipeline(p.name); } }}
                      >
                        {p.name}{boundPipeline === p.name ? ' ·' : ''}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {typeof p.activities === 'number' && <Caption1>{p.activities as number} act</Caption1>}
                        <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenPipeline(p.name)} aria-label={`Open ${p.name}`} /></Tooltip>
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(PIPE_ROUTE, p.name)} aria-label={`Delete ${p.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Datasets */}
          <TreeItem itemType="branch" value="g-datasets">
            {groupHeader('Datasets', <DocumentTable20Regular />, datasets.length, () => openCreate('dataset'), 'New dataset')}
            <Tree>
              {fDatasets.length === 0 && <TreeItem itemType="leaf" value="d-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No datasets'}</Caption1></TreeItemLayout></TreeItem>}
              {fDatasets.map((d) => (
                <TreeItem key={d.name} itemType="leaf" value={`d-${d.name}`}>
                  <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                    <span className={s.leafRow}>
                      <span>{d.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="Edit in Manage" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={onOpenManage} aria-label={`Edit ${d.name}`} /></Tooltip>
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(DS_ROUTE, d.name)} aria-label={`Delete ${d.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Data flows */}
          <TreeItem itemType="branch" value="g-dataflows">
            {groupHeader('Data flows', <DataUsage20Regular />, dataflows.length, () => openCreate('dataflow'), 'New data flow')}
            <Tree>
              {fDataflows.length === 0 && <TreeItem itemType="leaf" value="f-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No data flows'}</Caption1></TreeItemLayout></TreeItem>}
              {fDataflows.map((d) => (
                <TreeItem key={d.name} itemType="leaf" value={`f-${d.name}`}>
                  <TreeItemLayout iconBefore={<DataUsage20Regular />}>
                    <span className={s.leafRow}>
                      <span>{d.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {typeof d.type === 'string' && <Caption1>{(d.type as string).replace('DataFlow', '')}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(DF_ROUTE, d.name)} aria-label={`Delete ${d.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Triggers */}
          <TreeItem itemType="branch" value="g-triggers">
            {groupHeader('Triggers', <Clock20Regular />, triggers.length, () => openCreate('trigger'), 'New trigger')}
            <Tree>
              {fTriggers.length === 0 && <TreeItem itemType="leaf" value="t-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No triggers'}</Caption1></TreeItemLayout></TreeItem>}
              {fTriggers.map((t) => (
                <TreeItem key={t.name} itemType="leaf" value={`t-${t.name}`}>
                  <TreeItemLayout iconBefore={<Clock20Regular />}>
                    <span className={s.leafRow}>
                      <span>{t.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Badge size="small" appearance="filled" color={t.runtimeState === 'Started' ? 'success' : t.runtimeState === 'Stopped' ? 'informative' : 'warning'}>{t.runtimeState || '—'}</Badge>
                        {t.runtimeState === 'Started'
                          ? <Tooltip content="Stop" relationship="label"><Button size="small" appearance="subtle" icon={<Stop16Regular />} disabled={busy} onClick={() => triggerLifecycle(t.name, 'stop')} aria-label={`Stop ${t.name}`} /></Tooltip>
                          : <Tooltip content="Start" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy} onClick={() => triggerLifecycle(t.name, 'start')} aria-label={`Start ${t.name}`} /></Tooltip>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(TRG_ROUTE, t.name)} aria-label={`Delete ${t.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Linked services (managed in the Manage hub) */}
          <TreeItem itemType="branch" value="g-linked">
            {groupHeader('Linked services', <Link20Regular />, linkedServices.length, onOpenManage, 'New linked service (Manage hub)')}
            <Tree>
              {fLinked.length === 0 && <TreeItem itemType="leaf" value="l-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No linked services'}</Caption1></TreeItemLayout></TreeItem>}
              {fLinked.map((l) => (
                <TreeItem key={l.name} itemType="leaf" value={`l-${l.name}`} onClick={onOpenManage}>
                  <TreeItemLayout iconBefore={<Link20Regular />}>
                    <span className={s.leafRow}>
                      <span>{l.name}</span>
                      <span className={s.leafActions}>{typeof (l.properties as any)?.type === 'string' && <Caption1>{(l.properties as any).type}</Caption1>}</span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Integration runtimes (managed in the Manage hub) */}
          <TreeItem itemType="branch" value="g-runtimes">
            {groupHeader('Integration runtimes', <Server20Regular />, runtimes.length, onOpenManage, 'New integration runtime (Manage hub)')}
            <Tree>
              {fRuntimes.length === 0 && <TreeItem itemType="leaf" value="r-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No integration runtimes'}</Caption1></TreeItemLayout></TreeItem>}
              {fRuntimes.map((r) => (
                <TreeItem key={r.name} itemType="leaf" value={`r-${r.name}`} onClick={onOpenManage}>
                  <TreeItemLayout iconBefore={<Server20Regular />}>
                    <span className={s.leafRow}>
                      <span>{r.name}</span>
                      <span className={s.leafActions}>{typeof r.type === 'string' && <Caption1>{r.type as string}</Caption1>}{typeof r.state === 'string' && <Badge size="small" appearance="outline">{r.state as string}</Badge>}</span>
                    </span>
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
            {groupHeader('Change Data Capture (preview)', <ArrowRepeatAll20Regular />, cdcs.length)}
            <Tree>
              {fCdcs.length === 0 && <TreeItem itemType="leaf" value="c-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No CDC resources'}</Caption1></TreeItemLayout></TreeItem>}
              {fCdcs.map((c) => {
                const running = (c.status || '').toLowerCase() === 'running';
                const transitioning = ['starting', 'stopping'].includes((c.status || '').toLowerCase());
                const color = running ? 'success' : (c.status || '').toLowerCase() === 'stopped' ? 'informative' : transitioning ? 'warning' : 'danger';
                return (
                  <TreeItem key={c.name} itemType="leaf" value={`c-${c.name}`}>
                    <TreeItemLayout iconBefore={<ArrowRepeatAll20Regular />}>
                      <span className={s.leafRow}>
                        <span
                          role="button" tabIndex={0} style={{ cursor: onOpenCdc ? 'pointer' : undefined }}
                          onClick={() => onOpenCdc?.(c.name)}
                          onKeyDown={(e) => { if (onOpenCdc && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpenCdc(c.name); } }}
                        >{c.name}</span>
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          {typeof c.targetCount === 'number' && <Caption1>{(c.sourceCount ?? 0)}→{c.targetCount} tbl</Caption1>}
                          <Badge size="small" appearance="filled" color={color}>{c.status || '—'}</Badge>
                          {running
                            ? <Tooltip content="Stop" relationship="label"><Button size="small" appearance="subtle" icon={<Stop16Regular />} disabled={busy || transitioning} onClick={() => cdcLifecycle(c.name, 'stop')} aria-label={`Stop ${c.name}`} /></Tooltip>
                            : <Tooltip content="Start" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy || transitioning} onClick={() => cdcLifecycle(c.name, 'start')} aria-label={`Start ${c.name}`} /></Tooltip>}
                          {onOpenCdc && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenCdc(c.name)} aria-label={`Open ${c.name}`} /></Tooltip>}
                          <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(CDC_ROUTE, c.name)} aria-label={`Delete ${c.name}`} /></Tooltip>
                        </span>
                      </span>
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
              <span className={s.groupLayout}>
                <span>Global parameters ({Object.keys(globalParams).length})</span>
                <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
                  <Tooltip content="Edit global parameters" relationship="label">
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={openGp} disabled={busy} aria-label="Edit global parameters" />
                  </Tooltip>
                </span>
              </span>
            </TreeItemLayout>
            <Tree>
              {gpEntries.length === 0 && <TreeItem itemType="leaf" value="gp-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No global parameters — Edit to add'}</Caption1></TreeItemLayout></TreeItem>}
              {gpEntries.map(([name, spec]) => (
                <TreeItem key={name} itemType="leaf" value={`gp-${name}`}>
                  <TreeItemLayout iconBefore={<Globe20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                        onClick={openGp}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGp(); } }}
                      >{name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Caption1>{(spec?.type as string) || 'String'}</Caption1>
                        <Tooltip content="Edit" relationship="label"><Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={openGp} disabled={busy} aria-label={`Edit ${name}`} /></Tooltip>
                      </span>
                    </span>
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
              <span className={s.groupLayout}>
                <span>Managed private endpoints ({mpes.length})</span>
                <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
                  {managedVnetPresent && (
                    <Tooltip content="New managed private endpoint" relationship="label">
                      <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={openMpe} disabled={busy} aria-label="New managed private endpoint" />
                    </Tooltip>
                  )}
                </span>
              </span>
            </TreeItemLayout>
            <Tree>
              {!managedVnetPresent && (
                <TreeItem itemType="leaf" value="mpe-gate">
                  <TreeItemLayout>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, padding: '4px 0' }}>
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
                    <Tooltip content={m.privateLinkResourceId || m.name} relationship="description">
                      <TreeItemLayout iconBefore={<PlugConnected20Regular />}>
                        <span className={s.leafRow}>
                          <span>{m.name}</span>
                          <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                            {m.groupId && <Caption1>{m.groupId}</Caption1>}
                            <Badge size="small" appearance="filled" color={color}>{st}</Badge>
                            <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(MPE_ROUTE, m.name)} aria-label={`Delete ${m.name}`} /></Tooltip>
                          </span>
                        </span>
                      </TreeItemLayout>
                    </Tooltip>
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
    </div>
  );
}
