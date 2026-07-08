'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Typed per-activity property forms — the Loom one-for-one of each Azure Data
 * Factory / Synapse activity's Settings panel (ui-parity.md). Instead of making
 * users hand-write the `typeProperties` JSON, each known activity type declares
 * a field schema here; <ActivityForm/> renders the matching typed controls
 * (text / number / toggle / dropdown / expression) and reads-writes the
 * activity's typeProperties by dotted path. Expression-capable fields use
 * <ExpressionField/> so the portal's "Add dynamic content" + IntelliSense is
 * available exactly where Azure offers it.
 *
 * Activity types WITHOUT a schema fall back to the raw typeProperties JSON
 * editor in properties-panel.tsx — so nothing regresses, and coverage grows by
 * adding rows here. Grounded in:
 *   https://learn.microsoft.com/azure/data-factory/control-flow-* (per activity)
 */

import { useState } from 'react';
import {
  Field, Input, Dropdown, Option, Switch, Caption1, Subtitle2, Badge, Button, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, tokens, makeStyles,
} from '@fluentui/react-components';
import {
  Branch20Regular, ArrowEnterRegular, Open16Regular,
} from '@fluentui/react-icons';
import { ExpressionField, isDynamicExpression } from './expression-field';
import { DatasetSelectOrCreate, type DatasetProvider } from './dataset-wizard';
import { LinkedServicePicker, type LinkedServiceEngine } from './linked-service-gallery';
import { DataFlowPicker } from './dataflow-picker';
import {
  activityByType, type ActivityDef, type ActivitySettingField,
  aiEnrichEndpoint, AI_ENRICH_SERVER_ENV, type AiEnrichService,
} from './activity-catalog';
import { branchesOf, totalInnerCount } from './drill-path';
import type { PipelineActivity, PipelineParameter, PipelineVariable } from './types';

type FieldKind = 'text' | 'number' | 'bool' | 'select' | 'multiselect' | 'expr' | 'expr-multiline';

interface FieldSpec {
  /** Dotted path under activity.typeProperties (e.g. 'waitTimeInSeconds', 'value'). */
  path: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  hint?: string;
  /** Options for select. */
  options?: Array<{ value: string; label: string }>;
  /** Placeholder for text/expr. */
  placeholder?: string;
  /**
   * When true the `path` resolves against the activity root object
   * (e.g. 'linkedServiceName.referenceName') instead of typeProperties.
   * The renderer reads/writes the root and setPath clones existing nodes,
   * so sibling fields like `type:'LinkedServiceReference'` are preserved.
   */
  rootPath?: boolean;
}

/** HDInsight debug-info levels (ADF getDebugInfo enum). */
const HDI_DEBUG_OPTIONS = ['None', 'Always', 'Failure'].map((v) => ({ value: v, label: v }));

/**
 * Shared "HDI Cluster" field — the activity's top-level `linkedServiceName`
 * (the AzureHDInsight cluster), NOT a typeProperties field. rootPath routes
 * the read/write to the activity root.
 */
const HDI_CLUSTER_FIELD: FieldSpec = {
  path: 'linkedServiceName.referenceName',
  label: 'HDI Cluster linked service',
  kind: 'text',
  required: true,
  hint: 'Name of the AzureHDInsight linked service in this factory (Manage → Linked services → New → Azure HDInsight). Pre-filled from LOOM_HDINSIGHT_LINKED_SERVICE when set.',
  rootPath: true,
};

/** Set of HDInsight activity types that share the cluster honest-gate. */
const HDI_ACTIVITY_TYPES = new Set([
  'HDInsightHive', 'HDInsightSpark', 'HDInsightMapReduce', 'HDInsightStreaming',
]);

