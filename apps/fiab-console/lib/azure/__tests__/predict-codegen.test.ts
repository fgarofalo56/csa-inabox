import { describe, it, expect } from 'vitest';
import {
  validatePredictIdent,
  validatePredictSpec,
  buildPredictPySpark,
  parsePredictResult,
  modelUriFor,
  azuremlTrackingUri,
  PREDICT_RESULT_TYPES,
  type PredictSpec,
} from '../predict-codegen';

function baseSpec(overrides: Partial<PredictSpec> = {}): PredictSpec {
  return {
    modelName: 'churn_model',
    version: '3',
    inputMode: 'delta-path',
    inputRef: 'abfss://silver@acct.dfs.core.windows.net/Tables/customers',
    inputFormat: 'delta',
    features: [
      { feature: 'tenure', column: 'tenure_months' },
      { feature: 'monthly_charges', column: 'monthly_charges' },
    ],
    passthroughColumns: ['customer_id'],
    predictionColumn: 'prediction',
    resultType: 'double',
    outputMode: 'delta-path',
    outputRef: 'abfss://gold@acct.dfs.core.windows.net/Tables/customers_scored',
    writeMode: 'overwrite',
    ...overrides,
  };
}

describe('validatePredictIdent', () => {
  it('accepts valid identifiers', () => {
    expect(validatePredictIdent('feature_1', 'Feature')).toBeNull();
    expect(validatePredictIdent('_x', 'Feature')).toBeNull();
  });
  it('rejects blanks and bad identifiers', () => {
    expect(validatePredictIdent('', 'Feature')).toMatch(/required/i);
    expect(validatePredictIdent('1a', 'Feature')).toBeTruthy();
    expect(validatePredictIdent('a b', 'Feature')).toBeTruthy();
  });
});

describe('modelUriFor', () => {
  it('builds the MLflow registry URI', () => {
    expect(modelUriFor('churn_model', '3')).toBe('models:/churn_model/3');
  });
});

describe('validatePredictSpec', () => {
  it('passes a complete spec', () => {
    expect(validatePredictSpec(baseSpec())).toBeNull();
  });
  it('requires a version', () => {
    expect(validatePredictSpec(baseSpec({ version: '' }))).toMatch(/version/i);
  });
  it('requires at least one feature mapping', () => {
    expect(validatePredictSpec(baseSpec({ features: [] }))).toMatch(/feature/i);
  });
  it('rejects duplicate feature names', () => {
    expect(validatePredictSpec(baseSpec({
      features: [{ feature: 'x', column: 'a' }, { feature: 'x', column: 'b' }],
    }))).toMatch(/duplicate/i);
  });
  it('requires an abfss input path in delta-path mode', () => {
    expect(validatePredictSpec(baseSpec({ inputRef: '/local/path' }))).toMatch(/abfss/i);
  });
  it('requires an abfss output path in delta-path mode', () => {
    expect(validatePredictSpec(baseSpec({ outputRef: 'not-abfss' }))).toMatch(/abfss/i);
  });
  it('validates the prediction column identifier', () => {
    expect(validatePredictSpec(baseSpec({ predictionColumn: '9bad' }))).toBeTruthy();
  });
});

describe('buildPredictPySpark', () => {
  it('generates a valid mlflow.pyfunc.spark_udf scoring job', () => {
    const code = buildPredictPySpark(baseSpec());
    expect(code).toContain('import mlflow');
    expect(code).toContain('MODEL_URI = "models:/churn_model/3"');
    expect(code).toContain('mlflow.pyfunc.spark_udf(spark, model_uri=MODEL_URI, env_manager="local", result_type="double")');
    // reads the input Delta table
    expect(code).toContain('spark.read.format("delta").load("abfss://silver@acct.dfs.core.windows.net/Tables/customers")');
    // aliases a mapped column to the model feature name
    expect(code).toContain('col("tenure_months").alias("tenure")');
    // a same-named feature needs no alias
    expect(code).toContain('col("monthly_charges")');
    // passthrough carried through
    expect(code).toContain('col("customer_id")');
    // applies the UDF over the feature struct
    expect(code).toContain('_predict(struct(*[col(f) for f in _features]))');
    // writes a scored Delta table
    expect(code).toContain('.format("delta").mode("overwrite").save("abfss://gold@acct.dfs.core.windows.net/Tables/customers_scored")');
    // emits the machine-parseable receipt line
    expect(code).toContain('LOOM_PREDICT_RESULT');
  });

  it('bakes the azureml tracking URI when provided', () => {
    const code = buildPredictPySpark(baseSpec({ trackingUri: 'azureml://eastus.api.azureml.ms/mlflow/v1.0/subscriptions/s/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/ws' }));
    expect(code).toContain('mlflow.set_registry_uri("azureml://eastus.api.azureml.ms/mlflow/v1.0/subscriptions/s/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/ws")');
  });

  it('supports table input + saveAsTable output', () => {
    const code = buildPredictPySpark(baseSpec({
      inputMode: 'table', inputRef: 'sales.customers',
      outputMode: 'table', outputRef: 'sales.customers_scored',
    }));
    expect(code).toContain('spark.read.table("sales.customers")');
    expect(code).toContain('.saveAsTable("sales.customers_scored")');
  });

  it('honors the chosen result type', () => {
    const code = buildPredictPySpark(baseSpec({ resultType: 'string' }));
    expect(code).toContain('result_type="string"');
  });

  it('throws on an invalid spec', () => {
    expect(() => buildPredictPySpark(baseSpec({ features: [] }))).toThrow();
  });

  it('exposes the documented result types', () => {
    expect(PREDICT_RESULT_TYPES).toContain('double');
    expect(PREDICT_RESULT_TYPES).toContain('string');
  });
});

describe('parsePredictResult', () => {
  it('parses the receipt line', () => {
    const line = 'some log\nLOOM_PREDICT_RESULT {"rows": 8421, "output": "abfss://gold@a.dfs.core.windows.net/Tables/scored", "prediction_column": "prediction", "model": "churn_model", "version": "3"}\n';
    const r = parsePredictResult(line);
    expect(r).not.toBeNull();
    expect(r!.rows).toBe(8421);
    expect(r!.output).toContain('scored');
    expect(r!.predictionColumn).toBe('prediction');
    expect(r!.version).toBe('3');
  });
  it('returns null when absent', () => {
    expect(parsePredictResult('no receipt here')).toBeNull();
    expect(parsePredictResult(undefined)).toBeNull();
  });
});

describe('azuremlTrackingUri', () => {
  it('converts an https tracking base to azureml://', () => {
    expect(azuremlTrackingUri('https://eastus.api.azureml.ms/mlflow/v1.0/subscriptions/s/workspaces/ws/'))
      .toBe('azureml://eastus.api.azureml.ms/mlflow/v1.0/subscriptions/s/workspaces/ws');
  });
  it('passes through an azureml:// base', () => {
    expect(azuremlTrackingUri('azureml://host/mlflow')).toBe('azureml://host/mlflow');
  });
  it('returns null for other/empty input', () => {
    expect(azuremlTrackingUri('')).toBeNull();
    expect(azuremlTrackingUri(null)).toBeNull();
  });
});
