import { describe, it, expect } from 'vitest';
import {
  textToSpec, specToText,
  paramsFromSpec, paramsToSpec,
  varsFromSpec, varsToSpec,
  type PipelineSpec,
} from '../types';

describe('pipeline types — spec <-> text', () => {
  it('round-trips a starter spec', () => {
    const starter: PipelineSpec = {
      properties: {
        activities: [{ name: 'Wait1', type: 'Wait', typeProperties: { waitTimeInSeconds: 5 } }],
        parameters: { p1: { type: 'string', defaultValue: 'hi' } },
        variables: { v1: { type: 'String', defaultValue: '' } },
      },
    };
    const txt = specToText(starter);
    const parsed = textToSpec(txt);
    expect(parsed).not.toBeNull();
    expect(parsed!.properties.activities[0].name).toBe('Wait1');
    expect(parsed!.properties.parameters?.p1.type).toBe('string');
  });

  it('textToSpec returns null on bogus JSON', () => {
    expect(textToSpec('{not-json')).toBeNull();
  });

  it('textToSpec backfills missing properties.activities', () => {
    const s = textToSpec('{"properties":{}}');
    expect(s).not.toBeNull();
    expect(s!.properties.activities).toEqual([]);
  });
});

describe('parameters and variables conversion', () => {
  it('paramsFromSpec maps the ADF wire format to flat list', () => {
    const spec: PipelineSpec = {
      properties: {
        activities: [],
        parameters: {
          a: { type: 'string', defaultValue: 'x' },
          b: { type: 'int', defaultValue: 42 },
        },
      },
    };
    const list = paramsFromSpec(spec);
    expect(list).toHaveLength(2);
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(byName.a.defaultValue).toBe('x');
    expect(byName.b.type).toBe('int');
  });

  it('paramsToSpec drops nameless entries', () => {
    const out = paramsToSpec([
      { name: 'good', type: 'string', defaultValue: 1 },
      { name: '', type: 'int', defaultValue: 0 },
    ]);
    expect(Object.keys(out)).toEqual(['good']);
  });

  it('vars round-trip without losing type', () => {
    const spec: PipelineSpec = {
      properties: {
        activities: [],
        variables: {
          flag: { type: 'Boolean', defaultValue: true },
          items: { type: 'Array', defaultValue: [] },
        },
      },
    };
    const list = varsFromSpec(spec);
    const back = varsToSpec(list);
    expect(back.flag.type).toBe('Boolean');
    expect(back.items.type).toBe('Array');
  });
});