/** Field schema per ADF/Synapse activity `type`. */
export const ACTIVITY_FORMS: Record<string, FieldSpec[]> = {
  Wait: [
    { path: 'waitTimeInSeconds', label: 'Wait time (seconds)', kind: 'expr', required: true,
      hint: 'Seconds to pause before continuing. Accepts an expression.', placeholder: '30' },
  ],
  SetVariable: [
    { path: 'variableName', label: 'Variable name', kind: 'text', required: true,
      hint: 'The pipeline variable to set.' },
    { path: 'value', label: 'Value', kind: 'expr', placeholder: "@pipeline().RunId" },
  ],
  AppendVariable: [
    { path: 'variableName', label: 'Variable name', kind: 'text', required: true },
    { path: 'value', label: 'Value to append', kind: 'expr' },
  ],
  Until: [
    { path: 'expression.value', label: 'Expression', kind: 'expr', required: true,
      hint: 'Loop exits when this boolean expression is true.',
      placeholder: "@equals(activity('Lookup1').output.firstRow.done, true)" },
    { path: 'timeout', label: 'Timeout', kind: 'text', placeholder: '0.12:00:00',
      hint: 'Max duration (d.hh:mm:ss) before the loop fails.' },
  ],
  IfCondition: [
    { path: 'expression.value', label: 'Condition expression', kind: 'expr', required: true,
      placeholder: "@greater(activity('Lookup1').output.count, 0)" },
  ],
  Switch: [
    { path: 'on.value', label: 'On (expression)', kind: 'expr', required: true,
      hint: 'Evaluated value matched against each case.', placeholder: "@activity('Lookup1').output.region" },
  ],
  Filter: [
    { path: 'items.value', label: 'Items', kind: 'expr', required: true,
      placeholder: "@activity('GetMetadata1').output.childItems" },
    { path: 'condition.value', label: 'Condition', kind: 'expr', required: true,
      placeholder: "@endswith(item().name, '.csv')" },
  ],
  ForEach: [
    { path: 'items.value', label: 'Items', kind: 'expr', required: true,
      hint: 'Array to iterate. Reference each element with @item().' },
    { path: 'isSequential', label: 'Sequential', kind: 'bool',
      hint: 'Off = parallel iterations (up to batch count).' },
    { path: 'batchCount', label: 'Batch count', kind: 'number',
      hint: 'Max parallel iterations (1–50) when not sequential.' },
  ],
  Lookup: [
    { path: 'firstRowOnly', label: 'First row only', kind: 'bool',
      hint: 'Return only the first row of the source.' },
  ],
  ExecutePipeline: [
    { path: 'pipeline.referenceName', label: 'Invoked pipeline', kind: 'text', required: true,
      hint: 'Name of the pipeline to execute.' },
    { path: 'waitOnCompletion', label: 'Wait on completion', kind: 'bool' },
  ],
  WebActivity: [
    { path: 'method', label: 'Method', kind: 'select', required: true,
      options: ['GET', 'POST', 'PUT', 'DELETE'].map((m) => ({ value: m, label: m })) },
    { path: 'url', label: 'URL', kind: 'expr', required: true, placeholder: 'https://api.example.com/run' },
    { path: 'body', label: 'Body', kind: 'expr-multiline', hint: 'Request body (POST/PUT). Accepts an expression.' },
  ],
  Web: [
    { path: 'method', label: 'Method', kind: 'select', required: true,
      options: ['GET', 'POST', 'PUT', 'DELETE'].map((m) => ({ value: m, label: m })) },
    { path: 'url', label: 'URL', kind: 'expr', required: true },
    { path: 'body', label: 'Body', kind: 'expr-multiline' },
  ],
  Fail: [
    { path: 'message', label: 'Error message', kind: 'expr', required: true },
    { path: 'errorCode', label: 'Error code', kind: 'expr' },
  ],
  DatabricksNotebook: [
    { path: 'notebookPath', label: 'Notebook path', kind: 'text', required: true,
      placeholder: '/Workspace/Repos/csa-loom/medallion/bronze' },
  ],
  SynapseNotebook: [
    { path: 'notebook.referenceName', label: 'Notebook', kind: 'text', required: true },
  ],
  Script: [
    { path: 'scripts[0].text', label: 'Script', kind: 'expr-multiline', required: true,
      placeholder: 'SELECT COUNT(*) FROM gold.fact_sales' },
  ],
  GetMetadata: [
    { path: 'dataset.referenceName', label: 'Dataset', kind: 'text', required: true,
      hint: 'The dataset whose metadata to retrieve (file, folder, or table).' },
    { path: 'fieldList', label: 'Field list', kind: 'multiselect', required: true,
      hint: 'Which metadata fields to return. Reference results via @activity(\'…\').output.<field>.',
      options: [
        'itemName', 'itemType', 'size', 'created', 'lastModified', 'childItems',
        'contentMD5', 'structure', 'columnCount', 'exists',
      ].map((v) => ({ value: v, label: v })) },
  ],
  Delete: [
    { path: 'dataset.referenceName', label: 'Dataset', kind: 'text', required: true,
      hint: 'The file/folder dataset to delete.' },
    { path: 'recursive', label: 'Recursive', kind: 'bool',
      hint: 'Delete files in all subfolders, not just the top level.' },
    { path: 'enableLogging', label: 'Enable logging', kind: 'bool',
      hint: 'Write the list of deleted files to a log store.' },
    { path: 'maxConcurrentConnections', label: 'Max concurrent connections', kind: 'number',
      hint: 'Parallel connections to the store when deleting.' },
  ],
  SqlServerStoredProcedure: [
    { path: 'storedProcedureName', label: 'Stored procedure name', kind: 'expr', required: true,
      placeholder: '[dbo].[usp_LoadGold]',
      hint: 'Name of the stored procedure to run on the linked SQL service.' },
  ],
  WebHook: [
    { path: 'method', label: 'Method', kind: 'select', required: true,
      options: [{ value: 'POST', label: 'POST' }] },
    { path: 'url', label: 'URL', kind: 'expr', required: true, placeholder: 'https://api.example.com/callback' },
    { path: 'timeout', label: 'Timeout', kind: 'text', placeholder: '00:10:00',
      hint: 'How long to wait for the callBackUri before failing (hh:mm:ss).' },
    { path: 'body', label: 'Body', kind: 'expr-multiline', hint: 'Request body. Accepts an expression.' },
    { path: 'reportStatusOnCallBack', label: 'Report status on callback', kind: 'bool',
      hint: 'Let the callback report a failure status back to the activity.' },
  ],
  // Approval (Logic App + O365) — the Loom-native parity for Fabric's approval
  // email. Same WebHook wire shape, but the form points the operator at the
  // approval Logic App provisioning route instead of a raw callback URL.
  ApprovalWebhook: [
    { path: 'url', label: 'Logic App trigger URL', kind: 'text', required: true,
      placeholder: 'https://prod-XX.<region>.logic.azure.com:443/workflows/…/triggers/manual/run?…',
      hint:
        'HTTP trigger URL of the approval Logic App. Use "Fetch trigger URL" above ' +
        '(provisioned by approval-logicapp.bicep / LOOM_APPROVAL_LOGIC_APP_NAME), ' +
        'or paste it manually.' },
    { path: 'timeout', label: 'Approval timeout', kind: 'text', placeholder: '04:00:00',
      hint: 'How long ADF waits for the Logic App callback before failing (d.hh:mm:ss). ' +
            'Maximum 90 days on Logic Apps Consumption.' },
    { path: 'reportStatusOnCallBack', label: 'Report status on callback', kind: 'bool',
      hint:
        'Required. When true the Logic App callback body {StatusCode, Output, Error} ' +
        'controls success/failure — Approve → 200 continues, Reject → 400 fails the branch.' },
  ],
  Validation: [
    { path: 'dataset.referenceName', label: 'Dataset', kind: 'text', required: true,
      hint: 'The file/folder dataset to validate exists.' },
    { path: 'timeout', label: 'Timeout', kind: 'text', placeholder: '7.00:00:00',
      hint: 'Max time to wait for validation (d.hh:mm:ss).' },
    { path: 'sleep', label: 'Sleep (seconds)', kind: 'number',
      hint: 'Seconds between validation retries.' },
    { path: 'minimumSize', label: 'Minimum size (bytes)', kind: 'number',
      hint: 'For a file: minimum size required to pass.' },
    { path: 'childItems', label: 'Folder must contain children', kind: 'bool',
      hint: 'For a folder: require at least one child item.' },
  ],
  SynapseSparkJobDefinitionActivity: [
    { path: 'sparkJob.referenceName', label: 'Spark job definition', kind: 'text', required: true,
      hint: 'The Synapse Spark job definition to run.' },
  ],

  // ── HDInsight family (F17) — one-for-one with the ADF activity Settings tabs ──
  HDInsightHive: [
    HDI_CLUSTER_FIELD,
    { path: 'scriptLinkedService.referenceName', label: 'Script storage linked service', kind: 'text',
      hint: 'Azure Blob / ADLS Gen2 linked service holding the .hql file. Omit to use the cluster default storage.' },
    { path: 'scriptPath', label: 'Script path (.hql)', kind: 'expr', required: true,
      placeholder: 'scripts/transform.hql',
      hint: 'Path to the Hive script within the script storage.' },
    { path: 'getDebugInfo', label: 'Debug info', kind: 'select', options: HDI_DEBUG_OPTIONS,
      hint: 'When to capture YARN/Hive debug logs to the cluster default storage.' },
    { path: 'queryTimeout', label: 'Query timeout (minutes)', kind: 'number',
      hint: 'Required when the cluster has the Enterprise Security Package (ESP). Default 120.' },
    { path: 'arguments', label: 'Arguments (expression → string[])', kind: 'expr-multiline',
      hint: 'Hive command-line arguments as an ADF expression, e.g. @json(\'["--hiveconf","x=1"]\'). Complex defines go in the Advanced JSON accordion.' },
  ],
  HDInsightSpark: [
    HDI_CLUSTER_FIELD,
    { path: 'sparkJobLinkedService.referenceName', label: 'Job storage linked service', kind: 'text',
      hint: 'Azure Blob / ADLS Gen2 linked service containing the root path. Omit to use the cluster default storage.' },
    { path: 'rootPath', label: 'Root path (container/folder)', kind: 'expr', required: true,
      placeholder: 'adfspark/myjob',
      hint: 'Blob container + folder holding the entry file plus optional /jars and /pyFiles sub-folders.' },
    { path: 'entryFilePath', label: 'Entry file path (.py or .jar)', kind: 'expr', required: true,
      placeholder: 'main.py',
      hint: 'Relative path under the root path to the entry file.' },
    { path: 'className', label: 'Java / Spark main class', kind: 'text',
      placeholder: 'org.example.MyJob',
      hint: 'Required when the entry file is a JAR.' },
    { path: 'getDebugInfo', label: 'Debug info', kind: 'select', options: HDI_DEBUG_OPTIONS },
    { path: 'arguments', label: 'Arguments (expression → string[])', kind: 'expr-multiline',
      hint: 'Spark command-line arguments as an ADF expression. Spark config (sparkConfig) goes in the Advanced JSON accordion.' },
  ],
  HDInsightMapReduce: [
    HDI_CLUSTER_FIELD,
    { path: 'className', label: 'Main class', kind: 'expr', required: true,
      placeholder: 'org.apache.hadoop.examples.WordCount',
      hint: 'Fully-qualified Java class name to execute.' },
    { path: 'jarLinkedService.referenceName', label: 'JAR storage linked service', kind: 'text',
      hint: 'Azure Blob / ADLS Gen2 linked service holding the JAR. Omit to use the cluster default storage.' },
    { path: 'jarFilePath', label: 'JAR file path', kind: 'expr', required: true,
      placeholder: 'jars/myjob-1.0.jar',
      hint: 'Path to the primary JAR within the JAR storage.' },
    { path: 'getDebugInfo', label: 'Debug info', kind: 'select', options: HDI_DEBUG_OPTIONS },
    { path: 'arguments', label: 'Arguments (expression → string[])', kind: 'expr-multiline',
      hint: 'MapReduce arguments as an ADF expression. Additional jars (jarlibs) and defines go in the Advanced JSON accordion.' },
  ],
  HDInsightStreaming: [
    HDI_CLUSTER_FIELD,
    { path: 'mapper', label: 'Mapper executable', kind: 'expr', required: true,
      placeholder: 'MyMapper.exe',
      hint: 'Name of the mapper program (must be present in the file paths below).' },
    { path: 'reducer', label: 'Reducer executable', kind: 'expr', required: true,
      placeholder: 'MyReducer.exe' },
    { path: 'combiner', label: 'Combiner executable', kind: 'expr',
      placeholder: 'MyCombiner.exe',
      hint: 'Optional intermediate combiner program.' },
    { path: 'fileLinkedService.referenceName', label: 'File storage linked service', kind: 'text',
      hint: 'Azure Blob / ADLS Gen2 linked service holding the mapper/reducer/combiner files. Omit for the cluster default storage.' },
    { path: 'filePaths', label: 'File paths (expression → string[])', kind: 'expr-multiline', required: true,
      placeholder: '@json(\'["<container>/apps/MyMapper.exe","<container>/apps/MyReducer.exe"]\')',
      hint: 'Array of paths to the mapper, combiner, and reducer programs as an ADF expression.' },
    { path: 'input', label: 'Input path (WASB)', kind: 'expr', required: true,
      placeholder: 'wasb://<container>@<account>.blob.core.windows.net/input/data.txt' },
    { path: 'output', label: 'Output path (WASB)', kind: 'expr', required: true,
      placeholder: 'wasb://<container>@<account>.blob.core.windows.net/output/' },
    { path: 'getDebugInfo', label: 'Debug info', kind: 'select', options: HDI_DEBUG_OPTIONS },
    { path: 'arguments', label: 'Arguments (expression → string[])', kind: 'expr-multiline',
      hint: 'Extra streaming arguments as an ADF expression. commandEnvironment and defines go in the Advanced JSON accordion.' },
  ],
};

