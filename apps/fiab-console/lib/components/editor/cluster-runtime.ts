'use client';

/**
 * cluster-runtime — derive the notebook RUNTIME from the selected compute target
 * and build the runtime-specific IntelliSense + Copilot grounding.
 *
 * The operator's requirement (verbatim intent): when a notebook is attached to a
 * Databricks-backed Spark cluster, the editor must offer the CORRECT syntax +
 * IntelliSense for Databricks (dbutils / display() / Unity Catalog). When the
 * user picks a Synapse Spark pool, it must offer Synapse syntax (mssparkutils /
 * notebookutils / %%magics). When the user picks an Azure ML compute, it must
 * offer the Azure ML SDK v2 (azure.ai.ml MLClient / command / AutoML / mlflow).
 * Switching the compute SWITCHES the IntelliSense, and the AI Copilot is told
 * which runtime it is generating / fixing code for.
 *
 * All three completion sets are grounded in Microsoft Learn (citations in the
 * PR body), not invented:
 *   - Databricks Utilities (dbutils):
 *     https://learn.microsoft.com/azure/databricks/dev-tools/databricks-utils
 *   - Microsoft Spark Utilities (mssparkutils) / NotebookUtils:
 *     https://learn.microsoft.com/azure/synapse-analytics/spark/microsoft-spark-utilities
 *     https://learn.microsoft.com/fabric/data-engineering/notebook-utilities
 *   - Azure ML SDK v2 (azure.ai.ml MLClient / command / automl) + MLflow:
 *     https://learn.microsoft.com/azure/machine-learning/how-to-configure-auto-train
 *     https://learn.microsoft.com/azure/machine-learning/concept-mlflow
 *
 * This module is import-minimal (no React, no Azure SDK) so it can be shared by
 * the client editor, the Monaco provider, and the server Copilot prompt builder.
 */

/** The execution runtime a notebook cell targets. */
export type ClusterRuntime = 'databricks' | 'synapse-spark' | 'azure-ml';

/**
 * Compute `kind` values emitted by /api/loom/compute-targets. Kept loose
 * (string) so a new kind never throws — it just falls through to the default.
 */
export function runtimeFromComputeKind(kind: string | undefined | null): ClusterRuntime {
  switch (kind) {
    case 'databricks-cluster':
      return 'databricks';
    case 'aml-ci':
      return 'azure-ml';
    case 'synapse-spark':
    case 'synapse-dedicated-sql':
    case 'synapse-serverless-sql':
    default:
      // Synapse Spark is the historically-validated default path (Livy run-cell),
      // so an unknown / unset compute behaves exactly as before this feature.
      return 'synapse-spark';
  }
}

/**
 * Some compute ids carry their kind as a prefix (`databricks:`, `spark:`,
 * `aml-ci:`, `serverless:`, `dedicated-sql:`). When only the id is in hand
 * (e.g. the editor stored just computeId), derive the runtime from the prefix.
 */
export function runtimeFromComputeId(computeId: string | undefined | null): ClusterRuntime {
  const id = String(computeId || '');
  if (id.startsWith('databricks:')) return 'databricks';
  if (id.startsWith('aml-ci:')) return 'azure-ml';
  // spark: / serverless: / dedicated-sql: → Synapse
  return 'synapse-spark';
}

/** Human label for the runtime, used in badges + Copilot prompts. */
export const RUNTIME_LABEL: Record<ClusterRuntime, string> = {
  databricks: 'Databricks Spark',
  'synapse-spark': 'Synapse Spark',
  'azure-ml': 'Azure ML',
};

/**
 * A single runtime-specific completion entry. `insertText` may carry Monaco
 * snippet placeholders (`${1:arg}`) — `snippet:true` flags that so the provider
 * sets InsertTextRules.InsertAsSnippet.
 */
export interface RuntimeCompletion {
  label: string;
  insertText: string;
  detail: string;
  /** 'function' | 'module' | 'keyword' | 'snippet' | 'property' */
  kind: 'function' | 'module' | 'keyword' | 'snippet' | 'property';
  snippet?: boolean;
  documentation?: string;
}

