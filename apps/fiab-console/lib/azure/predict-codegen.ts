/**
 * predict-codegen — pure builders for the ML-model PREDICT guided
 * batch-scoring stepper (the Azure-native equivalent of Microsoft Fabric's
 * PREDICT experience).
 *
 * Fabric PREDICT lets a user pick a registered MLflow model, map an input
 * table's columns onto the model's input signature, and run a batch-scoring
 * Spark job that writes a scored table. The Azure-native 1:1 here is an
 * **Azure ML registered MLflow model** loaded on Spark via
 * `mlflow.pyfunc.spark_udf` — exactly what Fabric's PREDICT / SynapseML
 * `MLFlowTransformer` wraps — reading a Delta/lakehouse table, scoring it, and
 * writing a scored Delta table. No Fabric dependency: the model lives in the
 * AML registry (`models:/<name>/<version>`) and the compute is AML Serverless
 * Spark or Synapse Spark (never api.fabric.microsoft.com).
 *
 * Kept side-effect free (no @azure/* imports) so the generated PySpark is
 * reviewable + unit-testable in isolation, mirroring load-to-table-codegen.
 *
 * The runner is the standard mlflow-on-Spark scoring pattern:
 *   1. (optional) point MLflow's tracking + registry URI at the AML workspace
 *      so `models:/<name>/<version>` resolves on ANY Spark (AML Serverless
 *      Spark auto-configures this; Synapse Spark needs it set explicitly).
 *   2. read the input Delta table / registered table.
 *   3. select the mapped feature columns (aliased to the model's feature
 *      names) plus any passthrough/key columns.
 *   4. build a scoring UDF with `mlflow.pyfunc.spark_udf(...)` and apply it.
 *   5. write the scored rows as a Delta table (path or saveAsTable).
 *   6. print a single machine-parseable `LOOM_PREDICT_RESULT {json}` line the
 *      BFF reads back as the receipt (row count + output location).
 */

/** Valid Spark column / feature identifier (also the prediction column name). */
export const PREDICT_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type PredictInputMode = 'delta-path' | 'table';
export type PredictOutputMode = 'delta-path' | 'table';
export type PredictWriteMode = 'overwrite' | 'append';

/** Spark UDF result type the model's prediction is cast to (Fabric PREDICT lets you pick this). */
export const PREDICT_RESULT_TYPES = ['double', 'float', 'integer', 'long', 'string', 'boolean'] as const;
export type PredictResultType = (typeof PREDICT_RESULT_TYPES)[number];

/** One row of the column → model-feature mapping (Step 2 of the stepper). */
export interface FeatureMapping {
  /** The model's input feature / signature name the value is fed to. */
  feature: string;
  /** The input table column that supplies it (defaults to `feature`). */
  column: string;
}

export interface PredictSpec {
  /** AML registered-model name (the bound model). */
  modelName: string;
  /** Registered model version to score with. */
  version: string;
  /**
   * AML MLflow tracking/registry URI (`azureml://…`). Baked into the job so
   * `models:/<name>/<version>` resolves on Synapse Spark too. Optional — AML
   * Serverless Spark auto-configures its own registry, so omitting it is fine
   * on that backend.
   */
  trackingUri?: string;
  /** Input is a Delta path (abfss://…) or a registered Spark table name. */
  inputMode: PredictInputMode;
  /** abfss:// path (delta-path) OR `schema.table` / `table` (table). */
  inputRef: string;
  /** Reader format for delta-path mode. */
  inputFormat?: 'delta' | 'parquet';
  /** Model feature → input column mapping. */
  features: FeatureMapping[];
  /** Columns carried straight through to the output (ids / keys / labels). */
  passthroughColumns?: string[];
  /** Name of the appended prediction column. */
  predictionColumn: string;
  /** Spark type the prediction is cast to. */
  resultType: PredictResultType;
  /** Output is a new Delta path (abfss://…) or a saveAsTable target. */
  outputMode: PredictOutputMode;
  /** abfss:// path (delta-path) OR table name (table). */
  outputRef: string;
  /** Delta write mode. */
  writeMode: PredictWriteMode;
}