/**
 * Copy (type: 'Copy') intentionally has NO flat ACTIVITY_FORMS schema. Its
 * config surface is the four-tab editor in `lib/components/pipeline/copy/*`
 * (Source / Sink / Mapping / Settings), routed by `properties-panel.tsx`.
 * `hasActivityForm('Copy')` therefore stays false so the generic form never
 * renders for Copy. Exported for documentation + tests.
 */
export const COPY_TABBED_TYPES = new Set(['Copy']);

/**
 * Whether the structured (non-JSON) Settings form should render for `type`.
 *
 * True when EITHER a hand-tuned flat schema exists in {@link ACTIVITY_FORMS}
 * (HDInsight, Approval, the originals), OR the data-driven activity inventory
 * ({@link activityByType}) has a non-empty `settings[]` spec, OR the activity is
 * a control-flow container (ForEach / If / Switch / Until) — containers always
 * get the structured form so their condition field + inner-activity affordance
 * render instead of a raw `typeProperties` JSON textarea.
 *
 * Copy stays excluded (`COPY_TABBED_TYPES`) so its dedicated four-tab editor is
 * used; everything else with an inventory entry now renders a structured form,
 * eliminating the raw-JSON fallback for the whole ADF / Synapse activity set.
 */
export function hasActivityForm(type: string | undefined): boolean {
  if (!type || COPY_TABBED_TYPES.has(type)) return false;
  if (Array.isArray(ACTIVITY_FORMS[type]) && ACTIVITY_FORMS[type].length > 0) return true;
  const def = activityByType(type);
  if (def && (def.settings.length > 0 || def.hasInnerActivities)) return true;
  return false;
}

/** Read the Loom discriminator (`_loomKind`) off an activity, if present. */
export function activityLoomKind(activity: PipelineActivity): string | undefined {
  return Array.isArray(activity.userProperties)
    ? (activity.userProperties.find((p) => p.name === '_loomKind')?.value as string | undefined)
    : undefined;
}

// ── dotted-path get/set on a plain object (supports `a.b` and `a[0].b`) ──────
function tokenize(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const part of path.split('.')) {
    const m = part.match(/^([^[]+)((\[\d+\])+)?$/);
    if (!m) { out.push(part); continue; }
    out.push(m[1]);
    const idx = part.match(/\[(\d+)\]/g);
    if (idx) for (const i of idx) out.push(Number(i.replace(/[[\]]/g, '')));
  }
  return out;
}
function getPath(obj: any, path: string): any {
  let cur = obj;
  for (const t of tokenize(path)) { if (cur == null) return undefined; cur = cur[t as any]; }
  return cur;
}
function setPath(obj: any, path: string, value: any): any {
  const toks = tokenize(path);
  const root = Array.isArray(obj) ? [...obj] : { ...(obj || {}) };
  let cur: any = root;
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i];
    const nextIsIndex = typeof toks[i + 1] === 'number';
    const existing = cur[t as any];
    cur[t as any] = nextIsIndex
      ? (Array.isArray(existing) ? [...existing] : [])
      : (existing && typeof existing === 'object' ? { ...existing } : {});
    cur = cur[t as any];
  }
  cur[toks[toks.length - 1] as any] = value;
  return root;
}