// ---------------------------------------------------------------------------
// Databricks — dbutils, display(), Unity Catalog, magics
// Grounded in: learn.microsoft.com/azure/databricks/dev-tools/databricks-utils
// ---------------------------------------------------------------------------
const DATABRICKS_PY: RuntimeCompletion[] = [
  { label: 'dbutils', insertText: 'dbutils', kind: 'module', detail: 'Databricks Utilities root (fs · secrets · widgets · notebook · jobs)' },
  { label: 'dbutils.fs.ls', insertText: 'dbutils.fs.ls("${1:/}")', snippet: true, kind: 'function', detail: 'List files (DBFS / Unity Catalog volume)', documentation: 'File system utility — dbutils.fs.ls(path)' },
  { label: 'dbutils.fs.cp', insertText: 'dbutils.fs.cp("${1:src}", "${2:dst}")', snippet: true, kind: 'function', detail: 'Copy a file/dir' },
  { label: 'dbutils.fs.mkdirs', insertText: 'dbutils.fs.mkdirs("${1:/path}")', snippet: true, kind: 'function', detail: 'Create directories' },
  { label: 'dbutils.fs.rm', insertText: 'dbutils.fs.rm("${1:/path}", ${2:True})', snippet: true, kind: 'function', detail: 'Remove a file/dir (recurse)' },
  { label: 'dbutils.fs.head', insertText: 'dbutils.fs.head("${1:/path}")', snippet: true, kind: 'function', detail: 'Read the first bytes of a file' },
  { label: 'dbutils.fs.mount', insertText: 'dbutils.fs.mount(source="${1:abfss://...}", mount_point="${2:/mnt/...}")', snippet: true, kind: 'function', detail: 'Mount ADLS/Blob storage' },
  { label: 'dbutils.secrets.get', insertText: 'dbutils.secrets.get(scope="${1:scope}", key="${2:key}")', snippet: true, kind: 'function', detail: 'Read a secret (Key Vault-backed scope)' },
  { label: 'dbutils.secrets.list', insertText: 'dbutils.secrets.list("${1:scope}")', snippet: true, kind: 'function', detail: 'List secret keys in a scope' },
  { label: 'dbutils.widgets.text', insertText: 'dbutils.widgets.text("${1:name}", "${2:default}")', snippet: true, kind: 'function', detail: 'Create a text input widget (notebook parameter)' },
  { label: 'dbutils.widgets.get', insertText: 'dbutils.widgets.get("${1:name}")', snippet: true, kind: 'function', detail: 'Read a widget value' },
  { label: 'dbutils.widgets.dropdown', insertText: 'dbutils.widgets.dropdown("${1:name}", "${2:default}", [${3:"a","b"}])', snippet: true, kind: 'function', detail: 'Create a dropdown widget' },
  { label: 'dbutils.notebook.run', insertText: 'dbutils.notebook.run("${1:./other}", ${2:60}, {${3:}})', snippet: true, kind: 'function', detail: 'Run another notebook and return its exit value' },
  { label: 'dbutils.notebook.exit', insertText: 'dbutils.notebook.exit("${1:value}")', snippet: true, kind: 'function', detail: 'Exit a notebook with a value' },
  { label: 'dbutils.jobs.taskValues.set', insertText: 'dbutils.jobs.taskValues.set(key="${1:k}", value=${2:v})', snippet: true, kind: 'function', detail: 'Set a task value (Jobs)' },
  { label: 'display', insertText: 'display(${1:df})', snippet: true, kind: 'function', detail: 'Render a DataFrame as an interactive table/chart' },
  { label: 'displayHTML', insertText: 'displayHTML("${1:<h1>hi</h1>}")', snippet: true, kind: 'function', detail: 'Render HTML inline' },
  { label: 'spark', insertText: 'spark', kind: 'property', detail: 'Preconfigured SparkSession' },
  { label: 'spark.read.table (Unity Catalog)', insertText: 'spark.read.table("${1:catalog}.${2:schema}.${3:table}")', snippet: true, kind: 'function', detail: 'Read a Unity Catalog table (3-part name)' },
  { label: 'spark.sql', insertText: 'spark.sql("${1:SELECT * FROM catalog.schema.table}")', snippet: true, kind: 'function', detail: 'Run Spark SQL' },
  { label: 'WorkspaceClient', insertText: 'from databricks.sdk import WorkspaceClient\nw = WorkspaceClient()', snippet: true, kind: 'snippet', detail: 'Databricks SDK for Python entrypoint' },
];

