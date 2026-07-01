'use client';

/**
 * Databricks Job editor — extracted verbatim from
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
import { useStyles, runStateColor, fmtTime, fmtDuration } from './shared';
import type { Cluster, Warehouse, RunRow } from './shared';



// ============================================================
// Databricks Job editor
// ============================================================

// ------------------------------------------------------------
// Job task model — one-for-one with Databricks Jobs API 2.1/2.2 tasks[].
// Each task carries a task_key, a task-type payload, a compute binding
// (existing cluster or a new job cluster), optional run params, retries,
// timeout, run_if, and depends_on (the multi-task DAG).
// ------------------------------------------------------------
type JobTaskType =
  | 'notebook_task'
  | 'spark_python_task'
  | 'python_wheel_task'
  | 'spark_jar_task'
  | 'spark_submit_task'
  | 'sql_task'
  | 'dbt_task'
  | 'pipeline_task'
  | 'run_job_task';

const TASK_TYPE_LABELS: Record<JobTaskType, string> = {
  notebook_task: 'Notebook',
  spark_python_task: 'Python script',
  python_wheel_task: 'Python wheel',
  spark_jar_task: 'JAR',
  spark_submit_task: 'Spark Submit',
  sql_task: 'SQL',
  dbt_task: 'dbt',
  pipeline_task: 'Pipeline',
  run_job_task: 'Run Job',
};

interface JobTaskForm {
  task_key: string;
  task_type: JobTaskType;
  description: string;
  // Compute
  compute: 'existing' | 'new';
  existing_cluster_id: string;
  // new-job-cluster spec (used when compute === 'new')
  new_spark_version: string;
  new_node_type_id: string;
  new_num_workers: number;
  // depends_on
  depends_on: string[];        // upstream task_keys
  run_if: string;              // ALL_SUCCESS | AT_LEAST_ONE_SUCCESS | NONE_FAILED | ALL_DONE | AT_LEAST_ONE_FAILED | ALL_FAILED
  // reliability
  timeout_seconds: number;
  max_retries: number;
  min_retry_interval_millis: number;
  // type-specific fields
  notebook_path: string;
  notebook_params: string;     // k=v per line
  python_file: string;
  python_params: string;       // one arg per line
  wheel_package: string;
  wheel_entry_point: string;
  jar_main_class: string;
  jar_params: string;          // one arg per line
  spark_submit_params: string; // one arg per line
  sql_warehouse_id: string;
  sql_query_id: string;
  sql_file_path: string;
  dbt_commands: string;        // one command per line
  dbt_project_directory: string;
  pipeline_id: string;
  run_job_id: string;
}

function emptyTask(key: string): JobTaskForm {
  return {
    task_key: key,
    task_type: 'notebook_task',
    description: '',
    compute: 'existing',
    existing_cluster_id: '',
    new_spark_version: '',
    new_node_type_id: '',
    new_num_workers: 1,
    depends_on: [],
    run_if: 'ALL_SUCCESS',
    timeout_seconds: 0,
    max_retries: 0,
    min_retry_interval_millis: 0,
    notebook_path: '',
    notebook_params: '',
    python_file: '',
    python_params: '',
    wheel_package: '',
    wheel_entry_point: '',
    jar_main_class: '',
    jar_params: '',
    spark_submit_params: '',
    sql_warehouse_id: '',
    sql_query_id: '',
    sql_file_path: '',
    dbt_commands: '',
    dbt_project_directory: '',
    pipeline_id: '',
    run_job_id: '',
  };
}

// Parse "k=v" lines into a Record. Blank lines + lines without '=' are skipped.
function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
function serializeKv(rec?: Record<string, string>): string {
  if (!rec) return '';
  return Object.entries(rec).map(([k, v]) => `${k}=${v}`).join('\n');
}
// One-arg-per-(non-blank)-line → string[]
function parseLines(text: string): string[] {
  return (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

// Build the Databricks task[] payload entry from a form task.
function taskToSpec(t: JobTaskForm): Record<string, unknown> {
  const spec: Record<string, unknown> = { task_key: t.task_key };
  if (t.description) spec.description = t.description;
  if (t.compute === 'existing') {
    if (t.existing_cluster_id) spec.existing_cluster_id = t.existing_cluster_id;
  } else {
    spec.new_cluster = {
      spark_version: t.new_spark_version,
      node_type_id: t.new_node_type_id,
      num_workers: t.new_num_workers,
    };
  }
  if (t.depends_on.length > 0) {
    spec.depends_on = t.depends_on.map((k) => ({ task_key: k }));
    if (t.run_if && t.run_if !== 'ALL_SUCCESS') spec.run_if = t.run_if;
  }
  if (t.timeout_seconds > 0) spec.timeout_seconds = t.timeout_seconds;
  if (t.max_retries !== 0) {
    spec.max_retries = t.max_retries;
    if (t.min_retry_interval_millis > 0) spec.min_retry_interval_millis = t.min_retry_interval_millis;
  }
  switch (t.task_type) {
    case 'notebook_task':
      spec.notebook_task = {
        notebook_path: t.notebook_path,
        source: 'WORKSPACE',
        ...(t.notebook_params ? { base_parameters: parseKv(t.notebook_params) } : {}),
      };
      break;
    case 'spark_python_task':
      spec.spark_python_task = {
        python_file: t.python_file,
        ...(t.python_params ? { parameters: parseLines(t.python_params) } : {}),
      };
      break;
    case 'python_wheel_task':
      spec.python_wheel_task = {
        package_name: t.wheel_package,
        entry_point: t.wheel_entry_point,
        ...(t.python_params ? { parameters: parseLines(t.python_params) } : {}),
      };
      break;
    case 'spark_jar_task':
      spec.spark_jar_task = {
        main_class_name: t.jar_main_class,
        ...(t.jar_params ? { parameters: parseLines(t.jar_params) } : {}),
      };
      break;
    case 'spark_submit_task':
      spec.spark_submit_task = { parameters: parseLines(t.spark_submit_params) };
      break;
    case 'sql_task':
      spec.sql_task = {
        warehouse_id: t.sql_warehouse_id,
        ...(t.sql_query_id ? { query: { query_id: t.sql_query_id } } : {}),
        ...(t.sql_file_path ? { file: { path: t.sql_file_path, source: 'WORKSPACE' } } : {}),
      };
      break;
    case 'dbt_task':
      spec.dbt_task = {
        commands: parseLines(t.dbt_commands),
        ...(t.dbt_project_directory ? { project_directory: t.dbt_project_directory } : {}),
        ...(t.sql_warehouse_id ? { warehouse_id: t.sql_warehouse_id } : {}),
      };
      break;
    case 'pipeline_task':
      spec.pipeline_task = { pipeline_id: t.pipeline_id };
      break;
    case 'run_job_task':
      spec.run_job_task = { job_id: Number(t.run_job_id) || 0 };
      break;
  }
  return spec;
}

// Hydrate a form task from a Databricks task[] entry returned by jobs/get.
function specToTask(raw: any): JobTaskForm {
  const t = emptyTask(raw.task_key || 'task');
  t.description = raw.description || '';
  if (raw.new_cluster) {
    t.compute = 'new';
    t.new_spark_version = raw.new_cluster.spark_version || '';
    t.new_node_type_id = raw.new_cluster.node_type_id || '';
    t.new_num_workers = raw.new_cluster.num_workers ?? 1;
  } else {
    t.compute = 'existing';
    t.existing_cluster_id = raw.existing_cluster_id || '';
  }
  t.depends_on = (raw.depends_on || []).map((d: any) => d.task_key).filter(Boolean);
  t.run_if = raw.run_if || 'ALL_SUCCESS';
  t.timeout_seconds = raw.timeout_seconds ?? 0;
  t.max_retries = raw.max_retries ?? 0;
  t.min_retry_interval_millis = raw.min_retry_interval_millis ?? 0;
  if (raw.notebook_task) {
    t.task_type = 'notebook_task';
    t.notebook_path = raw.notebook_task.notebook_path || '';
    t.notebook_params = serializeKv(raw.notebook_task.base_parameters);
  } else if (raw.spark_python_task) {
    t.task_type = 'spark_python_task';
    t.python_file = raw.spark_python_task.python_file || '';
    t.python_params = (raw.spark_python_task.parameters || []).join('\n');
  } else if (raw.python_wheel_task) {
    t.task_type = 'python_wheel_task';
    t.wheel_package = raw.python_wheel_task.package_name || '';
    t.wheel_entry_point = raw.python_wheel_task.entry_point || '';
    t.python_params = (raw.python_wheel_task.parameters || []).join('\n');
  } else if (raw.spark_jar_task) {
    t.task_type = 'spark_jar_task';
    t.jar_main_class = raw.spark_jar_task.main_class_name || '';
    t.jar_params = (raw.spark_jar_task.parameters || []).join('\n');
  } else if (raw.spark_submit_task) {
    t.task_type = 'spark_submit_task';
    t.spark_submit_params = (raw.spark_submit_task.parameters || []).join('\n');
  } else if (raw.sql_task) {
    t.task_type = 'sql_task';
    t.sql_warehouse_id = raw.sql_task.warehouse_id || '';
    t.sql_query_id = raw.sql_task.query?.query_id || '';
    t.sql_file_path = raw.sql_task.file?.path || '';
  } else if (raw.dbt_task) {
    t.task_type = 'dbt_task';
    t.dbt_commands = (raw.dbt_task.commands || []).join('\n');
    t.dbt_project_directory = raw.dbt_task.project_directory || '';
    t.sql_warehouse_id = raw.dbt_task.warehouse_id || '';
  } else if (raw.pipeline_task) {
    t.task_type = 'pipeline_task';
    t.pipeline_id = raw.pipeline_task.pipeline_id || '';
  } else if (raw.run_job_task) {
    t.task_type = 'run_job_task';
    t.run_job_id = String(raw.run_job_task.job_id ?? '');
  }
  return t;
}

interface JobRow {
  job_id: number;
  settings?: {
    name?: string;
    schedule?: { quartz_cron_expression?: string; timezone_id?: string; pause_status?: string };
    continuous?: { pause_status?: string };
    trigger?: unknown;
    tasks?: any[];
    tags?: Record<string, string>;
    parameters?: Array<{ name: string; default: string }>;
    max_concurrent_runs?: number;
    timeout_seconds?: number;
    email_notifications?: { on_failure?: string[]; on_success?: string[]; on_start?: string[] };
  };
  creator_user_name?: string;
}

type TriggerType = 'none' | 'cron' | 'continuous' | 'file_arrival';

// Timezone ids the Databricks schedule UI offers (IANA / Joda zone ids).
// Mirrors the portal's timezone dropdown for cron schedules.
const SCHEDULE_TIMEZONES = [
  'UTC',
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

export function DatabricksJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobId, setJobId] = useState<number | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [creatorByJob, setCreatorByJob] = useState<Record<number, string>>({});
  // Bumped after a save/delete so the left Workspace navigator re-lists.
  const [navRefresh, setNavRefresh] = useState(0);

  // ---- Honest infra gate: which workspace will run jobs (LOOM_DATABRICKS_HOSTNAME) ----
  const [workspaceHost, setWorkspaceHost] = useState<string | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [gateHint, setGateHint] = useState<string | null>(null);

  // ---- Job-level settings ----
  const [name, setName] = useState('');
  const [tasks, setTasks] = useState<JobTaskForm[]>([emptyTask('main')]);
  const [activeTaskKey, setActiveTaskKey] = useState<string>('main');
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [jobTimeout, setJobTimeout] = useState(0);
  const [tagsText, setTagsText] = useState('');                 // k=v per line
  const [jobParamsText, setJobParamsText] = useState('');       // k=v per line (job_parameters defaults)
  const [emailOnFailure, setEmailOnFailure] = useState('');     // csv
  const [emailOnSuccess, setEmailOnSuccess] = useState('');     // csv

  // ---- Trigger / schedule ----
  const [triggerType, setTriggerType] = useState<TriggerType>('none');
  const [cron, setCron] = useState('0 0 2 * * ?');
  const [tz, setTz] = useState('UTC');
  const [paused, setPaused] = useState(false);
  const [fileArrivalUrl, setFileArrivalUrl] = useState('');

  // ---- Compute option sources (for new-job-cluster + existing pickers) ----
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [nodeTypes, setNodeTypes] = useState<{ node_type_id: string; description?: string }[]>([]);
  const [sparkVersions, setSparkVersions] = useState<{ key: string; name: string }[]>([]);
  // SQL Warehouses (for sql_task / dbt_task warehouse picker — real REST list).
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  // Notebook workspace browse (for notebook_task path picker)
  const [notebooks, setNotebooks] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<'tasks' | 'runs' | 'schedule' | 'settings' | 'json'>('tasks');

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // ---- Run output drawer ----
  const [outOpen, setOutOpen] = useState(false);
  const [outBusy, setOutBusy] = useState(false);
  const [outRunId, setOutRunId] = useState<number | null>(null);
  const [outData, setOutData] = useState<any>(null);
  const [outNote, setOutNote] = useState<string | null>(null);
  const [outError, setOutError] = useState<string | null>(null);

  const markDirty = useCallback(() => setDirty(true), []);

  const loadJobs = useCallback(async () => {
    try {
      const r = await fetch('/api/items/databricks-job');
      const j = await r.json();
      if (!j.ok) { setListError(j.error || `HTTP ${r.status}`); return; }
      setListError(null);
      setJobs(j.jobs || []);
      const cmap: Record<number, string> = {};
      for (const job of (j.jobs || []) as JobRow[]) {
        if (job.creator_user_name) cmap[job.job_id] = job.creator_user_name;
      }
      setCreatorByJob(cmap);
    } catch (e: any) { setListError(e?.message || String(e)); }
  }, []);

  useEffect(() => {
    void loadJobs();
    // workspace gate
    void (async () => {
      try {
        const r = await fetch('/api/databricks/workspace');
        const j = await r.json();
        if (j.ok) { setWorkspaceHost(j.workspace?.hostname || null); setGateError(null); }
        else { setGateError(j.error || `HTTP ${r.status}`); setGateHint(j.hint || null); }
      } catch (e: any) { setGateError(e?.message || String(e)); }
    })();
    // clusters
    void (async () => {
      const r = await fetch('/api/items/databricks-cluster');
      const j = await r.json();
      if (j.ok) setClusters(j.clusters || []);
    })();
    // compute options (spark versions + node types) for new job clusters
    void (async () => {
      const r = await fetch('/api/items/databricks-cluster/options');
      const j = await r.json();
      if (j.ok) { setNodeTypes(j.nodeTypes || []); setSparkVersions(j.sparkVersions || []); }
    })();
    // SQL warehouses (for sql_task / dbt_task warehouse picker). Optional —
    // a free-text fallback remains if the workspace has none / list fails.
    void (async () => {
      try {
        const r = await fetch('/api/databricks/warehouses');
        const j = await r.json();
        if (j.ok) {
          setWarehouses((j.warehouses || []).map((w: any) => ({ id: w.id, name: w.name || w.id })));
        }
      } catch { /* picker optional; free-text warehouse id still works */ }
    })();
    // notebooks under /Workspace for the notebook-task path picker
    void (async () => {
      try {
        const r = await fetch('/api/items/databricks-notebook/list?path=/Workspace');
        const j = await r.json();
        if (j.ok) {
          setNotebooks((j.objects || [])
            .filter((o: any) => o.object_type === 'NOTEBOOK')
            .map((o: any) => o.path));
        }
      } catch { /* picker is optional; free-text path still works */ }
    })();
  }, [loadJobs]);

  const resetForNew = useCallback(() => {
    setJobId(null); setName(''); setSaveMessage(null); setSaveError(null); setRunError(null);
    setTasks([emptyTask('main')]); setActiveTaskKey('main'); setRuns([]);
    setMaxConcurrent(1); setJobTimeout(0); setTagsText(''); setJobParamsText('');
    setEmailOnFailure(''); setEmailOnSuccess('');
    setTriggerType('none'); setCron('0 0 2 * * ?'); setTz('UTC'); setPaused(false); setFileArrivalUrl('');
    setActiveTab('tasks'); setDirty(false);
  }, []);

  // Bundle-installed job: seed the form from the item's stamped
  // DatabricksJobContent (tasks + shared cluster) so it opens FULLY BUILT-OUT
  // before any live Databricks job exists. The item GET route returns the
  // editor-shaped { job, source:'bundle' } when no jobId is passed. The user
  // then clicks Create to push it to the real workspace (jobs/create). Only
  // runs once per item id, and never overrides a live-job selection or unsaved
  // edits.
  const [bundleSeeded, setBundleSeeded] = useState(false);
  useEffect(() => {
    if (id === 'new' || !id || bundleSeeded || jobId !== null || dirty) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/items/databricks-job/${encodeURIComponent(id)}`);
        const j = await r.json();
        if (cancelled || !j.ok || j.source !== 'bundle' || !j.job?.settings) return;
        const settings = j.job.settings;
        setName(settings.name || '');
        const ts = (settings.tasks || []).map(specToTask);
        if (ts.length) { setTasks(ts); setActiveTaskKey(ts[0].task_key || 'main'); }
        setMaxConcurrent(settings.max_concurrent_runs ?? 1);
        setActiveTab('tasks');
        setBundleSeeded(true);
      } catch { /* best-effort seed; the live job list still works */ }
    })();
    return () => { cancelled = true; };
  }, [id, bundleSeeded, jobId, dirty]);

  const selectJob = useCallback(async (jid: number) => {
    setJobId(jid);
    setSaveError(null); setSaveMessage(null); setRunError(null);
    try {
      const r = await fetch(`/api/items/databricks-job/${id}?jobId=${jid}`);
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
      const job = j.job as JobRow;
      setName(job.settings?.name || '');
      const ts = (job.settings?.tasks || []).map(specToTask);
      setTasks(ts.length ? ts : [emptyTask('main')]);
      setActiveTaskKey(ts[0]?.task_key || 'main');
      setMaxConcurrent(job.settings?.max_concurrent_runs ?? 1);
      setJobTimeout(job.settings?.timeout_seconds ?? 0);
      setTagsText(serializeKv(job.settings?.tags));
      setJobParamsText((job.settings?.parameters || []).map((p) => `${p.name}=${p.default}`).join('\n'));
      setEmailOnFailure((job.settings?.email_notifications?.on_failure || []).join(', '));
      setEmailOnSuccess((job.settings?.email_notifications?.on_success || []).join(', '));
      const sch = job.settings?.schedule;
      const cont = job.settings?.continuous;
      const trig = job.settings?.trigger as any;
      if (sch) {
        setTriggerType('cron');
        setCron(sch.quartz_cron_expression || '0 0 2 * * ?');
        setTz(sch.timezone_id || 'UTC');
        setPaused(sch.pause_status === 'PAUSED');
      } else if (cont) {
        setTriggerType('continuous');
        setPaused(cont.pause_status === 'PAUSED');
      } else if (trig?.file_arrival) {
        setTriggerType('file_arrival');
        setFileArrivalUrl(trig.file_arrival.url || '');
        setPaused(trig.pause_status === 'PAUSED');
      } else {
        setTriggerType('none');
      }
      const rr = await fetch(`/api/items/databricks-job/${id}/runs?jobId=${jid}`);
      const rj = await rr.json();
      if (rj.ok) setRuns(rj.runs || []);
      setDirty(false);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    }
  }, [id]);

  const buildSpec = useCallback(() => {
    const spec: any = {
      name: name || 'untitled-job',
      tasks: tasks.filter((t) => t.task_key).map(taskToSpec),
      max_concurrent_runs: Math.max(1, maxConcurrent || 1),
    };
    if (jobTimeout > 0) spec.timeout_seconds = jobTimeout;
    const tags = parseKv(tagsText);
    if (Object.keys(tags).length) spec.tags = tags;
    const jp = parseKv(jobParamsText);
    if (Object.keys(jp).length) spec.parameters = Object.entries(jp).map(([nm, def]) => ({ name: nm, default: def }));
    const onFail = emailOnFailure.split(',').map((x) => x.trim()).filter(Boolean);
    const onSucc = emailOnSuccess.split(',').map((x) => x.trim()).filter(Boolean);
    if (onFail.length || onSucc.length) {
      spec.email_notifications = {
        ...(onFail.length ? { on_failure: onFail } : {}),
        ...(onSucc.length ? { on_success: onSucc } : {}),
      };
    }
    const pause = paused ? 'PAUSED' : 'UNPAUSED';
    if (triggerType === 'cron') {
      spec.schedule = { quartz_cron_expression: cron, timezone_id: tz, pause_status: pause };
    } else if (triggerType === 'continuous') {
      spec.continuous = { pause_status: pause };
    } else if (triggerType === 'file_arrival') {
      spec.trigger = { file_arrival: { url: fileArrivalUrl }, pause_status: pause };
    }
    return spec;
  }, [name, tasks, maxConcurrent, jobTimeout, tagsText, jobParamsText, emailOnFailure, emailOnSuccess, triggerType, cron, tz, paused, fileArrivalUrl]);

  const specJson = useMemo(() => {
    try { return JSON.stringify(buildSpec(), null, 2); } catch { return '{}'; }
  }, [buildSpec]);

  const save = useCallback(async () => {
    setSaving(true); setSaveError(null); setSaveMessage(null);
    const spec = buildSpec();
    try {
      if (jobId === null) {
        const r = await fetch('/api/items/databricks-job', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        const j = await r.json();
        if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
        setJobId(j.job_id);
        setSaveMessage(`Created job ${j.job_id} at ${new Date().toLocaleTimeString()}`);
        await loadJobs();
        setNavRefresh((n) => n + 1);
        setDirty(false);
      } else {
        const r = await fetch(`/api/items/databricks-job/${id}?jobId=${jobId}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        const j = await r.json();
        if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
        setSaveMessage(`Saved job ${jobId} at ${new Date().toLocaleTimeString()}`);
        setNavRefresh((n) => n + 1);
        setDirty(false);
      }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [id, jobId, buildSpec, loadJobs]);

  const del = useCallback(async () => {
    if (jobId === null) return;
    if (!window.confirm(`Delete job ${jobId}?`)) return;
    await fetch(`/api/items/databricks-job/${id}?jobId=${jobId}`, { method: 'DELETE' });
    resetForNew();
    await loadJobs();
    setNavRefresh((n) => n + 1);
  }, [id, jobId, loadJobs, resetForNew]);

  const refreshRuns = useCallback(async () => {
    if (jobId === null) return;
    const rr = await fetch(`/api/items/databricks-job/${id}/runs?jobId=${jobId}`);
    const rj = await rr.json();
    if (rj.ok) setRuns(rj.runs || []);
  }, [id, jobId]);

  const runNow = useCallback(async () => {
    if (jobId === null) return;
    setRunning(true); setRunError(null);
    try {
      // Pass job-level parameter defaults as job_parameters on run-now (real
      // run-now param shape); the API also honours notebook/python/etc.
      const jp = parseKv(jobParamsText);
      const body = Object.keys(jp).length ? { params: { job_parameters: jp } } : {};
      const r = await fetch(`/api/items/databricks-job/${id}/run?jobId=${jobId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setRunError(j.error || `HTTP ${r.status}`); return; }
      setActiveTab('runs');
      await refreshRuns();
    } catch (e: any) {
      setRunError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [id, jobId, jobParamsText, refreshRuns]);

  const openRunOutput = useCallback(async (runId: number) => {
    setOutOpen(true); setOutBusy(true); setOutRunId(runId);
    setOutData(null); setOutNote(null); setOutError(null);
    try {
      const r = await fetch(`/api/items/databricks-job/${id}/run-output?runId=${runId}`);
      const j = await r.json();
      if (!j.ok) { setOutError(j.error || `HTTP ${r.status}`); return; }
      setOutData(j); setOutNote(j.outputNote || null);
    } catch (e: any) {
      setOutError(e?.message || String(e));
    } finally {
      setOutBusy(false);
    }
  }, [id]);

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving && (dirty || jobId === null)) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, dirty, jobId, save]);

  // ---- Task mutations ----
  const activeTask = useMemo(
    () => tasks.find((t) => t.task_key === activeTaskKey) || tasks[0] || null,
    [tasks, activeTaskKey],
  );
  const patchTask = useCallback((key: string, patch: Partial<JobTaskForm>) => {
    setTasks((arr) => arr.map((t) => (t.task_key === key ? { ...t, ...patch } : t)));
    markDirty();
  }, [markDirty]);
  const addTask = useCallback(() => {
    setTasks((arr) => {
      let n = arr.length + 1;
      let key = `task_${n}`;
      while (arr.some((t) => t.task_key === key)) { n += 1; key = `task_${n}`; }
      const fresh = emptyTask(key);
      setActiveTaskKey(key);
      return [...arr, fresh];
    });
    markDirty();
  }, [markDirty]);
  const removeTask = useCallback((key: string) => {
    setTasks((arr) => {
      if (arr.length <= 1) return arr;
      const next = arr
        .filter((t) => t.task_key !== key)
        // drop dangling depends_on references to the removed task
        .map((t) => ({ ...t, depends_on: t.depends_on.filter((d) => d !== key) }));
      if (activeTaskKey === key) setActiveTaskKey(next[0]?.task_key || '');
      return next;
    });
    markDirty();
  }, [activeTaskKey, markDirty]);
  const renameTaskKey = useCallback((oldKey: string, newKey: string) => {
    setTasks((arr) => arr.map((t) => ({
      ...t,
      task_key: t.task_key === oldKey ? newKey : t.task_key,
      depends_on: t.depends_on.map((d) => (d === oldKey ? newKey : d)),
    })));
    if (activeTaskKey === oldKey) setActiveTaskKey(newKey);
    markDirty();
  }, [activeTaskKey, markDirty]);

  // DAG activities derived from tasks for the visual canvas.
  const dagActivities: PipelineActivity[] = useMemo(
    () => tasks.map((t) => ({
      name: t.task_key,
      type: TASK_TYPE_LABELS[t.task_type],
      dependsOn: t.depends_on.map((d) => ({ activity: d, dependencyConditions: [] })),
    })),
    [tasks],
  );

  const gated = !!gateError;
  const canSaveJob = !saving && (dirty || jobId === null) && tasks.some((t) => t.task_key);
  const canRunNow = jobId !== null && !running;
  const canDeleteJob = jobId !== null;
  const ribbonJob: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Job', actions: [
        { label: jobId === null ? 'New job' : 'New job', onClick: resetForNew },
        { label: saving ? 'Saving…' : jobId === null ? 'Create' : 'Save', onClick: canSaveJob ? save : undefined, disabled: !canSaveJob },
        { label: 'Delete', onClick: canDeleteJob ? del : undefined, disabled: !canDeleteJob },
      ]},
      { label: 'Run', actions: [
        { label: running ? 'Submitting…' : 'Run now', onClick: canRunNow ? runNow : undefined, disabled: !canRunNow, title: canRunNow ? undefined : 'Save the job first' },
        { label: 'View runs', onClick: jobId !== null ? () => { setActiveTab('runs'); void refreshRuns(); } : undefined, disabled: jobId === null },
      ]},
      { label: 'Tasks', actions: [
        { label: 'Add task', onClick: addTask },
      ]},
    ]},
  ], [jobId, resetForNew, saving, canSaveJob, save, canDeleteJob, del, running, canRunNow, runNow, refreshRuns, addTask]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbonJob}
      leftPanel={
        // Full Databricks Workspace navigator (parity with the ADF Factory
        // Resources / Synapse Workspace Resources panes): typed groups for
        // Jobs / Notebooks / Clusters / SQL Warehouses / Repos / Unity Catalog
        // with live counts, ＋New, filter, inline run/start/stop/delete — all on
        // real Databricks REST. Selecting a Job opens it here; "New job" opens
        // the new-job form (Databricks jobs need ≥1 task, authored below).
        <DatabricksWorkspaceTree
          selectedJobId={jobId}
          onOpenJob={(jid) => void selectJob(jid)}
          onNewJob={resetForNew}
          refreshKey={navRefresh}
        />
      }
      main={
        <div className={s.pad}>
          {/* Honest infra gate — full UI still renders below */}
          {gated && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Databricks workspace not configured</MessageBarTitle>
                {gateError}. {gateHint || 'Set LOOM_DATABRICKS_HOSTNAME on the Console Container App (e.g. adb-XXXXXX.NN.azuredatabricks.net) to enable the Jobs API.'}
                {' '}Provisioned by <code>platform/fiab/bicep/modules/landing-zone/databricks*.bicep</code>.
              </MessageBarBody>
            </MessageBar>
          )}

          <div className={s.toolbar}>
            {dirty && jobId !== null && <Badge appearance="outline" color="warning">unsaved</Badge>}
            {jobId !== null && <Badge appearance="outline">job_id {jobId}</Badge>}
            {workspaceHost && <Caption1>workspace: <code>{workspaceHost}</code></Caption1>}
            <Tooltip
              content={
                saving ? 'Save in progress…'
                  : !tasks.some((t) => t.task_key) ? 'Add at least one task with a task key'
                  : !canSaveJob ? 'No unsaved changes'
                  : jobId === null ? 'Create this job (jobs/create)' : 'Save changes (jobs/reset)'
              }
              relationship="label"
            >
              <Button
                appearance="primary"
                icon={<Save20Regular />}
                disabled={!canSaveJob}
                onClick={save}
                style={{ marginLeft: 'auto' }}
              >
                {saving ? 'Saving…' : jobId === null ? 'Create' : dirty ? 'Save *' : 'Save'}
              </Button>
            </Tooltip>
            {jobId !== null && (
              <Tooltip content={running ? 'A run is being submitted…' : 'Trigger this job now (jobs/run-now)'} relationship="label">
                <Button appearance="outline" icon={<Play20Regular />} disabled={running} onClick={runNow}>
                  {running ? 'Submitting…' : 'Run now'}
                </Button>
              </Tooltip>
            )}
            {jobId !== null && (
              <Button appearance="outline" icon={<Delete20Regular />} aria-label="Delete job" onClick={del}>Delete</Button>
            )}
          </div>
          {saveError && (
            <MessageBar intent="error"><MessageBarBody>
              <MessageBarTitle>Job save failed</MessageBarTitle>{saveError}
            </MessageBarBody></MessageBar>
          )}
          {runError && (
            <MessageBar intent="error"><MessageBarBody>
              <MessageBarTitle>Run failed</MessageBarTitle>{runError}
            </MessageBarBody></MessageBar>
          )}
          {saveMessage && (
            <MessageBar intent="success"><MessageBarBody>{saveMessage}</MessageBarBody></MessageBar>
          )}

          <Field label="Job name">
            <Input value={name} onChange={(_, d) => { setName(d.value); markDirty(); }} placeholder="My ETL job" />
          </Field>

          <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
            <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value as typeof activeTab)}>
              <Tab value="tasks">Tasks ({tasks.length})</Tab>
              <Tab value="schedule">Schedule &amp; triggers</Tab>
              <Tab value="settings">Settings</Tab>
              <Tab value="runs" disabled={jobId === null}>Runs ({runs.length})</Tab>
              <Tab value="json">JSON</Tab>
            </TabList>
          </div>

          {/* ---------------- TASKS TAB ---------------- */}
          {activeTab === 'tasks' && (
            <>
              <PipelineDagView activities={dagActivities} emptyHint="No tasks yet. Click Add task." />
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'flex-start' }}>
                {/* Task list */}
                <div style={{ minWidth: 220 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXS }}>
                    <Subtitle2 style={{ flex: 1 }}>Tasks</Subtitle2>
                    <Button size="small" icon={<Add20Regular />} appearance="outline" onClick={addTask}>Add</Button>
                  </div>
                  {tasks.map((t) => (
                    <div
                      key={t.task_key}
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit task ${t.task_key}`}
                      onClick={() => setActiveTaskKey(t.task_key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTaskKey(t.task_key); } }}
                      style={{
                        padding: tokens.spacingVerticalXS, cursor: 'pointer', borderRadius: tokens.borderRadiusMedium, marginBottom: tokens.spacingVerticalXXS,
                        display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
                        background: activeTaskKey === t.task_key ? tokens.colorNeutralBackground2Selected : undefined,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Body1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.task_key || '(unnamed)'}</Body1>
                        <Caption1>{TASK_TYPE_LABELS[t.task_type]}{t.depends_on.length ? ` · ⤴ ${t.depends_on.length}` : ''}</Caption1>
                      </div>
                      {tasks.length > 1 && (
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                          aria-label={`Remove ${t.task_key}`}
                          onClick={(e) => { e.stopPropagation(); removeTask(t.task_key); }} />
                      )}
                    </div>
                  ))}
                </div>

                <Divider vertical style={{ minHeight: 200 }} />

                {/* Task detail editor */}
                {activeTask && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
                      <Field label="Task key" style={{ flex: 1, minWidth: 160 }}>
                        <Input value={activeTask.task_key}
                          onChange={(_, d) => renameTaskKey(activeTask.task_key, d.value)} />
                      </Field>
                      <Field label="Type" style={{ flex: 1, minWidth: 160 }}>
                        <Dropdown
                          value={TASK_TYPE_LABELS[activeTask.task_type]}
                          selectedOptions={[activeTask.task_type]}
                          onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { task_type: d.optionValue as JobTaskType })}
                        >
                          {(Object.keys(TASK_TYPE_LABELS) as JobTaskType[]).map((tt) => (
                            <Option key={tt} value={tt} text={TASK_TYPE_LABELS[tt]}>{TASK_TYPE_LABELS[tt]}</Option>
                          ))}
                        </Dropdown>
                      </Field>
                    </div>
                    <Field label="Description">
                      <Input value={activeTask.description}
                        onChange={(_, d) => patchTask(activeTask.task_key, { description: d.value })} />
                    </Field>

                    {/* Type-specific fields */}
                    {activeTask.task_type === 'notebook_task' && (
                      <>
                        <Field label="Notebook path" hint="Workspace path, e.g. /Workspace/Users/you/etl">
                          <Dropdown
                            placeholder="/Workspace/…  (or type a path below)"
                            value={activeTask.notebook_path}
                            selectedOptions={activeTask.notebook_path ? [activeTask.notebook_path] : []}
                            onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { notebook_path: d.optionValue })}
                          >
                            {notebooks.map((p) => <Option key={p} value={p} text={p}>{p}</Option>)}
                          </Dropdown>
                        </Field>
                        <Field label="Notebook path (free text)">
                          <Input value={activeTask.notebook_path}
                            onChange={(_, d) => patchTask(activeTask.task_key, { notebook_path: d.value })} />
                        </Field>
                        <Field label="Base parameters (key=value per line)">
                          <Textarea rows={3} value={activeTask.notebook_params}
                            onChange={(_, d) => patchTask(activeTask.task_key, { notebook_params: d.value })} />
                        </Field>
                      </>
                    )}
                    {activeTask.task_type === 'spark_python_task' && (
                      <>
                        <Field label="Python file" hint="Workspace path or dbfs:/… or s3://…">
                          <Input value={activeTask.python_file}
                            onChange={(_, d) => patchTask(activeTask.task_key, { python_file: d.value })} />
                        </Field>
                        <Field label="Parameters (one arg per line)">
                          <Textarea rows={3} value={activeTask.python_params}
                            onChange={(_, d) => patchTask(activeTask.task_key, { python_params: d.value })} />
                        </Field>
                      </>
                    )}
                    {activeTask.task_type === 'python_wheel_task' && (
                      <>
                        <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                          <Field label="Package name" style={{ flex: 1 }}>
                            <Input value={activeTask.wheel_package}
                              onChange={(_, d) => patchTask(activeTask.task_key, { wheel_package: d.value })} />
                          </Field>
                          <Field label="Entry point" style={{ flex: 1 }}>
                            <Input value={activeTask.wheel_entry_point}
                              onChange={(_, d) => patchTask(activeTask.task_key, { wheel_entry_point: d.value })} />
                          </Field>
                        </div>
                        <Field label="Parameters (one arg per line)">
                          <Textarea rows={3} value={activeTask.python_params}
                            onChange={(_, d) => patchTask(activeTask.task_key, { python_params: d.value })} />
                        </Field>
                      </>
                    )}
                    {activeTask.task_type === 'spark_jar_task' && (
                      <>
                        <Field label="Main class">
                          <Input value={activeTask.jar_main_class}
                            onChange={(_, d) => patchTask(activeTask.task_key, { jar_main_class: d.value })} />
                        </Field>
                        <Field label="Parameters (one arg per line)">
                          <Textarea rows={3} value={activeTask.jar_params}
                            onChange={(_, d) => patchTask(activeTask.task_key, { jar_params: d.value })} />
                        </Field>
                      </>
                    )}
                    {activeTask.task_type === 'spark_submit_task' && (
                      <Field label="spark-submit parameters (one arg per line)">
                        <Textarea rows={4} value={activeTask.spark_submit_params}
                          onChange={(_, d) => patchTask(activeTask.task_key, { spark_submit_params: d.value })} />
                      </Field>
                    )}
                    {activeTask.task_type === 'sql_task' && (
                      <>
                        <Field label="SQL Warehouse" hint="Pro/serverless warehouse the SQL runs on">
                          {warehouses.length > 0 ? (
                            <Dropdown
                              aria-label="SQL Warehouse"
                              placeholder="Select warehouse"
                              value={warehouses.find((w) => w.id === activeTask.sql_warehouse_id)?.name || activeTask.sql_warehouse_id}
                              selectedOptions={activeTask.sql_warehouse_id ? [activeTask.sql_warehouse_id] : []}
                              onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { sql_warehouse_id: d.optionValue })}
                            >
                              {warehouses.map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>)}
                            </Dropdown>
                          ) : (
                            <Input aria-label="SQL Warehouse id" value={activeTask.sql_warehouse_id} placeholder="warehouse id"
                              onChange={(_, d) => patchTask(activeTask.task_key, { sql_warehouse_id: d.value })} />
                          )}
                        </Field>
                        <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                          <Field label="Query id (saved query)" style={{ flex: 1 }}>
                            <Input value={activeTask.sql_query_id}
                              onChange={(_, d) => patchTask(activeTask.task_key, { sql_query_id: d.value })} />
                          </Field>
                          <Field label="…or SQL file path" style={{ flex: 1 }}>
                            <Input value={activeTask.sql_file_path}
                              onChange={(_, d) => patchTask(activeTask.task_key, { sql_file_path: d.value })} />
                          </Field>
                        </div>
                      </>
                    )}
                    {activeTask.task_type === 'dbt_task' && (
                      <>
                        <Field label="dbt commands (one per line)" hint="e.g. dbt deps / dbt run / dbt test">
                          <Textarea rows={4} value={activeTask.dbt_commands}
                            onChange={(_, d) => patchTask(activeTask.task_key, { dbt_commands: d.value })} />
                        </Field>
                        <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                          <Field label="Project directory" style={{ flex: 1 }}>
                            <Input value={activeTask.dbt_project_directory}
                              onChange={(_, d) => patchTask(activeTask.task_key, { dbt_project_directory: d.value })} />
                          </Field>
                          <Field label="SQL Warehouse" style={{ flex: 1 }}>
                            {warehouses.length > 0 ? (
                              <Dropdown
                                aria-label="dbt SQL Warehouse"
                                placeholder="Select warehouse"
                                value={warehouses.find((w) => w.id === activeTask.sql_warehouse_id)?.name || activeTask.sql_warehouse_id}
                                selectedOptions={activeTask.sql_warehouse_id ? [activeTask.sql_warehouse_id] : []}
                                onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { sql_warehouse_id: d.optionValue })}
                              >
                                {warehouses.map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>)}
                              </Dropdown>
                            ) : (
                              <Input aria-label="dbt SQL Warehouse id" value={activeTask.sql_warehouse_id} placeholder="warehouse id"
                                onChange={(_, d) => patchTask(activeTask.task_key, { sql_warehouse_id: d.value })} />
                            )}
                          </Field>
                        </div>
                      </>
                    )}
                    {activeTask.task_type === 'pipeline_task' && (
                      <Field label="DLT / Lakeflow pipeline id" hint="Paste the pipeline id from the Databricks Delta Live Tables UI — no Loom DLT editor yet (tracked gap)">
                        <Input aria-label="DLT pipeline id" value={activeTask.pipeline_id} placeholder="e.g. 0123abcd-…"
                          onChange={(_, d) => patchTask(activeTask.task_key, { pipeline_id: d.value })} />
                      </Field>
                    )}
                    {activeTask.task_type === 'run_job_task' && (
                      <Field label="Job to run" hint="Another Databricks job this task triggers">
                        {jobs.filter((jb) => jb.job_id !== jobId).length > 0 ? (
                          <Dropdown
                            aria-label="Job to run"
                            placeholder="Select a job"
                            value={jobs.find((jb) => String(jb.job_id) === activeTask.run_job_id)?.settings?.name || activeTask.run_job_id}
                            selectedOptions={activeTask.run_job_id ? [activeTask.run_job_id] : []}
                            onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { run_job_id: d.optionValue })}
                          >
                            {jobs.filter((jb) => jb.job_id !== jobId).map((jb) => (
                              <Option key={jb.job_id} value={String(jb.job_id)} text={jb.settings?.name || String(jb.job_id)}>
                                {jb.settings?.name || `job ${jb.job_id}`} · {jb.job_id}
                              </Option>
                            ))}
                          </Dropdown>
                        ) : (
                          <Input aria-label="Job id to run" type="number" value={activeTask.run_job_id} placeholder="job_id"
                            onChange={(_, d) => patchTask(activeTask.task_key, { run_job_id: d.value })} />
                        )}
                      </Field>
                    )}

                    {/* Compute (not applicable to SQL / pipeline / run_job task types) */}
                    {!['sql_task', 'pipeline_task', 'run_job_task'].includes(activeTask.task_type) && (
                      <>
                        <Divider />
                        <Subtitle2>Compute</Subtitle2>
                        <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <Field label="Cluster">
                            <Dropdown
                              value={activeTask.compute === 'new' ? 'New job cluster' : 'Existing cluster'}
                              selectedOptions={[activeTask.compute]}
                              onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { compute: d.optionValue as 'existing' | 'new' })}
                            >
                              <Option value="existing" text="Existing cluster">Existing cluster</Option>
                              <Option value="new" text="New job cluster">New job cluster</Option>
                            </Dropdown>
                          </Field>
                          {activeTask.compute === 'existing' ? (
                            <Field label="Existing cluster" style={{ minWidth: 240 }}>
                              <Dropdown
                                placeholder="Select cluster"
                                value={clusters.find((c) => c.cluster_id === activeTask.existing_cluster_id)?.cluster_name || activeTask.existing_cluster_id}
                                selectedOptions={activeTask.existing_cluster_id ? [activeTask.existing_cluster_id] : []}
                                onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { existing_cluster_id: d.optionValue })}
                              >
                                {clusters.map((c) => (
                                  <Option key={c.cluster_id} value={c.cluster_id} text={c.cluster_name || c.cluster_id}>
                                    {c.cluster_name || c.cluster_id} · {c.state}
                                  </Option>
                                ))}
                              </Dropdown>
                            </Field>
                          ) : (
                            <>
                              <Field label="Spark version" style={{ minWidth: 220 }}>
                                <Dropdown
                                  placeholder="Runtime"
                                  value={sparkVersions.find((v) => v.key === activeTask.new_spark_version)?.name || activeTask.new_spark_version}
                                  selectedOptions={activeTask.new_spark_version ? [activeTask.new_spark_version] : []}
                                  onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { new_spark_version: d.optionValue })}
                                >
                                  {sparkVersions.slice(0, 80).map((v) => <Option key={v.key} value={v.key} text={v.name}>{v.name}</Option>)}
                                </Dropdown>
                              </Field>
                              <Field label="Node type" style={{ minWidth: 200 }}>
                                <Dropdown
                                  placeholder="Node type"
                                  value={activeTask.new_node_type_id}
                                  selectedOptions={activeTask.new_node_type_id ? [activeTask.new_node_type_id] : []}
                                  onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { new_node_type_id: d.optionValue })}
                                >
                                  {nodeTypes.slice(0, 80).map((n) => <Option key={n.node_type_id} value={n.node_type_id} text={n.node_type_id}>{n.node_type_id}</Option>)}
                                </Dropdown>
                              </Field>
                              <Field label="Workers">
                                <Input type="number" value={String(activeTask.new_num_workers)}
                                  onChange={(_, d) => patchTask(activeTask.task_key, { new_num_workers: Number(d.value) || 0 })} />
                              </Field>
                            </>
                          )}
                        </div>
                      </>
                    )}

                    {/* Dependencies + reliability */}
                    <Divider />
                    <Subtitle2>Depends on</Subtitle2>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                      {tasks.filter((t) => t.task_key !== activeTask.task_key).length === 0 && (
                        <Caption1>No other tasks to depend on. Add a task to build a multi-task DAG.</Caption1>
                      )}
                      {tasks.filter((t) => t.task_key !== activeTask.task_key).map((t) => {
                        const on = activeTask.depends_on.includes(t.task_key);
                        return (
                          <Button key={t.task_key} size="small"
                            appearance={on ? 'primary' : 'outline'}
                            onClick={() => {
                              const next = on
                                ? activeTask.depends_on.filter((d) => d !== t.task_key)
                                : [...activeTask.depends_on, t.task_key];
                              patchTask(activeTask.task_key, { depends_on: next });
                            }}>
                            {on ? '✓ ' : '+ '}{t.task_key}
                          </Button>
                        );
                      })}
                    </div>
                    {activeTask.depends_on.length > 0 && (
                      <Field label="Run if (dependency outcome)">
                        <Dropdown
                          value={activeTask.run_if}
                          selectedOptions={[activeTask.run_if]}
                          onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { run_if: d.optionValue })}
                        >
                          {['ALL_SUCCESS', 'AT_LEAST_ONE_SUCCESS', 'NONE_FAILED', 'ALL_DONE', 'AT_LEAST_ONE_FAILED', 'ALL_FAILED'].map((v) => (
                            <Option key={v} value={v} text={v}>{v}</Option>
                          ))}
                        </Dropdown>
                      </Field>
                    )}

                    <Divider />
                    <Subtitle2>Retries &amp; timeout</Subtitle2>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
                      <Field label="Max retries">
                        <Input type="number" value={String(activeTask.max_retries)}
                          onChange={(_, d) => patchTask(activeTask.task_key, { max_retries: Number(d.value) || 0 })} />
                      </Field>
                      <Field label="Min retry interval (ms)">
                        <Input type="number" value={String(activeTask.min_retry_interval_millis)}
                          onChange={(_, d) => patchTask(activeTask.task_key, { min_retry_interval_millis: Number(d.value) || 0 })} />
                      </Field>
                      <Field label="Task timeout (s)">
                        <Input type="number" value={String(activeTask.timeout_seconds)}
                          onChange={(_, d) => patchTask(activeTask.task_key, { timeout_seconds: Number(d.value) || 0 })} />
                      </Field>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ---------------- SCHEDULE TAB ---------------- */}
          {activeTab === 'schedule' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Field label="Trigger type">
                <Dropdown
                  value={triggerType === 'none' ? 'None (manual / API only)'
                    : triggerType === 'cron' ? 'Scheduled (cron)'
                    : triggerType === 'continuous' ? 'Continuous'
                    : 'File arrival'}
                  selectedOptions={[triggerType]}
                  onOptionSelect={(_, d) => { if (d.optionValue) { setTriggerType(d.optionValue as TriggerType); markDirty(); } }}
                >
                  <Option value="none" text="None (manual / API only)">None (manual / API only)</Option>
                  <Option value="cron" text="Scheduled (cron)">Scheduled (cron)</Option>
                  <Option value="continuous" text="Continuous">Continuous</Option>
                  <Option value="file_arrival" text="File arrival">File arrival</Option>
                </Dropdown>
              </Field>
              {triggerType === 'cron' && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Quartz cron expression" hint="e.g. 0 0 2 * * ?  (daily 02:00)">
                    <Input value={cron} onChange={(_, d) => { setCron(d.value); markDirty(); }} />
                  </Field>
                  <Field label="Timezone" hint="Cron is evaluated in this zone">
                    <Dropdown
                      aria-label="Schedule timezone"
                      value={tz}
                      selectedOptions={[tz]}
                      onOptionSelect={(_, d) => { if (d.optionValue) { setTz(d.optionValue); markDirty(); } }}
                    >
                      {SCHEDULE_TIMEZONES.map((z) => <Option key={z} value={z} text={z}>{z}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
              )}
              {triggerType === 'continuous' && (
                <MessageBar intent="info"><MessageBarBody>
                  Continuous jobs keep one run active at all times, restarting automatically. Databricks ignores cron for continuous mode.
                </MessageBarBody></MessageBar>
              )}
              {triggerType === 'file_arrival' && (
                <Field label="File arrival URL" hint="External location / volume path watched for new files">
                  <Input value={fileArrivalUrl} onChange={(_, d) => { setFileArrivalUrl(d.value); markDirty(); }} />
                </Field>
              )}
              {triggerType !== 'none' && (
                <Switch checked={paused} label="Paused"
                  onChange={(_, d) => { setPaused(!!d.checked); markDirty(); }} />
              )}
            </div>
          )}

          {/* ---------------- SETTINGS TAB ---------------- */}
          {activeTab === 'settings' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
                <Field label="Max concurrent runs">
                  <Input type="number" value={String(maxConcurrent)}
                    onChange={(_, d) => { setMaxConcurrent(Number(d.value) || 1); markDirty(); }} />
                </Field>
                <Field label="Job timeout (s, 0 = none)">
                  <Input type="number" value={String(jobTimeout)}
                    onChange={(_, d) => { setJobTimeout(Number(d.value) || 0); markDirty(); }} />
                </Field>
              </div>
              <Field label="Tags (key=value per line)">
                <Textarea rows={3} value={tagsText} onChange={(_, d) => { setTagsText(d.value); markDirty(); }} />
              </Field>
              <Field label="Job parameters (key=default per line)" hint="Surfaced as job_parameters on run-now">
                <Textarea rows={3} value={jobParamsText} onChange={(_, d) => { setJobParamsText(d.value); markDirty(); }} />
              </Field>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
                <Field label="Email on failure (comma-separated)" style={{ flex: 1, minWidth: 240 }}>
                  <Input value={emailOnFailure} onChange={(_, d) => { setEmailOnFailure(d.value); markDirty(); }} />
                </Field>
                <Field label="Email on success (comma-separated)" style={{ flex: 1, minWidth: 240 }}>
                  <Input value={emailOnSuccess} onChange={(_, d) => { setEmailOnSuccess(d.value); markDirty(); }} />
                </Field>
              </div>
            </div>
          )}

          {/* ---------------- RUNS TAB ---------------- */}
          {activeTab === 'runs' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Subtitle2 style={{ flex: 1 }}>Run history</Subtitle2>
                <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={refreshRuns}>Refresh</Button>
                <Button size="small" appearance="primary" icon={<Play20Regular />} disabled={!canRunNow} onClick={runNow}>
                  {running ? 'Submitting…' : 'Run now'}
                </Button>
              </div>
              <div className={s.tableWrap}>
                <Table size="small" aria-label="Run history">
                  <TableHeader><TableRow>
                    <TableHeaderCell>run_id</TableHeaderCell>
                    <TableHeaderCell>State</TableHeaderCell>
                    <TableHeaderCell>Start</TableHeaderCell>
                    <TableHeaderCell>Exec</TableHeaderCell>
                    <TableHeaderCell>Creator</TableHeaderCell>
                    <TableHeaderCell>Output</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {runs.length === 0 && (
                      <TableRow><TableCell colSpan={6}><Caption1>No runs yet. Click Run now.</Caption1></TableCell></TableRow>
                    )}
                    {runs.map((r) => (
                      <TableRow key={r.run_id}>
                        <TableCell>{r.run_id}</TableCell>
                        <TableCell>
                          <Badge appearance="outline" color={runStateColor(r.state?.result_state)}>
                            {r.state?.life_cycle_state || '—'}{r.state?.result_state ? ` · ${r.state.result_state}` : ''}
                          </Badge>
                        </TableCell>
                        <TableCell>{fmtTime(r.start_time)}</TableCell>
                        <TableCell>{fmtDuration(r.execution_duration)}</TableCell>
                        <TableCell>{r.creator_user_name || '—'}</TableCell>
                        <TableCell>
                          <Button size="small" appearance="subtle" onClick={() => openRunOutput(r.run_id)}>View</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {/* ---------------- JSON TAB ---------------- */}
          {activeTab === 'json' && (
            <>
              <Caption1>Live job spec (the exact payload sent to <code>jobs/create</code> / <code>jobs/reset</code>) — parity with Databricks &quot;View JSON&quot;.</Caption1>
              <MonacoTextarea value={specJson} onChange={() => { /* read-only view */ }} language="json" height={420} minHeight={300} ariaLabel="Job spec JSON" readOnly />
            </>
          )}

          {/* Run output drawer */}
          <Dialog open={outOpen} onOpenChange={(_, d) => setOutOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '900px', width: '92vw' }}>
              <DialogBody>
                <DialogTitle>Run output — run_id {outRunId}</DialogTitle>
                <DialogContent>
                  {outBusy && <Spinner size="small" label="Loading run output…" labelPosition="after" />}
                  {outError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Failed</MessageBarTitle>{outError}</MessageBarBody></MessageBar>}
                  {outData?.run && (
                    <div style={{ marginBottom: tokens.spacingVerticalS }}>
                      <Badge appearance="outline" color={runStateColor(outData.run.state?.result_state)}>
                        {outData.run.state?.life_cycle_state || '—'}{outData.run.state?.result_state ? ` · ${outData.run.state.result_state}` : ''}
                      </Badge>
                      {outData.run.state?.state_message && <Caption1> · {outData.run.state.state_message}</Caption1>}
                    </div>
                  )}
                  {outNote && <MessageBar intent="info"><MessageBarBody>{outNote}</MessageBarBody></MessageBar>}
                  {outData?.output?.error && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Task error</MessageBarTitle>{outData.output.error}</MessageBarBody></MessageBar>
                  )}
                  {outData?.output?.notebook_output?.result !== undefined && (
                    <>
                      <Caption1>Notebook output</Caption1>
                      <pre className={s.cellPre}>{String(outData.output.notebook_output.result)}</pre>
                    </>
                  )}
                  {outData?.output?.logs && (
                    <>
                      <Caption1>Logs{outData.output.logs_truncated ? ' (truncated)' : ''}</Caption1>
                      <pre className={s.cellPre}>{outData.output.logs}</pre>
                    </>
                  )}
                  {outData?.output?.error_trace && (
                    <>
                      <Caption1>Error trace</Caption1>
                      <pre className={s.cellPre} style={{ color: tokens.colorPaletteRedForeground1 }}>{outData.output.error_trace}</pre>
                    </>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setOutOpen(false)} disabled={outBusy}>Close</Button>
                  <Button appearance="primary" onClick={() => outRunId != null && openRunOutput(outRunId)} disabled={outBusy || outRunId == null}>Refresh</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