export interface ActivityFormProps {
  activity: PipelineActivity;
  onPatch: (patch: Partial<PipelineActivity>) => void;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  allActivities: PipelineActivity[];
  /** Item id of the pipeline being edited — enables live helpers (e.g. the
   *  Approval activity's "Fetch trigger URL" call). Omit to hide them. */
  itemId?: string;
  /** Pipeline item id — enables Evaluate (F9) last-run sample pre-fill. */
  pipelineId?: string;
  /** Workspace id of the pipeline being edited. */
  workspaceId?: string;
  /** API slug for the editor host (default 'data-pipeline'). */
  apiSlug?: string;
  /**
   * Drill into a container activity's inner-activity sub-canvas. Threaded down
   * from the designer (which owns the drill-path model) so the container form's
   * "Edit inner activities" affordance navigates the EXISTING canvas instead of
   * rebuilding nesting here. Omit to hide the affordance's button.
   */
  onDrillInto?: (name: string) => void;
}

/**
 * Map the editor host API slug to the dataset / linked-service backend engine
 * the pickers self-fetch against. ADF (`data-pipeline`) is the default; a
 * Synapse-hosted pipeline editor passes a slug containing "synapse".
 */
function engineForSlug(apiSlug: string): DatasetProvider & LinkedServiceEngine {
  return /synapse/i.test(apiSlug) ? 'synapse' : 'adf';
}

const useFormStyles = makeStyles({
  innerCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4,
  },
  innerHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
  },
  branchRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
    padding: `${tokens.spacingVerticalXS} 0`,
  },
  branchList: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
  },
});

/**
 * Approval-specific helper rendered above the typed fields when the activity is
 * the Loom "Approval (Logic App)" kind. Calls the approval-logicapp BFF route to
 * provision/link the Consumption Logic App and populate the activity URL. Honest
 * gate (no-vaporware): a 503 surfaces the exact Bicep module + env var, never a
 * dead button.
 */
