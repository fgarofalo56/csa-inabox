'use client';

/**
 * DatabricksWorkspaceTree — the Databricks-workspace "Workspace" navigator.
 *
 * The Databricks equivalent of the ADF Factory Resources / Synapse Workspace
 * Resources panes. Once the Databricks workspace is known (env-pinned
 * LOOM_DATABRICKS_HOSTNAME), the editor's left pane becomes this typed
 * navigator: one group per workspace object type with a live count and a ＋ New
 * affordance, a "Filter resources by name" box, and a top "Add new" menu —
 * collapsing the Databricks left sidebar (Workspace / Jobs / Compute / SQL
 * Warehouses / Repos / Catalog) into one tree.
 *
 * Every count comes from a real Databricks REST list call; every create/delete/
 * lifecycle hits the real Databricks REST through the workspace-level BFF routes:
 *   - Jobs           → /api/databricks/jobs        (list / run-now / delete; ＋New opens the Job editor)
 *   - Notebooks      → /api/databricks/notebooks    (list / import / mkdirs / delete)
 *   - Clusters       → /api/databricks/clusters     (list / create / start / restart / terminate)
 *   - SQL Warehouses → /api/databricks/warehouses   (list / create / start / stop / delete)
 *   - Repos          → /api/databricks/repos        (list / create / delete)
 *   - Unity Catalog  → /api/databricks/catalogs     (read-only catalogs list)
 *
 * Things the Databricks UI exposes but we don't yet wire (DLT pipelines, MLflow
 * experiments/models, Dashboards/Queries/Alerts, Serving endpoints) render as
 * honest ⚠️ gate rows naming what's missing — never a fake list. No mocks.
 *
 * The workspace is the env-pinned default. When unconfigured the routes 503 and
 * the whole tree shows a single honest infra-gate MessageBar.
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
  Notebook20Regular, Server20Regular, Database20Regular, BranchFork20Regular,
  Play16Regular, Stop16Regular, Open16Regular, Flow20Regular,
  Search20Regular, Warning20Regular, FolderOpen20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, height: '100%', minWidth: 240 },
  header: { display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  leafRow: { display: 'flex', alignItems: 'center', gap: 4, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
});

const JOBS_ROUTE = '/api/databricks/jobs';
const NB_ROUTE = '/api/databricks/notebooks';
const CL_ROUTE = '/api/databricks/clusters';
const WH_ROUTE = '/api/databricks/warehouses';
const REPO_ROUTE = '/api/databricks/repos';
const CAT_ROUTE = '/api/databricks/catalogs';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface JobRow { job_id: number; name: string; tasks?: number; creator?: string }
interface NbRow { path: string; name: string; object_type: string; language?: string }
interface ClusterRow { cluster_id: string; name: string; state?: string; spark_version?: string; node_type_id?: string }
interface WarehouseRow { id: string; name: string; state?: string; cluster_size?: string; serverless?: boolean }
interface RepoRow { id: number; name: string; path?: string; provider?: string; branch?: string }
interface CatalogRow { name: string; type?: string; comment?: string }

type CreateGroup = 'notebook' | 'cluster' | 'warehouse' | 'repo';

function clusterColor(state?: string) {
  if (state === 'RUNNING') return 'success' as const;
  if (state === 'PENDING' || state === 'RESTARTING' || state === 'RESIZING') return 'warning' as const;
  return 'informative' as const;
}
function warehouseColor(state?: string) {
  if (state === 'RUNNING') return 'success' as const;
  if (state === 'STARTING' || state === 'STOPPING') return 'warning' as const;
  return 'informative' as const;
}

export interface DatabricksWorkspaceTreeProps {
  /** Currently selected job (highlighted in the tree). */
  selectedJobId?: number | null;
  /** Open / bind a saved job in the host editor. */
  onOpenJob?: (jobId: number) => void;
  /** Start a brand-new job in the host editor (Databricks jobs need ≥1 task — authored in the editor, not blind-created). */
  onNewJob?: () => void;
  /** Increment to force a refresh from the parent (e.g. after a save/create). */
  refreshKey?: number;
}

/**
 * A typed, Databricks-faithful Workspace navigator.
 */
