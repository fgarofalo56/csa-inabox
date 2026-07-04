'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Databricks Cluster editor — extracted verbatim from
 * databricks-editors.tsx (behavior-preserving split — zero logic change).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Dropdown, Option,
  Combobox,
  Input, Field, Switch, Textarea, Tooltip, Divider,
  Tab, TabList,
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Stop20Regular,
  ArrowSync20Regular, Folder20Regular, Document20Regular,
  Save20Regular, Delete20Regular, Add20Regular, Key20Regular, Sparkle20Regular,
  Flowchart20Regular,
  DataBarVertical20Regular,
  TableAdd20Regular, Copy20Regular,
  Eye20Regular, MathFormula20Regular,
  ArrowDownload20Regular,
  Organization20Regular,
  Tag20Regular,
  CloudLink20Regular, PlugConnected20Regular,
  History20Regular, ShieldTask20Regular, Link20Regular,
  ArrowUpload20Regular, CloudArrowUp24Regular, Dismiss16Regular,
  BuildingShop20Regular, ShieldLock20Regular, People20Regular, Star20Regular,
} from '@fluentui/react-icons';
import { ModelViewPanel } from '../components/model-view-canvas';
import { ItemEditorChrome } from '../item-editor-chrome';
import { StatsMaintenanceDialog } from '../components/stats-maintenance-dialog';
import { WarehouseMonitoringTab } from '../components/warehouse-monitoring';
import { ConnectionDetailsPanel } from '../components/connection-details';
import { AiFunctionsHelper } from '../components/ai-functions-helper';
import { SqlObjectScriptMenu, SqlRowCountBadge } from '@/lib/components/sql-object-script-menu';
import { DatabricksWorkspaceTree } from '@/lib/components/databricks/databricks-workspace-tree';
import { UcLineagePanel } from '@/lib/components/databricks/uc-lineage-panel';
import { UcSecurityPanel } from '@/lib/panes/uc-security-panel';
import { PipelineDagView, type PipelineActivity } from '@/lib/components/pipeline/pipeline-dag-view';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { useSqlTabs, SqlTabBar, getRunSql } from '@/lib/components/editor/sql-editor-kit';
import { registerSqlIntelliSense, createEmptyCache, type SqlSchemaCache } from '@/lib/components/editor/sql-intellisense';
import { WarehouseAlerts } from '../components/warehouse-alerts';
import { SqlCopilotEditor } from '@/lib/components/editor/sql-copilot-editor';
import { VisualQueryCanvas, type VqSourceTable } from '../components/visual-query-canvas';
import { downloadResultsCsv, downloadResultsJson } from '../components/result-export';
import { CodeCell } from '@/lib/components/notebook/code-cell';
import { MarkdownCell } from '@/lib/components/notebook/markdown-cell';
import { CellAdder } from '@/lib/components/notebook/cell-adder';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { emptyCell } from '@/lib/types/notebook-cell';
import {
  parseSource, serializeCells, cellLangToCommandLanguage,
  type DbxBaseLanguage,
} from '../databricks-notebook-source';
import { QueryParamsBar, substituteDbx, type QueryParam } from '../components/query-params';
import { ResultVisualize } from '../components/result-visualize';
import { useStyles, clusterStateColor, fmtTime } from './shared';
import type { Cluster, ClusterLibrary } from './shared';

// ============================================================
// Databricks Cluster editor
// ============================================================

interface ClusterEvent {
  timestamp?: number;
  type?: string;
  details?: { reason?: { code?: string }; cause?: string; user?: string; current_num_workers?: number };
}

/** Reusable key/value rows editor — spark_conf, spark_env_vars, custom_tags. */
function KvEditor({ label, rows, setRows, kPlaceholder, vPlaceholder }: {
  label: string;
  rows: Array<{ key: string; value: string }>;
  setRows: (r: Array<{ key: string; value: string }>) => void;
  kPlaceholder?: string; vPlaceholder?: string;
}) {
  return (
    <Field label={label}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
            <Input style={{ flex: 1 }} placeholder={kPlaceholder} value={r.key}
              onChange={(_, d) => { const n = [...rows]; n[i] = { ...n[i], key: d.value }; setRows(n); }} />
            <Input style={{ flex: 1 }} placeholder={vPlaceholder} value={r.value}
              onChange={(_, d) => { const n = [...rows]; n[i] = { ...n[i], value: d.value }; setRows(n); }} />
            <Button appearance="subtle" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button appearance="secondary" size="small" style={{ alignSelf: 'flex-start' }}
          onClick={() => setRows([...rows, { key: '', value: '' }])}>+ Add</Button>
      </div>
    </Field>
  );
}

