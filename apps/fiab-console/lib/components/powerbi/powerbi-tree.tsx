'use client';

/**
 * PowerBiTree — the Power BI **workspace navigator** (parity wave 9).
 *
 * The Power BI equivalent of the ADF Factory Resources / Synapse Workspace /
 * Databricks Workspace / Cosmos navigators. Given a selected Power BI workspace
 * (groupId), the host editor's left pane becomes this typed Fluent v9 Tree:
 * one group per Power BI content type with a live count and inline actions —
 * collapsing the Power BI service left rail (Semantic models / Reports /
 * Dashboards / Dataflows) into one tree.
 *
 * Every count comes from a real Power BI REST list call; every action hits real
 * Power BI REST through the workspace-scoped BFF route family:
 *   - Semantic models → /api/powerbi/datasets    (list / Refresh now / open editor)
 *   - Reports         → /api/powerbi/reports      (list / open editor / delete)
 *   - Dashboards      → /api/powerbi/dashboards   (list / open editor)
 *   - Dataflows       → /api/powerbi/dataflows    (list / Refresh now / delete)
 *
 * Authoring (new report / new model) is **not faked** — it is honestly routed
 * to the existing Loom editors (the Report and Semantic Model editors do the
 * real authoring against Power BI REST). Deployment pipelines render as an
 * honest ⚠️ "coming" gate naming the REST that would wire them. No mocks.
 *
 * When the console can't authenticate (no UAMI / credential) the routes 503 and
 * the whole tree shows one honest infra-gate MessageBar. When Power BI returns
 * 401/403 (SP not authorized in the tenant / not a workspace member) the exact
 * remediation hint is surfaced verbatim.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, ArrowSync20Regular, Delete16Regular,
  Table20Regular, DocumentText20Regular, Board20Regular, Flow20Regular,
  Open16Regular, Search20Regular, Warning20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalS, height: '100%', minWidth: '260px' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  leafRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
});

const DATASETS = '/api/powerbi/datasets';
const REPORTS = '/api/powerbi/reports';
const DASHBOARDS = '/api/powerbi/dashboards';
const DATAFLOWS = '/api/powerbi/dataflows';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface DatasetRow { id: string; name: string; isRefreshable?: boolean; configuredBy?: string }
interface ReportRow { id: string; name: string; reportType?: string; webUrl?: string; datasetId?: string }
interface DashboardRow { id: string; displayName: string; webUrl?: string }
interface DataflowRow { objectId: string; name: string; description?: string; configuredBy?: string }

export interface PowerBiTreeProps {
  /** The Power BI workspace (groupId) to navigate. Empty = "pick a workspace" prompt. */
  workspaceId: string;
  /** Currently selected semantic model (highlighted). */
  selectedDatasetId?: string | null;
  /** Open / bind a saved semantic model in the host editor. */
  onOpenDataset?: (datasetId: string) => void;
  /** Start authoring a brand-new semantic model in the host editor (real Push-dataset builder). */
  onNewDataset?: () => void;
  /** Open a report (links to the Report editor, or opens the Power BI webUrl). */
  onOpenReport?: (report: ReportRow) => void;
  /** Open a dashboard (links to the Dashboard editor, or opens the webUrl). */
  onOpenDashboard?: (dashboard: DashboardRow) => void;
  /** Increment to force a refresh from the parent (e.g. after a save/create). */
  refreshKey?: number;
}