function ApprovalTriggerUrlFetcher({
  activity, onPatch, itemId, workspaceId, apiSlug,
}: {
  activity: PipelineActivity;
  onPatch: (patch: Partial<PipelineActivity>) => void;
  itemId?: string;
  workspaceId?: string;
  apiSlug: string;
}) {
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<{ reason: string; remediation: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const canFetch = !!itemId && !!workspaceId && itemId !== 'new';

  async function fetchUrl() {
    if (!canFetch) return;
    setBusy(true); setGate(null); setErr(null); setOk(null);
    try {
      const r = await clientFetch(
        `/api/items/${apiSlug}/${encodeURIComponent(itemId!)}/approval-logicapp` +
          `?workspaceId=${encodeURIComponent(workspaceId!)}`,
      );
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok && j.triggerUrl) {
        const tp = { ...((activity.typeProperties as Record<string, unknown>) || {}), url: j.triggerUrl };
        onPatch({ typeProperties: tp });
        setOk(`Linked Logic App "${j.workflowName}" — trigger URL populated.`);
        return;
      }
      if (j?.gate) { setGate(j.gate); return; }
      setErr(j?.error || `Request failed (${r.status}).`);
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS }}>
      <Caption1>
        The Approval activity posts to a Consumption Logic App that sends an Office 365
        approval email and calls back. Declare a <strong>string</strong> pipeline
        parameter <code>approverEmail</code> (Parameters tab) so each run can target a
        recipient. <strong>Approve</strong> continues the pipeline; <strong>Reject</strong> fails the branch.
      </Caption1>
      <div>
        <Button appearance="primary" size="small" disabled={!canFetch || busy} onClick={fetchUrl}>
          {busy ? <Spinner size="tiny" label="Linking…" /> : 'Fetch trigger URL'}
        </Button>
      </div>
      {!canFetch && (
        <Caption1>Save the pipeline first to enable automatic Logic App linking, or paste the trigger URL below.</Caption1>
      )}
      {ok && (
        <MessageBar intent="success">
          <MessageBarBody>{ok}</MessageBarBody>
        </MessageBar>
      )}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Approval Logic App not configured</MessageBarTitle>
            {gate.reason} {gate.remediation}
          </MessageBarBody>
        </MessageBar>
      )}
      {err && (
        <MessageBar intent="error">
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

// =============================================================================
// LEGACY flat-schema form (ACTIVITY_FORMS) — preserves every originally-wired
// activity form exactly (HDInsight cluster gate, Approval Logic-App fetcher,
// Wait/SetVariable/…). Activities WITHOUT a flat schema fall through to
// <CatalogSettingsForm/> below.
// =============================================================================
function LegacyActivityForm({
  schema, loomKind, activity, onPatch, parameters, variables, allActivities,
  itemId, workspaceId, apiSlug = 'data-pipeline', pipelineId,
}: ActivityFormProps & { schema: FieldSpec[]; loomKind?: string }) {
  const tp = (activity.typeProperties as any) || {};

  const patchTp = (path: string, value: unknown) => {
    onPatch({ typeProperties: setPath(tp, path, value) });
  };
  // Root-level patch (e.g. linkedServiceName.referenceName). Clone the whole
  // activity, set the dotted path, then emit only the touched top-level key so
  // sibling fields (type:'LinkedServiceReference') survive the merge.
  const patchRoot = (path: string, value: unknown) => {
    const cloned = JSON.parse(JSON.stringify(activity));
    const updated = setPath(cloned, path, value);
    const topKey = path.split('.')[0] as keyof PipelineActivity;
    onPatch({ [topKey]: (updated as any)[topKey] } as Partial<PipelineActivity>);
  };
  const patch = (fld: FieldSpec, value: unknown) =>
    (fld.rootPath ? patchRoot : patchTp)(fld.path, value);

  // Honest infra-gate: every HDInsight activity targets an AzureHDInsight
  // linked service. When none is set, name the env var + the manual step.
  const showHdiGate = HDI_ACTIVITY_TYPES.has(activity.type || '')
    && !activity.linkedServiceName?.referenceName;

  return (
    <>
      {showHdiGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No HDInsight cluster linked service configured</MessageBarTitle>
            Go to <strong>Manage → Linked services</strong>, create a linked service of type{' '}
            <code>Azure HDInsight</code> pointing at your cluster, then enter its name in the{' '}
            <em>HDI Cluster linked service</em> field below. Set{' '}
            <code>LOOM_HDINSIGHT_LINKED_SERVICE</code> in your deployment environment to pre-fill it
            automatically for new HDInsight activities.
          </MessageBarBody>
        </MessageBar>
      )}
      {loomKind === 'ApprovalWebhook' && (
        <ApprovalTriggerUrlFetcher
          activity={activity}
          onPatch={onPatch}
          itemId={itemId}
          workspaceId={workspaceId}
          apiSlug={apiSlug}
        />
      )}
      {schema.map((fld) => {
        const raw = fld.rootPath ? getPath(activity, fld.path) : getPath(tp, fld.path);
        const strVal = raw == null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        if (fld.kind === 'bool') {
          return (
            <Field key={fld.path} label={fld.label} hint={fld.hint}>
              <Switch checked={raw === true || raw === 'true'}
                onChange={(_, d) => patch(fld, d.checked)} />
            </Field>
          );
        }
        if (fld.kind === 'select') {
          return (
            <Field key={fld.path} label={fld.label} required={fld.required} hint={fld.hint}>
              <Dropdown
                value={strVal}
                selectedOptions={strVal ? [strVal] : []}
                onOptionSelect={(_, d) => patch(fld, d.optionValue)}
              >
                {(fld.options || []).map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
              </Dropdown>
            </Field>
          );
        }
        if (fld.kind === 'multiselect') {
          const selected: string[] = Array.isArray(raw) ? raw.map(String) : [];
          return (
            <Field key={fld.path} label={fld.label} required={fld.required} hint={fld.hint}>
              <Dropdown
                multiselect
                placeholder="Select one or more…"
                value={selected.join(', ')}
                selectedOptions={selected}
                onOptionSelect={(_, d) => patch(fld, d.selectedOptions)}
              >
                {(fld.options || []).map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
              </Dropdown>
            </Field>
          );
        }
        if (fld.kind === 'number') {
          return (
            <Field key={fld.path} label={fld.label} required={fld.required} hint={fld.hint}>
              <Input type="number" value={strVal} placeholder={fld.placeholder}
                onChange={(_, d) => patch(fld, d.value === '' ? undefined : Number(d.value))} />
            </Field>
          );
        }
        if (fld.kind === 'text') {
          return (
            <Field key={fld.path} label={fld.label} required={fld.required} hint={fld.hint}>
              <Input value={strVal} placeholder={fld.placeholder}
                onChange={(_, d) => patch(fld, d.value)} />
            </Field>
          );
        }
        // expr / expr-multiline
        return (
          <ExpressionField
            key={fld.path}
            label={fld.label}
            hint={fld.hint}
            required={fld.required}
            placeholder={fld.placeholder}
            multiline={fld.kind === 'expr-multiline'}
            supportsDynamic
            inForEach={activity.type === 'ForEach'}
            value={strVal}
            parameters={parameters}
            variables={variables}
            activities={allActivities}
            selfName={activity.name}
            pipelineId={pipelineId}
            workspaceId={workspaceId}
            onChange={(v) => patch(fld, v)}
          />
        );
      })}
    </>
  );
}

// =============================================================================
// CATALOG-DRIVEN form — the generic renderer over an ActivityDef.settings[]
// (ActivitySettingField). Covers EVERY activity in the ACTIVITIES inventory:
// Iteration & conditionals, Move & transform, Synapse, Databricks, HDInsight,
// General, Azure Function & ML. Per loom-no-freeform-config it renders typed
// Fluent controls — DatasetPicker for `ref:'dataset'` activities (Lookup /
// GetMetadata / Delete / Validation), LinkedServicePicker for
// `ref:'linkedService'` (StoredProcedure / Script / Databricks / HDInsight /
// Function / ML / U-SQL auth + log stores), and ExpressionField for any field
// ADF allows dynamic (`supportsDynamic`). Values round-trip on the real PUT.
// =============================================================================

/** Evaluate a field's `showIf` against the resolved typeProperties + root. */
function fieldVisible(field: ActivitySettingField, read: (path: string) => unknown): boolean {
  if (!field.showIf) return true;
  const cur = read(field.showIf.key);
  const want = field.showIf.equals;
  // Booleans compare against the string 'true'/'false' the inventory uses.
  if (typeof cur === 'boolean') return String(cur) === want;
  return (cur == null ? '' : String(cur)) === want;
}

/** Resolve a settings field's effective dotted path (key when no `path`). */
function fieldPath(field: ActivitySettingField): string {
  return field.path || field.key;
}

function CatalogFieldRenderer({
  field, activity, engine, onPatch, parameters, variables, allActivities,
  pipelineId, workspaceId, read,
}: {
  field: ActivitySettingField;
  activity: PipelineActivity;
  engine: DatasetProvider & LinkedServiceEngine;
  onPatch: (patch: Partial<PipelineActivity>) => void;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  allActivities: PipelineActivity[];
  pipelineId?: string;
  workspaceId?: string;
  /** Reader for showIf siblings (typeProperties- or root-relative per field). */
  read: (path: string) => unknown;
}) {
  const tp = (activity.typeProperties as any) || {};
  const path = fieldPath(field);

  const writeTp = (value: unknown) => onPatch({ typeProperties: setPath(tp, path, value) });
  const writeRoot = (value: unknown) => {
    const cloned = JSON.parse(JSON.stringify(activity));
    const updated = setPath(cloned, path, value);
    const topKey = path.split('.')[0] as keyof PipelineActivity;
    onPatch({ [topKey]: (updated as any)[topKey] } as Partial<PipelineActivity>);
  };
  const write = field.rootPath ? writeRoot : writeTp;

  const raw = field.rootPath ? getPath(activity, path) : getPath(tp, path);
  const strVal = raw == null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);

  // — Factory DATASET reference → DatasetPicker (self-fetching + create-new) —
  if (field.ref === 'dataset') {
    return (
      <DatasetSelectOrCreate
        label={field.label}
        value={typeof raw === 'string' ? raw : ''}
        required={field.required}
        hint={field.hint}
        provider={engine}
        onChange={(name) => write(name)}
      />
    );
  }

  // — MAPPING DATA FLOW reference → DataFlowPicker (lists published flows) —
  if (field.ref === 'dataFlow') {
    return (
      <DataFlowPicker
        label={field.label}
        required={field.required}
        hint={field.hint}
        provider={engine}
        value={typeof raw === 'string' ? raw : ''}
        onChange={(name) => write(name)}
      />
    );
  }

  // — LINKED-SERVICE reference → LinkedServicePicker (gallery + create-new) —
  if (field.ref === 'linkedService') {
    return (
      <LinkedServicePicker
        engine={engine}
        label={field.label}
        required={field.required}
        value={typeof raw === 'string' ? raw : ''}
        onSelected={(name) => write(name)}
      />
    );
  }

  if (field.kind === 'boolean') {
    return (
      <Field label={field.label} hint={field.hint}>
        <Switch checked={raw === true || raw === 'true'} onChange={(_, d) => write(d.checked)} />
      </Field>
    );
  }

  if (field.kind === 'select') {
    return (
      <Field label={field.label} required={field.required} hint={field.hint}>
        <Dropdown
          value={strVal}
          selectedOptions={strVal ? [strVal] : []}
          onOptionSelect={(_, d) => write(d.optionValue)}
        >
          {(field.options || []).map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
        </Dropdown>
      </Field>
    );
  }

  if (field.kind === 'number') {
    // A numeric field that ADF lets be dynamic must accept an @-expression.
    if (field.supportsDynamic) {
      return (
        <ExpressionField
          label={field.label} hint={field.hint} required={field.required}
          placeholder={field.placeholder} value={strVal} supportsDynamic
          inForEach={activity.type === 'ForEach'}
          parameters={parameters} variables={variables} activities={allActivities}
          selfName={activity.name} pipelineId={pipelineId} workspaceId={workspaceId}
          onChange={(v) => write(v === '' ? undefined : (isDynamicExpression(v) ? v : Number(v)))}
        />
      );
    }
    return (
      <Field label={field.label} required={field.required} hint={field.hint}>
        <Input type="number" value={strVal} placeholder={field.placeholder}
          onChange={(_, d) => write(d.value === '' ? undefined : Number(d.value))} />
      </Field>
    );
  }

  // text / multiline. Dynamic-capable fields bind ExpressionField; otherwise a
  // plain typed control (still no JSON textarea).
  if (field.supportsDynamic) {
    return (
      <ExpressionField
        label={field.label} hint={field.hint} required={field.required}
        placeholder={field.placeholder} multiline={field.kind === 'multiline'}
        supportsDynamic inForEach={activity.type === 'ForEach'}
        value={strVal} parameters={parameters} variables={variables}
        activities={allActivities} selfName={activity.name}
        pipelineId={pipelineId} workspaceId={workspaceId}
        onChange={(v) => write(v)}
      />
    );
  }
  return (
    <Field label={field.label} required={field.required} hint={field.hint}>
      <Input value={strVal} placeholder={field.placeholder} onChange={(_, d) => write(d.value)} />
    </Field>
  );
}

function CatalogSettingsForm({
  def, activity, onPatch, parameters, variables, allActivities,
  pipelineId, workspaceId, apiSlug = 'data-pipeline',
}: ActivityFormProps & { def: ActivityDef }) {
  const engine = engineForSlug(apiSlug);
  const tp = (activity.typeProperties as any) || {};
  // showIf siblings read against root for rootPath fields, else typeProperties.
  const read = (path: string) => getPath(tp, path);

  // Honest infra-gate: HDInsight activities target an AzureHDInsight cluster
  // linked service (the activity-root linkedServiceName). Surface the env var
  // when unset — same gate the legacy HDI forms show.
  const showHdiGate = HDI_ACTIVITY_TYPES.has(activity.type || '')
    && !activity.linkedServiceName?.referenceName;

  return (
    <>
      {showHdiGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No HDInsight cluster linked service configured</MessageBarTitle>
            Pick (or create) an <code>Azure HDInsight</code> linked service in the{' '}
            <em>HDI cluster linked service</em> field below, or set{' '}
            <code>LOOM_HDINSIGHT_LINKED_SERVICE</code> in your deployment to pre-fill it.
          </MessageBarBody>
        </MessageBar>
      )}
      {def.settings
        .filter((f) => fieldVisible(f, read))
        .map((field) => (
          <CatalogFieldRenderer
            key={fieldPath(field)}
            field={field}
            activity={activity}
            engine={engine}
            onPatch={onPatch}
            parameters={parameters}
            variables={variables}
            allActivities={allActivities}
            pipelineId={pipelineId}
            workspaceId={workspaceId}
            read={read}
          />
        ))}
    </>
  );
}

// =============================================================================
// SUB-ACTIVITY affordance — for control-flow containers (ForEach / If / Switch
// / Until). The canvas + drill-path model OWN nesting; this is a summary +
// "Edit inner activities" launcher that DRILLS the existing canvas via the
// designer-provided `onDrillInto` callback. It never rebuilds the canvas.
// =============================================================================
function SubActivityAffordance({
  activity, onDrillInto,
}: {
  activity: PipelineActivity;
  onDrillInto?: (name: string) => void;
}) {
  const s = useFormStyles();
  const branches = branchesOf(activity);
  const total = totalInnerCount(activity);
  if (branches.length === 0) return null;

  return (
    <div className={s.innerCard}>
      <div className={s.innerHead}>
        <Branch20Regular />
        <Subtitle2>Inner activities</Subtitle2>
        <Badge appearance="tint" color="brand" size="small">
          {total} total
        </Badge>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        {activity.type === 'ForEach' && 'Activities run once per item in the loop. '}
        {activity.type === 'Until' && 'Activities run repeatedly until the expression is true. '}
        {activity.type === 'IfCondition' && 'Activities run on the matching True / False branch. '}
        {activity.type === 'Switch' && 'Activities run on the matching case (or Default). '}
        Open the sub-canvas to add and wire the inner activities.
      </Caption1>
      <div className={s.branchList}>
        {branches.map((b) => (
          <div key={b.label} className={s.branchRow}>
            <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
              <Badge appearance="outline" size="small">{b.label}</Badge>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                {b.count} activit{b.count === 1 ? 'y' : 'ies'}
              </Caption1>
            </span>
          </div>
        ))}
      </div>
      <div>
        <Button
          appearance="primary"
          size="small"
          icon={onDrillInto ? <ArrowEnterRegular /> : <Open16Regular />}
          disabled={!onDrillInto}
          onClick={() => onDrillInto?.(activity.name)}
        >
          Edit inner activities
        </Button>
        {!onDrillInto && (
          <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXXS, color: tokens.colorNeutralForeground3 }}>
            Double-click the container on the canvas (or use its pencil button) to drill into its sub-canvas.
          </Caption1>
        )}
      </div>
    </div>
  );
}