const DATABRICKS_MAGICS: RuntimeCompletion[] = [
  { label: '%sql', insertText: '%sql\n${1:SELECT 1}', snippet: true, kind: 'keyword', detail: 'Run the cell as SQL' },
  { label: '%md', insertText: '%md\n${1:# heading}', snippet: true, kind: 'keyword', detail: 'Render the cell as Markdown' },
  { label: '%run', insertText: '%run ${1:./other-notebook}', snippet: true, kind: 'keyword', detail: 'Inline-run another notebook' },
  { label: '%python', insertText: '%python\n', kind: 'keyword', detail: 'Run the cell as Python' },
  { label: '%scala', insertText: '%scala\n', kind: 'keyword', detail: 'Run the cell as Scala' },
  { label: '%pip', insertText: '%pip install ${1:package}', snippet: true, kind: 'keyword', detail: 'Notebook-scoped pip install' },
  { label: '%fs', insertText: '%fs ${1:ls /}', snippet: true, kind: 'keyword', detail: 'Shorthand for dbutils.fs' },
];

const DATABRICKS_SCALA: RuntimeCompletion[] = [
  { label: 'dbutils.fs.ls', insertText: 'dbutils.fs.ls("${1:/}")', snippet: true, kind: 'function', detail: 'List files (DBFS)' },
  { label: 'dbutils.secrets.get', insertText: 'dbutils.secrets.get(scope="${1:scope}", key="${2:key}")', snippet: true, kind: 'function', detail: 'Read a secret' },
  { label: 'display', insertText: 'display(${1:df})', snippet: true, kind: 'function', detail: 'Render a DataFrame interactively' },
  { label: 'spark', insertText: 'spark', kind: 'property', detail: 'Preconfigured SparkSession' },
];

// ---------------------------------------------------------------------------
// Synapse Spark — mssparkutils / notebookutils, %%magics
// Grounded in: learn.microsoft.com/azure/synapse-analytics/spark/microsoft-spark-utilities
//              learn.microsoft.com/fabric/data-engineering/notebook-utilities
// ---------------------------------------------------------------------------
const SYNAPSE_PY: RuntimeCompletion[] = [
  { label: 'mssparkutils', insertText: 'mssparkutils', kind: 'module', detail: 'Microsoft Spark Utilities (fs · credentials · env · runtime · notebook)' },
  { label: 'notebookutils', insertText: 'notebookutils', kind: 'module', detail: 'NotebookUtils (renamed mssparkutils, Runtime v1.2+)' },
  { label: 'mssparkutils.fs.ls', insertText: 'mssparkutils.fs.ls("${1:abfss://<fs>@<acct>.dfs.core.windows.net/}")', snippet: true, kind: 'function', detail: 'List files (ADLS Gen2 / Blob / Lakehouse)' },
  { label: 'mssparkutils.fs.cp', insertText: 'mssparkutils.fs.cp("${1:src}", "${2:dst}", ${3:True})', snippet: true, kind: 'function', detail: 'Copy a file/dir (recurse)' },
  { label: 'mssparkutils.fs.mkdirs', insertText: 'mssparkutils.fs.mkdirs("${1:path}")', snippet: true, kind: 'function', detail: 'Create directories' },
  { label: 'mssparkutils.fs.mount', insertText: 'mssparkutils.fs.mount("${1:abfss://...}", "${2:/mnt/...}")', snippet: true, kind: 'function', detail: 'Mount ADLS Gen2 to the Spark nodes' },
  { label: 'mssparkutils.credentials.getSecret', insertText: 'mssparkutils.credentials.getSecret("${1:https://<name>.vault.azure.net/}", "${2:secret}")', snippet: true, kind: 'function', detail: 'Read a Key Vault secret (user credentials)' },
  { label: 'mssparkutils.credentials.getToken', insertText: 'mssparkutils.credentials.getToken("${1:storage}")', snippet: true, kind: 'function', detail: 'Microsoft Entra token (storage|pbi|keyvault|kusto)' },
  { label: 'mssparkutils.env.getWorkspaceName', insertText: 'mssparkutils.env.getWorkspaceName()', kind: 'function', detail: 'Current workspace name' },
  { label: 'mssparkutils.env.getPoolName', insertText: 'mssparkutils.env.getPoolName()', kind: 'function', detail: 'Current Spark pool name' },
  { label: 'mssparkutils.runtime.context', insertText: 'mssparkutils.runtime.context', kind: 'property', detail: 'Notebook name / pipeline job id / activity run id' },
  { label: 'mssparkutils.notebook.run', insertText: 'mssparkutils.notebook.run("${1:notebook}", ${2:90}, {${3:}})', snippet: true, kind: 'function', detail: 'Run another notebook and return its exit value' },
  { label: 'mssparkutils.notebook.exit', insertText: 'mssparkutils.notebook.exit("${1:value}")', snippet: true, kind: 'function', detail: 'Exit a notebook with a value' },
  { label: 'spark', insertText: 'spark', kind: 'property', detail: 'Preconfigured SparkSession' },
  { label: 'spark.read.load', insertText: 'spark.read.load("${1:abfss://<fs>@<acct>.dfs.core.windows.net/<path>}", format="${2:delta}")', snippet: true, kind: 'function', detail: 'Read data from ADLS' },
  { label: 'spark.sql', insertText: 'spark.sql("${1:SELECT * FROM db.table}")', snippet: true, kind: 'function', detail: 'Run Spark SQL' },
];

