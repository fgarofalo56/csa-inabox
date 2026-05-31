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
 *
 * Groups Azure exposes but we don't yet wire (Managed private endpoints, Power
 * Query, Change data capture, Global parameters) render as honest ⚠️ gate rows
 * naming what's missing — never a fake list. No mocks.
 *
 * The factory is the env-pinned default (LOOM_ADF_NAME / LOOM_DLZ_RG /
 * LOOM_SUBSCRIPTION_ID). When unconfigured the routes 503 and the whole tree
 * shows a single honest infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, MoreHorizontal20Regular,
  Flow20Regular, DocumentTable20Regular, DataUsage20Regular, Clock20Regular,
  Link20Regular, Server20Regular, Play16Regular, Stop16Regular, Open16Regular,
  Search20Regular, Warning20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, height: '100%', minWidth: 240 },
  header: { display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  leafRow: { display: 'flex', alignItems: 'center', gap: 4, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  gateRow: { padding: '4px 8px' },
});

const PIPE_ROUTE = '/api/adf/pipelines';
const DS_ROUTE = '/api/adf/datasets';
const DF_ROUTE = '/api/adf/dataflows';
const TRG_ROUTE = '/api/adf/triggers';
const LS_ROUTE = '/api/adf/linked-services';
const IR_ROUTE = '/api/adf/integration-runtimes';

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
  /** Increment to force a refresh from the parent (e.g. after a bind/create). */
  refreshKey?: number;
}

/**
 * A typed, ADF-Studio-faithful Factory Resources navigator.
 */
export function FactoryResourcesTree({
  boundPipeline, onOpenPipeline, onOpenManage, refreshKey = 0,
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

  const [busy, setBusy] = useState(false);

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreatableGroup | null>(null);
  const [createName, setCreateName] = useState('');
  const [createDsType, setCreateDsType] = useState('DelimitedText');
  const [createDsLinkedService, setCreateDsLinkedService] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pr, dr, fr, tr, lr, ir] = await Promise.all([
        fetch(PIPE_ROUTE).then(readJson),
        fetch(DS_ROUTE).then(readJson),
        fetch(DF_ROUTE).then(readJson),
        fetch(TRG_ROUTE).then(readJson),
        fetch(LS_ROUTE).then(readJson),
        fetch(IR_ROUTE).then(readJson),
      ]);
      // Any route reporting not_configured gates the whole tree (same factory).
      for (const b of [pr, dr, fr, tr, lr, ir]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (pr.ok) setPipelines(pr.pipelines || []); else setError(pr.error || 'failed to list pipelines');
      if (dr.ok) setDatasets(dr.datasets || []);
      if (fr.ok) setDataflows(fr.dataflows || []);
      if (tr.ok) setTriggers(tr.triggers || []);
      if (lr.ok) setLinkedServices(lr.linkedServices || []);
      if (ir.ok) setRuntimes(ir.runtimes || []);
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
        <span style={{ display: 'flex', gap: 2 }}>
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

      {loading && <div style={{ padding: 8 }}><Spinner size="tiny" label="Loading factory resources…" /></div>}
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

          {/* Honest gate rows — Azure exposes these groups; we don't wire them yet. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired</TreeItemLayout>
            <Tree>
              {[
                ['Managed private endpoints', 'Microsoft.DataFactory/factories/managedVirtualNetworks/managedPrivateEndpoints — needs a Managed VNet on the factory.'],
                ['Power Query', 'WranglingDataFlow authoring (mashup editor) — Power Query online surface not embedded yet.'],
                ['Change data capture', 'Top-level CDC resource (adfcdc) — preview REST not wired.'],
                ['Global parameters', 'Factory-level globalParameters — editor not wired; edit via the factory ARM resource for now.'],
              ].map(([label, why]) => (
                <TreeItem key={label} itemType="leaf" value={`nw-${label}`}>
                  <Tooltip content={why} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{label}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">coming</Badge>
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
                  <Field label="Type" style={{ marginTop: 8 }}>
                    <Dropdown value={createDsType} selectedOptions={[createDsType]} onOptionSelect={(_, d) => setCreateDsType(d.optionValue || 'DelimitedText')}>
                      {['DelimitedText', 'Json', 'Parquet', 'Binary', 'AzureSqlTable'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Linked service" required style={{ marginTop: 8 }}>
                    <Dropdown
                      placeholder={linkedServices.length ? 'Select a linked service' : 'No linked services — create one in Manage'}
                      value={createDsLinkedService} selectedOptions={createDsLinkedService ? [createDsLinkedService] : []}
                      onOptionSelect={(_, d) => setCreateDsLinkedService(d.optionValue || '')}
                      disabled={!linkedServices.length}
                    >
                      {linkedServices.map((l) => <Option key={l.name} value={l.name} text={l.name}>{l.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                    Refine location/format and schema in the Manage hub after creation.
                  </Caption1>
                </>
              )}
              {createGroup === 'dataflow' && (
                <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
                  Creates an empty Mapping Data Flow. Add sources, transformations and sinks by editing the
                  data flow JSON in the Manage hub (full visual data-flow designer is a follow-up).
                </Caption1>
              )}
              {createGroup === 'trigger' && (
                <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
                  Creates a daily Schedule trigger (Stopped). Wire it to a pipeline from that pipeline&apos;s
                  Triggers panel, then Start it.
                </Caption1>
              )}
              {createError && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateGroup(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCreate} disabled={busy || !createName.trim()}>{busy ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