/**
 * Renders the typed Settings form for the activity's type. Routing:
 *   1. A hand-tuned flat schema in ACTIVITY_FORMS (HDInsight / Approval / the
 *      originals) → render it verbatim (preserves every existing wiring).
 *   2. Otherwise a data-driven inventory entry (ACTIVITIES) → the generic
 *      CatalogSettingsForm (DatasetPicker / LinkedServicePicker / ExpressionField
 *      / typed controls) covering the rest of the ADF / Synapse activity set.
 *   3. Container activities (ForEach / If / Switch / Until) ALSO get the
 *      sub-activity affordance wired to the canvas drill-path.
 * Returns null only for activities with no schema, no inventory entry, and no
 * nesting (the caller then shows the raw-JSON fallback).
 */
// =============================================================================
// AI-enrich form (SVC-1 / SVC-8) — Document Intelligence / Vision / Language /
// Translator / Content Safety. Each activity is a real ADF WebActivity whose URL
// + request body are composed here from TYPED controls (dropdowns / multiselect /
// expression fields) — never a raw JSON textarea (loom-no-freeform-config). A
// live "Test on a sample" button hits the real cognitive backend via the
// preview BFF route (no-vaporware receipt). Honest gate: when the endpoint env
// var is unset the URL stays blank and a MessageBar names LOOM_<SVC>_ENDPOINT +
// the bicep module.
// =============================================================================

const AI_ENRICH_KINDS = new Set([
  'DocumentIntelligenceAnalyze', 'VisionAnalyzeImage',
  'LanguageAnalyzeText', 'TranslateText', 'ModerateText',
]);

