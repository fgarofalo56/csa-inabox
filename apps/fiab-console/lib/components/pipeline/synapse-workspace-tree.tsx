'use client';

/**
 * SynapseWorkspaceTree — the Synapse-Studio "Workspace Resources" navigator.
 *
 * The Synapse equivalent of the ADF Factory Resources pane. Once the Synapse
 * pipeline editor is open, its left pane becomes this typed navigator: one
 * group per workspace artifact type with a live count and a ＋ New affordance,
 * a "Filter resources by name" box, RIGHT-CLICK context menus per node, and a
 * top "Add new resource" menu — matching the Synapse Studio Develop / Integrate
 * / Data / Manage hubs collapsed into one tree.
 *
 * The tree chrome (typed icons, filter, right-click context menus, inline row
 * actions, lazy expand) is the shared SC-7 `<ExplorerTree>`; this file maps the
 * workspace's REAL artifact lists into its generic node model and dispatches
 * every action to the same real REST handlers as before. Adopting the shared
 * component ADDS the previously-missing right-click context menus (its top gap
 * per the UX-baseline inventory, UX-710) with no change to the backend.
 *
 * Every count comes from a real Synapse artifacts list call; every create/
 * delete hits the real Synapse dev-plane REST (api-version 2020-12-01) through
 * the workspace-level BFF routes:
 *   - Pipelines      → /api/synapse/pipelines      (list/create/delete) + open on canvas
 *   - Datasets       → /api/synapse/datasets        (list/create/delete)
 *   - Data flows     → /api/synapse/dataflows       (list/create/delete)
 *   - Notebooks      → /api/synapse/notebooks       (list/create/delete)
 *   - SQL scripts    → /api/synapse/sqlscripts      (list/create/delete)
 *   - KQL scripts    → /api/synapse/kqlscripts      (list/create/delete + open editor → Run on a Kusto pool)
 *   - Spark job defs → /api/synapse/sparkjobdefinitions (list/create/delete + open editor → Submit Livy batch)
 *   - Triggers       → /api/synapse/triggers        (list/create/start/stop/delete)
 *   - Linked services→ /api/synapse/linkedservices  (list/create/delete)
 *   - Spark / SQL pools → /api/synapse/pools         (read-only list from ARM)
 *
 * The remaining Synapse Studio group we don't yet author (dedicated-SQL-pool
 * create/scale — listed read-only here, authored in the scaling editor) renders
 * as an honest ⚠️ node naming where it lives — never a fake list. No mocks.
 *
 * The workspace is the env-pinned default (LOOM_SYNAPSE_WORKSPACE). When
 * unconfigured the routes 503 and the whole tree shows a single honest
 * infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Button, Input, Field, Caption1, Dropdown, Option,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete16Regular,
  Flow20Regular, DocumentTable20Regular, DataUsage20Regular, Clock20Regular,
  Link20Regular, Server20Regular, Play16Regular, Stop16Regular, Open16Regular,
  Warning20Regular, Notebook20Regular, DocumentText20Regular,
  Database20Regular, DatabaseArrowRight20Regular, AppsListDetail20Regular,
} from '@fluentui/react-icons';
import { ExplorerTree, type ExplorerNode, type ExplorerAction } from '@/lib/components/shared/explorer-tree';

const PIPE_ROUTE = '/api/synapse/pipelines';
const DS_ROUTE = '/api/synapse/datasets';
const DF_ROUTE = '/api/synapse/dataflows';
const NB_ROUTE = '/api/synapse/notebooks';
const SQL_ROUTE = '/api/synapse/sqlscripts';
const TRG_ROUTE = '/api/synapse/triggers';
const LS_ROUTE = '/api/synapse/linkedservices';
const POOLS_ROUTE = '/api/synapse/pools';
const KQL_ROUTE = '/api/synapse/kqlscripts';
const SJD_ROUTE = '/api/synapse/sparkjobdefinitions';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface NamedRow { name: string; [k: string]: unknown }

type CreatableGroup = 'pipeline' | 'dataset' | 'dataflow' | 'notebook' | 'sqlscript' | 'trigger' | 'kqlscript' | 'sparkjobdef';

// Per-kind icon for the shared ExplorerTree (groups + leaves).
const KIND_ICON: Record<string, ReactElement> = {
  'group-pipelines': <Flow20Regular />, pipeline: <Flow20Regular />,
  'group-datasets': <DocumentTable20Regular />, dataset: <DocumentTable20Regular />,
  'group-dataflows': <DataUsage20Regular />, dataflow: <DataUsage20Regular />,
  'group-notebooks': <Notebook20Regular />, notebook: <Notebook20Regular />,
  'group-sqlscripts': <DocumentText20Regular />, sqlscript: <DocumentText20Regular />,
  'group-kqlscripts': <DatabaseArrowRight20Regular />, kqlscript: <DatabaseArrowRight20Regular />,
  'group-sparkjobdefs': <AppsListDetail20Regular />, sparkjobdef: <AppsListDetail20Regular />,
  'group-triggers': <Clock20Regular />, trigger: <Clock20Regular />,
  'group-linked': <Link20Regular />, linkedservice: <Link20Regular />,
  'group-spark': <Server20Regular />, sparkpool: <Server20Regular />,
  'group-sqlpools': <Database20Regular />, sqlpool: <Database20Regular />,
  'group-notwired': <Warning20Regular />, notwired: <Warning20Regular />,
};

function iconForSynapseNode(node: ExplorerNode): ReactElement {
  return KIND_ICON[node.kind] ?? <DocumentText20Regular />;
}

// Delete route per creatable/deletable leaf kind.
const ROUTE_BY_KIND: Record<string, string> = {
  pipeline: PIPE_ROUTE, dataset: DS_ROUTE, dataflow: DF_ROUTE, notebook: NB_ROUTE,
  sqlscript: SQL_ROUTE, kqlscript: KQL_ROUTE, sparkjobdef: SJD_ROUTE,
  trigger: TRG_ROUTE, linkedservice: LS_ROUTE,
};
// Group kind → the create dialog it opens.
const GROUP_CREATE: Record<string, CreatableGroup> = {
  'group-pipelines': 'pipeline', 'group-datasets': 'dataset', 'group-dataflows': 'dataflow',
  'group-notebooks': 'notebook', 'group-sqlscripts': 'sqlscript', 'group-kqlscripts': 'kqlscript',
  'group-sparkjobdefs': 'sparkjobdef', 'group-triggers': 'trigger',
};

export interface SynapseWorkspaceTreeProps {
  /** The currently bound pipeline name (highlighted in the tree). */
  boundPipeline: string | null;
  /** Open / bind a pipeline on the canvas (existing flow). */
  onOpenPipeline: (name: string) => void;
  /** Open the KQL-script editor for a workspace KQL script artifact. */
  onOpenKqlScript?: (name: string) => void;
  /** Open the Spark-job-definition editor for a workspace SJD artifact. */
  onOpenSparkJobDef?: (name: string) => void;
  /** Increment to force a refresh from the parent (e.g. after a bind/create). */
  refreshKey?: number;
}