export function DatabricksWorkspaceTree({
  selectedJobId = null, onOpenJob, onNewJob, refreshKey = 0,
}: DatabricksWorkspaceTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [notebooks, setNotebooks] = useState<NbRow[]>([]);
  const [clusters, setClusters] = useState<ClusterRow[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogRow[]>([]);

  const [nbPath] = useState('/Workspace');
  const [busy, setBusy] = useState(false);

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreateGroup | null>(null);
  const [createName, setCreateName] = useState('');
  const [createLang, setCreateLang] = useState('PYTHON');
  const [createSize, setCreateSize] = useState('X-Small');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoProvider, setRepoProvider] = useState('gitHub');
  const [createError, setCreateError] = useState<string | null>(null);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [jr, nr, cr, wr, rr, kr] = await Promise.all([
        fetch(JOBS_ROUTE).then(readJson),
        fetch(`${NB_ROUTE}?path=${encodeURIComponent(nbPath)}`).then(readJson),
        fetch(CL_ROUTE).then(readJson),
        fetch(WH_ROUTE).then(readJson),
        fetch(REPO_ROUTE).then(readJson),
        fetch(CAT_ROUTE).then(readJson),
      ]);
      for (const b of [jr, nr, cr, wr, rr, kr]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (jr.ok) setJobs(jr.jobs || []); else setError(jr.error || 'failed to list jobs');
      if (nr.ok) setNotebooks(nr.objects || []);
      if (cr.ok) setClusters(cr.clusters || []);
      if (wr.ok) setWarehouses(wr.warehouses || []);
      if (rr.ok) setRepos(rr.repos || []);
      if (kr.ok) setCatalogs(kr.catalogs || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [nbPath]);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  // ---------------------------------------------------------------
  // Create / delete / lifecycle (real REST)
  // ---------------------------------------------------------------
  const openCreate = useCallback((g: CreateGroup) => {
    setCreateGroup(g); setCreateName(''); setCreateError(null);
    setCreateLang('PYTHON'); setCreateSize('X-Small');
    setRepoUrl(''); setRepoProvider('gitHub');
  }, []);

  const submitCreate = useCallback(async () => {
    if (!createGroup) return;
    setBusy(true); setCreateError(null);
    try {
      let route = NB_ROUTE; let payload: any = {};
      if (createGroup === 'notebook') {
        if (!createName.trim()) { setCreateError('Name is required.'); setBusy(false); return; }
        route = NB_ROUTE; payload = { name: createName.trim(), path: nbPath, language: createLang };
      } else if (createGroup === 'cluster') {
        if (!createName.trim()) { setCreateError('Name is required.'); setBusy(false); return; }
        route = CL_ROUTE; payload = { name: createName.trim() };
      } else if (createGroup === 'warehouse') {
        if (!createName.trim()) { setCreateError('Name is required.'); setBusy(false); return; }
        route = WH_ROUTE; payload = { name: createName.trim(), cluster_size: createSize };
      } else if (createGroup === 'repo') {
        if (!repoUrl.trim()) { setCreateError('Remote Git URL is required.'); setBusy(false); return; }
        route = REPO_ROUTE; payload = { url: repoUrl.trim(), provider: repoProvider };
      }
      const res = await fetch(route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setCreateError(body.error || 'create failed'); setBusy(false); return; }
      setCreateGroup(null);
      await loadAll();
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [createGroup, createName, createLang, createSize, repoUrl, repoProvider, nbPath, loadAll]);

  const del = useCallback(async (route: string, query: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${route}?${query}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  const post = useCallback(async (route: string, payload: any) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'action failed'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fJobs = useMemo(() => jobs.filter((j) => match(j.name)), [jobs, f]);
  const fNotebooks = useMemo(() => notebooks.filter((n) => match(n.name)), [notebooks, f]);
  const fClusters = useMemo(() => clusters.filter((c) => match(c.name)), [clusters, f]);
  const fWarehouses = useMemo(() => warehouses.filter((w) => match(w.name)), [warehouses, f]);
  const fRepos = useMemo(() => repos.filter((r) => match(r.name)), [repos, f]);
  const fCatalogs = useMemo(() => catalogs.filter((c) => match(c.name)), [catalogs, f]);

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
        <div className={s.header}><span className={s.title}>Workspace</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Databricks workspace not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> on the Console Container App (e.g.{' '}
            <code>adb-7405613013893759.19.azuredatabricks.net</code>) so the Loom console can reach a
            real Azure Databricks workspace. The navigator stays here; objects appear once the
            workspace is reachable. The Loom UAMI must be a <strong>workspace user/admin</strong> (granted
            via the SCIM bootstrap) and hold the <strong>Contributor</strong> role on the workspace
            resource. Provisioned by{' '}
            <code>platform/fiab/bicep/modules/landing-zone/databricks*.bicep</code>.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Workspace</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="Add new" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="Add new" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Flow20Regular />} onClick={() => onNewJob?.()} disabled={!onNewJob}>Job</MenuItem>
                <MenuItem icon={<Notebook20Regular />} onClick={() => openCreate('notebook')}>Notebook</MenuItem>
                <MenuItem icon={<Server20Regular />} onClick={() => openCreate('cluster')}>Cluster</MenuItem>
                <MenuItem icon={<Database20Regular />} onClick={() => openCreate('warehouse')}>SQL Warehouse</MenuItem>
                <MenuItem icon={<BranchFork20Regular />} onClick={() => openCreate('repo')}>Repo (Git folder)</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadAll} disabled={loading} aria-label="Refresh workspace" />
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

      {loading && <div style={{ padding: 8 }}><Spinner size="tiny" label="Loading workspace…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Workspace error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree aria-label="Databricks workspace" defaultOpenItems={['g-jobs']}>
          {/* Jobs */}
          <TreeItem itemType="branch" value="g-jobs">
            {groupHeader('Jobs', <Flow20Regular />, jobs.length, onNewJob ? () => onNewJob() : undefined, 'New job (opens editor)')}
            <Tree>
              {fJobs.length === 0 && <TreeItem itemType="leaf" value="j-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No jobs'}</Caption1></TreeItemLayout></TreeItem>}
              {fJobs.map((j) => (
                <TreeItem key={j.job_id} itemType="leaf" value={`j-${j.job_id}`}>
                  <TreeItemLayout iconBefore={<Flow20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: onOpenJob ? 'pointer' : undefined, fontWeight: selectedJobId === j.job_id ? tokens.fontWeightSemibold : undefined }}
                        onClick={() => onOpenJob?.(j.job_id)}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onOpenJob) { e.preventDefault(); onOpenJob(j.job_id); } }}
                      >
                        {j.name}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {typeof j.tasks === 'number' && <Caption1>{j.tasks} task</Caption1>}
                        <Tooltip content="Run now" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy} onClick={() => post(JOBS_ROUTE, { jobId: j.job_id, action: 'run' })} aria-label={`Run ${j.name}`} /></Tooltip>
                        {onOpenJob && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenJob(j.job_id)} aria-label={`Open ${j.name}`} /></Tooltip>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(JOBS_ROUTE, `jobId=${j.job_id}`)} aria-label={`Delete ${j.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Notebooks / Workspace files */}
          <TreeItem itemType="branch" value="g-notebooks">
            {groupHeader('Notebooks', <Notebook20Regular />, notebooks.length, () => openCreate('notebook'), 'New notebook')}
            <Tree>
              {fNotebooks.length === 0 && <TreeItem itemType="leaf" value="n-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : `Empty (${nbPath})`}</Caption1></TreeItemLayout></TreeItem>}
              {fNotebooks.map((n) => {
                const isDir = n.object_type === 'DIRECTORY' || n.object_type === 'REPO';
                return (
                  <TreeItem key={n.path} itemType="leaf" value={`n-${n.path}`}>
                    <TreeItemLayout iconBefore={isDir ? <FolderOpen20Regular /> : <Notebook20Regular />}>
                      <span className={s.leafRow}>
                        <span>{n.name}</span>
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          {n.language && <Caption1>{n.language}</Caption1>}
                          {!isDir && <Caption1>{n.object_type}</Caption1>}
                          <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(NB_ROUTE, `path=${encodeURIComponent(n.path)}${isDir ? '&recursive=true' : ''}`)} aria-label={`Delete ${n.name}`} /></Tooltip>
                        </span>
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                );
              })}
            </Tree>
          </TreeItem>

          {/* Clusters */}
          <TreeItem itemType="branch" value="g-clusters">
            {groupHeader('Clusters', <Server20Regular />, clusters.length, () => openCreate('cluster'), 'New cluster')}
            <Tree>
              {fClusters.length === 0 && <TreeItem itemType="leaf" value="c-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No clusters'}</Caption1></TreeItemLayout></TreeItem>}
              {fClusters.map((c) => {
                const running = c.state === 'RUNNING';
                return (
                  <TreeItem key={c.cluster_id} itemType="leaf" value={`c-${c.cluster_id}`}>
                    <TreeItemLayout iconBefore={<Server20Regular />}>
                      <span className={s.leafRow}>
                        <span>{c.name}</span>
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          <Badge size="small" appearance="filled" color={clusterColor(c.state)}>{c.state || '—'}</Badge>
                          {running
                            ? <Tooltip content="Terminate" relationship="label"><Button size="small" appearance="subtle" icon={<Stop16Regular />} disabled={busy} onClick={() => del(CL_ROUTE, `clusterId=${encodeURIComponent(c.cluster_id)}`)} aria-label={`Terminate ${c.name}`} /></Tooltip>
                            : <Tooltip content="Start" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy} onClick={() => post(CL_ROUTE, { clusterId: c.cluster_id, action: 'start' })} aria-label={`Start ${c.name}`} /></Tooltip>}
                          <Tooltip content="Delete (terminate)" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(CL_ROUTE, `clusterId=${encodeURIComponent(c.cluster_id)}`)} aria-label={`Delete ${c.name}`} /></Tooltip>
                        </span>
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                );
              })}
            </Tree>
          </TreeItem>

          {/* SQL Warehouses */}
          <TreeItem itemType="branch" value="g-warehouses">
            {groupHeader('SQL Warehouses', <Database20Regular />, warehouses.length, () => openCreate('warehouse'), 'New SQL warehouse')}
            <Tree>
              {fWarehouses.length === 0 && <TreeItem itemType="leaf" value="w-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No SQL warehouses'}</Caption1></TreeItemLayout></TreeItem>}
              {fWarehouses.map((w) => {
                const running = w.state === 'RUNNING';
                return (
                  <TreeItem key={w.id} itemType="leaf" value={`w-${w.id}`}>
                    <TreeItemLayout iconBefore={<Database20Regular />}>
                      <span className={s.leafRow}>
                        <span>{w.name}</span>
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          {w.cluster_size && <Caption1>{w.cluster_size}</Caption1>}
                          {w.serverless && <Badge size="small" appearance="outline">Serverless</Badge>}
                          <Badge size="small" appearance="filled" color={warehouseColor(w.state)}>{w.state || '—'}</Badge>
                          {running
                            ? <Tooltip content="Stop" relationship="label"><Button size="small" appearance="subtle" icon={<Stop16Regular />} disabled={busy} onClick={() => post(WH_ROUTE, { id: w.id, action: 'stop' })} aria-label={`Stop ${w.name}`} /></Tooltip>
                            : <Tooltip content="Start" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy} onClick={() => post(WH_ROUTE, { id: w.id, action: 'start' })} aria-label={`Start ${w.name}`} /></Tooltip>}
                          <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(WH_ROUTE, `id=${encodeURIComponent(w.id)}`)} aria-label={`Delete ${w.name}`} /></Tooltip>
                        </span>
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                );
              })}
            </Tree>
          </TreeItem>

          {/* Repos */}
          <TreeItem itemType="branch" value="g-repos">
            {groupHeader('Repos', <BranchFork20Regular />, repos.length, () => openCreate('repo'), 'New Git folder')}
            <Tree>
              {fRepos.length === 0 && <TreeItem itemType="leaf" value="r-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No Git folders'}</Caption1></TreeItemLayout></TreeItem>}
              {fRepos.map((r) => (
                <TreeItem key={r.id} itemType="leaf" value={`r-${r.id}`}>
                  <TreeItemLayout iconBefore={<BranchFork20Regular />}>
                    <span className={s.leafRow}>
                      <span>{r.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {r.branch && <Badge size="small" appearance="outline">{r.branch}</Badge>}
                        {r.provider && <Caption1>{r.provider}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(REPO_ROUTE, `id=${r.id}`)} aria-label={`Delete ${r.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Unity Catalog (read-only) */}
          <TreeItem itemType="branch" value="g-catalogs">
            {groupHeader('Unity Catalog', <Database20Regular />, catalogs.length, undefined)}
            <Tree>
              {fCatalogs.length === 0 && <TreeItem itemType="leaf" value="uc-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No catalogs'}</Caption1></TreeItemLayout></TreeItem>}
              {fCatalogs.map((c) => (
                <TreeItem key={c.name} itemType="leaf" value={`uc-${c.name}`}>
                  <TreeItemLayout iconBefore={<Database20Regular />}>
                    <span className={s.leafRow}>
                      <span>{c.name}</span>
                      <span className={s.leafActions}>
                        {c.type && <Badge size="small" appearance="tint">{c.type}</Badge>}
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Honest gate rows — Databricks exposes these; we don't wire them yet. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired</TreeItemLayout>
            <Tree>
              {[
                ['DLT pipelines', '/api/2.0/pipelines — Delta Live Tables pipeline list/create/start; data plane not wired yet.'],
                ['MLflow experiments & models', '/api/2.0/mlflow/* — experiments, registered models; not wired yet.'],
                ['Dashboards / Queries / Alerts', '/api/2.0/lakeview, /api/2.0/sql/queries|alerts — Databricks SQL authoring objects; not wired yet.'],
                ['Model serving endpoints', '/api/2.0/serving-endpoints — real-time model serving; not wired yet.'],
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

      {/* Create dialog (notebook / cluster / warehouse / repo) */}
      <Dialog open={createGroup !== null} onOpenChange={(_, d) => { if (!d.open) setCreateGroup(null); }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'notebook' ? 'notebook'
                : createGroup === 'cluster' ? 'cluster'
                : createGroup === 'warehouse' ? 'SQL warehouse'
                : 'Git folder'}
            </DialogTitle>
            <DialogContent>
              {createGroup !== 'repo' && (
                <Field label="Name" required>
                  <Input value={createName} onChange={(_, d) => setCreateName(d.value)} placeholder="my_resource" />
                </Field>
              )}
              {createGroup === 'notebook' && (
                <>
                  <Field label="Language" style={{ marginTop: 8 }}>
                    <Dropdown value={createLang} selectedOptions={[createLang]} onOptionSelect={(_, d) => setCreateLang(d.optionValue || 'PYTHON')}>
                      {['PYTHON', 'SQL', 'SCALA', 'R'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                    Imports an empty notebook at <code>{nbPath}/{createName || '<name>'}</code>. Add cells and
                    attach a cluster in the Databricks Notebook editor.
                  </Caption1>
                </>
              )}
              {createGroup === 'cluster' && (
                <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
                  Creates an autoscaling all-purpose cluster (1–4 workers, 30-min auto-terminate) using the
                  workspace default node type + latest LTS runtime. Tune node type / runtime / libraries in
                  the Databricks Cluster editor.
                </Caption1>
              )}
              {createGroup === 'warehouse' && (
                <Field label="Size" style={{ marginTop: 8 }}>
                  <Dropdown value={createSize} selectedOptions={[createSize]} onOptionSelect={(_, d) => setCreateSize(d.optionValue || 'X-Small')}>
                    {['2X-Small', 'X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large', '4X-Large'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                  </Dropdown>
                </Field>
              )}
              {createGroup === 'repo' && (
                <>
                  <Field label="Remote Git URL" required>
                    <Input value={repoUrl} onChange={(_, d) => setRepoUrl(d.value)} placeholder="https://github.com/org/repo.git" />
                  </Field>
                  <Field label="Provider" style={{ marginTop: 8 }}>
                    <Dropdown value={repoProvider} selectedOptions={[repoProvider]} onOptionSelect={(_, d) => setRepoProvider(d.optionValue || 'gitHub')}>
                      {['gitHub', 'gitLab', 'azureDevOpsServices', 'bitbucketCloud', 'gitHubEnterprise', 'bitbucketServer', 'gitLabEnterpriseEdition', 'awsCodeCommit'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                    Programmatic Git folders must link a remote repo. The workspace needs a Git credential
                    (PAT) configured for the provider, set in Databricks → Settings → Linked accounts.
                  </Caption1>
                </>
              )}
              {createError && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateGroup(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCreate} disabled={busy || (createGroup === 'repo' ? !repoUrl.trim() : !createName.trim())}>{busy ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