/** Validate a Spark identifier (feature / column / prediction column). Returns error or null. */
export function validatePredictIdent(name: string, label = 'Name'): string | null {
  if (!name || !name.trim()) return `${label} is required.`;
  if (!PREDICT_IDENT_RE.test(name.trim())) {
    return `${label} must start with a letter or underscore, then letters, digits, or underscores (max 128).`;
  }
  return null;
}

/** The MLflow model URI a `models:/` reference resolves against the AML registry. */
export function modelUriFor(modelName: string, version: string): string {
  return `models:/${modelName}/${version}`;
}

/**
 * Validate a full PREDICT spec. Returns a human-readable error string (for a
 * Fluent MessageBar) or null when the spec is submittable.
 */
export function validatePredictSpec(spec: PredictSpec): string | null {
  if (!spec.modelName?.trim()) return 'A registered model must be selected (Step 1).';
  if (!spec.version?.trim()) return 'A model version must be selected (Step 1).';
  if (!spec.inputRef?.trim()) {
    return spec.inputMode === 'delta-path'
      ? 'Enter the input Delta table path (abfss://…) (Step 2).'
      : 'Enter the input table name (Step 2).';
  }
  if (spec.inputMode === 'delta-path' && !/^abfss:\/\//i.test(spec.inputRef.trim())) {
    return 'Input Delta path must be an abfss:// URI.';
  }
  if (!spec.features?.length) return 'Map at least one model feature to an input column (Step 2).';
  for (const f of spec.features) {
    const fe = validatePredictIdent(f.feature, 'Feature name');
    if (fe) return fe;
    if (!f.column?.trim()) return `Map an input column for feature "${f.feature}" (Step 2).`;
  }
  // Duplicate feature names collide when aliased into the scoring struct.
  const seen = new Set<string>();
  for (const f of spec.features) {
    const k = f.feature.trim();
    if (seen.has(k)) return `Duplicate feature "${k}" in the mapping.`;
    seen.add(k);
  }
  const pe = validatePredictIdent(spec.predictionColumn, 'Prediction column');
  if (pe) return pe;
  if (!PREDICT_RESULT_TYPES.includes(spec.resultType)) return `Unsupported result type "${spec.resultType}".`;
  if (!spec.outputRef?.trim()) {
    return spec.outputMode === 'delta-path'
      ? 'Enter the output Delta path (abfss://…) (Step 3).'
      : 'Enter the output table name (Step 3).';
  }
  if (spec.outputMode === 'delta-path' && !/^abfss:\/\//i.test(spec.outputRef.trim())) {
    return 'Output Delta path must be an abfss:// URI.';
  }
  for (const c of spec.passthroughColumns || []) {
    if (!c.trim()) return 'Passthrough column names cannot be blank.';
  }
  return null;
}

/** Python string literal (safe quoting/escaping) for embedding a value in the job. */
function py(s: string): string {
  return JSON.stringify(s);
}

/**
 * Build the batch-scoring PySpark. The final `print` emits a single
 * machine-parseable `LOOM_PREDICT_RESULT {json}` line the BFF reads back as
 * the receipt (row count + output location).
 *
 * Throws when the spec is invalid (so a bad request never reaches Spark).
 */
