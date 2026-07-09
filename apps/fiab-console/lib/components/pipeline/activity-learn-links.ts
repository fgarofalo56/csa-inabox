/**
 * activity-learn-links — Microsoft Learn "Learn more" deep links per pipeline
 * activity type, so the properties panel can offer the same contextual help
 * link Fabric / ADF Studio shows on every activity editor.
 *
 * Grounded in the per-activity Learn pages under
 * https://learn.microsoft.com/azure/data-factory/. Any type without a specific
 * page falls back to the activities-overview page — never a dead link.
 */

const BASE = 'https://learn.microsoft.com/azure/data-factory';

/** Per-wire-type Learn doc slugs (verbatim from the ADF Learn TOC). */
const LEARN_SLUG: Record<string, string> = {
  Copy: 'copy-activity-overview',
  Lookup: 'control-flow-lookup-activity',
  GetMetadata: 'control-flow-get-metadata-activity',
  Delete: 'delete-activity',
  ExecuteDataFlow: 'control-flow-execute-data-flow-activity',
  ExecuteWranglingDataflow: 'wrangling-tutorial',
  ForEach: 'control-flow-for-each-activity',
  IfCondition: 'control-flow-if-condition-activity',
  Switch: 'control-flow-switch-activity',
  Until: 'control-flow-until-activity',
  Wait: 'control-flow-wait-activity',
  SetVariable: 'control-flow-set-variable-activity',
  AppendVariable: 'control-flow-append-variable-activity',
  Filter: 'control-flow-filter-activity',
  ExecutePipeline: 'control-flow-execute-pipeline-activity',
  Fail: 'control-flow-fail-activity',
  Validation: 'control-flow-validation-activity',
  WebActivity: 'control-flow-web-activity',
  WebHook: 'control-flow-webhook-activity',
  SqlServerStoredProcedure: 'transform-data-using-stored-procedure',
  Script: 'transform-data-using-script',
  DatabricksNotebook: 'transform-data-databricks-notebook',
  DatabricksSparkJar: 'transform-data-databricks-jar',
  DatabricksSparkPython: 'transform-data-databricks-python',
  SynapseNotebook: 'transform-data-synapse-notebook',
  SparkJob: 'transform-data-synapse-spark-job-definition',
  HDInsightHive: 'transform-data-using-hadoop-hive',
  HDInsightPig: 'transform-data-using-hadoop-pig',
  HDInsightMapReduce: 'transform-data-using-hadoop-map-reduce',
  HDInsightSpark: 'transform-data-using-spark',
  HDInsightStreaming: 'transform-data-using-hadoop-streaming',
  AzureFunctionActivity: 'control-flow-azure-function-activity',
  AzureMLExecutePipeline: 'transform-data-machine-learning-service',
  AzureMLBatchExecution: 'transform-data-using-machine-learning',
  'DataLakeAnalyticsU-SQL': 'transform-data-using-data-lake-analytics',
};

/**
 * The Learn "Learn more" URL for an activity wire type. Normalises the Fabric-era
 * `RefreshDataflow` alias and falls back to the ADF activities-overview when a
 * type has no dedicated page.
 */
export function learnUrlForActivity(type?: string): string {
  if (!type) return `${BASE}/concepts-pipelines-activities`;
  const normalised = type === 'RefreshDataflow' ? 'ExecuteWranglingDataflow' : type;
  const slug = LEARN_SLUG[normalised];
  return slug ? `${BASE}/${slug}` : `${BASE}/concepts-pipelines-activities`;
}