/**
 * A typed, Synapse-Studio-faithful Workspace Resources navigator over the shared
 * SC-7 ExplorerTree.
 */
export function SynapseWorkspaceTree({
  boundPipeline, onOpenPipeline, onOpenKqlScript, onOpenSparkJobDef, refreshKey = 0,
}: SynapseWorkspaceTreeProps) {
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pipelines, setPipelines] = useState<NamedRow[]>([]);
  const [datasets, setDatasets] = useState<NamedRow[]>([]);
  const [dataflows, setDataflows] = useState<NamedRow[]>([]);
  const [notebooks, setNotebooks] = useState<NamedRow[]>([]);
  const [sqlScripts, setSqlScripts] = useState<NamedRow[]>([]);
  const [kqlScripts, setKqlScripts] = useState<Array<{ name: string; pool?: string; database?: string }>>([]);
  const [sparkJobDefs, setSparkJobDefs] = useState<Array<{ name: string; pool?: string; language?: string }>>([]);
  const [triggers, setTriggers] = useState<Array<{ name: string; type?: string; runtimeState?: string }>>([]);
  const [linkedServices, setLinkedServices] = useState<NamedRow[]>([]);
  const [sparkPools, setSparkPools] = useState<Array<{ name: string; nodeSize?: string; sparkVersion?: string; state?: string }>>([]);
  const [sqlPools, setSqlPools] = useState<Array<{ name: string; status?: string; sku?: string }>>([]);

  const [busy, setBusy] = useState(false);

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreatableGroup | null>(null);
  const [createName, setCreateName] = useState('');
  const [createDsType, setCreateDsType] = useState('DelimitedText');
  const [createDsLinkedService, setCreateDsLinkedService] = useState('');
  const [createSjdPool, setCreateSjdPool] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pr, dr, fr, nr, qr, tr, lr, plr, kr, sjr] = await Promise.all([
        fetch(PIPE_ROUTE).then(readJson),
        fetch(DS_ROUTE).then(readJson),
        fetch(DF_ROUTE).then(readJson),
        fetch(NB_ROUTE).then(readJson),
        fetch(SQL_ROUTE).then(readJson),
        fetch(TRG_ROUTE).then(readJson),
        fetch(LS_ROUTE).then(readJson),
        fetch(POOLS_ROUTE).then(readJson),
        fetch(KQL_ROUTE).then(readJson),
        fetch(SJD_ROUTE).then(readJson),
      ]);
      // Any route reporting not_configured gates the whole tree (same workspace).
      for (const b of [pr, dr, fr, nr, qr, tr, lr, plr, kr, sjr]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (pr.ok) setPipelines(pr.pipelines || []); else setError(pr.error || 'failed to list pipelines');
      if (dr.ok) setDatasets(dr.datasets || []);
      if (fr.ok) setDataflows(fr.dataflows || []);
      if (nr.ok) setNotebooks(nr.notebooks || []);
      if (qr.ok) setSqlScripts(qr.sqlScripts || []);
      if (tr.ok) setTriggers(tr.triggers || []);
      if (lr.ok) setLinkedServices(lr.linkedServices || []);
      if (plr.ok) { setSparkPools(plr.sparkPools || []); setSqlPools(plr.sqlPools || []); }
      if (kr.ok) setKqlScripts(kr.kqlScripts || []);
      if (sjr.ok) setSparkJobDefs(sjr.sparkJobDefinitions || []);
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
    setCreateSjdPool(sparkPools[0]?.name || '');
  }, [linkedServices, sparkPools]);

  const submitCreate = useCallback(async () => {
    if (!createGroup || !createName.trim()) return;
    setBusy(true); setCreateError(null);
    const name = createName.trim();
    try {
      let route = PIPE_ROUTE; let payload: any = { name };
      if (createGroup === 'pipeline') { route = PIPE_ROUTE; payload = { name }; }
      else if (createGroup === 'dataflow') { route = DF_ROUTE; payload = { name }; }
      else if (createGroup === 'notebook') { route = NB_ROUTE; payload = { name }; }
      else if (createGroup === 'sqlscript') { route = SQL_ROUTE; payload = { name }; }
      else if (createGroup === 'trigger') { route = TRG_ROUTE; payload = { name }; }
      else if (createGroup === 'kqlscript') { route = KQL_ROUTE; payload = { name }; }
      else if (createGroup === 'sparkjobdef') {
        if (!createSjdPool) { setCreateError('Pick a Spark pool for the job definition (create one first).'); setBusy(false); return; }
        route = SJD_ROUTE; payload = { name, pool: createSjdPool };
      }
      else if (createGroup === 'dataset') {
        if (!createDsLinkedService) { setCreateError('Pick a linked service (create one first).'); setBusy(false); return; }
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
      // Creating a pipeline opens it straight away on the canvas (Synapse Studio behaviour).
      if (group === 'pipeline') onOpenPipeline(name);
      // KQL scripts + Spark job definitions open their editor on create.
      else if (group === 'kqlscript') onOpenKqlScript?.(name);
      else if (group === 'sparkjobdef') onOpenSparkJobDef?.(name);
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [createGroup, createName, createDsType, createDsLinkedService, createSjdPool, loadAll, onOpenPipeline, onOpenKqlScript, onOpenSparkJobDef]);

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
  // ExplorerTree wiring — nodes, per-node actions, open/dispatch
  // ---------------------------------------------------------------
  const onOpen = useCallback((node: ExplorerNode) => {
    if (node.kind === 'pipeline') onOpenPipeline(node.label);
    else if (node.kind === 'kqlscript') onOpenKqlScript?.(node.label);
    else if (node.kind === 'sparkjobdef') onOpenSparkJobDef?.(node.label);
  }, [onOpenPipeline, onOpenKqlScript, onOpenSparkJobDef]);

  const onAction = useCallback((key: string, node: ExplorerNode) => {
    if (key === 'new') { const g = GROUP_CREATE[node.kind]; if (g) openCreate(g); return; }
    if (key === 'open') { onOpen(node); return; }
    if (key === 'delete') { const r = ROUTE_BY_KIND[node.kind]; if (r) del(r, node.label); return; }
    if (key === 'start') { triggerLifecycle(node.label, 'start'); return; }
    if (key === 'stop') { triggerLifecycle(node.label, 'stop'); return; }
  }, [openCreate, onOpen, del, triggerLifecycle]);

  const actionsFor = useCallback((node: ExplorerNode): ExplorerAction[] => {
    const newAction = (label: string): ExplorerAction => ({ key: 'new', label, icon: <Add20Regular />, inline: true, disabled: busy });
    const deleteAction: ExplorerAction = { key: 'delete', label: 'Delete', icon: <Delete16Regular />, inline: true, destructive: true, disabled: busy };
    const openAction: ExplorerAction = { key: 'open', label: 'Open', icon: <Open16Regular />, inline: true };
    switch (node.kind) {
      case 'group-pipelines': return [newAction('New pipeline')];
      case 'group-datasets': return [newAction('New dataset')];
      case 'group-dataflows': return [newAction('New data flow')];
      case 'group-notebooks': return [newAction('New notebook')];
      case 'group-sqlscripts': return [newAction('New SQL script')];
      case 'group-kqlscripts': return [newAction('New KQL script')];
      case 'group-sparkjobdefs': return [newAction('New Spark job definition')];
      case 'group-triggers': return [newAction('New trigger')];
      case 'pipeline': return [openAction, deleteAction];
      case 'dataset': case 'dataflow': case 'notebook': case 'sqlscript': case 'linkedservice':
        return [deleteAction];
      case 'kqlscript': return [...(onOpenKqlScript ? [openAction] : []), deleteAction];
      case 'sparkjobdef': return [...(onOpenSparkJobDef ? [openAction] : []), deleteAction];
      case 'trigger': {
        const started = (node.data as { runtimeState?: string } | undefined)?.runtimeState === 'Started';
        const life: ExplorerAction = started
          ? { key: 'stop', label: 'Stop', icon: <Stop16Regular />, inline: true, disabled: busy }
          : { key: 'start', label: 'Start', icon: <Play16Regular />, inline: true, disabled: busy };
        return [life, deleteAction];
      }
      default: return [];
    }
  }, [busy, onOpenKqlScript, onOpenSparkJobDef]);

  const nodes = useMemo<ExplorerNode[]>(() => [
    {
      id: 'group-pipelines', label: 'Pipelines', kind: 'group-pipelines', meta: String(pipelines.length),
      children: pipelines.map((p) => ({
        id: `p-${p.name}`, label: p.name, kind: 'pipeline',
        emphasized: boundPipeline === p.name,
        meta: typeof p.activities === 'number' ? `${p.activities as number} act` : undefined,
        data: p,
      })),
    },
    {
      id: 'group-datasets', label: 'Datasets', kind: 'group-datasets', meta: String(datasets.length),
      children: datasets.map((d) => ({
        id: `d-${d.name}`, label: d.name, kind: 'dataset',
        meta: typeof d.type === 'string' ? (d.type as string) : undefined, data: d,
      })),
    },
    {
      id: 'group-dataflows', label: 'Data flows', kind: 'group-dataflows', meta: String(dataflows.length),
      children: dataflows.map((d) => ({
        id: `f-${d.name}`, label: d.name, kind: 'dataflow',
        meta: typeof d.type === 'string' ? (d.type as string).replace('DataFlow', '') : undefined, data: d,
      })),
    },
    {
      id: 'group-notebooks', label: 'Notebooks', kind: 'group-notebooks', meta: String(notebooks.length),
      children: notebooks.map((n) => ({
        id: `n-${n.name}`, label: n.name, kind: 'notebook',
        meta: typeof n.language === 'string' ? (n.language as string) : undefined, data: n,
      })),
    },
    {
      id: 'group-sqlscripts', label: 'SQL scripts', kind: 'group-sqlscripts', meta: String(sqlScripts.length),
      children: sqlScripts.map((q) => ({
        id: `q-${q.name}`, label: q.name, kind: 'sqlscript',
        meta: typeof q.pool === 'string' ? (q.pool as string) : undefined, data: q,
      })),
    },
    {
      id: 'group-kqlscripts', label: 'KQL scripts', kind: 'group-kqlscripts', meta: String(kqlScripts.length),
      children: kqlScripts.map((k) => ({
        id: `k-${k.name}`, label: k.name, kind: 'kqlscript',
        badge: k.pool ? { text: k.pool, appearance: 'outline' } : undefined, data: k,
      })),
    },
    {
      id: 'group-sparkjobdefs', label: 'Spark job definitions', kind: 'group-sparkjobdefs', meta: String(sparkJobDefs.length),
      children: sparkJobDefs.map((d) => ({
        id: `sj-${d.name}`, label: d.name, kind: 'sparkjobdef',
        meta: d.language, badge: d.pool ? { text: d.pool, appearance: 'outline' } : undefined, data: d,
      })),
    },
    {
      id: 'group-triggers', label: 'Triggers', kind: 'group-triggers', meta: String(triggers.length),
      children: triggers.map((t) => ({
        id: `t-${t.name}`, label: t.name, kind: 'trigger',
        badge: {
          text: t.runtimeState || '—',
          color: t.runtimeState === 'Started' ? 'success' : t.runtimeState === 'Stopped' ? 'informative' : 'warning',
        },
        data: t,
      })),
    },
    {
      id: 'group-linked', label: 'Linked services', kind: 'group-linked', meta: String(linkedServices.length),
      children: linkedServices.map((l) => ({
        id: `l-${l.name}`, label: l.name, kind: 'linkedservice',
        meta: typeof l.type === 'string' ? (l.type as string) : undefined, data: l,
      })),
    },
    {
      id: 'group-spark', label: 'Spark pools', kind: 'group-spark', meta: String(sparkPools.length),
      children: sparkPools.map((p) => ({
        id: `sp-${p.name}`, label: p.name, kind: 'sparkpool',
        meta: [p.nodeSize, p.sparkVersion ? `Spark ${p.sparkVersion}` : ''].filter(Boolean).join(' · ') || undefined,
        badge: p.state ? { text: p.state, appearance: 'tint', color: p.state === 'Succeeded' ? 'success' : 'informative' } : undefined,
        data: p,
      })),
    },
    {
      id: 'group-sqlpools', label: 'SQL pools', kind: 'group-sqlpools', meta: String(sqlPools.length),
      children: sqlPools.map((p) => ({
        id: `dp-${p.name}`, label: p.name, kind: 'sqlpool',
        meta: p.sku, badge: p.status ? { text: p.status, appearance: 'tint', color: p.status === 'Online' ? 'success' : p.status === 'Paused' ? 'informative' : 'warning' } : undefined,
        data: p,
      })),
    },
    {
      // Honest node — Synapse Studio exposes dedicated-SQL-pool authoring; we
      // list pools read-only here and author them in the scaling editor.
      id: 'group-notwired', label: 'Not yet wired', kind: 'group-notwired',
      children: [{
        id: 'nw-dedicated-sql', label: 'Dedicated SQL pool authoring', kind: 'notwired',
        meta: 'authored in the Synapse scaling editor',
        badge: { text: 'coming', appearance: 'tint', color: 'warning' },
      }],
    },
  ], [pipelines, datasets, dataflows, notebooks, sqlScripts, kqlScripts, sparkJobDefs, triggers, linkedServices, sparkPools, sqlPools, boundPipeline]);

  const headerMenu = (
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
          <MenuItem icon={<Notebook20Regular />} onClick={() => openCreate('notebook')}>Notebook</MenuItem>
          <MenuItem icon={<DocumentText20Regular />} onClick={() => openCreate('sqlscript')}>SQL script</MenuItem>
          <MenuItem icon={<DatabaseArrowRight20Regular />} onClick={() => openCreate('kqlscript')}>KQL script</MenuItem>
          <MenuItem icon={<AppsListDetail20Regular />} onClick={() => openCreate('sparkjobdef')}>Spark job definition</MenuItem>
          <MenuItem icon={<DocumentTable20Regular />} onClick={() => openCreate('dataset')}>Dataset</MenuItem>
          <MenuItem icon={<Clock20Regular />} onClick={() => openCreate('trigger')}>Trigger</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );

  const gateContent = gate ? (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>Synapse workspace not configured</MessageBarTitle>
        Set <code>{gate.missing}</code> so the Loom console can reach a real Azure Synapse
        workspace (the artifacts data plane at <code>&lt;workspace&gt;.dev.azuresynapse.net</code>).
        The navigator stays here; resources appear once the workspace is reachable. The Loom UAMI
        needs the <strong>Synapse Artifact Publisher</strong> (or <strong>Synapse Administrator</strong>)
        Synapse-RBAC role on that workspace.
      </MessageBarBody>
    </MessageBar>
  ) : undefined;

  return (
    <>
      <ExplorerTree
        nodes={nodes}
        title="Workspace Resources"
        iconFor={iconForSynapseNode}
        actionsFor={actionsFor}
        onAction={onAction}
        onOpen={onOpen}
        headerActions={headerMenu}
        onRefresh={loadAll}
        loading={loading}
        error={error}
        gate={gateContent}
        ariaLabel="Workspace resources"
        emptyLabel="No resources"
        filterPlaceholder="Filter resources by name"
        defaultOpenIds={['group-pipelines']}
      />

      {/* Create dialog (pipeline / dataflow / notebook / sqlscript / trigger / dataset) */}
      <Dialog open={createGroup !== null} onOpenChange={(_, d) => { if (!d.open) setCreateGroup(null); }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'pipeline' ? 'pipeline'
                : createGroup === 'dataflow' ? 'data flow'
                : createGroup === 'notebook' ? 'notebook'
                : createGroup === 'sqlscript' ? 'SQL script'
                : createGroup === 'kqlscript' ? 'KQL script'
                : createGroup === 'sparkjobdef' ? 'Spark job definition'
                : createGroup === 'dataset' ? 'dataset' : 'trigger'}
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
                      placeholder={linkedServices.length ? 'Select a linked service' : 'No linked services — create one first'}
                      value={createDsLinkedService} selectedOptions={createDsLinkedService ? [createDsLinkedService] : []}
                      onOptionSelect={(_, d) => setCreateDsLinkedService(d.optionValue || '')}
                      disabled={!linkedServices.length}
                    >
                      {linkedServices.map((l) => <Option key={l.name} value={l.name} text={l.name}>{l.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    Refine location/format and schema after creation.
                  </Caption1>
                </>
              )}
              {createGroup === 'dataflow' && (
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                  Creates an empty Mapping Data Flow. Edit the data flow definition — add sources,
                  transformations, and sinks — in the data flow JSON editor.
                </Caption1>
              )}
              {createGroup === 'notebook' && (
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                  Creates an empty PySpark notebook (nbformat 4). Attach a Spark pool and add cells in the
                  notebook editor.
                </Caption1>
              )}
              {createGroup === 'sqlscript' && (
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                  Creates an empty SQL script targeting the built-in serverless SQL pool. Edit and run it in
                  the SQL script editor.
                </Caption1>
              )}
              {createGroup === 'kqlscript' && (
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                  Creates an empty KQL script. Pick a Synapse Data Explorer (Kusto) pool + database in the
                  editor, then write and run KQL against it.
                </Caption1>
              )}
              {createGroup === 'sparkjobdef' && (
                <Field label="Spark pool" required style={{ marginTop: tokens.spacingVerticalS }}>
                  <Dropdown
                    placeholder={sparkPools.length ? 'Select a Spark pool' : 'No Spark pools — provision one first'}
                    value={createSjdPool} selectedOptions={createSjdPool ? [createSjdPool] : []}
                    onOptionSelect={(_, d) => setCreateSjdPool(d.optionValue || '')}
                    disabled={!sparkPools.length}
                  >
                    {sparkPools.map((p) => <Option key={p.name} value={p.name} text={p.name}>{p.name}{p.sparkVersion ? ` · Spark ${p.sparkVersion}` : ''}</Option>)}
                  </Dropdown>
                </Field>
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
              <Button appearance="primary" onClick={submitCreate} disabled={busy || !createName.trim() || (createGroup === 'sparkjobdef' && !createSjdPool)}>{busy ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
