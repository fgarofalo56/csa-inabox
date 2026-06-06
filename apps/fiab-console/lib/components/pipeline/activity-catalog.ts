/**
 * Activity catalog — single source of truth for every Fabric / ADF /
 * Synapse pipeline activity type, what bucket it lives in, what colour
 * the canvas tile gets, and the JSON template used when a user drags
 * one onto the canvas.
 *
 * Per .claude/rules/no-vaporware.md: every entry here must save through
 * adf-client.upsertPipeline. Activity types that ADF *does not* natively
 * support are marked `runnable: false` so the editor disables Run and
 * surfaces a precise MessageBar explaining the gap (e.g. "Office 365
 * Outlook activity requires Fabric pipelines — not available against
 * ADF backing").
 */

import type { PipelineActivity } from './types';

/**
 * Palette groups — match the Fabric / ADF "Activities" sidebar exactly:
 *   - Move & transform : Copy data, Dataflow Gen2, Mapping data flow, Lookup,
 *                        Get metadata, Delete
 *   - Orchestration    : Notebook, Spark job def, Execute pipeline, Script,
 *                        Stored procedure
 *   - Control flow     : ForEach, If condition, Switch, Until, Wait,
 *                        Set/Append variable, Filter, Web, Webhook, Fail,
 *                        Validation, Office 365 Outlook
 */
export type ActivityCategory = 'move-transform' | 'orchestration' | 'control-flow';

/** Fabric/ADF palette group display order + labels. */
export const ACTIVITY_CATEGORY_ORDER: Array<{ id: ActivityCategory; label: string }> = [
  { id: 'move-transform', label: 'Move & transform' },
  { id: 'orchestration',  label: 'Orchestration' },
  { id: 'control-flow',   label: 'Control flow' },
];

export interface ActivityTypeDef {
  /** Stable key shown in the palette. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Short description rendered in tooltip + property panel. */
  description: string;
  /** Palette category. */
  category: ActivityCategory;
  /** ADF-side type string (e.g. `Copy`, `DatabricksNotebook`). */
  type: string;
  /** Auto-name prefix when stamped onto the canvas. */
  namePrefix: string;
  /** Default tile background colour. */
  color: string;
  /** Foreground colour (white/black for contrast). */
  fg: string;
  /**
   * Whether the activity can actually execute end-to-end against the
   * deployed ADF / Synapse backing today. `false` means save+validate
   * works, but Run will surface a MessageBar.
   */
  runnable: boolean;
  /** Remediation note for non-runnable activities. */
  remediation?: string;
  /** Factory that returns a fresh activity JSON. */
  build: (name: string) => PipelineActivity;
}