export function DatabricksClusterEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [clusterId, setClusterId] = useState<string | null>(null);
  const [cluster, setCluster] = useState<Cluster | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [sparkVersion, setSparkVersion] = useState('');
  const [autoscale, setAutoscale] = useState(true);
  const [minWorkers, setMinWorkers] = useState(2);
  const [maxWorkers, setMaxWorkers] = useState(8);
  const [numWorkers, setNumWorkers] = useState(2);
  const [autoterm, setAutoterm] = useState(60);

  // Advanced compute config — round-trips through ClusterSpec into clusters/create+edit.
  const [driverNodeType, setDriverNodeType] = useState('');
  const [accessMode, setAccessMode] = useState<'SINGLE_USER' | 'USER_ISOLATION' | 'LEGACY_SINGLE_USER' | ''>('');
  const [photon, setPhoton] = useState(false);
  const [spot, setSpot] = useState(false);
  const [sparkConf, setSparkConf] = useState<Array<{ key: string; value: string }>>([]);
  const [sparkEnv, setSparkEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [tags, setTags] = useState<Array<{ key: string; value: string }>>([]);
  const [initScripts, setInitScripts] = useState<Array<{ kind: 'workspace' | 'volumes' | 'dbfs'; dest: string }>>([]);
  // Library install form
  const [libType, setLibType] = useState<'pypi' | 'maven' | 'cran' | 'whl' | 'jar' | 'requirements'>('pypi');
  const [libCoord, setLibCoord] = useState('');
  const [libBusy, setLibBusy] = useState(false);
  const [libErr, setLibErr] = useState<string | null>(null);

  const [nodeTypes, setNodeTypes] = useState<{ node_type_id: string; description?: string }[]>([]);
  const [sparkVersions, setSparkVersions] = useState<{ key: string; name: string }[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [stateBusy, setStateBusy] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  const [events, setEvents] = useState<ClusterEvent[]>([]);
  const [libraries, setLibraries] = useState<ClusterLibrary[]>([]);
  const [librariesErr, setLibrariesErr] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'config' | 'libraries' | 'init' | 'events'>('config');

  const loadClusters = useCallback(async () => {
    try {
      const r = await clientFetch('/api/items/databricks-cluster');
      const j = await r.json();
      if (!j.ok) { setListError(j.error || `HTTP ${r.status}`); return; }
      setClusters(j.clusters || []);
    } catch (e: any) { setListError(e?.message || String(e)); }
  }, []);

  useEffect(() => {
    void loadClusters();
    void (async () => {
      const r = await clientFetch('/api/items/databricks-cluster/options');
      const j = await r.json();
      if (j.ok) {
        setNodeTypes(j.nodeTypes || []);
        setSparkVersions(j.sparkVersions || []);
        if (!nodeType && j.nodeTypes?.[0]) setNodeType(j.nodeTypes[0].node_type_id);
        if (!sparkVersion && j.sparkVersions?.[0]) setSparkVersion(j.sparkVersions[0].key);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectCluster = useCallback(async (cid: string) => {
    setClusterId(cid);
    setSaveError(null);
    setStateError(null);
    setSaveMessage(null);
    try {
      const r = await clientFetch(`/api/items/databricks-cluster/${id}?clusterId=${encodeURIComponent(cid)}`);
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
      const c = j.cluster as Cluster;
      setCluster(c);
      setName(c.cluster_name || '');
      setNodeType(c.node_type_id || '');
      setSparkVersion(c.spark_version || '');
      if (c.autoscale) {
        setAutoscale(true);
        setMinWorkers(c.autoscale.min_workers || 2);
        setMaxWorkers(c.autoscale.max_workers || 8);
      } else {
        setAutoscale(false);
        setNumWorkers(c.num_workers || 2);
      }
      setAutoterm(c.autotermination_minutes ?? 60);
      setDriverNodeType(c.driver_node_type_id || '');
      setAccessMode((c.data_security_mode as any) || '');
      setPhoton(c.runtime_engine === 'PHOTON');
      setSpot((c.azure_attributes?.availability || '').startsWith('SPOT'));
      setSparkConf(Object.entries(c.spark_conf || {}).map(([key, value]) => ({ key, value: String(value) })));
      setSparkEnv(Object.entries(c.spark_env_vars || {}).map(([key, value]) => ({ key, value: String(value) })));
      setTags(Object.entries(c.custom_tags || {}).map(([key, value]) => ({ key, value: String(value) })));
      setInitScripts((c.init_scripts || []).map((sc) => {
        if (sc.volumes?.destination) return { kind: 'volumes' as const, dest: sc.volumes.destination };
        if (sc.dbfs?.destination) return { kind: 'dbfs' as const, dest: sc.dbfs.destination };
        return { kind: 'workspace' as const, dest: sc.workspace?.destination || '' };
      }));
      // events
      const er = await clientFetch(`/api/items/databricks-cluster/${id}/events?clusterId=${encodeURIComponent(cid)}&limit=50`);
      const ej = await er.json();
      if (ej.ok) setEvents(ej.events || []);
      // v3.4 — libraries (read-only). Renders in the Libraries tab.
      setLibrariesErr(null);
      try {
        const lr = await clientFetch(`/api/items/databricks-cluster/${id}/libraries?clusterId=${encodeURIComponent(cid)}`);
        const lj = await lr.json();
        if (lj.ok) setLibraries(lj.libraries || []);
        else { setLibraries([]); setLibrariesErr(lj.error || `HTTP ${lr.status}`); }
      } catch (le: any) { setLibrariesErr(le?.message || String(le)); }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    }
  }, [id]);

  const buildSpec = useCallback(() => {
    const spec: any = {
      cluster_name: name || 'untitled-cluster',
      spark_version: sparkVersion,
      node_type_id: nodeType,
      autotermination_minutes: autoterm,
    };
    if (autoscale) spec.autoscale = { min_workers: minWorkers, max_workers: maxWorkers };
    else spec.num_workers = numWorkers;
    if (driverNodeType) spec.driver_node_type_id = driverNodeType;
    if (accessMode) spec.data_security_mode = accessMode;
    if (photon) spec.runtime_engine = 'PHOTON';
    if (spot) spec.azure_attributes = { availability: 'SPOT_WITH_FALLBACK_AZURE', first_on_demand: 1 };
    const conf = sparkConf.filter((r) => r.key.trim());
    if (conf.length) spec.spark_conf = Object.fromEntries(conf.map((r) => [r.key.trim(), r.value]));
    const env = sparkEnv.filter((r) => r.key.trim());
    if (env.length) spec.spark_env_vars = Object.fromEntries(env.map((r) => [r.key.trim(), r.value]));
    const t = tags.filter((r) => r.key.trim());
    if (t.length) spec.custom_tags = Object.fromEntries(t.map((r) => [r.key.trim(), r.value]));
    const inits = initScripts.filter((r) => r.dest.trim());
    if (inits.length) spec.init_scripts = inits.map((r) => ({ [r.kind]: { destination: r.dest.trim() } }));
    return spec;
  }, [name, sparkVersion, nodeType, autoscale, minWorkers, maxWorkers, numWorkers, autoterm,
      driverNodeType, accessMode, photon, spot, sparkConf, sparkEnv, tags, initScripts]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    // Phase 4.5 — call buildSpec before the await so any in-flight typing
    // during the request lands in the next save, not silently dropped.
    const spec = buildSpec();
    try {
      if (!clusterId) {
        const r = await clientFetch('/api/items/databricks-cluster', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        // Defensive parse — if the Container App / WAF returns HTML,
        // surface a useful message instead of throwing 'Unexpected
        // token <'.
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json().catch(() => null) : null;
        if (!j || !j.ok) {
          const rawErr = j?.error || (await r.text().catch(() => ''))?.slice(0, 240) || `HTTP ${r.status}`;
          // Specifically remediate the SCIM-entitlement gap. The cluster
          // editor's most common 403 is the Console UAMI lacking the
          // allow-cluster-create entitlement (see
          // platform/fiab/bicep/modules/landing-zone/databricks-scim-bootstrap.bicep
          // and docs/fiab/runbooks/databricks-cluster-create-permission.md).
          const looksLikePermDenied =
            /PERMISSION_DENIED/.test(rawErr) ||
            /not authorized to create clusters/i.test(rawErr) ||
            /allow-cluster-create/i.test(rawErr) ||
            r.status === 403;
          if (looksLikePermDenied) {
            setSaveError(
              "Databricks denied the create-cluster call (PERMISSION_DENIED). " +
              "The Loom Console UAMI was registered in the workspace without the " +
              "`allow-cluster-create` entitlement. Fix: re-run the SCIM bootstrap " +
              "deploymentScript via `azd up` (idempotent, takes ~2 min) — it now " +
              "PATCHes existing service principals with the full entitlement set " +
              "(workspace-access, databricks-sql-access, allow-cluster-create, " +
              "allow-instance-pool-create). Runbook: docs/fiab/runbooks/" +
              "databricks-cluster-create-permission.md"
            );
          } else {
            setSaveError(rawErr);
          }
          return;
        }
        setSaveMessage(`Created cluster ${j.cluster_id} at ${new Date().toLocaleTimeString()}`);
        await loadClusters();
        setClusterId(j.cluster_id);
        await selectCluster(j.cluster_id);
      } else {
        // Edit an existing cluster via POST /api/2.0/clusters/edit. Databricks
        // only allows edit while the cluster is RUNNING or TERMINATED; any
        // other state returns 400 INVALID_STATE, which we surface verbatim.
        const r = await clientFetch(`/api/items/databricks-cluster/${id}?clusterId=${encodeURIComponent(clusterId)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json().catch(() => null) : null;
        if (!j || !j.ok) {
          const rawErr = j?.error || (await r.text().catch(() => ''))?.slice(0, 240) || `HTTP ${r.status}`;
          if (/INVALID_STATE/i.test(rawErr) || /Clusters in state/i.test(rawErr)) {
            setSaveError(
              `Databricks rejected the edit: ${rawErr}. A cluster can only be edited while it is ` +
              `RUNNING or TERMINATED. Stop (terminate) the cluster, edit it, then Start — or edit ` +
              `while it is fully RUNNING.`,
            );
          } else {
            setSaveError(rawErr);
          }
          return;
        }
        setSaveMessage(`Saved cluster ${clusterId} at ${new Date().toLocaleTimeString()}`);
        await loadClusters();
        await selectCluster(clusterId);
      }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [id, clusterId, buildSpec, loadClusters, selectCluster]);

  const refreshLibraries = useCallback(async (cid: string) => {
    try {
      const lr = await clientFetch(`/api/items/databricks-cluster/${id}/libraries?clusterId=${encodeURIComponent(cid)}`);
      const lj = await lr.json();
      if (lj.ok) { setLibraries(lj.libraries || []); setLibrariesErr(null); }
      else setLibrariesErr(lj.error || `HTTP ${lr.status}`);
    } catch (le: any) { setLibrariesErr(le?.message || String(le)); }
  }, [id]);

  const libSpecFromForm = useCallback((): any | null => {
    const c = libCoord.trim();
    if (!c) return null;
    if (libType === 'pypi') return { pypi: { package: c } };
    if (libType === 'maven') return { maven: { coordinates: c } };
    if (libType === 'cran') return { cran: { package: c } };
    if (libType === 'whl') return { whl: c };
    if (libType === 'jar') return { jar: c };
    return { requirements: c };
  }, [libType, libCoord]);

  const installLibrary = useCallback(async () => {
    if (!clusterId) return;
    const lib = libSpecFromForm(); if (!lib) return;
    setLibBusy(true); setLibErr(null);
    try {
      const r = await clientFetch(`/api/items/databricks-cluster/${id}/libraries`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clusterId, libraries: [lib] }),
      });
      const j = await r.json();
      if (!j.ok) { setLibErr(j.error || `HTTP ${r.status}`); return; }
      setLibCoord('');
      await refreshLibraries(clusterId);
    } catch (e: any) { setLibErr(e?.message || String(e)); } finally { setLibBusy(false); }
  }, [id, clusterId, libSpecFromForm, refreshLibraries]);

  const uninstallLibrary = useCallback(async (lib: any) => {
    if (!clusterId) return;
    setLibBusy(true); setLibErr(null);
    try {
      const r = await clientFetch(`/api/items/databricks-cluster/${id}/libraries`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clusterId, libraries: [lib] }),
      });
      const j = await r.json();
      if (!j.ok) { setLibErr(j.error || `HTTP ${r.status}`); return; }
      await refreshLibraries(clusterId);
    } catch (e: any) { setLibErr(e?.message || String(e)); } finally { setLibBusy(false); }
  }, [id, clusterId, refreshLibraries]);

  const doState = useCallback(async (action: 'start' | 'stop' | 'restart') => {
    if (!clusterId) return;
    setStateBusy(true);
    setStateError(null);
    try {
      const r = await clientFetch(`/api/items/databricks-cluster/${id}/state?clusterId=${encodeURIComponent(clusterId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) setStateError(j.error || `HTTP ${r.status}`);
      else {
        // refresh
        await selectCluster(clusterId);
        await loadClusters();
      }
    } catch (e: any) { setStateError(e?.message || String(e)); }
    finally { setStateBusy(false); }
  }, [id, clusterId, selectCluster, loadClusters]);

  const del = useCallback(async () => {
    if (!clusterId) return;
    if (!window.confirm(`Permanently delete cluster ${clusterId}?`)) return;
    await clientFetch(`/api/items/databricks-cluster/${id}?clusterId=${encodeURIComponent(clusterId)}&permanent=true`, { method: 'DELETE' });
    setClusterId(null);
    setCluster(null);
    await loadClusters();
  }, [id, clusterId, loadClusters]);

  // Ctrl/Cmd+S to save when not already busy — works for both create
  // (clusterId === null → /clusters/create) and edit (existing cluster →
  // /clusters/edit), matching the family-wide muscle memory.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, save]);

  const state = cluster?.state || (clusterId ? 'UNKNOWN' : 'NEW');

  const canStartCluster = !!clusterId && !stateBusy && state !== 'RUNNING' && state !== 'PENDING';
  const canStopCluster = !!clusterId && !stateBusy && state !== 'TERMINATED' && state !== 'TERMINATING';
  const canRestartCluster = !!clusterId && !stateBusy && state === 'RUNNING';
  const ribbonCluster: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Cluster', actions: [
        { label: saving ? 'Saving…' : clusterId ? 'Save' : 'Create', onClick: saving ? undefined : save, disabled: saving },
        { label: 'Delete', onClick: clusterId ? del : undefined, disabled: !clusterId },
      ]},
      { label: 'State', actions: [
        { label: 'Start', onClick: canStartCluster ? () => doState('start') : undefined, disabled: !canStartCluster },
        { label: 'Stop', onClick: canStopCluster ? () => doState('stop') : undefined, disabled: !canStopCluster },
        { label: 'Restart', onClick: canRestartCluster ? () => doState('restart') : undefined, disabled: !canRestartCluster },
      ]},
    ]},
  ], [saving, clusterId, save, del, canStartCluster, canStopCluster, canRestartCluster, doState]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbonCluster}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXS }}>
            <Subtitle2 style={{ flex: 1 }}>Clusters ({clusters.length})</Subtitle2>
            <Button size="small" icon={<Add20Regular />} aria-label="New cluster" onClick={() => {
              setClusterId(null); setCluster(null); setName(''); setEvents([]);
              setSaveMessage(null); setSaveError(null);
            }} />
            <Button size="small" icon={<ArrowSync20Regular />} aria-label="Refresh cluster list" onClick={loadClusters} />
          </div>
          {listError && (
            <MessageBar intent="error"><MessageBarBody>{listError}</MessageBarBody></MessageBar>
          )}
          {clusters.map((c) => (
            <div
              key={c.cluster_id}
              role="button"
              tabIndex={0}
              aria-label={`Open cluster ${c.cluster_name || c.cluster_id}`}
              onClick={() => selectCluster(c.cluster_id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCluster(c.cluster_id); } }}
              style={{
                padding: tokens.spacingVerticalXS, cursor: 'pointer', borderRadius: tokens.borderRadiusMedium,
                background: clusterId === c.cluster_id ? tokens.colorNeutralBackground2Selected : undefined,
              }}
            >
              <Body1>{c.cluster_name || c.cluster_id}</Body1>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' }}>
                <Badge appearance="filled" color={clusterStateColor(c.state)} size="small">{c.state || '?'}</Badge>
                <Caption1>{c.node_type_id || '—'}</Caption1>
              </div>
            </div>
          ))}
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color={clusterStateColor(state)}>{state}</Badge>
            {cluster?.state_message && <Caption1>{cluster.state_message}</Caption1>}
            <Button appearance="primary" icon={<Save20Regular />} disabled={saving} onClick={save}>
              {saving ? 'Saving…' : clusterId ? 'Save changes' : 'Create'}
            </Button>
            {clusterId && (
              <>
                <Tooltip content={state === 'RUNNING' || state === 'PENDING' ? `Cluster is already ${state.toLowerCase()}` : 'Start the cluster (clusters/start)'} relationship="label">
                  <Button appearance="outline" icon={<Play20Regular />}
                    disabled={stateBusy || state === 'RUNNING' || state === 'PENDING'}
                    onClick={() => doState('start')}>Start</Button>
                </Tooltip>
                <Tooltip content={state === 'TERMINATED' || state === 'TERMINATING' ? `Cluster is already ${state.toLowerCase()}` : 'Terminate the cluster (clusters/delete)'} relationship="label">
                  <Button appearance="outline" icon={<Stop20Regular />}
                    disabled={stateBusy || state === 'TERMINATED' || state === 'TERMINATING'}
                    onClick={() => doState('stop')}>Stop</Button>
                </Tooltip>
                <Tooltip content={state !== 'RUNNING' ? 'Restart is only available while RUNNING' : 'Restart the cluster (clusters/restart)'} relationship="label">
                  <Button appearance="outline" icon={<ArrowSync20Regular />}
                    disabled={stateBusy || state !== 'RUNNING'}
                    onClick={() => doState('restart')}>Restart</Button>
                </Tooltip>
                <Button appearance="outline" icon={<Delete20Regular />} aria-label="Permanently delete cluster" onClick={del}>Delete</Button>
              </>
            )}
          </div>

          {saveError && <MessageBar intent="error"><MessageBarBody>
            <MessageBarTitle>Save failed</MessageBarTitle>{saveError}
          </MessageBarBody></MessageBar>}
          {stateError && <MessageBar intent="error"><MessageBarBody>
            <MessageBarTitle>State change failed</MessageBarTitle>{stateError}
          </MessageBarBody></MessageBar>}
          {saveMessage && <MessageBar intent="success"><MessageBarBody>{saveMessage}</MessageBarBody></MessageBar>}

          {clusterId && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Editing an existing cluster</MessageBarTitle>
                Change the name, node type, runtime, autoscale / workers, or autotermination, then click
                <strong> Save</strong> to call <code>POST /api/2.0/clusters/edit</code>. Databricks only allows
                edits while the cluster is <strong>RUNNING</strong> or <strong>TERMINATED</strong>; in any other
                state it returns INVALID_STATE.
              </MessageBarBody>
            </MessageBar>
          )}
          <Field label="Cluster name">
            <Input value={name} onChange={(_, d) => setName(d.value)} />
          </Field>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
            <Field label="Node type" style={{ flex: 1 }}>
              <Dropdown
                value={nodeType}
                selectedOptions={nodeType ? [nodeType] : []}
                onOptionSelect={(_, d) => d.optionValue && setNodeType(d.optionValue)}
              >
                {nodeTypes.slice(0, 80).map((n) => (
                  <Option key={n.node_type_id} value={n.node_type_id} text={n.node_type_id}>
                    {n.node_type_id}{n.description ? ` · ${n.description}` : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Spark version" style={{ flex: 1 }}>
              <Dropdown
                value={sparkVersions.find((v) => v.key === sparkVersion)?.name || sparkVersion}
                selectedOptions={sparkVersion ? [sparkVersion] : []}
                onOptionSelect={(_, d) => d.optionValue && setSparkVersion(d.optionValue)}
              >
                {sparkVersions.slice(0, 80).map((v) => (
                  <Option key={v.key} value={v.key} text={v.name}>{v.name}</Option>
                ))}
              </Dropdown>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end' }}>
            <Switch checked={autoscale} onChange={(_, d) => setAutoscale(!!d.checked)} label="Autoscale" />
            {autoscale ? (
              <>
                <Field label="Min workers">
                  <Input type="number" value={String(minWorkers)}
                    onChange={(_, d) => setMinWorkers(Number(d.value) || 1)} />
                </Field>
                <Field label="Max workers">
                  <Input type="number" value={String(maxWorkers)}
                    onChange={(_, d) => setMaxWorkers(Number(d.value) || 1)} />
                </Field>
              </>
            ) : (
              <Field label="Workers">
                <Input type="number" value={String(numWorkers)}
                  onChange={(_, d) => setNumWorkers(Number(d.value) || 1)} />
              </Field>
            )}
            <Field label="Autotermination (min)">
              <Input type="number" value={String(autoterm)}
                onChange={(_, d) => setAutoterm(Number(d.value) || 0)} />
            </Field>
          </div>

          <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Access mode" style={{ minWidth: 220 }}>
              <Dropdown
                value={accessMode || 'Workspace default'}
                selectedOptions={accessMode ? [accessMode] : []}
                onOptionSelect={(_, d) => setAccessMode((d.optionValue as any) || '')}
              >
                <Option value="" text="Workspace default">Workspace default</Option>
                <Option value="SINGLE_USER" text="Single user">Single user</Option>
                <Option value="USER_ISOLATION" text="Shared (isolation)">Shared (isolation)</Option>
                <Option value="LEGACY_SINGLE_USER" text="No isolation (legacy)">No isolation (legacy)</Option>
              </Dropdown>
            </Field>
            <Field label="Driver node type" style={{ minWidth: 220 }}>
              <Dropdown
                value={driverNodeType || 'Same as worker'}
                selectedOptions={driverNodeType ? [driverNodeType] : []}
                onOptionSelect={(_, d) => setDriverNodeType(d.optionValue || '')}
              >
                <Option value="" text="Same as worker">Same as worker</Option>
                {nodeTypes.slice(0, 80).map((n) => (
                  <Option key={n.node_type_id} value={n.node_type_id} text={n.node_type_id}>{n.node_type_id}</Option>
                ))}
              </Dropdown>
            </Field>
            <Switch checked={photon} onChange={(_, d) => setPhoton(!!d.checked)} label="Photon acceleration" />
            <Switch checked={spot} onChange={(_, d) => setSpot(!!d.checked)} label="Spot workers" />
          </div>

          <KvEditor label="Spark config" rows={sparkConf} setRows={setSparkConf} kPlaceholder="spark.databricks.x" vPlaceholder="value" />
          <KvEditor label="Environment variables" rows={sparkEnv} setRows={setSparkEnv} kPlaceholder="PYSPARK_PYTHON" vPlaceholder="/databricks/python3/bin/python" />
          <KvEditor label="Tags (cost allocation)" rows={tags} setRows={setTags} kPlaceholder="cost-center" vPlaceholder="data-eng" />

          {clusterId && (
            <>
              <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginTop: tokens.spacingVerticalM }}>
                <TabList selectedValue={detailTab} onTabSelect={(_, d) => setDetailTab(d.value as 'config' | 'libraries' | 'init' | 'events')}>
                  <Tab value="config">Spark config ({Object.keys(cluster?.spark_conf || {}).length})</Tab>
                  <Tab value="libraries">Libraries ({libraries.length})</Tab>
                  <Tab value="init">Init scripts ({(cluster?.init_scripts || []).length})</Tab>
                  <Tab value="events">Events ({events.length})</Tab>
                </TabList>
              </div>

              {detailTab === 'config' && (
                <>
                  {!cluster?.spark_conf || Object.keys(cluster.spark_conf).length === 0 ? (
                    <MessageBar intent="info"><MessageBarBody>No custom <code>spark_conf</code> keys on this cluster. Spark uses Databricks defaults.</MessageBarBody></MessageBar>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Spark config">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Key</TableHeaderCell>
                          <TableHeaderCell>Value</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {Object.entries(cluster.spark_conf).map(([k, v]) => (
                            <TableRow key={k}>
                              <TableCell><code style={{ fontSize: tokens.fontSizeBase200 }}>{k}</code></TableCell>
                              <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 }}>{v}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}

              {detailTab === 'libraries' && (
                <>
                  {librariesErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Library list failed</MessageBarTitle>{librariesErr}</MessageBarBody></MessageBar>}
                  {libErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Install/uninstall failed</MessageBarTitle>{libErr}</MessageBarBody></MessageBar>}
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Field label="Type" style={{ minWidth: 130 }}>
                      <Dropdown value={libType} selectedOptions={[libType]}
                        onOptionSelect={(_, d) => d.optionValue && setLibType(d.optionValue as any)}>
                        {['pypi', 'maven', 'cran', 'whl', 'jar', 'requirements'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label={libType === 'pypi' ? 'Package (e.g. scikit-learn==1.4.0)' : libType === 'maven' ? 'Coordinates (group:artifact:ver)' : 'Path / package'} style={{ flex: 1, minWidth: 240 }}>
                      <Input value={libCoord} onChange={(_, d) => setLibCoord(d.value)} placeholder={libType === 'whl' ? '/Volumes/main/default/wheels/x.whl' : 'name'} />
                    </Field>
                    <Button appearance="primary" disabled={libBusy || !libCoord.trim()} onClick={() => void installLibrary()}>Install</Button>
                  </div>
                  {libraries.length === 0 ? (
                    <Caption1>No libraries attached.</Caption1>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Cluster libraries">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Type</TableHeaderCell>
                          <TableHeaderCell>Coordinates / package</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Messages</TableHeaderCell>
                          <TableHeaderCell>Action</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {libraries.map((lib, i) => {
                            const l = lib.library || {};
                            const t = l.pypi ? 'pypi' : l.maven ? 'maven' : l.cran ? 'cran' : l.jar ? 'jar' : l.whl ? 'whl' : l.egg ? 'egg' : l.requirements ? 'requirements' : '?';
                            const coords = l.pypi?.package || l.maven?.coordinates || l.cran?.package || l.jar || l.whl || l.egg || l.requirements || '—';
                            return (
                              <TableRow key={i}>
                                <TableCell><Badge appearance="outline">{t}</Badge></TableCell>
                                <TableCell><code style={{ fontSize: tokens.fontSizeBase200 }}>{coords}</code></TableCell>
                                <TableCell><Badge appearance="filled" color={lib.status === 'INSTALLED' ? 'success' : lib.status === 'FAILED' ? 'danger' : 'warning'}>{lib.status || '—'}</Badge></TableCell>
                                <TableCell style={{ fontSize: tokens.fontSizeBase100 }}>{(lib.messages || []).join('; ') || '—'}</TableCell>
                                <TableCell><Button size="small" appearance="subtle" disabled={libBusy} onClick={() => void uninstallLibrary(lib.library)}>Uninstall</Button></TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}

              {detailTab === 'init' && (
                <>
                  <Caption1>Bootstrap scripts run on every node at startup. Add a path, then <strong>Save</strong> (cluster must be RUNNING or TERMINATED). Edits apply on next start.</Caption1>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                    {initScripts.map((sc, i) => (
                      <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                        <Dropdown style={{ minWidth: 120 }} value={sc.kind} selectedOptions={[sc.kind]}
                          onOptionSelect={(_, d) => { if (!d.optionValue) return; const n = [...initScripts]; n[i] = { ...n[i], kind: d.optionValue as any }; setInitScripts(n); }}>
                          {['workspace', 'volumes', 'dbfs'].map((k) => <Option key={k} value={k} text={k}>{k}</Option>)}
                        </Dropdown>
                        <Input style={{ flex: 1 }} placeholder="/Workspace/init/setup.sh" value={sc.dest}
                          onChange={(_, d) => { const n = [...initScripts]; n[i] = { ...n[i], dest: d.value }; setInitScripts(n); }} />
                        <Button appearance="subtle" onClick={() => setInitScripts(initScripts.filter((_, j) => j !== i))}>Remove</Button>
                      </div>
                    ))}
                    <Button appearance="secondary" size="small" style={{ alignSelf: 'flex-start' }}
                      onClick={() => setInitScripts([...initScripts, { kind: 'workspace', dest: '' }])}>+ Add init script</Button>
                  </div>
                </>
              )}

              {detailTab === 'events' && (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Cluster events">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Time</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Reason / cause</TableHeaderCell>
                      <TableHeaderCell>Workers</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {events.length === 0 && (
                        <TableRow><TableCell colSpan={4}><Caption1>No events.</Caption1></TableCell></TableRow>
                      )}
                      {events.map((e, i) => (
                        <TableRow key={i}>
                          <TableCell>{fmtTime(e.timestamp)}</TableCell>
                          <TableCell><Badge appearance="outline">{e.type || '—'}</Badge></TableCell>
                          <TableCell>{(e.details as any)?.reason?.code || (e.details as any)?.cause || '—'}</TableCell>
                          <TableCell>{(e.details as any)?.current_num_workers ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </div>
      }
    />
  );
}