export function PowerBiTree({
  workspaceId,
  selectedDatasetId = null,
  onOpenDataset,
  onNewDataset,
  onOpenReport,
  onOpenDashboard,
  refreshKey = 0,
}: PowerBiTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string; detail: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [dashboards, setDashboards] = useState<DashboardRow[]>([]);
  const [dataflows, setDataflows] = useState<DataflowRow[]>([]);

  // Deployment pipelines are TENANT-scoped (not per-workspace) — lazy-loaded
  // when the user expands the "Deployment pipelines" node.
  interface PipelineRow { id: string; displayName: string; stages?: Array<{ order: number; workspaceName?: string }> }
  const [pipelines, setPipelines] = useState<PipelineRow[] | null>(null);
  const [pipelinesErr, setPipelinesErr] = useState<string | null>(null);
  const loadPipelines = useCallback(async () => {
    if (pipelines !== null) return; // load once
    try {
      const j = await fetch('/api/powerbi/pipelines').then(readJson);
      if (j.ok) { setPipelines(j.pipelines || []); setPipelinesErr(null); }
      else { setPipelines([]); setPipelinesErr(j.error || j.hint || 'could not load pipelines'); }
    } catch (e: any) { setPipelines([]); setPipelinesErr(e?.message || String(e)); }
  }, [pipelines]);
  const deployStage = useCallback(async (pipelineId: string, sourceStageOrder: number, label: string) => {
    setBusy(true); setActionMsg(null);
    try {
      const j = await fetch('/api/powerbi/pipelines', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipelineId, sourceStageOrder }),
      }).then(readJson);
      setActionMsg({ ok: !!j.ok, text: j.ok ? `${label}: ${j.message}` : (j.error || j.hint || 'deploy failed') });
    } catch (e: any) { setActionMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, []);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) {
      setGate({ missing: body.missing, detail: body.error || '' });
      return true;
    }
    return false;
  }

  const loadAll = useCallback(async () => {
    if (!workspaceId) {
      setDatasets([]); setReports([]); setDashboards([]); setDataflows([]);
      return;
    }
    setLoading(true); setError(null); setHint(null);
    try {
      const q = `?workspaceId=${encodeURIComponent(workspaceId)}`;
      const [dsr, rr, dbr, dfr] = await Promise.all([
        fetch(`${DATASETS}${q}`).then(readJson),
        fetch(`${REPORTS}${q}`).then(readJson),
        fetch(`${DASHBOARDS}${q}`).then(readJson),
        fetch(`${DATAFLOWS}${q}`).then(readJson),
      ]);
      for (const b of [dsr, rr, dbr, dfr]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      // Surface the first hard error (e.g. 401/403 SP-not-authorized) once.
      const firstErr = [dsr, rr, dbr, dfr].find((b) => b && b.ok === false);
      if (firstErr) { setError(firstErr.error || 'Power BI request failed'); setHint(firstErr.hint || null); }
      setDatasets(dsr.ok ? (dsr.datasets || []) : []);
      setReports(rr.ok ? (rr.reports || []) : []);
      setDashboards(dbr.ok ? (dbr.dashboards || []) : []);
      setDataflows(dfr.ok ? (dfr.dataflows || []) : []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  // --- actions (real Power BI REST) ---------------------------------------
  const refreshDataset = useCallback(async (id: string, name: string) => {
    setBusy(true); setActionMsg(null);
    try {
      const res = await fetch(DATASETS, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, id, action: 'refresh' }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setActionMsg({ ok: false, text: body.error || 'refresh failed' }); }
      else { setActionMsg({ ok: true, text: `Refresh queued for "${name}".` }); }
    } catch (e: any) { setActionMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [workspaceId]);

  const refreshDataflow = useCallback(async (id: string, name: string) => {
    setBusy(true); setActionMsg(null);
    try {
      const res = await fetch(DATAFLOWS, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, id, action: 'refresh' }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setActionMsg({ ok: false, text: body.error || 'refresh failed' }); }
      else { setActionMsg({ ok: true, text: `Refresh queued for dataflow "${name}".` }); }
    } catch (e: any) { setActionMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [workspaceId]);

  const del = useCallback(async (route: string, id: string, name: string) => {
    setBusy(true); setActionMsg(null);
    try {
      const res = await fetch(`${route}?workspaceId=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setActionMsg({ ok: false, text: body.error || 'delete failed' }); setBusy(false); return; }
      setActionMsg({ ok: true, text: `Deleted "${name}".` });
      await loadAll();
    } catch (e: any) { setActionMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [workspaceId, loadAll]);

  function openReport(r: ReportRow) {
    if (onOpenReport) { onOpenReport(r); return; }
    if (r.webUrl) { try { window.open(r.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ } }
  }
  function openDashboard(d: DashboardRow) {
    if (onOpenDashboard) { onOpenDashboard(d); return; }
    if (d.webUrl) { try { window.open(d.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ } }
  }

  // --- filtering ----------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fDatasets = useMemo(() => datasets.filter((d) => match(d.name)), [datasets, f]);
  const fReports = useMemo(() => reports.filter((r) => match(r.name)), [reports, f]);
  const fDashboards = useMemo(() => dashboards.filter((d) => match(d.displayName)), [dashboards, f]);
  const fDataflows = useMemo(() => dataflows.filter((d) => match(d.name)), [dataflows, f]);

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

  // --- config gate (whole tree) -------------------------------------------
  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>Workspace content</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Power BI not configured</MessageBarTitle>
            {gate.detail || (
              <>Set <code>{gate.missing}</code> so the Console can authenticate to Power BI.</>
            )}
            <br />
            Tenant bootstrap: <code>docs/fiab/v3-tenant-bootstrap.md</code>.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>Workspace content</span></div>
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Select a workspace</MessageBarTitle>
            Choose a Power BI workspace above to browse its semantic models, reports, dashboards and dataflows.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Workspace content</span>
        <span style={{ display: 'flex', gap: tokens.spacingHorizontalXXS }}>
          <Tooltip content="New semantic model (opens editor)" relationship="label">
            <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={() => onNewDataset?.()} disabled={!onNewDataset} aria-label="New semantic model" />
          </Tooltip>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadAll} disabled={loading} aria-label="Refresh workspace content" />
          </Tooltip>
        </span>
      </div>

      <Field>
        <Input
          size="small"
          contentBefore={<Search20Regular />}
          placeholder="Filter by name"
          value={filter}
          onChange={(_, d) => setFilter(d.value)}
        />
      </Field>

      {loading && <div style={{ padding: tokens.spacingVerticalS }}><Spinner size="tiny" label="Loading workspace content…" /></div>}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Power BI not reachable</MessageBarTitle>
            {error}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}
      {actionMsg && (
        <MessageBar intent={actionMsg.ok ? 'success' : 'error'}>
          <MessageBarBody>{actionMsg.text}</MessageBarBody>
        </MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree aria-label="Power BI workspace content" defaultOpenItems={['g-datasets', 'g-reports']}>
          {/* Semantic models (datasets) */}
          <TreeItem itemType="branch" value="g-datasets">
            {groupHeader('Semantic models', <Table20Regular />, datasets.length, onNewDataset ? () => onNewDataset() : undefined, 'New semantic model (opens editor)')}
            <Tree>
              {fDatasets.length === 0 && <TreeItem itemType="leaf" value="ds-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No semantic models'}</Caption1></TreeItemLayout></TreeItem>}
              {fDatasets.map((d) => (
                <TreeItem key={d.id} itemType="leaf" value={`ds-${d.id}`}>
                  <TreeItemLayout iconBefore={<Table20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: onOpenDataset ? 'pointer' : undefined, fontWeight: selectedDatasetId === d.id ? tokens.fontWeightSemibold : undefined }}
                        onClick={() => onOpenDataset?.(d.id)}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onOpenDataset) { e.preventDefault(); onOpenDataset(d.id); } }}
                      >
                        {d.name}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {d.isRefreshable === false && <Badge size="small" appearance="tint">read-only</Badge>}
                        <Tooltip content="Refresh now" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} disabled={busy || d.isRefreshable === false} onClick={() => refreshDataset(d.id, d.name)} aria-label={`Refresh ${d.name}`} /></Tooltip>
                        {onOpenDataset && <Tooltip content="Open in editor" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenDataset(d.id)} aria-label={`Open ${d.name}`} /></Tooltip>}
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Reports */}
          <TreeItem itemType="branch" value="g-reports">
            {groupHeader('Reports', <DocumentText20Regular />, reports.length, onOpenDataset ? () => onNewDataset?.() : undefined, undefined)}
            <Tree>
              {fReports.length === 0 && <TreeItem itemType="leaf" value="r-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No reports'}</Caption1></TreeItemLayout></TreeItem>}
              {fReports.map((r) => (
                <TreeItem key={r.id} itemType="leaf" value={`r-${r.id}`}>
                  <TreeItemLayout iconBefore={<DocumentText20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: 'pointer' }}
                        onClick={() => openReport(r)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReport(r); } }}
                      >
                        {r.name}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {r.reportType === 'PaginatedReport' && <Badge size="small" appearance="outline">Paginated</Badge>}
                        <Tooltip content="Open report" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openReport(r)} aria-label={`Open ${r.name}`} /></Tooltip>
                        <Tooltip content="Delete report" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(REPORTS, r.id, r.name)} aria-label={`Delete ${r.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Dashboards */}
          <TreeItem itemType="branch" value="g-dashboards">
            {groupHeader('Dashboards', <Board20Regular />, dashboards.length, undefined)}
            <Tree>
              {fDashboards.length === 0 && <TreeItem itemType="leaf" value="db-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No dashboards'}</Caption1></TreeItemLayout></TreeItem>}
              {fDashboards.map((d) => (
                <TreeItem key={d.id} itemType="leaf" value={`db-${d.id}`}>
                  <TreeItemLayout iconBefore={<Board20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: 'pointer' }}
                        onClick={() => openDashboard(d)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDashboard(d); } }}
                      >
                        {d.displayName}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="Open dashboard" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openDashboard(d)} aria-label={`Open ${d.displayName}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Dataflows */}
          <TreeItem itemType="branch" value="g-dataflows">
            {groupHeader('Dataflows', <Flow20Regular />, dataflows.length, undefined)}
            <Tree>
              {fDataflows.length === 0 && <TreeItem itemType="leaf" value="df-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No dataflows'}</Caption1></TreeItemLayout></TreeItem>}
              {fDataflows.map((d) => (
                <TreeItem key={d.objectId} itemType="leaf" value={`df-${d.objectId}`}>
                  <TreeItemLayout iconBefore={<Flow20Regular />}>
                    <span className={s.leafRow}>
                      <span>{d.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="Refresh now" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} disabled={busy} onClick={() => refreshDataflow(d.objectId, d.name)} aria-label={`Refresh ${d.name}`} /></Tooltip>
                        <Tooltip content="Delete dataflow" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(DATAFLOWS, d.objectId, d.name)} aria-label={`Delete ${d.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Honest gate rows — Power BI exposes these; authoring is routed to the
              real editors, deployment pipelines are not yet wired. Never faked. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>More in Power BI</TreeItemLayout>
            <Tree>
              {[
                ['New report authoring', 'Authored in the Loom Report editor (real Power BI REST: Reports/Clone, ExportTo, embed). Use New ＋ on a semantic model or the catalog Report editor.'],
                ['New / edit semantic model', 'Authored in the Loom Semantic Model editor (real Power BI Push-Datasets REST: tables, typed columns, measures, relationships, scheduled refresh). Use New ＋ above.'],
              ].map(([label, why]) => (
                <TreeItem key={label} itemType="leaf" value={`nw-${label}`}>
                  <Tooltip content={why} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{label}</span>{' '}
                      <Badge size="small" appearance="tint" color="informative">in editor</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Deployment pipelines — Dev/Test/Prod stage promotion (tenant-scoped,
              real Power BI REST). Lazy-loaded on expand. */}
          <TreeItem itemType="branch" value="g-pipelines" onOpenChange={(_e, d) => { if (d.open) void loadPipelines(); }}>
            <TreeItemLayout iconBefore={<Flow20Regular />}>Deployment pipelines</TreeItemLayout>
            <Tree>
              {pipelines === null ? (
                <TreeItem itemType="leaf" value="pl-loading"><TreeItemLayout><Caption1>Expand to load…</Caption1></TreeItemLayout></TreeItem>
              ) : pipelinesErr ? (
                <TreeItem itemType="leaf" value="pl-err"><TreeItemLayout iconBefore={<Warning20Regular />}><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{pipelinesErr}</Caption1></TreeItemLayout></TreeItem>
              ) : pipelines.length === 0 ? (
                <TreeItem itemType="leaf" value="pl-empty"><TreeItemLayout><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No deployment pipelines in this tenant.</Caption1></TreeItemLayout></TreeItem>
              ) : pipelines.map((p) => (
                <TreeItem key={p.id} itemType="branch" value={`pl-${p.id}`}>
                  <TreeItemLayout iconBefore={<Flow20Regular />}>{p.displayName}</TreeItemLayout>
                  <Tree>
                    {(p.stages || []).map((st) => {
                      const stageName = ['Development', 'Test', 'Production'][st.order] || `Stage ${st.order}`;
                      const canDeploy = st.order < 2; // 0→1, 1→2
                      return (
                        <TreeItem key={st.order} itemType="leaf" value={`pl-${p.id}-${st.order}`}>
                          <TreeItemLayout iconBefore={<Board20Regular />}>
                            <span className={s.leafRow}>
                              <span>{stageName}{st.workspaceName ? ` · ${st.workspaceName}` : ''}</span>
                              {canDeploy && (
                                <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                                  <Tooltip content={`Promote ${stageName} → ${['Development', 'Test', 'Production'][st.order + 1]}`} relationship="label">
                                    <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} disabled={busy}
                                      onClick={() => deployStage(p.id, st.order, `${p.displayName} ${stageName}→${['Development', 'Test', 'Production'][st.order + 1]}`)}
                                      aria-label={`Promote ${stageName}`} />
                                  </Tooltip>
                                </span>
                              )}
                            </span>
                          </TreeItemLayout>
                        </TreeItem>
                      );
                    })}
                  </Tree>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        </Tree>
      </div>
    </div>
  );
}
