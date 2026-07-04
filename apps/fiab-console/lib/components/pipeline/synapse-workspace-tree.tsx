'use client';

/**
 * SynapseWorkspaceTree — the Synapse-Studio "Workspace Resources" navigator.
 *
 * The Synapse equivalent of the ADF Factory Resources pane. Once the Synapse
 * pipeline editor is open, its left pane becomes this typed navigator: one
 * group per workspace artifact type with a live count and a ＋ New affordance,
 * a "Filter resources by name" box, and a top "Add new resource" menu —
 * matching the Synapse Studio Develop / Integrate / Data / Manage hubs
 * collapsed into one tree.
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
 * as an honest ⚠️ gate row naming where it lives — never a fake list. No mocks.
 *
 * The workspace is the env-pinned default (LOOM_SYNAPSE_WORKSPACE). When
 * unconfigured the routes 503 and the whole tree shows a single honest
 * infra-gate MessageBar.
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
  Add20Regular, ArrowSync16Regular, Delete16Regular,
  Flow20Regular, DocumentTable20Regular, DataUsage20Regular, Clock20Regular,
  Link20Regular, Server20Regular, Play16Regular, Stop16Regular, Open16Regular,
  Search20Regular, Warning20Regular, Notebook20Regular, DocumentText20Regular,
  Database20Regular, DatabaseArrowRight20Regular, AppsListDetail20Regular,
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
 * A typed, Synapse-Studio-faithful Workspace Resources navigator.
 */
