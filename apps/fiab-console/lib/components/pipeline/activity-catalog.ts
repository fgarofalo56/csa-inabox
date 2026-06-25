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
import type { ConfigField } from '../../pipeline/connector-catalog';
// Type-only import — the canvas Web-5.0 visual system's 5-category enum. Used by
// the pure `canvasCategoryForType` helper below so non-kit callers/tests can
// resolve a pipeline activity's canvas accent category from this catalog.
// Type-only ⇒ no runtime cycle (the kit keeps its own inline category map).
import type { CanvasNodeCategory } from '@/lib/components/canvas/canvas-node-kit';

// Re-export ConfigField so callers can import the activity-settings field shape
// (the Wave-1 contract) straight from the activity catalog.
export type { ConfigField } from '../../pipeline/connector-catalog';

/**
 * Pre-fill the AzureHDInsight linked-service reference for new HDInsight
 * activities. NEXT_PUBLIC_LOOM_HDINSIGHT_LINKED_SERVICE is set by the
 * deployment (admin-plane bicep) and exposed client-side so the four
 * HDInsight activity templates stamp the cluster reference automatically.
 * When unset, the reference is left blank and activity-forms.tsx surfaces an
 * honest MessageBar gate naming LOOM_HDINSIGHT_LINKED_SERVICE.
 */