const SYNAPSE_MAGICS: RuntimeCompletion[] = [
  { label: '%%pyspark', insertText: '%%pyspark\n', kind: 'keyword', detail: 'Run the cell as PySpark (Python on Spark)' },
  { label: '%%spark', insertText: '%%spark\n', kind: 'keyword', detail: 'Run the cell as Spark (Scala)' },
  { label: '%%sql', insertText: '%%sql\n${1:SELECT 1}', snippet: true, kind: 'keyword', detail: 'Run the cell as Spark SQL' },
  { label: '%%sparksql', insertText: '%%sparksql\n${1:SELECT 1}', snippet: true, kind: 'keyword', detail: 'Run the cell as Spark SQL' },
  { label: '%%sparkr', insertText: '%%sparkr\n', kind: 'keyword', detail: 'Run the cell as SparkR (R)' },
  { label: '%%configure', insertText: '%%configure\n{ "executorMemory": "${1:4g}", "executorCores": ${2:2}, "numExecutors": ${3:2} }', snippet: true, kind: 'keyword', detail: 'Size the Spark (Livy) session' },
];

const SYNAPSE_SCALA: RuntimeCompletion[] = [
  { label: 'mssparkutils.fs.ls', insertText: 'mssparkutils.fs.ls("${1:abfss://...}")', snippet: true, kind: 'function', detail: 'List files (ADLS Gen2)' },
  { label: 'mssparkutils.credentials.getSecret', insertText: 'mssparkutils.credentials.getSecret("${1:vault}", "${2:secret}")', snippet: true, kind: 'function', detail: 'Read a Key Vault secret' },
  { label: 'mssparkutils.runtime.context', insertText: 'mssparkutils.runtime.context', kind: 'property', detail: 'Runtime context' },
  { label: 'spark', insertText: 'spark', kind: 'property', detail: 'Preconfigured SparkSession' },
];