export const ACTIVITY_CATALOG: ActivityTypeDef[] = [
  // ============ Move & transform ============
  {
    key: 'Copy', label: 'Copy data',
    description: 'Copy data between any supported source and sink.',
    category: 'move-transform', type: 'Copy', namePrefix: 'Copy',
    color: '#0078d4', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Copy', dependsOn: [],
      typeProperties: {
        source: { type: 'BlobSource' },
        sink: { type: 'BlobSink' },
        enableStaging: false,
      },
      inputs: [],
      outputs: [],
    }),
  },
  {
    key: 'DataflowGen2', label: 'Dataflow Gen2',
    description: 'Run a published Fabric Dataflow Gen2 (Power Query M).',
    category: 'move-transform', type: 'RefreshDataflow', namePrefix: 'Dataflow',
    color: '#7719aa', fg: '#fff', runnable: false,
    remediation: 'Dataflow Gen2 refresh is a Fabric-native activity. ADF backing exposes ExecuteDataFlow (mapping data flow) instead — drag that.',
    build: (name) => ({
      name, type: 'RefreshDataflow', dependsOn: [],
      typeProperties: { dataflow: { referenceName: '', type: 'DataflowReference' } },
    }),
  },
  {
    key: 'ExecuteDataFlow', label: 'Mapping data flow',
    description: 'Execute a published mapping data flow on an integration runtime.',
    category: 'move-transform', type: 'ExecuteDataFlow', namePrefix: 'DataFlow',
    color: '#7719aa', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'ExecuteDataFlow', dependsOn: [],
      typeProperties: {
        dataflow: { referenceName: '', type: 'DataFlowReference' },
        compute: { coreCount: 8, computeType: 'General' },
        traceLevel: 'Fine',
      },
    }),
  },
  {
    key: 'Lookup', label: 'Lookup',
    description: 'Read a single row or a row set from a dataset for downstream activities.',
    category: 'move-transform', type: 'Lookup', namePrefix: 'Lookup',
    color: '#5c2d91', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Lookup', dependsOn: [],
      typeProperties: {
        source: { type: 'AzureSqlSource' },
        dataset: { referenceName: '', type: 'DatasetReference' },
        firstRowOnly: true,
      },
    }),
  },
  {
    key: 'GetMetadata', label: 'Get metadata',
    description: 'Retrieve metadata (existence, size, item count, structure) of a dataset.',
    category: 'move-transform', type: 'GetMetadata', namePrefix: 'GetMetadata',
    color: '#5c2d91', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'GetMetadata', dependsOn: [],
      typeProperties: {
        dataset: { referenceName: '', type: 'DatasetReference' },
        fieldList: ['exists', 'itemName', 'lastModified'],
      },
    }),
  },
  {
    key: 'Delete', label: 'Delete data',
    description: 'Delete files or folders from a store after processing.',
    category: 'move-transform', type: 'Delete', namePrefix: 'Delete',
    color: '#a4262c', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Delete', dependsOn: [],
      typeProperties: {
        dataset: { referenceName: '', type: 'DatasetReference' },
        enableLogging: false,
        recursive: true,
      },
    }),
  },

  // ============ Orchestration ============
  {
    key: 'Notebook', label: 'Notebook',
    description: 'Run a Fabric / Synapse / Databricks notebook.',
    category: 'orchestration', type: 'DatabricksNotebook', namePrefix: 'Notebook',
    color: '#0078d4', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'DatabricksNotebook', dependsOn: [],
      typeProperties: { notebookPath: '', baseParameters: {} },
      linkedServiceName: { referenceName: '', type: 'LinkedServiceReference' },
    }),
  },
  {
    key: 'SparkJob', label: 'Spark Job Definition',
    description: 'Run a Synapse Spark batch job (JAR or .py).',
    category: 'orchestration', type: 'SynapseSparkJobDefinitionActivity', namePrefix: 'SparkJob',
    color: '#0a4f7a', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'SynapseSparkJobDefinitionActivity', dependsOn: [],
      typeProperties: {
        sparkJob: { referenceName: '', type: 'SparkJobDefinitionReference' },
      },
    }),
  },
  {
    key: 'ExecutePipeline', label: 'Invoke pipeline',
    description: 'Invoke another pipeline from this one (Execute Pipeline activity).',
    category: 'orchestration', type: 'ExecutePipeline', namePrefix: 'InvokePipeline',
    color: '#0078d4', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'ExecutePipeline', dependsOn: [],
      typeProperties: {
        pipeline: { referenceName: '', type: 'PipelineReference' },
        waitOnCompletion: true,
        parameters: {},
      },
    }),
  },
  {
    key: 'Script', label: 'Script',
    description: 'Run inline SQL / Hive / Pig / U-SQL against a linked service.',
    category: 'orchestration', type: 'Script', namePrefix: 'Script',
    color: '#3aaaaa', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Script', dependsOn: [],
      typeProperties: {
        scripts: [
          { type: 'Query', text: 'SELECT 1' },
        ],
        scriptBlockExecutionTimeout: '02:00:00',
      },
      linkedServiceName: { referenceName: '', type: 'LinkedServiceReference' },
    }),
  },
  {
    key: 'StoredProcedure', label: 'Stored procedure',
    description: 'Invoke a SQL stored procedure against a linked SQL server.',
    category: 'orchestration', type: 'SqlServerStoredProcedure', namePrefix: 'StoredProc',
    color: '#3aaaaa', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'SqlServerStoredProcedure', dependsOn: [],
      typeProperties: { storedProcedureName: '', storedProcedureParameters: {} },
      linkedServiceName: { referenceName: '', type: 'LinkedServiceReference' },
    }),
  },

  // ============ Control flow ============
  {
    key: 'Web', label: 'Web',
    description: 'Invoke a custom REST endpoint (GET/POST/PUT/DELETE).',
    category: 'control-flow', type: 'WebActivity', namePrefix: 'Web',
    color: '#107c10', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'WebActivity', dependsOn: [],
      typeProperties: { url: 'https://example.com', method: 'GET', headers: {} },
    }),
  },
  {
    key: 'Webhook', label: 'Webhook',
    description: 'Call an endpoint and pause until a callback URI signals completion.',
    category: 'control-flow', type: 'WebHook', namePrefix: 'Webhook',
    color: '#107c10', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'WebHook', dependsOn: [],
      typeProperties: { url: 'https://example.com/hook', method: 'POST', timeout: '00:10:00', headers: {} },
    }),
  },
  {
    // Approval activity — Azure-native parity for Fabric's "Office 365 Outlook →
    // Send approval email" + Power Automate approvals. Implemented as a native
    // ADF/Synapse WebHook activity that POSTs to a Consumption Logic App trigger.
    // ADF injects `callBackUri` into the POST body; the Logic App runs the O365
    // "Send approval email" action (blocks until the approver clicks Approve /
    // Reject) and POSTs {StatusCode, Output|Error} back to callBackUri. A 200
    // status continues the pipeline; a 400 fails the branch. No Fabric / Power
    // Automate dependency — see platform/fiab/bicep/modules/integration/
    // approval-logicapp.bicep.
    key: 'ApprovalWebhook', label: 'Approval (Logic App)',
    description:
      'Pause the pipeline and send an Office 365 approval email via a Consumption ' +
      'Logic App. Resumes when the approver clicks Approve or Reject. Requires ' +
      'approval-logicapp.bicep deployed and LOOM_APPROVAL_LOGIC_APP_NAME set; ' +
      'fetch the trigger URL in the Settings tab.',
    category: 'control-flow', type: 'WebHook', namePrefix: 'Approval',
    color: '#0062ad', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'WebHook', dependsOn: [],
      typeProperties: {
        url: '',
        method: 'POST',
        timeout: '04:00:00', // 4 h approval SLA; Logic Apps Consumption allows up to 90 d.
        headers: { 'Content-Type': 'application/json' },
        body: {
          value:
            "@json(concat('{\"pipelineName\":\"', pipeline().Pipeline, '\",\"runId\":\"', " +
            "pipeline().RunId, '\",\"approverEmail\":\"', pipeline().parameters.approverEmail, '\"}'))",
          type: 'Expression',
        },
        reportStatusOnCallBack: true,
      },
      // Discriminator so activity-forms renders the Approval form (not the plain
      // Webhook form) even though both share ADF wire type `WebHook`.
      userProperties: [{ name: '_loomKind', value: 'ApprovalWebhook' }],
    }),
  },
  {
    key: 'Fail', label: 'Fail',
    description: 'Stop the pipeline with a custom error message and error code.',
    category: 'control-flow', type: 'Fail', namePrefix: 'Fail',
    color: '#a4262c', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Fail', dependsOn: [],
      typeProperties: { message: 'Pipeline failed.', errorCode: '1' },
    }),
  },
  {
    key: 'Validation', label: 'Validation',
    description: 'Wait until a dataset exists / meets a condition before continuing.',
    category: 'control-flow', type: 'Validation', namePrefix: 'Validation',
    color: '#bd7800', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Validation', dependsOn: [],
      typeProperties: {
        dataset: { referenceName: '', type: 'DatasetReference' },
        timeout: '7.00:00:00',
        sleep: 10,
      },
    }),
  },
  {
    key: 'Office365Outlook', label: 'Office 365 Outlook',
    description: 'Send an email via an Office 365 connection.',
    category: 'control-flow', type: 'Office365OutlookSendEmail', namePrefix: 'Email',
    color: '#0062ad', fg: '#fff', runnable: false,
    remediation: 'Office 365 Outlook send-email is a Fabric pipeline activity. ADF backing has no native equivalent — use Web activity against Microsoft Graph instead.',
    build: (name) => ({
      name, type: 'Office365OutlookSendEmail', dependsOn: [],
      typeProperties: { to: '', subject: '', body: '' },
    }),
  },
  {
    key: 'SetVariable', label: 'Set variable',
    description: 'Set a pipeline-scoped variable.',
    category: 'control-flow', type: 'SetVariable', namePrefix: 'SetVar',
    color: '#444', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'SetVariable', dependsOn: [],
      typeProperties: { variableName: '', value: '' },
    }),
  },
  {
    key: 'AppendVariable', label: 'Append variable',
    description: 'Append a value to a pipeline array variable.',
    category: 'control-flow', type: 'AppendVariable', namePrefix: 'AppendVar',
    color: '#444', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'AppendVariable', dependsOn: [],
      typeProperties: { variableName: '', value: '' },
    }),
  },
  {
    key: 'Filter', label: 'Filter',
    description: 'Apply a filter expression to an input array.',
    category: 'control-flow', type: 'Filter', namePrefix: 'Filter',
    color: '#bd7800', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Filter', dependsOn: [],
      typeProperties: {
        items: { value: "@variables('items')", type: 'Expression' },
        condition: { value: '@equals(item(),1)', type: 'Expression' },
      },
    }),
  },
  {
    key: 'ForEach', label: 'ForEach',
    description: 'Iterate over an array, running child activities for each item.',
    category: 'control-flow', type: 'ForEach', namePrefix: 'ForEach',
    color: '#dca900', fg: '#000', runnable: true,
    build: (name) => ({
      name, type: 'ForEach', dependsOn: [],
      typeProperties: {
        items: { value: "@variables('items')", type: 'Expression' },
        isSequential: false,
        batchCount: 20,
        activities: [],
      },
    }),
  },
  {
    key: 'IfCondition', label: 'If condition',
    description: 'Branch the pipeline on a boolean expression.',
    category: 'control-flow', type: 'IfCondition', namePrefix: 'If',
    color: '#bd7800', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'IfCondition', dependsOn: [],
      typeProperties: {
        expression: { value: '@equals(1,1)', type: 'Expression' },
        ifTrueActivities: [],
        ifFalseActivities: [],
      },
    }),
  },
  {
    key: 'Switch', label: 'Switch',
    description: 'Branch the pipeline to one of N cases.',
    category: 'control-flow', type: 'Switch', namePrefix: 'Switch',
    color: '#bd7800', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Switch', dependsOn: [],
      typeProperties: {
        on: { value: "@variables('case')", type: 'Expression' },
        cases: [],
        defaultActivities: [],
      },
    }),
  },
  {
    key: 'Until', label: 'Until',
    description: 'Loop until an expression evaluates true.',
    category: 'control-flow', type: 'Until', namePrefix: 'Until',
    color: '#bd7800', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Until', dependsOn: [],
      typeProperties: {
        expression: { value: '@greater(1,0)', type: 'Expression' },
        timeout: '0.00:30:00',
        activities: [],
      },
    }),
  },
  {
    key: 'Wait', label: 'Wait',
    description: 'Pause for a fixed number of seconds.',
    category: 'control-flow', type: 'Wait', namePrefix: 'Wait',
    color: '#666', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'Wait', dependsOn: [],
      typeProperties: { waitTimeInSeconds: 5 },
    }),
  },
];