export function SynapseWorkspaceTree({
  boundPipeline, onOpenPipeline, onOpenKqlScript, onOpenSparkJobDef, refreshKey = 0,
}: SynapseWorkspaceTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
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
  // Filtering
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fPipelines = useMemo(() => pipelines.filter((p) => match(p.name)), [pipelines, f]);
  const fDatasets = useMemo(() => datasets.filter((d) => match(d.name)), [datasets, f]);
  const fDataflows = useMemo(() => dataflows.filter((d) => match(d.name)), [dataflows, f]);
  const fNotebooks = useMemo(() => notebooks.filter((n) => match(n.name)), [notebooks, f]);
  const fSqlScripts = useMemo(() => sqlScripts.filter((q) => match(q.name)), [sqlScripts, f]);
  const fKqlScripts = useMemo(() => kqlScripts.filter((q) => match(q.name)), [kqlScripts, f]);
  const fSparkJobDefs = useMemo(() => sparkJobDefs.filter((d) => match(d.name)), [sparkJobDefs, f]);
  const fTriggers = useMemo(() => triggers.filter((t) => match(t.name)), [triggers, f]);
  const fLinked = useMemo(() => linkedServices.filter((l) => match(l.name)), [linkedServices, f]);
  const fSparkPools = useMemo(() => sparkPools.filter((p) => match(p.name)), [sparkPools, f]);
  const fSqlPools = useMemo(() => sqlPools.filter((p) => match(p.name)), [sqlPools, f]);

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
        <div className={s.header}><span className={s.title}>Workspace Resources</span></div>
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
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Workspace Resources</span>
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
                <MenuItem icon={<Notebook20Regular />} onClick={() => openCreate('notebook')}>Notebook</MenuItem>
                <MenuItem icon={<DocumentText20Regular />} onClick={() => openCreate('sqlscript')}>SQL script</MenuItem>
                <MenuItem icon={<DatabaseArrowRight20Regular />} onClick={() => openCreate('kqlscript')}>KQL script</MenuItem>
                <MenuItem icon={<AppsListDetail20Regular />} onClick={() => openCreate('sparkjobdef')}>Spark job definition</MenuItem>
                <MenuItem icon={<DocumentTable20Regular />} onClick={() => openCreate('dataset')}>Dataset</MenuItem>
                <MenuItem icon={<Clock20Regular />} onClick={() => openCreate('trigger')}>Trigger</MenuItem>
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

      {loading && <div style={{ padding: tokens.spacingVerticalS }}><Spinner size="tiny" label="Loading workspace resources…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Workspace error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree aria-label="Workspace resources" defaultOpenItems={['g-pipelines']}>
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
                        {typeof d.type === 'string' && <Caption1>{d.type as string}</Caption1>}
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

          {/* Notebooks */}
          <TreeItem itemType="branch" value="g-notebooks">
            {groupHeader('Notebooks', <Notebook20Regular />, notebooks.length, () => openCreate('notebook'), 'New notebook')}
            <Tree>
              {fNotebooks.length === 0 && <TreeItem itemType="leaf" value="n-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No notebooks'}</Caption1></TreeItemLayout></TreeItem>}
              {fNotebooks.map((n) => (
                <TreeItem key={n.name} itemType="leaf" value={`n-${n.name}`}>
                  <TreeItemLayout iconBefore={<Notebook20Regular />}>
                    <span className={s.leafRow}>
                      <span>{n.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {typeof n.language === 'string' && <Caption1>{n.language as string}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(NB_ROUTE, n.name)} aria-label={`Delete ${n.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* SQL scripts */}
          <TreeItem itemType="branch" value="g-sqlscripts">
            {groupHeader('SQL scripts', <DocumentText20Regular />, sqlScripts.length, () => openCreate('sqlscript'), 'New SQL script')}
            <Tree>
              {fSqlScripts.length === 0 && <TreeItem itemType="leaf" value="q-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No SQL scripts'}</Caption1></TreeItemLayout></TreeItem>}
              {fSqlScripts.map((q) => (
                <TreeItem key={q.name} itemType="leaf" value={`q-${q.name}`}>
                  <TreeItemLayout iconBefore={<DocumentText20Regular />}>
                    <span className={s.leafRow}>
                      <span>{q.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {typeof q.pool === 'string' && <Caption1>{q.pool as string}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(SQL_ROUTE, q.name)} aria-label={`Delete ${q.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* KQL scripts */}
          <TreeItem itemType="branch" value="g-kqlscripts">
            {groupHeader('KQL scripts', <DatabaseArrowRight20Regular />, kqlScripts.length, () => openCreate('kqlscript'), 'New KQL script')}
            <Tree>
              {fKqlScripts.length === 0 && <TreeItem itemType="leaf" value="k-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No KQL scripts'}</Caption1></TreeItemLayout></TreeItem>}
              {fKqlScripts.map((k) => (
                <TreeItem key={k.name} itemType="leaf" value={`k-${k.name}`}>
                  <TreeItemLayout iconBefore={<DatabaseArrowRight20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0} style={{ cursor: onOpenKqlScript ? 'pointer' : undefined }}
                        onClick={() => onOpenKqlScript?.(k.name)}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onOpenKqlScript) { e.preventDefault(); onOpenKqlScript(k.name); } }}
                      >{k.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {k.pool && <Badge size="small" appearance="outline">{k.pool}</Badge>}
                        {onOpenKqlScript && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenKqlScript(k.name)} aria-label={`Open ${k.name}`} /></Tooltip>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(KQL_ROUTE, k.name)} aria-label={`Delete ${k.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Spark job definitions */}
          <TreeItem itemType="branch" value="g-sparkjobdefs">
            {groupHeader('Spark job definitions', <AppsListDetail20Regular />, sparkJobDefs.length, () => openCreate('sparkjobdef'), 'New Spark job definition')}
            <Tree>
              {fSparkJobDefs.length === 0 && <TreeItem itemType="leaf" value="sj-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No Spark job definitions'}</Caption1></TreeItemLayout></TreeItem>}
              {fSparkJobDefs.map((d) => (
                <TreeItem key={d.name} itemType="leaf" value={`sj-${d.name}`}>
                  <TreeItemLayout iconBefore={<AppsListDetail20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0} style={{ cursor: onOpenSparkJobDef ? 'pointer' : undefined }}
                        onClick={() => onOpenSparkJobDef?.(d.name)}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onOpenSparkJobDef) { e.preventDefault(); onOpenSparkJobDef(d.name); } }}
                      >{d.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {d.language && <Caption1>{d.language}</Caption1>}
                        {d.pool && <Badge size="small" appearance="outline">{d.pool}</Badge>}
                        {onOpenSparkJobDef && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenSparkJobDef(d.name)} aria-label={`Open ${d.name}`} /></Tooltip>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(SJD_ROUTE, d.name)} aria-label={`Delete ${d.name}`} /></Tooltip>
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

          {/* Linked services */}
          <TreeItem itemType="branch" value="g-linked">
            {groupHeader('Linked services', <Link20Regular />, linkedServices.length, undefined)}
            <Tree>
              {fLinked.length === 0 && <TreeItem itemType="leaf" value="l-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No linked services'}</Caption1></TreeItemLayout></TreeItem>}
              {fLinked.map((l) => (
                <TreeItem key={l.name} itemType="leaf" value={`l-${l.name}`}>
                  <TreeItemLayout iconBefore={<Link20Regular />}>
                    <span className={s.leafRow}>
                      <span>{l.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {typeof l.type === 'string' && <Caption1>{l.type as string}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(LS_ROUTE, l.name)} aria-label={`Delete ${l.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Spark pools (read-only from ARM) */}
          <TreeItem itemType="branch" value="g-spark">
            {groupHeader('Spark pools', <Server20Regular />, sparkPools.length, undefined)}
            <Tree>
              {fSparkPools.length === 0 && <TreeItem itemType="leaf" value="sp-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No Spark pools'}</Caption1></TreeItemLayout></TreeItem>}
              {fSparkPools.map((p) => (
                <TreeItem key={p.name} itemType="leaf" value={`sp-${p.name}`}>
                  <TreeItemLayout iconBefore={<Server20Regular />}>
                    <span className={s.leafRow}>
                      <span>{p.name}</span>
                      <span className={s.leafActions}>
                        {p.nodeSize && <Caption1>{p.nodeSize}</Caption1>}
                        {p.sparkVersion && <Badge size="small" appearance="outline">Spark {p.sparkVersion}</Badge>}
                        {p.state && <Badge size="small" appearance="tint" color={p.state === 'Succeeded' ? 'success' : 'informative'}>{p.state}</Badge>}
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* SQL pools (read-only from ARM) */}
          <TreeItem itemType="branch" value="g-sqlpools">
            {groupHeader('SQL pools', <Database20Regular />, sqlPools.length, undefined)}
            <Tree>
              {fSqlPools.length === 0 && <TreeItem itemType="leaf" value="dp-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No dedicated SQL pools'}</Caption1></TreeItemLayout></TreeItem>}
              {fSqlPools.map((p) => (
                <TreeItem key={p.name} itemType="leaf" value={`dp-${p.name}`}>
                  <TreeItemLayout iconBefore={<Database20Regular />}>
                    <span className={s.leafRow}>
                      <span>{p.name}</span>
                      <span className={s.leafActions}>
                        {p.sku && <Caption1>{p.sku}</Caption1>}
                        {p.status && <Badge size="small" appearance="tint" color={p.status === 'Online' ? 'success' : p.status === 'Paused' ? 'informative' : 'warning'}>{p.status}</Badge>}
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Honest gate rows — Synapse Studio exposes these; we don't wire them yet. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired</TreeItemLayout>
            <Tree>
              {[
                ['Dedicated SQL pool authoring', 'sqlPools create/scale/pause/resume — listed read-only here; authoring lives in the Synapse scaling editor (/api/admin/scaling/*).'],
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
    </div>
  );
}