// ---------------------------------------------------------------------------
// Azure ML — azure.ai.ml SDK v2 (MLClient / command / automl), mlflow
// Grounded in: learn.microsoft.com/azure/machine-learning/how-to-configure-auto-train
//              learn.microsoft.com/azure/machine-learning/concept-mlflow
// ---------------------------------------------------------------------------
const AZURE_ML_PY: RuntimeCompletion[] = [
  { label: 'MLClient (connect)', insertText: 'from azure.ai.ml import MLClient\nfrom azure.identity import DefaultAzureCredential\nml_client = MLClient(DefaultAzureCredential(), "${1:subscription_id}", "${2:resource_group}", "${3:workspace}")', snippet: true, kind: 'snippet', detail: 'Get a handle to the AML workspace' },
  { label: 'MLClient', insertText: 'MLClient(${1:DefaultAzureCredential()}, "${2:sub}", "${3:rg}", "${4:ws}")', snippet: true, kind: 'function', detail: 'azure.ai.ml workspace client' },
  { label: 'command (job)', insertText: 'from azure.ai.ml import command, Environment\njob = command(\n    code="${1:src}",\n    command="${2:python train.py}",\n    environment=Environment(image="${3:library/python:latest}"),\n    compute="${4:cpu-cluster}",\n    display_name="${5:my-job}",\n)', snippet: true, kind: 'snippet', detail: 'Define a command job (SDK v2)' },
  { label: 'ml_client.jobs.create_or_update', insertText: 'returned_job = ml_client.jobs.create_or_update(${1:job})', snippet: true, kind: 'function', detail: 'Submit a job to the AML backend' },
  { label: 'ml_client.jobs.stream', insertText: 'ml_client.jobs.stream(${1:returned_job}.name)', snippet: true, kind: 'function', detail: 'Stream a running job\'s logs' },
  { label: 'automl.classification', insertText: 'from azure.ai.ml import automl\nclassification_job = automl.classification(\n    training_data=${1:train_input},\n    target_column_name="${2:label}",\n    primary_metric="${3:accuracy}",\n)', snippet: true, kind: 'snippet', detail: 'AutoML classification job (SDK v2)' },
  { label: 'automl.regression', insertText: 'from azure.ai.ml import automl\nregression_job = automl.regression(training_data=${1:train_input}, target_column_name="${2:target}")', snippet: true, kind: 'snippet', detail: 'AutoML regression job' },
  { label: 'automl.forecasting', insertText: 'from azure.ai.ml import automl\nforecasting_job = automl.forecasting(training_data=${1:train_input}, target_column_name="${2:target}")', snippet: true, kind: 'snippet', detail: 'AutoML forecasting job' },
  { label: 'job.set_limits (AutoML)', insertText: 'job.set_limits(timeout_minutes=${1:60}, max_trials=${2:20}, enable_early_termination=${3:True})', snippet: true, kind: 'function', detail: 'AutoML run limits' },
  { label: 'Input (data asset)', insertText: 'from azure.ai.ml import Input\nfrom azure.ai.ml.constants import AssetTypes\ndata = Input(type=AssetTypes.${1:MLTABLE}, path="${2:./data}")', snippet: true, kind: 'snippet', detail: 'Typed job input (URI_FILE / URI_FOLDER / MLTABLE)' },
  { label: 'mlflow.start_run', insertText: 'import mlflow\nwith mlflow.start_run():\n    ${1:pass}', snippet: true, kind: 'snippet', detail: 'Start an MLflow run (tracking)' },
  { label: 'mlflow.log_metric', insertText: 'mlflow.log_metric("${1:metric}", ${2:value})', snippet: true, kind: 'function', detail: 'Log a metric to the workspace tracking store' },
  { label: 'mlflow.log_param', insertText: 'mlflow.log_param("${1:param}", ${2:value})', snippet: true, kind: 'function', detail: 'Log a parameter' },
  { label: 'mlflow.log_artifact', insertText: 'mlflow.log_artifact("${1:path}")', snippet: true, kind: 'function', detail: 'Log a file artifact' },
  { label: 'mlflow.autolog', insertText: 'mlflow.autolog()', kind: 'function', detail: 'Auto-log metrics/params/model for supported frameworks' },
  { label: 'mlflow.sklearn.log_model', insertText: 'mlflow.sklearn.log_model(${1:model}, "${2:model}")', snippet: true, kind: 'function', detail: 'Log a scikit-learn model' },
];

const AZURE_ML_R: RuntimeCompletion[] = [
  { label: 'library(azuremlsdk)', insertText: 'library(azuremlsdk)', kind: 'snippet', detail: 'Azure ML R SDK' },
];

/**
 * Completion set for a (runtime, monacoLanguage) pair. `monacoLanguage` is the
 * MAPPED Monaco language id ('python' | 'scala' | 'sql' | 'r'), so pyspark and
 * python both arrive as 'python'.
 */
export function completionsFor(runtime: ClusterRuntime, monacoLanguage: string): RuntimeCompletion[] {
  if (runtime === 'databricks') {
    if (monacoLanguage === 'python') return [...DATABRICKS_PY, ...DATABRICKS_MAGICS];
    if (monacoLanguage === 'scala') return [...DATABRICKS_SCALA, ...DATABRICKS_MAGICS];
    return DATABRICKS_MAGICS;
  }
  if (runtime === 'azure-ml') {
    if (monacoLanguage === 'python') return AZURE_ML_PY;
    if (monacoLanguage === 'r') return AZURE_ML_R;
    return [];
  }
  // synapse-spark (default)
  if (monacoLanguage === 'python') return [...SYNAPSE_PY, ...SYNAPSE_MAGICS];
  if (monacoLanguage === 'scala') return [...SYNAPSE_SCALA, ...SYNAPSE_MAGICS];
  return SYNAPSE_MAGICS;
}