const DOCINTEL_MODEL_OPTIONS = [
  'prebuilt-layout', 'prebuilt-read', 'prebuilt-document', 'prebuilt-invoice',
  'prebuilt-receipt', 'prebuilt-idDocument', 'prebuilt-businessCard',
];
const VISION_FEATURE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'Caption', label: 'Caption' },
  { id: 'DenseCaptions', label: 'Dense captions' },
  { id: 'Read', label: 'Read (OCR)' },
  { id: 'Tags', label: 'Tags' },
  { id: 'Objects', label: 'Objects' },
  { id: 'People', label: 'People' },
  { id: 'SmartCrops', label: 'Smart crops' },
];
const LANGUAGE_TASK_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'PiiEntityRecognition', label: 'PII detection / redaction' },
  { id: 'SentimentAnalysis', label: 'Sentiment' },
  { id: 'EntityRecognition', label: 'Entity recognition' },
  { id: 'KeyPhraseExtraction', label: 'Key phrases' },
];
const MODERATE_CATEGORY_OPTIONS = ['Hate', 'SelfHarm', 'Sexual', 'Violence'];

/** Recompute the WebActivity analyze URL for the given service + friendly config. */
function aiComposeUrl(service: AiEnrichService, endpoint: string, cfg: Record<string, any>): string {
  if (!endpoint) return '';
  switch (service) {
    case 'doc-intel':
      return `${endpoint}/documentintelligence/documentModels/${cfg.modelId || 'prebuilt-layout'}:analyze?api-version=2024-11-30`;
    case 'vision': {
      const feats = (Array.isArray(cfg.features) && cfg.features.length ? cfg.features : ['Caption', 'Read']).join(',');
      return `${endpoint}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=${encodeURIComponent(feats)}&language=${encodeURIComponent(cfg.language || 'en')}`;
    }
    case 'language':
      return `${endpoint}/language/:analyze-text?api-version=2024-11-01`;
    case 'translator': {
      const p = new URLSearchParams();
      p.set('api-version', '3.0');
      for (const t of (Array.isArray(cfg.to) && cfg.to.length ? cfg.to : ['fr'])) if (t) p.append('to', t);
      if (cfg.from) p.set('from', cfg.from);
      return `${endpoint}/translator/text/v3.0/translate?${p.toString()}`;
    }
    case 'content-safety':
      return `${endpoint}/contentsafety/text:analyze?api-version=2024-09-01`;
  }
}

function useAiEnrichStyles() {
  return useFormStyles();
}

