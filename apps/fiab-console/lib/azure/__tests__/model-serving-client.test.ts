import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  resolveServingBackend,
  validateTrafficSplit,
  shapeInvokePayload,
  servingConfigGate,
} from '../model-serving-client';

/**
 * WS-1.2 — model-serving-client pure-logic tests: backend selection default
 * (Azure-native AML), traffic-split validation, invoke payload shaping, and the
 * honest gate. No network — every function under test is pure or env-only.
 */
describe('model-serving-client — backend selection', () => {
  const prev = process.env.LOOM_MODEL_SERVING_BACKEND;
  afterEach(() => {
    if (prev === undefined) delete process.env.LOOM_MODEL_SERVING_BACKEND;
    else process.env.LOOM_MODEL_SERVING_BACKEND = prev;
  });

  it('defaults to the Azure-native AML backend when unset (no Fabric)', () => {
    delete process.env.LOOM_MODEL_SERVING_BACKEND;
    expect(resolveServingBackend()).toBe('aml');
  });

  it('selects databricks only when explicitly opted in', () => {
    process.env.LOOM_MODEL_SERVING_BACKEND = 'databricks';
    expect(resolveServingBackend()).toBe('databricks');
  });

  it('falls through to AML for any other/unknown value (never Fabric)', () => {
    process.env.LOOM_MODEL_SERVING_BACKEND = 'fabric';
    expect(resolveServingBackend()).toBe('aml');
    process.env.LOOM_MODEL_SERVING_BACKEND = 'DATABRICKS'; // case-insensitive
    expect(resolveServingBackend()).toBe('databricks');
  });
});

describe('model-serving-client — validateTrafficSplit', () => {
  it('accepts a valid split that totals 100', () => {
    expect(validateTrafficSplit({ blue: 80, green: 20 })).toBeNull();
    expect(validateTrafficSplit({ blue: 100 })).toBeNull();
  });

  it('rejects a split that does not total 100', () => {
    expect(validateTrafficSplit({ blue: 80, green: 10 })).toMatch(/total 100/);
    expect(validateTrafficSplit({ blue: 50, green: 60 })).toMatch(/total 100/);
  });

  it('rejects non-integer / out-of-range / empty splits', () => {
    expect(validateTrafficSplit({ blue: 50.5, green: 49.5 })).toMatch(/whole number/);
    expect(validateTrafficSplit({ blue: 120, green: -20 })).toMatch(/between 0 and 100/);
    expect(validateTrafficSplit({})).toMatch(/At least one/);
  });
});

describe('model-serving-client — shapeInvokePayload', () => {
  it('passes a JSON object through for the AML backend', () => {
    expect(shapeInvokePayload('{"input_data":{"data":[[1,2]]}}', 'aml')).toEqual({ input_data: { data: [[1, 2]] } });
  });

  it('wraps a bare array as dataframe_records for the Databricks backend', () => {
    expect(shapeInvokePayload('[{"x":1}]', 'databricks')).toEqual({ dataframe_records: [{ x: 1 }] });
  });

  it('leaves an object untouched for the Databricks backend', () => {
    expect(shapeInvokePayload('{"inputs":[1,2,3]}', 'databricks')).toEqual({ inputs: [1, 2, 3] });
  });

  it('throws on empty or non-JSON input', () => {
    expect(() => shapeInvokePayload('', 'aml')).toThrow(/required/);
    expect(() => shapeInvokePayload('not json', 'aml')).toThrow(/valid JSON/);
  });
});

describe('model-serving-client — servingConfigGate (honest gate)', () => {
  const snapshot = {
    backend: process.env.LOOM_MODEL_SERVING_BACKEND,
    ws: process.env.LOOM_AML_WORKSPACE,
    foundry: process.env.LOOM_FOUNDRY_NAME,
    sub: process.env.LOOM_SUBSCRIPTION_ID,
    dbx: process.env.LOOM_DATABRICKS_HOSTNAME,
  };
  beforeEach(() => {
    delete process.env.LOOM_MODEL_SERVING_BACKEND;
    delete process.env.LOOM_AML_WORKSPACE;
    delete process.env.LOOM_FOUNDRY_NAME;
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-123';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries({
      LOOM_MODEL_SERVING_BACKEND: snapshot.backend, LOOM_AML_WORKSPACE: snapshot.ws,
      LOOM_FOUNDRY_NAME: snapshot.foundry, LOOM_SUBSCRIPTION_ID: snapshot.sub,
      LOOM_DATABRICKS_HOSTNAME: snapshot.dbx,
    })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('gates on the AML default when no AML workspace is configured', () => {
    const g = servingConfigGate();
    expect(g?.backend).toBe('aml');
    expect(g?.fixEnvVar).toBe('LOOM_AML_WORKSPACE');
    expect(g?.gateId).toBe('svc-model-serving');
  });

  it('is satisfied (null) once an AML/Foundry workspace is addressable', () => {
    process.env.LOOM_FOUNDRY_NAME = 'aifoundry-loom';
    expect(servingConfigGate()).toBeNull();
  });

  it('gates on LOOM_DATABRICKS_HOSTNAME when the databricks backend is opted in but unset', () => {
    process.env.LOOM_MODEL_SERVING_BACKEND = 'databricks';
    const g = servingConfigGate();
    expect(g?.backend).toBe('databricks');
    expect(g?.fixEnvVar).toBe('LOOM_DATABRICKS_HOSTNAME');
  });
});