function hdiCluster(): string {
  return (typeof process !== 'undefined'
    && process.env?.NEXT_PUBLIC_LOOM_HDINSIGHT_LINKED_SERVICE) || '';
}

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
        enableSkipIncompatibleRow: false,
        validateDataConsistency: false,
        // dataIntegrationUnits / parallelCopies omitted = Auto.
        // translator omitted = default column-name mapping.
      },
      inputs: [],
      outputs: [],
    }),
  },
  {
    key: 'DataflowGen2', label: 'Dataflow Gen2',
    description:
      'Run a Power Query (M) dataflow on ADF Spark via ExecuteWranglingDataflow. ' +
      'On the Azure-native path Loom publishes a WranglingDataFlow resource and ' +
      'runs it; set LOOM_DATAFLOW_BACKEND=fabric + bind a workspace for the Fabric path.',
    category: 'move-transform', type: 'ExecuteWranglingDataflow', namePrefix: 'Dataflow',
    color: '#7719aa', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'ExecuteWranglingDataflow', dependsOn: [],
      typeProperties: {
        dataFlow: { referenceName: '', type: 'DataFlowReference' },
        integrationRuntime: { referenceName: 'AutoResolveIntegrationRuntime', type: 'IntegrationRuntimeReference' },
        compute: { computeType: 'General', coreCount: 8 },
      },
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

  // ---------- HDInsight family (F17) ----------
  // ADF natively supports all four HDInsight activity types at api-version
  // 2018-06-01 (the version adf-client.ts targets), so they save, validate,
  // and run end-to-end against the deployed factory. Each activity carries a
  // top-level `linkedServiceName` referencing an AzureHDInsight linked
  // service (the cluster). hdiCluster() pre-fills that reference from
  // NEXT_PUBLIC_LOOM_HDINSIGHT_LINKED_SERVICE; when it is unset
  // activity-forms.tsx renders an honest MessageBar gate naming
  // LOOM_HDINSIGHT_LINKED_SERVICE. No Fabric dependency — pure ADF + an
  // operator-registered Azure HDInsight cluster.
  {
    key: 'HDInsightHive', label: 'HDInsight Hive',
    description: 'Execute a Hive query (.hql) on an HDInsight cluster.',
    category: 'orchestration', type: 'HDInsightHive', namePrefix: 'HiveActivity',
    color: '#c05c1f', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'HDInsightHive', dependsOn: [],
      linkedServiceName: { referenceName: hdiCluster(), type: 'LinkedServiceReference' },
      typeProperties: {
        scriptLinkedService: { referenceName: '', type: 'LinkedServiceReference' },
        scriptPath: '',
        getDebugInfo: 'Failure',
        arguments: [],
        defines: {},
      },
    }),
  },
  {
    key: 'HDInsightSpark', label: 'HDInsight Spark',
    description: 'Run a Spark program (.py or .jar) on an HDInsight cluster.',
    category: 'orchestration', type: 'HDInsightSpark', namePrefix: 'SparkActivity',
    color: '#c05c1f', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'HDInsightSpark', dependsOn: [],
      linkedServiceName: { referenceName: hdiCluster(), type: 'LinkedServiceReference' },
      typeProperties: {
        sparkJobLinkedService: { referenceName: '', type: 'LinkedServiceReference' },
        rootPath: '',
        entryFilePath: '',
        getDebugInfo: 'Failure',
        arguments: [],
      },
    }),
  },
  {
    key: 'HDInsightMapReduce', label: 'HDInsight MapReduce',
    description: 'Run a MapReduce JAR on an HDInsight cluster.',
    category: 'orchestration', type: 'HDInsightMapReduce', namePrefix: 'MapReduceActivity',
    color: '#c05c1f', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'HDInsightMapReduce', dependsOn: [],
      linkedServiceName: { referenceName: hdiCluster(), type: 'LinkedServiceReference' },
      typeProperties: {
        className: '',
        jarLinkedService: { referenceName: '', type: 'LinkedServiceReference' },
        jarFilePath: '',
        getDebugInfo: 'Failure',
        arguments: [],
        defines: {},
      },
    }),
  },
  {
    key: 'HDInsightStreaming', label: 'HDInsight Streaming',
    description: 'Execute a Hadoop Streaming job (mapper + reducer) on an HDInsight cluster.',
    category: 'orchestration', type: 'HDInsightStreaming', namePrefix: 'StreamingActivity',
    color: '#c05c1f', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'HDInsightStreaming', dependsOn: [],
      linkedServiceName: { referenceName: hdiCluster(), type: 'LinkedServiceReference' },
      typeProperties: {
        mapper: '',
        reducer: '',
        combiner: '',
        fileLinkedService: { referenceName: '', type: 'LinkedServiceReference' },
        filePaths: [],
        input: '',
        output: '',
        getDebugInfo: 'Failure',
        arguments: [],
        defines: {},
      },
    }),
  },
  {
    key: 'HDInsightPig', label: 'HDInsight Pig',
    description: 'Execute a Pig Latin script (.pig) on an HDInsight cluster.',
    category: 'orchestration', type: 'HDInsightPig', namePrefix: 'PigActivity',
    color: '#c05c1f', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'HDInsightPig', dependsOn: [],
      linkedServiceName: { referenceName: hdiCluster(), type: 'LinkedServiceReference' },
      typeProperties: {
        scriptLinkedService: { referenceName: '', type: 'LinkedServiceReference' },
        scriptPath: '',
        getDebugInfo: 'Failure',
        arguments: [],
        defines: {},
      },
    }),
  },

  // ---------- Notebook / Spark families (Synapse + Databricks) ----------
  // Each is a native ADF/Synapse activity (api-version 2018-06-01). Synapse
  // Notebook binds a workspace notebook + Spark pool; the Databricks Jar/Python
  // activities bind an AzureDatabricks linked service (the workspace + cluster).
  {
    key: 'SynapseNotebook', label: 'Notebook (Synapse)',
    description: 'Run an Azure Synapse Analytics Spark notebook on a big-data pool, with parameters.',
    category: 'orchestration', type: 'SynapseNotebook', namePrefix: 'SynapseNotebook',
    color: '#0a4f7a', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'SynapseNotebook', dependsOn: [],
      typeProperties: {
        notebook: { referenceName: '', type: 'NotebookReference' },
        parameters: {},
      },
    }),
  },
  {
    key: 'DatabricksSparkJar', label: 'Jar (Databricks)',
    description: 'Run a JAR main class on an Azure Databricks cluster.',
    category: 'orchestration', type: 'DatabricksSparkJar', namePrefix: 'DatabricksJar',
    color: '#d04a02', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'DatabricksSparkJar', dependsOn: [],
      typeProperties: { mainClassName: '', parameters: [], libraries: [] },
      linkedServiceName: { referenceName: '', type: 'LinkedServiceReference' },
    }),
  },
  {
    key: 'DatabricksSparkPython', label: 'Python (Databricks)',
    description: 'Run a Python file on an Azure Databricks cluster (DBFS path), passing parameters.',
    category: 'orchestration', type: 'DatabricksSparkPython', namePrefix: 'DatabricksPython',
    color: '#d04a02', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'DatabricksSparkPython', dependsOn: [],
      typeProperties: { pythonFile: '', parameters: [], libraries: [] },
      linkedServiceName: { referenceName: '', type: 'LinkedServiceReference' },
    }),
  },

  // ---------- Azure Function & ML ----------
  // Native ADF/Synapse activities. Each binds the linked service for the target
  // backend (Function App / Azure ML workspace / Studio-classic web service /
  // Data Lake Analytics account) via the activity-root linkedServiceName.
  {
    key: 'AzureFunction', label: 'Azure Function',
    description: 'Call an Azure Function in a Function App via its Azure Function linked service.',
    category: 'orchestration', type: 'AzureFunctionActivity', namePrefix: 'AzureFunction',
    color: '#0062ad', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'AzureFunctionActivity', dependsOn: [],
      typeProperties: { functionName: '', method: 'POST', headers: {} },
      linkedServiceName: { referenceName: '', type: 'LinkedServiceReference' },
    }),
  },
  {
    key: 'AzureMLExecutePipeline', label: 'ML Execute Pipeline',
    description: 'Run a published Azure Machine Learning pipeline via an Azure ML linked service.',
    category: 'orchestration', type: 'AzureMLExecutePipeline', namePrefix: 'MLExecutePipeline',
    color: '#5c2d91', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'AzureMLExecutePipeline', dependsOn: [],
      typeProperties: { mlPipelineId: '' },
      linkedServiceName: { referenceName: '', type: 'LinkedServiceReference' },
    }),
  },
  {
    key: 'AzureMLBatchExecution', label: 'ML Batch Execution',
    description: 'Invoke an ML Studio (classic) batch execution web service.',
    category: 'orchestration', type: 'AzureMLBatchExecution', namePrefix: 'MLBatchExecution',
    color: '#5c2d91', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'AzureMLBatchExecution', dependsOn: [],
      typeProperties: { webServiceInputs: {}, webServiceOutputs: {}, globalParameters: {} },
      linkedServiceName: { referenceName: '', type: 'LinkedServiceReference' },
    }),
  },
  {
    key: 'DataLakeAnalyticsUSQL', label: 'U-SQL (Data Lake Analytics)',
    description: 'Run a U-SQL script on an Azure Data Lake Analytics account.',
    category: 'orchestration', type: 'DataLakeAnalyticsU-SQL', namePrefix: 'USQLActivity',
    color: '#3aaaaa', fg: '#fff', runnable: true,
    build: (name) => ({
      name, type: 'DataLakeAnalyticsU-SQL', dependsOn: [],
      typeProperties: {
        scriptPath: '',
        scriptLinkedService: { referenceName: '', type: 'LinkedServiceReference' },
      },
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
  // Migrate Fabric-era `RefreshDataflow` tiles (saved before the Azure-native
  // Dataflow Gen2 backend landed) onto the real ADF `ExecuteWranglingDataflow`
  // type so existing pipelines keep resolving + stay runnable.
  const normalised = type === 'RefreshDataflow' ? 'ExecuteWranglingDataflow' : type;
  return ACTIVITY_CATALOG.find((a) => a.type === normalised);
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

/**
 * Resolve an activity's Web-5.0 CANVAS category from this catalog — the single
 * data-driven mapping from a pipeline activity wire `type` (or palette key) to
 * the 5 canvas accent buckets (`move | transform | control | external |
 * iteration`). Pure + side-effect-free; reads only ACTIVITY_CATALOG / ACTIVITIES
 * (never a hand-kept list). Used by the canvas node/edge system + tests; the kit
 * keeps its own inline fallback map so there is no import cycle.
 *
 * Mapping (per the canvas visual spec):
 *   - Iteration & conditional CONTAINERS (ForEach / Until / IfCondition /
 *     Switch) ............................................... → 'iteration'
 *   - External integrations (Office 365 Outlook / Approval / Azure Function /
 *     Azure ML execute|batch / external REST call) ......... → 'external'
 *   - Palette `control-flow` (Web / Webhook / Fail / Validation / Set/Append
 *     var / Filter / Wait / Execute pipeline) .............. → 'control'
 *   - Palette `move-transform`, data-movement (Copy / Lookup / GetMetadata /
 *     Delete / mapping & wrangling data flow) .............. → 'move'
 *   - Palette `orchestration` + any remaining transform compute (Notebook /
 *     Spark / Script / Stored proc / Databricks / HDInsight / U-SQL) → 'transform'
 *   - Unmapped types fall through to 'transform' (generic compute bucket).
 */
export function canvasCategoryForType(type?: string): CanvasNodeCategory {
  if (!type) return 'transform';
  // Normalise the Fabric-era dataflow alias so it resolves like every other path.
  const normalised = type === 'RefreshDataflow' ? 'ExecuteWranglingDataflow' : type;

  // 1) Iteration & conditional containers (have nested child activities).
  const ITERATION_TYPES = new Set(['ForEach', 'Until', 'IfCondition', 'Switch']);
  if (ITERATION_TYPES.has(normalised)) return 'iteration';

  // 2) External integrations (cross-boundary REST / approval / ML service calls).
  //    Office 365 Outlook + the Approval Logic-App webhook are matched by their
  //    palette key (both share an ADF wire type) so the discriminator wins.
  const EXTERNAL_TYPES = new Set([
    'Office365OutlookSendEmail',
    'AzureFunctionActivity',
    'AzureMLExecutePipeline',
    'AzureMLBatchExecution',
  ]);
  const EXTERNAL_KEYS = new Set(['Office365Outlook', 'ApprovalWebhook', 'AzureFunction']);
  if (EXTERNAL_TYPES.has(normalised)) return 'external';
  const externalDef = ACTIVITY_CATALOG.find(
    (a) => a.type === normalised && EXTERNAL_KEYS.has(a.key),
  );
  if (externalDef) return 'external';

  // 3) Data-movement (the canonical Move & transform "move" set + data flows).
  const MOVE_TYPES = new Set([
    'Copy', 'Lookup', 'GetMetadata', 'Delete',
    'ExecuteDataFlow', 'ExecuteWranglingDataflow',
  ]);
  if (MOVE_TYPES.has(normalised)) return 'move';

  // 4) Resolve the remaining buckets from the palette category source of truth.
  const def = ACTIVITY_CATALOG.find((a) => a.type === normalised);
  if (def) {
    switch (def.category) {
      case 'control-flow':   return 'control';
      case 'move-transform': return 'move';   // any non-listed move-transform tile
      case 'orchestration':  return 'transform';
    }
  }

  // 5) Generic compute fallback.
  return 'transform';
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

// =============================================================================
// COMPLETE ADF / Synapse pipeline ACTIVITY INVENTORY (data-driven settings)
// =============================================================================
//
// WHY THIS SECTION EXISTS
// -----------------------
// The `ACTIVITY_CATALOG` above is the palette/canvas/build() source of truth
// (key, colour, icon, the default typeProperties stamped on drop). This second
// inventory — `ACTIVITIES` — is the DATA-DRIVEN SETTINGS spec: for every ADF /
// Synapse activity type it declares the exact `typeProperties` fields the
// portal's Settings tab exposes, as a `ConfigField[]` (the same Wave-1 shape
// the connector-catalog uses for linked-service/dataset forms). The
// properties-panel + activity-forms render structured Fluent controls from
// these specs (per loom-no-freeform-config + no-vaporware) — never a freeform
// `typeProperties` JSON textarea.
//
// Each field that ADF lets be a dynamic `@{…}` expression is marked
// `supportsDynamic: true`, so the renderer binds it to <ExpressionField/>
// (the "Add dynamic content" builder). Fields that reference a factory dataset
// or linked service set `ref: 'dataset' | 'linkedService'` so the renderer can
// swap in the dataset-wizard <DatasetPicker/> or linked-service-gallery
// <LinkedServicePicker/> instead of a plain text input.
//
// Every key + type string below is verbatim from the per-activity Microsoft
// Learn pages ("<activity> activity in Azure Data Factory") and the ARM
// `factories/pipelines` 2018-06-01 schema / `@azure/arm-datafactory` +
// `@azure/synapse-artifacts` models:
//   - control-flow-*           (ForEach/If/Switch/Until/Wait/Set/Append/Filter/
//                               Execute-pipeline/Web/WebHook/Fail/Validation)
//   - transform-data-*         (Notebook/Spark/Databricks/HDInsight/ML/U-SQL/sproc/script)
//   - control-flow-lookup / -get-metadata / delete-activity
//   - control-flow-azure-function-activity
//
// `referencesDataset` / `referencesLinkedService` summarise (per activity)
// whether it binds a dataset vs a linked service — surfaced as flags for the
// editor + the parity doc.

/**
 * Which kind of factory reference a settings field resolves to. The renderer
 * uses this to swap the plain text input for the dataset-wizard DatasetPicker
 * (`'dataset'`) or the linked-service-gallery LinkedServicePicker
 * (`'linkedService'`). `undefined` ⇒ a normal field (text/expr/select/…).
 */
export type ActivityFieldRef = 'dataset' | 'linkedService' | 'dataFlow';

/**
 * A single activity-settings field. Extends the Wave-1 `ConfigField` (key,
 * label, kind, required, options, placeholder, hint, secret, showIf,
 * supportsDynamic) with two activity-specific extras:
 *   - `path` — when the typeProperties key is nested (e.g. 'expression.value',
 *              'sparkPool.referenceName', 'scripts[0].text'), the dotted/indexed
 *              path activity-forms' get/setPath walks. Falls back to `key`.
 *   - `ref`  — bind to DatasetPicker / LinkedServicePicker (see ActivityFieldRef).
 */
export interface ActivitySettingField extends ConfigField {
  /** Dotted/indexed path under typeProperties when it differs from `key`. */
  path?: string;
  /** Resolve as a dataset / linked-service reference (swap in the picker). */
  ref?: ActivityFieldRef;
  /** When true the `path`/`key` resolves against the activity root object
   *  (e.g. 'linkedServiceName.referenceName') instead of typeProperties. */
  rootPath?: boolean;
}

/**
 * ADF / Fabric "Activities" pane categories, matching the portal section
 * headers used across the activity docs. These are the *settings*-inventory
 * categories (finer-grained than the 3 palette groups in ACTIVITY_CATEGORY_ORDER):
 *   - Iteration & conditionals  (control flow containers + variable/flow ops)
 *   - Move & transform          (Copy, data flow, Lookup, Get metadata, Delete)
 *   - Synapse                   (Notebook, Spark job definition)
 *   - Databricks                (Notebook, Jar, Python)
 *   - HDInsight                 (Hive, Pig, MapReduce, Spark, Streaming)
 *   - General                   (Web, Webhook, Stored procedure, Script, …)
 *   - Azure Function & ML       (Azure Function, ML execute/batch, U-SQL)
 */
export type ActivitySettingsCategory =
  | 'Iteration & conditionals'
  | 'Move & transform'
  | 'Synapse'
  | 'Databricks'
  | 'HDInsight'
  | 'General'
  | 'Azure Function & ML';

/** Display order of the settings-inventory categories. */
export const ACTIVITY_SETTINGS_CATEGORY_ORDER: ActivitySettingsCategory[] = [
  'Iteration & conditionals',
  'Move & transform',
  'Synapse',
  'Databricks',
  'HDInsight',
  'General',
  'Azure Function & ML',
];

/**
 * A complete activity-inventory entry. One per ADF/Synapse activity `type`
 * (Copy is REFERENCED here for completeness but its rich settings live in the
 * four-tab Copy editor, so its `settings` is empty + `copyTabbed: true`).
 */
export interface ActivityDef {
  /** ADF-side wire `type` (e.g. 'ForEach', 'DatabricksSparkJar'). */
  type: string;
  /** Human-readable name (matches the portal palette label). */
  displayName: string;
  /** Settings-inventory category. */
  category: ActivitySettingsCategory;
  /** One-line description (tooltip + property-panel header). */
  description: string;
  /** Data-driven Settings-tab field spec (rendered as structured controls). */
  settings: ActivitySettingField[];
  /** Containers (ForEach/If/Switch/Until) carry nested child activities[]. */
  hasInnerActivities: boolean;
  /** True when the activity binds a factory DATASET (Lookup/GetMetadata/Delete/Validation/Copy). */
  referencesDataset: boolean;
  /** True when the activity binds a LINKED SERVICE (sproc/Script/Databricks/HDInsight/Function/U-SQL/…). */
  referencesLinkedService: boolean;
  /** Copy's settings live in the dedicated four-tab editor, not `settings`. */
  copyTabbed?: boolean;
}

// ── Reusable field fragments (DRY; every key verbatim from ADF docs) ─────────

/** Activity-root linked-service reference (binds a LinkedServicePicker). */
function lsRef(label: string, hint?: string): ActivitySettingField {
  return {
    key: 'linkedServiceName.referenceName',
    path: 'linkedServiceName.referenceName',
    rootPath: true,
    ref: 'linkedService',
    label, kind: 'text', required: true, hint,
  };
}

/** A typeProperties dataset reference (binds a DatasetPicker). */
function datasetRef(
  key: string, label: string, hint?: string, required = true,
): ActivitySettingField {
  return {
    key, path: `${key}.referenceName`, ref: 'dataset',
    label, kind: 'text', required, hint,
  };
}

/** REST method dropdown (Web / Webhook / Azure Function). */
const METHOD_FIELD: ActivitySettingField = {
  key: 'method', label: 'Method', kind: 'select', required: true,
  options: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE']
    .map((m) => ({ value: m, label: m })),
};

const HDI_DEBUG_FIELD: ActivitySettingField = {
  key: 'getDebugInfo', label: 'Debug info', kind: 'select',
  options: ['None', 'Always', 'Failure'].map((v) => ({ value: v, label: v })),
  hint: 'When to capture YARN debug logs to the cluster default storage.',
};

/**
 * THE COMPLETE ACTIVITY INVENTORY. Every ADF/Synapse pipeline activity type
 * with its exact `typeProperties` field spec. Ordered by category for the
 * `activitiesByCategory()` grouping.
 */
export const ACTIVITIES: ActivityDef[] = [
  // ====================== Iteration & conditionals =========================
  {
    type: 'ForEach', displayName: 'ForEach',
    category: 'Iteration & conditionals',
    description: 'Iterate over an array, running a set of inner activities for each item (@item()). Parallel up to batchCount, or sequential.',
    hasInnerActivities: true, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'items', path: 'items.value', label: 'Items', kind: 'multiline', required: true,
        supportsDynamic: true, placeholder: "@activity('Lookup1').output.value",
        hint: 'Array to iterate. Reference each element with @item().' },
      { key: 'isSequential', label: 'Sequential', kind: 'boolean',
        hint: 'Off = parallel iterations (up to batch count).' },
      { key: 'batchCount', label: 'Batch count', kind: 'number',
        hint: 'Max parallel iterations (1–50) when not sequential.' },
    ],
  },
  {
    type: 'IfCondition', displayName: 'If Condition',
    category: 'Iteration & conditionals',
    description: 'Evaluate a boolean expression and run the ifTrue or ifFalse inner-activity branch.',
    hasInnerActivities: true, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'expression', path: 'expression.value', label: 'Expression', kind: 'multiline',
        required: true, supportsDynamic: true,
        placeholder: "@greater(activity('Lookup1').output.count, 0)",
        hint: 'Boolean expression; chooses the ifTrueActivities / ifFalseActivities branch.' },
    ],
  },
  {
    type: 'Switch', displayName: 'Switch',
    category: 'Iteration & conditionals',
    description: 'Evaluate an expression and run the matching case branch, or the default branch.',
    hasInnerActivities: true, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'on', path: 'on.value', label: 'On (expression)', kind: 'multiline', required: true,
        supportsDynamic: true, placeholder: "@activity('Lookup1').output.region",
        hint: 'Value matched against each case value; unmatched runs defaultActivities. Up to 25 cases.' },
    ],
  },
  {
    type: 'Until', displayName: 'Until',
    category: 'Iteration & conditionals',
    description: 'Run inner activities repeatedly until a boolean expression evaluates true (or timeout).',
    hasInnerActivities: true, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'expression', path: 'expression.value', label: 'Expression', kind: 'multiline',
        required: true, supportsDynamic: true,
        placeholder: "@equals(activity('Lookup1').output.firstRow.done, true)",
        hint: 'Loop exits when this boolean expression is true.' },
      { key: 'timeout', label: 'Timeout', kind: 'text', supportsDynamic: true, placeholder: '0.12:00:00',
        hint: 'Max duration (d.hh:mm:ss) before the loop fails. Default 7 days.' },
    ],
  },
  {
    type: 'Wait', displayName: 'Wait',
    category: 'Iteration & conditionals',
    description: 'Pause the pipeline for a fixed number of seconds before continuing.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'waitTimeInSeconds', label: 'Wait time (seconds)', kind: 'number', required: true,
        supportsDynamic: true, placeholder: '30',
        hint: 'Seconds to pause. Accepts an expression.' },
    ],
  },
  {
    type: 'SetVariable', displayName: 'Set Variable',
    category: 'Iteration & conditionals',
    description: 'Set a pipeline-scoped variable to a value (or set the pipeline return value).',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'variableName', label: 'Variable name', kind: 'text', required: true,
        hint: 'The pipeline variable to set (declared in the Variables tab).' },
      { key: 'value', label: 'Value', kind: 'multiline', supportsDynamic: true,
        placeholder: '@pipeline().RunId',
        hint: 'New value. Accepts an expression. (Cannot reference the same variable.)' },
    ],
  },
  {
    type: 'AppendVariable', displayName: 'Append Variable',
    category: 'Iteration & conditionals',
    description: 'Append a value to a pipeline-scoped Array variable.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'variableName', label: 'Variable name', kind: 'text', required: true,
        hint: 'An Array-typed pipeline variable.' },
      { key: 'value', label: 'Value to append', kind: 'multiline', supportsDynamic: true,
        hint: 'Item appended to the array. Accepts an expression.' },
    ],
  },
  {
    type: 'Filter', displayName: 'Filter',
    category: 'Iteration & conditionals',
    description: 'Apply a filter condition to an input array and return the matching subset.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'items', path: 'items.value', label: 'Items', kind: 'multiline', required: true,
        supportsDynamic: true, placeholder: "@activity('GetMetadata1').output.childItems",
        hint: 'The input array to filter.' },
      { key: 'condition', path: 'condition.value', label: 'Condition', kind: 'multiline', required: true,
        supportsDynamic: true, placeholder: "@endswith(item().name, '.csv')",
        hint: 'Boolean expression evaluated per element (@item()).' },
    ],
  },
  {
    type: 'ExecutePipeline', displayName: 'Execute Pipeline',
    category: 'Iteration & conditionals',
    description: 'Invoke another pipeline, optionally passing parameters and waiting on completion.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'pipeline', path: 'pipeline.referenceName', label: 'Invoked pipeline', kind: 'text',
        required: true, hint: 'Name of the pipeline to execute.' },
      { key: 'waitOnCompletion', label: 'Wait on completion', kind: 'boolean',
        hint: 'When on, the parent waits for the child pipeline to finish.' },
      { key: 'parameters', label: 'Parameters (object)', kind: 'multiline', supportsDynamic: true,
        hint: 'Key/value parameters passed to the invoked pipeline (object expression).' },
    ],
  },
  {
    type: 'Fail', displayName: 'Fail',
    category: 'Iteration & conditionals',
    description: 'Deliberately fail the pipeline with a custom error message and error code.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'message', label: 'Error message', kind: 'multiline', required: true,
        supportsDynamic: true, hint: 'Message surfaced in the run error. Accepts an expression.' },
      { key: 'errorCode', label: 'Error code', kind: 'text', required: true,
        supportsDynamic: true, placeholder: '1',
        hint: 'Custom error code for categorising the failure.' },
    ],
  },

  // ========================= Move & transform ==============================
  {
    type: 'Copy', displayName: 'Copy data',
    category: 'Move & transform',
    description: 'Copy data between any supported source and sink. Configured in the dedicated Source / Sink / Mapping / Settings tabs.',
    hasInnerActivities: false, referencesDataset: true, referencesLinkedService: true,
    copyTabbed: true,
    settings: [], // Copy uses the four-tab editor in lib/components/pipeline/copy/*.
  },
  {
    type: 'Lookup', displayName: 'Lookup',
    category: 'Move & transform',
    description: 'Read a single row or a row set from a source dataset for downstream activities.',
    hasInnerActivities: false, referencesDataset: true, referencesLinkedService: false,
    settings: [
      datasetRef('dataset', 'Source dataset', 'Dataset to read from (file, table, or query source).'),
      { key: 'firstRowOnly', label: 'First row only', kind: 'boolean',
        hint: 'Return only the first row (output.firstRow) vs the full row set (output.value).' },
    ],
  },
  {
    type: 'GetMetadata', displayName: 'Get Metadata',
    category: 'Move & transform',
    description: 'Retrieve metadata (existence, size, item count, structure, last-modified) of a dataset.',
    hasInnerActivities: false, referencesDataset: true, referencesLinkedService: false,
    settings: [
      datasetRef('dataset', 'Dataset', 'The file, folder, or table dataset to inspect.'),
      { key: 'fieldList', label: 'Field list', kind: 'select', required: true,
        hint: 'Which metadata fields to return. Multiple selectable; reference via @activity(…).output.<field>.',
        options: [
          'itemName', 'itemType', 'size', 'created', 'lastModified', 'childItems',
          'contentMD5', 'structure', 'columnCount', 'exists',
        ].map((v) => ({ value: v, label: v })) },
    ],
  },
  {
    type: 'Delete', displayName: 'Delete',
    category: 'Move & transform',
    description: 'Delete files or folders from a store, with optional recursive delete and a logging store.',
    hasInnerActivities: false, referencesDataset: true, referencesLinkedService: true,
    settings: [
      datasetRef('dataset', 'Dataset', 'The file/folder dataset to delete.'),
      { key: 'recursive', label: 'Recursive', kind: 'boolean',
        hint: 'Delete files in all subfolders, not just the top level.' },
      { key: 'enableLogging', label: 'Enable logging', kind: 'boolean',
        hint: 'Write the list of deleted files to a log store (set the logging linked service below).' },
      { key: 'maxConcurrentConnections', label: 'Max concurrent connections', kind: 'number',
        hint: 'Parallel connections to the store when deleting.' },
      { key: 'logStorageSettings.linkedServiceName', path: 'logStorageSettings.linkedServiceName.referenceName',
        ref: 'linkedService', label: 'Logging linked service', kind: 'text',
        showIf: { key: 'enableLogging', equals: 'true' },
        hint: 'Blob / ADLS Gen2 linked service the delete log is written to.' },
    ],
  },
  {
    type: 'ExecuteDataFlow', displayName: 'Data flow',
    category: 'Move & transform',
    description: 'Execute a published mapping data flow on an integration runtime (Spark compute).',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'dataflow', path: 'dataflow.referenceName', label: 'Data flow', kind: 'text', required: true,
        ref: 'dataFlow', hint: 'The mapping data flow to run.' },
      { key: 'compute.computeType', label: 'Compute type', kind: 'select',
        options: [
          { value: 'General', label: 'General purpose' },
          { value: 'MemoryOptimized', label: 'Memory optimized' },
          { value: 'ComputeOptimized', label: 'Compute optimized' },
        ] },
      { key: 'compute.coreCount', label: 'Core count', kind: 'number', hint: '8, 16, 32, 48, 80, 144, or 272.' },
      { key: 'traceLevel', label: 'Logging level', kind: 'select',
        options: ['None', 'Coarse', 'Fine'].map((v) => ({ value: v, label: v })) },
    ],
  },
  {
    type: 'ExecuteWranglingDataflow', displayName: 'Dataflow Gen2 (Power Query)',
    category: 'Move & transform',
    description: 'Run a Power Query (M) wrangling data flow on ADF Spark. Azure-native default; Fabric opt-in via LOOM_DATAFLOW_BACKEND.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'dataFlow', path: 'dataFlow.referenceName', label: 'Wrangling data flow', kind: 'text',
        required: true, hint: 'The published WranglingDataFlow resource to run.' },
      { key: 'compute.computeType', label: 'Compute type', kind: 'select',
        options: [
          { value: 'General', label: 'General purpose' },
          { value: 'MemoryOptimized', label: 'Memory optimized' },
          { value: 'ComputeOptimized', label: 'Compute optimized' },
        ] },
      { key: 'compute.coreCount', label: 'Core count', kind: 'number' },
    ],
  },

  // ============================= Synapse ===================================
  {
    type: 'SynapseNotebook', displayName: 'Notebook (Synapse)',
    category: 'Synapse',
    description: 'Run an Azure Synapse Analytics Spark notebook on a big-data (Spark) pool, with parameters.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'notebook', path: 'notebook.referenceName', label: 'Notebook', kind: 'text', required: true,
        hint: 'The Synapse notebook to run.' },
      { key: 'sparkPool', path: 'sparkPool.referenceName', label: 'Spark pool', kind: 'text',
        hint: 'Big-data (Apache Spark) pool used to execute the notebook.' },
      { key: 'parameters', label: 'Parameters (object)', kind: 'multiline', supportsDynamic: true,
        hint: 'Values for the notebook parameters cell (object expression).' },
      { key: 'executorSize', label: 'Executor size', kind: 'select',
        options: ['Small', 'Medium', 'Large', 'XLarge', 'XXLarge'].map((v) => ({ value: v, label: v })),
        hint: 'Overrides the notebook executor cores/memory.' },
      { key: 'driverSize', label: 'Driver size', kind: 'select',
        options: ['Small', 'Medium', 'Large', 'XLarge', 'XXLarge'].map((v) => ({ value: v, label: v })) },
      { key: 'numExecutors', label: 'Executors', kind: 'number',
        hint: 'Number of executors to allocate for the session.' },
    ],
  },
  {
    type: 'SparkJob', displayName: 'Spark Job Definition (Synapse)',
    category: 'Synapse',
    description: 'Run a Synapse Spark job definition (JAR or .py batch job) on a big-data pool.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'sparkJob', path: 'sparkJob.referenceName', label: 'Spark job definition', kind: 'text',
        required: true, hint: 'The Synapse Spark job definition to run.' },
      { key: 'args', label: 'Command-line arguments', kind: 'multiline', supportsDynamic: true,
        hint: 'Optional arguments passed to the job (array expression).' },
      { key: 'targetBigDataPool.referenceName', label: 'Spark pool override', kind: 'text',
        hint: 'Override the Spark pool defined on the job definition.' },
      { key: 'executorSize', label: 'Executor size', kind: 'select',
        options: ['Small', 'Medium', 'Large', 'XLarge', 'XXLarge'].map((v) => ({ value: v, label: v })) },
      { key: 'numExecutors', label: 'Executors', kind: 'number' },
    ],
  },

  // ============================ Databricks =================================
  {
    type: 'DatabricksNotebook', displayName: 'Notebook (Databricks)',
    category: 'Databricks',
    description: 'Run an Azure Databricks notebook on a job/interactive cluster, passing base parameters and libraries.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('Databricks linked service', 'AzureDatabricks linked service (the workspace + cluster).'),
      { key: 'notebookPath', label: 'Notebook path', kind: 'text', required: true,
        supportsDynamic: true, placeholder: '/Workspace/Repos/csa-loom/medallion/bronze',
        hint: 'Absolute path of the notebook in the Databricks workspace.' },
      { key: 'baseParameters', label: 'Base parameters (object)', kind: 'multiline', supportsDynamic: true,
        hint: 'Widget parameters passed to the notebook (object of name→value).' },
      { key: 'libraries', label: 'Libraries (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'Extra libraries to install: jar/egg/whl/maven/pypi/cran entries.' },
    ],
  },
  {
    type: 'DatabricksSparkJar', displayName: 'Jar (Databricks)',
    category: 'Databricks',
    description: 'Run a JAR main class on an Azure Databricks cluster (the JAR must be provided as a library).',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('Databricks linked service', 'AzureDatabricks linked service.'),
      { key: 'mainClassName', label: 'Main class name', kind: 'text', required: true,
        supportsDynamic: true, placeholder: 'org.example.MyJob',
        hint: 'Full class name containing the main method (must be in a JAR library).' },
      { key: 'parameters', label: 'Parameters (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'Arguments passed to the main method (array of strings).' },
      { key: 'libraries', label: 'Libraries (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'Libraries to install on the cluster (must include the JAR).' },
    ],
  },
  {
    type: 'DatabricksSparkPython', displayName: 'Python (Databricks)',
    category: 'Databricks',
    description: 'Run a Python file on an Azure Databricks cluster (DBFS path), passing command-line parameters.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('Databricks linked service', 'AzureDatabricks linked service.'),
      { key: 'pythonFile', label: 'Python file (DBFS URI)', kind: 'text', required: true,
        supportsDynamic: true, placeholder: 'dbfs:/scripts/transform.py',
        hint: 'URI of the Python file to execute. DBFS paths supported.' },
      { key: 'parameters', label: 'Parameters (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'Command-line parameters passed to the Python file (array of strings).' },
      { key: 'libraries', label: 'Libraries (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'Libraries to install on the cluster.' },
    ],
  },

  // ============================= HDInsight =================================
  {
    type: 'HDInsightHive', displayName: 'Hive (HDInsight)',
    category: 'HDInsight',
    description: 'Execute a Hive query (.hql) on an HDInsight cluster.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('HDI cluster linked service', 'AzureHDInsight linked service (the cluster). Pre-filled from LOOM_HDINSIGHT_LINKED_SERVICE.'),
      { key: 'scriptLinkedService.referenceName', ref: 'linkedService',
        label: 'Script storage linked service', kind: 'text',
        hint: 'Blob / ADLS Gen2 linked service holding the .hql file. Omit for cluster default storage.' },
      { key: 'scriptPath', label: 'Script path (.hql)', kind: 'text', required: true,
        supportsDynamic: true, placeholder: 'scripts/transform.hql' },
      HDI_DEBUG_FIELD,
      { key: 'queryTimeout', label: 'Query timeout (minutes)', kind: 'number',
        hint: 'Required when the cluster has the Enterprise Security Package. Default 120.' },
      { key: 'arguments', label: 'Arguments (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'Hive command-line arguments (array expression). `defines` go in raw JSON.' },
    ],
  },
  {
    type: 'HDInsightPig', displayName: 'Pig (HDInsight)',
    category: 'HDInsight',
    description: 'Execute a Pig Latin script (.pig) on an HDInsight cluster.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('HDI cluster linked service', 'AzureHDInsight linked service (the cluster).'),
      { key: 'scriptLinkedService.referenceName', ref: 'linkedService',
        label: 'Script storage linked service', kind: 'text',
        hint: 'Blob / ADLS Gen2 linked service holding the .pig file. Omit for cluster default storage.' },
      { key: 'scriptPath', label: 'Script path (.pig)', kind: 'text', required: true,
        supportsDynamic: true, placeholder: 'scripts/transform.pig' },
      HDI_DEBUG_FIELD,
      { key: 'arguments', label: 'Arguments (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'Pig command-line arguments (array expression).' },
    ],
  },
  {
    type: 'HDInsightMapReduce', displayName: 'MapReduce (HDInsight)',
    category: 'HDInsight',
    description: 'Run a MapReduce JAR program on an HDInsight cluster.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('HDI cluster linked service', 'AzureHDInsight linked service (the cluster).'),
      { key: 'className', label: 'Main class', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'org.apache.hadoop.examples.WordCount',
        hint: 'Fully-qualified Java class name to execute.' },
      { key: 'jarLinkedService.referenceName', ref: 'linkedService',
        label: 'JAR storage linked service', kind: 'text',
        hint: 'Blob / ADLS Gen2 linked service holding the JAR. Omit for cluster default storage.' },
      { key: 'jarFilePath', label: 'JAR file path', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'jars/myjob-1.0.jar' },
      HDI_DEBUG_FIELD,
      { key: 'arguments', label: 'Arguments (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'MapReduce arguments (array expression). `jarlibs`/`defines` go in raw JSON.' },
    ],
  },
  {
    type: 'HDInsightSpark', displayName: 'Spark (HDInsight)',
    category: 'HDInsight',
    description: 'Run a Spark program (.py or .jar) on an HDInsight cluster.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('HDI cluster linked service', 'AzureHDInsight linked service (the cluster).'),
      { key: 'sparkJobLinkedService.referenceName', ref: 'linkedService',
        label: 'Job storage linked service', kind: 'text',
        hint: 'Blob / ADLS Gen2 linked service containing the root path. Omit for cluster default storage.' },
      { key: 'rootPath', label: 'Root path (container/folder)', kind: 'text', required: true,
        supportsDynamic: true, placeholder: 'adfspark/myjob',
        hint: 'Container + folder holding the entry file plus optional /jars and /pyFiles.' },
      { key: 'entryFilePath', label: 'Entry file path (.py / .jar)', kind: 'text', required: true,
        supportsDynamic: true, placeholder: 'main.py',
        hint: 'Relative path under the root path to the entry file.' },
      { key: 'className', label: 'Java / Spark main class', kind: 'text', supportsDynamic: true,
        placeholder: 'org.example.MyJob', hint: 'Required when the entry file is a JAR.' },
      HDI_DEBUG_FIELD,
      { key: 'arguments', label: 'Arguments (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'Spark command-line arguments (array expression). `sparkConfig` goes in raw JSON.' },
    ],
  },
  {
    type: 'HDInsightStreaming', displayName: 'Streaming (HDInsight)',
    category: 'HDInsight',
    description: 'Execute a Hadoop Streaming job (mapper + reducer) on an HDInsight cluster.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('HDI cluster linked service', 'AzureHDInsight linked service (the cluster).'),
      { key: 'mapper', label: 'Mapper executable', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'MyMapper.exe' },
      { key: 'reducer', label: 'Reducer executable', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'MyReducer.exe' },
      { key: 'combiner', label: 'Combiner executable', kind: 'text', supportsDynamic: true,
        placeholder: 'MyCombiner.exe', hint: 'Optional intermediate combiner.' },
      { key: 'fileLinkedService.referenceName', ref: 'linkedService',
        label: 'File storage linked service', kind: 'text',
        hint: 'Blob / ADLS Gen2 linked service holding the mapper/reducer/combiner files.' },
      { key: 'input', label: 'Input path (WASB)', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'wasb://<container>@<account>.blob.core.windows.net/input/data.txt' },
      { key: 'output', label: 'Output path (WASB)', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'wasb://<container>@<account>.blob.core.windows.net/output/' },
      { key: 'filePaths', label: 'File paths (array)', kind: 'multiline', required: true, supportsDynamic: true,
        hint: 'Paths to the mapper, combiner, and reducer programs (array expression).' },
      HDI_DEBUG_FIELD,
      { key: 'arguments', label: 'Arguments (array)', kind: 'multiline', supportsDynamic: true,
        hint: 'Extra streaming arguments (array expression).' },
    ],
  },

  // ============================== General ==================================
  {
    type: 'SqlServerStoredProcedure', displayName: 'Stored procedure',
    category: 'General',
    description: 'Invoke a SQL stored procedure against an Azure SQL / SQL MI / Synapse / SQL Server linked service.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('SQL linked service', 'Azure SQL Database / SQL MI / Synapse / SQL Server linked service.'),
      { key: 'storedProcedureName', label: 'Stored procedure name', kind: 'text', required: true,
        supportsDynamic: true, placeholder: '[dbo].[usp_LoadGold]' },
      { key: 'storedProcedureParameters', label: 'Parameters (name → {value,type})', kind: 'multiline',
        supportsDynamic: true,
        hint: 'e.g. {"param1":{"value":"1","type":"Int32"}}. For null use {"value":null}.' },
    ],
  },
  {
    type: 'Script', displayName: 'Script',
    category: 'General',
    description: 'Run inline SQL/DDL/DML scripts (or queries) against a SQL-family linked service, with optional log settings.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('SQL linked service', 'Azure SQL / SQL MI / Synapse / SQL Server linked service the script runs against.'),
      { key: 'scripts[0].type', label: 'Script type', kind: 'select',
        options: [
          { value: 'Query', label: 'Query (returns rows)' },
          { value: 'NonQuery', label: 'NonQuery (DDL/DML)' },
        ] },
      { key: 'scripts[0].text', label: 'Script', kind: 'multiline', required: true, supportsDynamic: true,
        placeholder: 'SELECT COUNT(*) FROM gold.fact_sales' },
      { key: 'scriptBlockExecutionTimeout', label: 'Block execution timeout', kind: 'text',
        placeholder: '02:00:00', hint: 'Per-block timeout (hh:mm:ss).' },
      { key: 'logSettings.logDestination', label: 'Log destination', kind: 'select',
        options: [
          { value: 'ActivityOutput', label: 'Activity output' },
          { value: 'ExternalStore', label: 'External store' },
        ],
        hint: 'Where script status/results logs go.' },
      { key: 'logSettings.logLocationSettings.linkedServiceName.referenceName', ref: 'linkedService',
        label: 'Log store linked service', kind: 'text',
        showIf: { key: 'logSettings.logDestination', equals: 'ExternalStore' },
        hint: 'Blob / ADLS Gen2 linked service for the external log store.' },
    ],
  },
  {
    type: 'WebActivity', displayName: 'Web',
    category: 'General',
    description: 'Call a custom REST endpoint (GET/POST/PUT/DELETE) with headers, body, and authentication.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'url', label: 'URL', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'https://api.example.com/run' },
      { key: 'method', label: 'Method', kind: 'select', required: true,
        options: ['GET', 'POST', 'PUT', 'DELETE'].map((m) => ({ value: m, label: m })) },
      { key: 'headers', label: 'Headers (object)', kind: 'multiline', supportsDynamic: true,
        hint: 'e.g. {"Content-Type":"application/json"}.' },
      { key: 'body', label: 'Body', kind: 'multiline', supportsDynamic: true,
        hint: 'Request body (required for POST/PUT). Accepts an expression.' },
      { key: 'authentication.type', label: 'Authentication', kind: 'select',
        options: [
          { value: 'None', label: 'None' },
          { value: 'Basic', label: 'Basic' },
          { value: 'ClientCertificate', label: 'Client certificate' },
          { value: 'MSI', label: 'Managed identity' },
          { value: 'ServicePrincipal', label: 'Service principal' },
        ] },
      { key: 'authentication.resource', label: 'MSI / SP resource', kind: 'text', supportsDynamic: true,
        showIf: { key: 'authentication.type', equals: 'MSI' },
        hint: 'AAD resource the token is requested for (MSI / service principal auth).' },
    ],
  },
  {
    type: 'WebHook', displayName: 'Webhook',
    category: 'General',
    description: 'Call an endpoint and pause until the called service POSTs back to the injected callBackUri (or timeout).',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: false,
    settings: [
      { key: 'url', label: 'URL', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'https://api.example.com/callback' },
      { key: 'method', label: 'Method', kind: 'select', required: true,
        options: [{ value: 'POST', label: 'POST' }] },
      { key: 'timeout', label: 'Timeout', kind: 'text', placeholder: '00:10:00',
        hint: 'How long to wait for the callBackUri before failing (hh:mm:ss / d.hh:mm:ss).' },
      { key: 'headers', label: 'Headers (object)', kind: 'multiline', supportsDynamic: true },
      { key: 'body', label: 'Body', kind: 'multiline', supportsDynamic: true,
        hint: 'Request body. ADF injects callBackUri automatically.' },
      { key: 'reportStatusOnCallBack', label: 'Report status on callback', kind: 'boolean',
        hint: 'Let the callback report a failure status back to the activity.' },
    ],
  },
  {
    type: 'Validation', displayName: 'Validation',
    category: 'General',
    description: 'Block the pipeline until a dataset exists / meets size or child-item conditions, or timeout.',
    hasInnerActivities: false, referencesDataset: true, referencesLinkedService: false,
    settings: [
      datasetRef('dataset', 'Dataset', 'The file/folder dataset to validate exists.'),
      { key: 'timeout', label: 'Timeout', kind: 'text', placeholder: '7.00:00:00',
        hint: 'Max time to wait for validation (d.hh:mm:ss).' },
      { key: 'sleep', label: 'Sleep (seconds)', kind: 'number',
        hint: 'Seconds between validation retries.' },
      { key: 'minimumSize', label: 'Minimum size (bytes)', kind: 'number',
        hint: 'For a file: minimum size required to pass.' },
      { key: 'childItems', label: 'Folder must contain children', kind: 'boolean',
        hint: 'For a folder: require at least one child item.' },
    ],
  },

  // ====================== Azure Function & ML ==============================
  {
    type: 'AzureFunctionActivity', displayName: 'Azure Function',
    category: 'Azure Function & ML',
    description: 'Call an Azure Function in a Function App via its Azure Function linked service.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('Azure Function linked service', 'AzureFunction linked service for the target Function App.'),
      { key: 'functionName', label: 'Function name', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'HttpTriggerCSharp',
        hint: 'Function to call. Append routing/query, e.g. HttpTriggerCSharp?name=hello.' },
      METHOD_FIELD,
      { key: 'headers', label: 'Headers (object)', kind: 'multiline', supportsDynamic: true,
        hint: 'e.g. {"Content-Type":"application/json"}.' },
      { key: 'body', label: 'Body', kind: 'multiline', supportsDynamic: true,
        hint: 'Payload (required for POST/PUT, not allowed for GET).' },
    ],
  },
  {
    type: 'AzureMLExecutePipeline', displayName: 'ML Execute Pipeline',
    category: 'Azure Function & ML',
    description: 'Run a published Azure Machine Learning pipeline (batch scoring/training) via an Azure ML linked service.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('Azure ML linked service', 'AzureMLService linked service for the ML workspace.'),
      { key: 'mlPipelineId', label: 'ML pipeline ID', kind: 'text', required: true, supportsDynamic: true,
        hint: 'ID of the published Azure ML pipeline to run.' },
      { key: 'experimentName', label: 'Experiment name', kind: 'text', supportsDynamic: true,
        hint: 'Run-history experiment name.' },
      { key: 'mlPipelineParameters', label: 'Pipeline parameters (object)', kind: 'multiline',
        supportsDynamic: true, hint: 'Key/value parameters matching the published pipeline parameters.' },
      { key: 'mlParentRunId', label: 'Parent run ID', kind: 'text', supportsDynamic: true },
      { key: 'dataPathAssignments', label: 'Data-path assignments (object)', kind: 'multiline',
        supportsDynamic: true, hint: 'Override datapaths in Azure ML.' },
      { key: 'continueOnStepFailure', label: 'Continue on step failure', kind: 'boolean',
        hint: 'Continue other steps if a step fails.' },
    ],
  },
  {
    type: 'AzureMLBatchExecution', displayName: 'ML Batch Execution (Studio classic)',
    category: 'Azure Function & ML',
    description: 'Invoke an ML Studio (classic) batch execution web service with web-service inputs/outputs and global parameters.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('Azure ML (classic) linked service', 'AzureML linked service for the Studio-classic batch web service.'),
      { key: 'webServiceInputs', label: 'Web service inputs (object)', kind: 'multiline', supportsDynamic: true,
        hint: 'Map of web-service input port → AzureMLWebServiceFile (filePath + linkedServiceName).' },
      { key: 'webServiceOutputs', label: 'Web service outputs (object)', kind: 'multiline', supportsDynamic: true,
        hint: 'Map of web-service output port → AzureMLWebServiceFile.' },
      { key: 'globalParameters', label: 'Global parameters (object)', kind: 'multiline', supportsDynamic: true,
        hint: 'Global parameter name/value pairs for the web service.' },
    ],
  },
  {
    type: 'DataLakeAnalyticsU-SQL', displayName: 'U-SQL (Data Lake Analytics)',
    category: 'Azure Function & ML',
    description: 'Run a U-SQL script on an Azure Data Lake Analytics account via its linked service.',
    hasInnerActivities: false, referencesDataset: false, referencesLinkedService: true,
    settings: [
      lsRef('Data Lake Analytics linked service', 'AzureDataLakeAnalytics linked service (the ADLA account).'),
      { key: 'scriptPath', label: 'Script path (.usql)', kind: 'text', required: true, supportsDynamic: true,
        placeholder: 'scripts/SearchLogProcessing.usql',
        hint: 'Path to the U-SQL script within the script storage.' },
      { key: 'scriptLinkedService.referenceName', ref: 'linkedService',
        label: 'Script storage linked service', kind: 'text', required: true,
        hint: 'Azure Data Lake Store / Blob linked service holding the .usql script.' },
      { key: 'degreeOfParallelism', label: 'Degree of parallelism', kind: 'number', supportsDynamic: true,
        hint: 'Max compute (AU) used simultaneously.' },
      { key: 'priority', label: 'Priority', kind: 'number', supportsDynamic: true,
        hint: 'Lower runs sooner (default 1000).' },
      { key: 'runtimeVersion', label: 'Runtime version', kind: 'text', supportsDynamic: true },
      { key: 'compilationMode', label: 'Compilation mode', kind: 'select',
        options: ['Semantic', 'Full', 'SingleBox'].map((v) => ({ value: v, label: v })) },
      { key: 'parameters', label: 'Parameters (object)', kind: 'multiline', supportsDynamic: true,
        hint: 'U-SQL script parameters.' },
    ],
  },
];

/** Lookup an activity-inventory entry by ADF wire `type`. */
export function activityByType(type?: string): ActivityDef | undefined {
  if (!type) return undefined;
  // Migrate Fabric-era `RefreshDataflow` to the Azure-native wrangling type.
  const normalised = type === 'RefreshDataflow' ? 'ExecuteWranglingDataflow' : type;
  return ACTIVITIES.find((a) => a.type === normalised);
}

/** Group the activity inventory by settings-category, in display order. */
export function activitiesByCategory(): Array<{ category: ActivitySettingsCategory; activities: ActivityDef[] }> {
  return ACTIVITY_SETTINGS_CATEGORY_ORDER.map((category) => ({
    category,
    activities: ACTIVITIES.filter((a) => a.category === category),
  })).filter((g) => g.activities.length > 0);
}