/**
 * Runtime-specific starter / seed cell source for a NEW code cell, keyed by the
 * notebook cell language. Drives the "switch the seed/sample cell to match the
 * cluster type" requirement.
 */
export function starterCellFor(runtime: ClusterRuntime, lang: string): string {
  if (runtime === 'databricks') {
    if (lang === 'sparkr') return '# Databricks notebook (R)\ndf <- createDataFrame(faithful)\ndisplay(df)\n';
    if (lang === 'spark') return '// Databricks notebook (Scala)\nval df = spark.range(10)\ndisplay(df)\n';
    return '# Databricks notebook (PySpark)\n# `spark` and `dbutils` are preconfigured.\ndf = spark.range(10)\ndisplay(df)\n';
  }
  if (runtime === 'azure-ml') {
    if (lang === 'sparkr') return '# Azure ML notebook (R on a Compute Instance)\nprint("Hello from R on your AML Compute Instance")\n';
    return '# Azure ML notebook (Python 3.10 on a Compute Instance)\n# Connect to the workspace with the SDK v2 and track with MLflow.\nfrom azure.ai.ml import MLClient\nfrom azure.identity import DefaultAzureCredential\nml_client = MLClient.from_config(DefaultAzureCredential())\nprint(ml_client.workspace_name)\n';
  }
  // synapse-spark (default) — keep the historically-validated PySpark seed.
  if (lang === 'spark') return '// Synapse Spark notebook (Scala)\nval df = spark.range(10)\ndf.show()\n';
  if (lang === 'sparkr') return '# Synapse Spark notebook (SparkR)\nlibrary(notebookutils)\ndf <- as.DataFrame(faithful)\nhead(df)\n';
  return '# Synapse Spark notebook (PySpark)\n# Edit, then click Save. Click Run cell to queue execution.\ndf = spark.range(10)\ndf.show()\n';
}

/**
 * Compact runtime grounding line injected into the Copilot system prompt so
 * generated + error-fixed code targets the CORRECT runtime APIs. Returned as a
 * single sentence the prompt builders append.
 */
export function copilotRuntimeDirective(runtime: ClusterRuntime): string {
  switch (runtime) {
    case 'databricks':
      return (
        'TARGET RUNTIME: Databricks Spark. Use Databricks idioms — `dbutils` ' +
        '(dbutils.fs / dbutils.secrets / dbutils.widgets / dbutils.notebook), ' +
        '`display(df)` to visualize, the preconfigured `spark` session, Unity ' +
        'Catalog three-part names (catalog.schema.table), and %sql/%md/%run/%pip ' +
        'magics. Do NOT use mssparkutils/notebookutils or %%-style Synapse magics.'
      );
    case 'azure-ml':
      return (
        'TARGET RUNTIME: Azure Machine Learning (Compute Instance, plain Python — ' +
        'no implicit Spark session). Use the Azure ML SDK v2 (`azure.ai.ml`): ' +
        '`MLClient` with `DefaultAzureCredential`, `command(...)` jobs, ' +
        '`ml_client.jobs.create_or_update(...)`, AutoML via ' +
        '`automl.classification()/regression()/forecasting()`, and MLflow ' +
        '(`mlflow.start_run` / `log_metric` / `autolog`) for tracking. Do NOT ' +
        'assume a `spark`/`dbutils`/`mssparkutils` global exists.'
      );
    case 'synapse-spark':
    default:
      return (
        'TARGET RUNTIME: Azure Synapse Spark (Livy). Use Synapse idioms — ' +
        '`mssparkutils`/`notebookutils` (fs / credentials / env / runtime / ' +
        'notebook), the preconfigured `spark` session, and %%pyspark/%%spark/' +
        '%%sql/%%sparkr cell magics. Do NOT use Databricks `dbutils`/`display()` ' +
        'or the Azure ML SDK.'
      );
  }
}