export function buildPredictPySpark(spec: PredictSpec): string {
  const err = validatePredictSpec(spec);
  if (err) throw new Error(err);

  const modelUri = modelUriFor(spec.modelName.trim(), spec.version.trim());
  const featureNames = spec.features.map((f) => f.feature.trim());
  const passthrough = (spec.passthroughColumns || []).map((c) => c.trim()).filter(Boolean);

  // --- read expression ---
  const readExpr =
    spec.inputMode === 'delta-path'
      ? `spark.read.format(${py(spec.inputFormat || 'delta')}).load(${py(spec.inputRef.trim())})`
      : `spark.read.table(${py(spec.inputRef.trim())})`;

  // --- select list: passthrough columns then feature columns aliased to feature names ---
  const selectExprs = [
    ...passthrough.map((c) => `col(${py(c)})`),
    ...spec.features.map((f) => {
      const src = f.column.trim();
      return src === f.feature.trim()
        ? `col(${py(f.feature.trim())})`
        : `col(${py(src)}).alias(${py(f.feature.trim())})`;
    }),
  ];

  // --- write expression ---
  const writeTail =
    spec.outputMode === 'delta-path'
      ? `.save(${py(spec.outputRef.trim())})`
      : `.saveAsTable(${py(spec.outputRef.trim())})`;

  const lines: string[] = [
    '# Auto-generated by the Loom ML-model PREDICT batch-scoring stepper (rel-T84)',
    `# Model:  ${modelUri}  (Azure ML registered MLflow model)`,
    `# Input:  ${spec.inputMode === 'delta-path' ? spec.inputRef.trim() : `table ${spec.inputRef.trim()}`}`,
    `# Output: ${spec.outputRef.trim()} (Delta, ${spec.writeMode})`,
    'import json',
    'import mlflow',
    'from pyspark.sql.functions import col, struct',
    '',
  ];

  // Point MLflow at the AML registry so `models:/` resolves on any Spark
  // backend. AML Serverless Spark auto-configures this; Synapse Spark needs it.
  if (spec.trackingUri?.trim()) {
    lines.push(
      `mlflow.set_tracking_uri(${py(spec.trackingUri.trim())})`,
      `mlflow.set_registry_uri(${py(spec.trackingUri.trim())})`,
      '',
    );
  }

  lines.push(
    `MODEL_URI = ${py(modelUri)}`,
    `_df = ${readExpr}`,
    `_features = [${featureNames.map(py).join(', ')}]`,
    `_work = _df.select(`,
    ...selectExprs.map((e) => `    ${e},`),
    `)`,
    // env_manager="local" reuses the cluster's env instead of rebuilding a
    // conda env per run (which would fail/timeout on a short-lived Spark job).
    `_predict = mlflow.pyfunc.spark_udf(spark, model_uri=MODEL_URI, env_manager="local", result_type=${py(spec.resultType)})`,
    `_scored = _work.withColumn(${py(spec.predictionColumn.trim())}, _predict(struct(*[col(f) for f in _features])))`,
    `(_scored.write.format("delta").mode(${py(spec.writeMode)})${writeTail})`,
    `_rows = _scored.count()`,
    `print("LOOM_PREDICT_RESULT " + json.dumps({` +
      `"rows": _rows, ` +
      `"output": ${py(spec.outputRef.trim())}, ` +
      `"prediction_column": ${py(spec.predictionColumn.trim())}, ` +
      `"model": ${py(spec.modelName.trim())}, ` +
      `"version": ${py(spec.version.trim())}}))`,
  );

  return lines.join('\n');
}

export interface PredictResult {
  rows: number | null;
  output?: string;
  predictionColumn?: string;
  model?: string;
  version?: string;
}

/**
 * Parse the `LOOM_PREDICT_RESULT {json}` receipt line back out of a Spark
 * statement's stdout / captured text. Returns null when not present.
 */
export function parsePredictResult(textPlain: string | undefined | null): PredictResult | null {
  if (!textPlain) return null;
  const m = textPlain.match(/LOOM_PREDICT_RESULT\s+(\{.*\})/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return {
      rows: typeof j.rows === 'number' ? j.rows : Number.isFinite(Number(j.rows)) ? Number(j.rows) : null,
      output: typeof j.output === 'string' ? j.output : undefined,
      predictionColumn: typeof j.prediction_column === 'string' ? j.prediction_column : undefined,
      model: typeof j.model === 'string' ? j.model : undefined,
      version: j.version != null ? String(j.version) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Derive the AML MLflow `azureml://` tracking/registry URI from the https
 * tracking base that mlflowConfig() produces. Baked into the job so Synapse
 * Spark can resolve `models:/…`. Returns null for a non-https base.
 */
export function azuremlTrackingUri(httpsBase: string | undefined | null): string | null {
  if (!httpsBase) return null;
  const b = httpsBase.trim();
  if (b.startsWith('azureml://')) return b.replace(/\/+$/, '');
  if (b.startsWith('https://')) return b.replace(/^https:\/\//, 'azureml://').replace(/\/+$/, '');
  return null;
}
