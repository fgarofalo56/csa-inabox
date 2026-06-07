'use client';

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

import { Field, Input, Dropdown, Option, Switch, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { ExpressionField } from './dynamic-content';
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

export function hasActivityForm(type: string | undefined): boolean {
  return !!type && Array.isArray(ACTIVITY_FORMS[type]) && ACTIVITY_FORMS[type].length > 0;
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
  /** Pipeline item id — enables Evaluate (F9) last-run sample pre-fill. */
  pipelineId?: string;
  /** Workspace id — used by the Evaluate pre-fill API call. */
  workspaceId?: string;
}

/** Renders the typed form for the activity's type, or null if none is defined. */
export function ActivityForm({ activity, onPatch, parameters, variables, allActivities, pipelineId, workspaceId }: ActivityFormProps) {
  const schema = activity.type ? ACTIVITY_FORMS[activity.type] : undefined;
  if (!schema) return null;
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
      <Caption1>
        Typed configuration for <strong>{activity.type}</strong> — the same fields the Azure portal exposes.
        Expression fields offer <em>Add dynamic content</em> + IntelliSense.
      </Caption1>
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