/** Lookup by ADF type string. */
export function findByType(type?: string): ActivityTypeDef | undefined {
  if (!type) return undefined;
  return ACTIVITY_CATALOG.find((a) => a.type === type);
}

/** Lookup by palette key. */
export function findByKey(key: string): ActivityTypeDef | undefined {
  return ACTIVITY_CATALOG.find((a) => a.key === key);
}

/**
 * Resolve the catalog def for a concrete activity instance. Some Loom palette
 * entries share an ADF wire `type` but differ by a `_loomKind` user property
 * (e.g. plain Webhook vs Approval — both ADF type `WebHook`). Prefer the
 * `_loomKind` match so the right label / colour / form is used; fall back to
 * the first type match.
 */
export function findForActivity(activity: PipelineActivity | null | undefined): ActivityTypeDef | undefined {
  if (!activity) return undefined;
  const kind = Array.isArray(activity.userProperties)
    ? (activity.userProperties.find((p) => p.name === '_loomKind')?.value as string | undefined)
    : undefined;
  if (kind) {
    const byKind = ACTIVITY_CATALOG.find((a) => a.key === kind);
    if (byKind) return byKind;
  }
  return findByType(activity.type);
}

/** All activities in a category, in palette order. */
export function byCategory(c: ActivityCategory): ActivityTypeDef[] {
  return ACTIVITY_CATALOG.filter((a) => a.category === c);
}

/** Auto-increment a fresh name for the given prefix. */
export function nextNameSuffix(activities: PipelineActivity[], prefix: string): number {
  let max = 0;
  for (const a of activities) {
    const name = a.name || '';
    if (!name.startsWith(prefix)) continue;
    const tail = name.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    const n = parseInt(tail, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}
