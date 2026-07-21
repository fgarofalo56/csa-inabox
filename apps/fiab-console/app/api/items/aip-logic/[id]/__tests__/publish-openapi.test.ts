/**
 * buildLogicOpenApi / type mapping / slug — pure unit tests for the Spindle
 * publish-as-REST OpenAPI generator (WS-4.6). No Azure deps.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLogicOpenApi, aipTypeToJsonSchema, outputTypeToJsonSchema, slugifyApi,
} from '../_publish-openapi';

describe('aipTypeToJsonSchema', () => {
  it('maps AIP Logic types to JSON schema', () => {
    expect(aipTypeToJsonSchema('integer')).toEqual({ type: 'integer' });
    expect(aipTypeToJsonSchema('long')).toEqual({ type: 'integer' });
    expect(aipTypeToJsonSchema('double')).toEqual({ type: 'number' });
    expect(aipTypeToJsonSchema('boolean')).toEqual({ type: 'boolean' });
    expect(aipTypeToJsonSchema('array')).toEqual({ type: 'array', items: {} });
    expect(aipTypeToJsonSchema('struct')).toEqual({ type: 'object' });
    expect(aipTypeToJsonSchema('timestamp')).toEqual({ type: 'string', format: 'date-time' });
    expect(aipTypeToJsonSchema('string')).toEqual({ type: 'string' });
    // object/model/media default to string (keyed by id)
    expect(aipTypeToJsonSchema('object')).toEqual({ type: 'string' });
  });
});

describe('outputTypeToJsonSchema', () => {
  it('maps the four output kinds', () => {
    expect(outputTypeToJsonSchema('number')).toEqual({ type: 'number' });
    expect(outputTypeToJsonSchema('boolean')).toEqual({ type: 'boolean' });
    expect(outputTypeToJsonSchema('object')).toEqual({ type: 'object' });
    expect(outputTypeToJsonSchema('string')).toEqual({ type: 'string' });
  });
});

describe('slugifyApi', () => {
  it('produces a safe apim slug', () => {
    expect(slugifyApi('Risk Scorer!')).toBe('risk-scorer');
    expect(slugifyApi('')).toBe('spindle');
    expect(slugifyApi('  --Weird__Name--  ')).toBe('weird-name');
  });
});

describe('buildLogicOpenApi', () => {
  const doc = buildLogicOpenApi({
    displayName: 'Risk (Spindle REST)',
    inputs: [
      { name: 'customerId', type: 'string', required: true, description: 'The customer' },
      { name: 'threshold', type: 'double' },
      { name: 'blank', type: 'string' }, // kept
      { name: '', type: 'string' },       // dropped (no name)
    ],
    outputType: 'string',
    outputDescription: 'A one-line risk summary',
  });

  it('is a valid single POST /invoke OpenAPI 3 doc', () => {
    expect(doc.openapi).toBe('3.0.1');
    const paths = doc.paths as Record<string, any>;
    expect(Object.keys(paths)).toEqual(['/invoke']);
    expect(paths['/invoke'].post.operationId).toBe('invoke');
  });

  it('types the request body from the function inputs (drops nameless)', () => {
    const schema = (doc.paths as any)['/invoke'].post.requestBody.content['application/json'].schema;
    const props = schema.properties.inputs.properties;
    expect(Object.keys(props).sort()).toEqual(['blank', 'customerId', 'threshold']);
    expect(props.customerId).toMatchObject({ type: 'string', description: 'The customer' });
    expect(props.threshold).toEqual({ type: 'number' });
    expect(schema.properties.inputs.required).toEqual(['customerId']);
    expect(schema.properties.mode.enum).toEqual(['logic', 'agent']);
  });

  it('types the 200 response from the output contract', () => {
    const resp = (doc.paths as any)['/invoke'].post.responses['200'].content['application/json'].schema;
    expect(resp.properties.output).toMatchObject({ type: 'string', description: 'A one-line risk summary' });
    expect((doc.paths as any)['/invoke'].post.responses['503']).toBeDefined();
  });
});