function AiEnrichForm(props: ActivityFormProps & { loomKind: string }) {
  const { activity, onPatch, parameters, variables, allActivities } = props;
  const styles = useAiEnrichStyles();
  const up = Array.isArray(activity.userProperties) ? activity.userProperties : [];
  const service = (up.find((p) => p.name === '_loomService')?.value as AiEnrichService) || 'doc-intel';
  const endpoint = aiEnrichEndpoint(service);
  const serverVar = AI_ENRICH_SERVER_ENV[service];

  const tp = (activity.typeProperties as Record<string, any>) || {};
  const body = tp.body;

  // Parse friendly config out of the current URL + body so the controls are
  // controlled by the activity (no drift between the form and the saved WebActivity).
  const url: string = typeof tp.url === 'string' ? tp.url : '';
  const q = (() => { try { return new URL(url).searchParams; } catch { return new URLSearchParams(); } })();
  const modelId = (up.find((p) => p.name === '_loomModelId')?.value as string)
    || url.match(/documentModels\/([^:]+):analyze/)?.[1] || 'prebuilt-layout';
  const features = (q.get('features') || 'Caption,Read').split(',').filter(Boolean);
  const visionLang = q.get('language') || 'en';
  const toLangs = q.getAll('to');
  const fromLang = q.get('from') || '';

  const [busy, setBusy] = useState(false);
  const [testOk, setTestOk] = useState<string | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);

  /** Recompute url + body and patch the activity + carry the model discriminator. */
  function apply(nextCfg: Record<string, any>, nextBody: any, nextUserProps?: Array<{ name: string; value: string }>) {
    const nextUrl = aiComposeUrl(service, endpoint, nextCfg);
    onPatch({
      typeProperties: { ...tp, url: nextUrl, method: 'POST', body: nextBody },
      ...(nextUserProps ? { userProperties: nextUserProps } : {}),
    });
  }

  async function testSample() {
    setBusy(true); setTestOk(null); setTestErr(null);
    try {
      const sample = AI_ENRICH_SAMPLE[service];
      const r = await clientFetch(`/api/items/ai-enrich/${service}/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sample),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        setTestOk(JSON.stringify(j.result).slice(0, 300));
        return;
      }
      setTestErr(j?.gate?.hint || j?.error || `Request failed (${r.status}).`);
    } catch (e) {
      setTestErr((e as Error)?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const exprCommon = {
    parameters, variables, activities: allActivities,
    pipelineId: props.pipelineId, workspaceId: props.workspaceId, selfName: activity.name,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
      <Caption1>
        Azure AI enrichment — a real Data Factory <strong>Web activity</strong> calling the
        cognitive endpoint with the factory managed identity. Every field is a typed control;
        the request URL + body are composed for you.
      </Caption1>

      {!endpoint && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cognitive endpoint not configured</MessageBarTitle>
            Set <code>{serverVar}</code> (and its <code>NEXT_PUBLIC_</code> mirror) to a deployed
            Azure AI account endpoint. Provision it via
            {' '}<code>platform/fiab/bicep/modules/deploy-planner/cognitive-account.bicep</code>
            {' '}and grant the factory + Console UAMI <em>Cognitive Services User</em>. The activity
            still saves; it will run once the endpoint is set.
          </MessageBarBody>
        </MessageBar>
      )}

      {service === 'doc-intel' && (
        <>
          <Field label="Prebuilt model">
            <Dropdown
              value={modelId} selectedOptions={[modelId]}
              onOptionSelect={(_, d) => {
                const m = d.optionValue || 'prebuilt-layout';
                const nextUp: Array<{ name: string; value: string }> = [
                  ...up.filter((p) => p.name !== '_loomModelId').map((p) => ({ name: p.name, value: String(p.value ?? '') })),
                  { name: '_loomModelId', value: m },
                ];
                apply({ modelId: m }, body, nextUp);
              }}
            >
              {DOCINTEL_MODEL_OPTIONS.map((m) => <Option key={m} value={m}>{m}</Option>)}
            </Dropdown>
          </Field>
          <ExpressionField
            {...exprCommon}
            label="Source document URL (public or SAS)" required
            placeholder="@pipeline().parameters.documentUrl"
            value={typeof body?.urlSource === 'string' ? body.urlSource : ''}
            onChange={(v) => apply({ modelId }, { ...(body || {}), urlSource: v })}
          />
        </>
      )}

      {service === 'vision' && (
        <>
          <Field label="Visual features" hint="One or more Image Analysis 4.0 features.">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS }}>
              {VISION_FEATURE_OPTIONS.map((f) => (
                <Switch
                  key={f.id} label={f.label}
                  checked={features.includes(f.id)}
                  onChange={(_, d) => {
                    const next = d.checked ? [...features, f.id] : features.filter((x) => x !== f.id);
                    apply({ features: next, language: visionLang }, body);
                  }}
                />
              ))}
            </div>
          </Field>
          <Field label="Language (BCP-47)">
            <Input value={visionLang} onChange={(_, d) => apply({ features, language: d.value || 'en' }, body)} />
          </Field>
          <ExpressionField
            {...exprCommon}
            label="Image URL (public or SAS)" required
            placeholder="@pipeline().parameters.imageUrl"
            value={typeof body?.url === 'string' ? body.url : ''}
            onChange={(v) => apply({ features, language: visionLang }, { ...(body || {}), url: v })}
          />
        </>
      )}

      {service === 'language' && (() => {
        const doc = body?.analysisInput?.documents?.[0] || { id: '1', language: 'en', text: '' };
        const kind = typeof body?.kind === 'string' ? body.kind : 'PiiEntityRecognition';
        const setDoc = (patch: Record<string, any>, nextKind?: string) => {
          const nextDoc = { ...doc, ...patch };
          apply({}, { ...(body || {}), kind: nextKind || kind, analysisInput: { documents: [nextDoc] } });
        };
        return (
          <>
            <Field label="Task">
              <Dropdown
                value={LANGUAGE_TASK_OPTIONS.find((t) => t.id === kind)?.label || kind}
                selectedOptions={[kind]}
                onOptionSelect={(_, d) => setDoc({}, d.optionValue || 'PiiEntityRecognition')}
              >
                {LANGUAGE_TASK_OPTIONS.map((t) => <Option key={t.id} value={t.id}>{t.label}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Language (BCP-47)">
              <Input value={doc.language || 'en'} onChange={(_, d) => setDoc({ language: d.value || 'en' })} />
            </Field>
            <ExpressionField
              {...exprCommon}
              label="Text to analyze" required multiline
              placeholder="@item().comments"
              value={typeof doc.text === 'string' ? doc.text : ''}
              onChange={(v) => setDoc({ text: v })}
            />
          </>
        );
      })()}

      {service === 'translator' && (
        <>
          <Field label="Target languages" hint="Comma-separated BCP-47 codes, e.g. fr, de, es.">
            <Input
              value={toLangs.join(', ')}
              placeholder="fr, de"
              onChange={(_, d) => apply({ to: d.value.split(',').map((x) => x.trim()).filter(Boolean), from: fromLang }, body)}
            />
          </Field>
          <Field label="Source language (optional — auto-detected when blank)">
            <Input value={fromLang} onChange={(_, d) => apply({ to: toLangs, from: d.value.trim() }, body)} />
          </Field>
          <ExpressionField
            {...exprCommon}
            label="Text to translate" required multiline
            placeholder="@item().description"
            value={Array.isArray(body) && typeof body[0]?.Text === 'string' ? body[0].Text : ''}
            onChange={(v) => apply({ to: toLangs, from: fromLang }, [{ Text: v }])}
          />
        </>
      )}

      {service === 'content-safety' && (
        <>
          <Field label="Categories to screen" hint="Leave all off to screen every category.">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS }}>
              {MODERATE_CATEGORY_OPTIONS.map((c) => {
                const cats: string[] = Array.isArray(body?.categories) ? body.categories : [];
                return (
                  <Switch
                    key={c} label={c} checked={cats.includes(c)}
                    onChange={(_, d) => {
                      const next = d.checked ? [...cats, c] : cats.filter((x) => x !== c);
                      apply({}, { ...(body || {}), categories: next });
                    }}
                  />
                );
              })}
            </div>
          </Field>
          <ExpressionField
            {...exprCommon}
            label="Text to moderate" required multiline
            placeholder="@item().freeText"
            value={typeof body?.text === 'string' ? body.text : ''}
            onChange={(v) => apply({}, { ...(body || {}), text: v })}
          />
        </>
      )}

      <div className={styles.branchRow}>
        <Button appearance="primary" size="small" disabled={busy || !endpoint} onClick={testSample}>
          {busy ? <Spinner size="tiny" label="Testing…" /> : 'Test on a sample'}
        </Button>
        <Caption1>Runs the real cognitive call on a built-in sample.</Caption1>
      </div>
      {testOk && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Real response (first 300 chars)</MessageBarTitle>
            <code style={{ wordBreak: 'break-all' }}>{testOk}</code>
          </MessageBarBody>
        </MessageBar>
      )}
      {testErr && (
        <MessageBar intent="error"><MessageBarBody>{testErr}</MessageBarBody></MessageBar>
      )}
    </div>
  );
}

/** Built-in samples the "Test on a sample" button sends to the preview route. */
const AI_ENRICH_SAMPLE: Record<AiEnrichService, Record<string, unknown>> = {
  'doc-intel': {
    modelId: 'prebuilt-read',
    urlSource: 'https://raw.githubusercontent.com/Azure-Samples/cognitive-services-REST-api-samples/master/curl/form-recognizer/sample-invoice.pdf',
  },
  vision: {
    url: 'https://learn.microsoft.com/azure/ai-services/computer-vision/media/quickstarts/presentation.png',
    features: ['caption', 'read'],
  },
  language: { kind: 'KeyPhraseExtraction', text: 'The new analytics platform cut our reporting time from days to minutes.' },
  translator: { text: 'Hello, world.', to: ['fr', 'de'] },
  'content-safety': { text: 'You are a wonderful person and I appreciate your help.' },
};

export function ActivityForm(props: ActivityFormProps) {
  const { activity, onDrillInto } = props;
  // Discriminate Loom palette variants that share an ADF wire type (e.g.
  // Approval vs plain Webhook — both ADF type `WebHook`) via `_loomKind`.
  const loomKind = activityLoomKind(activity);
  // AI-enrichment activities (SVC-1/SVC-8) share the ADF `WebActivity` wire type
  // but render a dedicated typed form that composes the cognitive URL + body.
  if (loomKind && AI_ENRICH_KINDS.has(loomKind)) {
    return (
      <>
        <Caption1>
          Typed configuration for <strong>{activity.name}</strong> — Azure AI enrichment
          on the pipeline canvas.
        </Caption1>
        <AiEnrichForm {...props} loomKind={loomKind} />
      </>
    );
  }
  const flatSchema = (loomKind && ACTIVITY_FORMS[loomKind])
    ? ACTIVITY_FORMS[loomKind]
    : (activity.type ? ACTIVITY_FORMS[activity.type] : undefined);
  const def = activityByType(activity.type);
  const isContainer = !!def?.hasInnerActivities;

  const headerName = loomKind === 'ApprovalWebhook'
    ? 'Approval (Logic App)'
    : (def?.displayName || activity.type || 'activity');

  // Nothing to render structurally → let the caller fall back to raw JSON.
  if (!flatSchema && (!def || (def.settings.length === 0 && !isContainer))) return null;

  return (
    <>
      <Caption1>
        Typed configuration for <strong>{headerName}</strong> — the same fields the
        Azure portal / Fabric exposes. Expression fields offer <em>Add dynamic content</em> + IntelliSense.
      </Caption1>

      {flatSchema ? (
        <LegacyActivityForm {...props} schema={flatSchema} loomKind={loomKind} />
      ) : def && def.settings.length > 0 ? (
        <CatalogSettingsForm {...props} def={def} />
      ) : null}

      {isContainer && (
        <SubActivityAffordance activity={activity} onDrillInto={onDrillInto} />
      )}
    </>
  );
}
