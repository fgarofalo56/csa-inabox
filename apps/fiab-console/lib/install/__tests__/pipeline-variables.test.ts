/**
 * FGC-24 — Variable-library-aware promotion: pure resolution + rebind logic.
 *
 * No Azure / Cosmos here — this is the exact substitution the deploy/approve
 * routes run at promote time, so it is unit-tested in isolation.
 */
import { describe, it, expect } from 'vitest';
import {
  stageValueSet, referencedTokenNames, collectStageVariableValues, rebindContent, variableDiffRows,
} from '@/lib/install/pipeline-variables';
import type { VarDef } from '@/lib/variables/resolve';

const vars: VarDef[] = [
  { name: 'connectionString', type: 'string', default: 'dev-sql.database.windows.net', test: 'test-sql.database.windows.net', prod: 'prod-sql.database.windows.net' },
  { name: 'BatchSize', type: 'number', default: '1000', prod: '5000' },
  { name: 'ApiKey', type: 'secret-ref', default: 'env:DEV_KEY', prod: 'kv://vault/prod-key' },
];

describe('stageValueSet', () => {
  it('maps by display name', () => {
    expect(stageValueSet({ displayName: 'Development' })).toBe('dev');
    expect(stageValueSet({ displayName: 'Test' })).toBe('test');
    expect(stageValueSet({ displayName: 'Staging' })).toBe('test');
    expect(stageValueSet({ displayName: 'Production' })).toBe('prod');
  });
  it('falls back to order then default', () => {
    expect(stageValueSet({ displayName: 'QA', order: 1 })).toBe('test');
    expect(stageValueSet({ displayName: 'Ring 4', order: 5 })).toBe('default');
  });
});

describe('referencedTokenNames', () => {
  it('extracts distinct {{var:NAME}} names (whitespace tolerant)', () => {
    expect(referencedTokenNames('a {{var:X}} b {{ var: Y }} {{var:X}}')).toEqual(['X', 'Y']);
    expect(referencedTokenNames('no tokens')).toEqual([]);
  });
});

describe('collectStageVariableValues', () => {
  it('resolves the prod value set and excludes secret-refs from values', () => {
    const { values, secretNames } = collectStageVariableValues([vars], 'prod');
    expect(values.connectionString).toBe('prod-sql.database.windows.net');
    expect(values.BatchSize).toBe('5000');
    expect(values.ApiKey).toBeUndefined();
    expect(secretNames.has('ApiKey')).toBe(true);
  });
  it('falls back to default when the set has no override', () => {
    const { values } = collectStageVariableValues([vars], 'test');
    expect(values.connectionString).toBe('test-sql.database.windows.net'); // has test
    expect(values.BatchSize).toBe('1000'); // no test → default
  });
  it('later library wins on a name clash (target overrides source)', () => {
    const src: VarDef[] = [{ name: 'connectionString', type: 'string', default: 'src' }];
    const tgt: VarDef[] = [{ name: 'connectionString', type: 'string', default: 'tgt' }];
    const { values } = collectStageVariableValues([src, tgt], 'default');
    expect(values.connectionString).toBe('tgt');
  });
  it('a secret-ref shadows an earlier non-secret of the same name', () => {
    const a: VarDef[] = [{ name: 'X', type: 'string', default: 'plain' }];
    const b: VarDef[] = [{ name: 'X', type: 'secret-ref', default: 'env:X' }];
    const { values, secretNames } = collectStageVariableValues([a, b], 'default');
    expect(values.X).toBeUndefined();
    expect(secretNames.has('X')).toBe(true);
  });
});

describe('rebindContent', () => {
  const { values, secretNames } = collectStageVariableValues([vars], 'prod');

  it('rebinds tokens in nested strings and records substitutions', () => {
    const content = {
      datasource: { server: '{{var:connectionString}}', batch: 'size={{var:BatchSize}}' },
      steps: ['load {{var:connectionString}}', 'noop'],
    };
    const out = rebindContent(content, values, secretNames);
    expect(out.content.datasource.server).toBe('prod-sql.database.windows.net');
    expect(out.content.datasource.batch).toBe('size=5000');
    expect(out.content.steps[0]).toBe('load prod-sql.database.windows.net');
    expect(out.substitutions.map((s) => s.name).sort()).toEqual(['BatchSize', 'connectionString']);
  });

  it('leaves secret-ref tokens verbatim and reports them skipped', () => {
    const out = rebindContent({ key: 'X-{{var:ApiKey}}' }, values, secretNames);
    expect(out.content.key).toBe('X-{{var:ApiKey}}');
    expect(out.skippedSecrets).toEqual(['ApiKey']);
  });

  it('leaves unknown tokens verbatim and reports them unresolved', () => {
    const out = rebindContent({ key: '{{var:Nope}}' }, values, secretNames);
    expect(out.content.key).toBe('{{var:Nope}}');
    expect(out.unresolved).toEqual(['Nope']);
  });

  it('does not mutate the input (deep clone)', () => {
    const content = { server: '{{var:connectionString}}' };
    const out = rebindContent(content, values, secretNames);
    expect(content.server).toBe('{{var:connectionString}}');
    expect(out.content).not.toBe(content);
  });

  it('passes non-object content through unchanged', () => {
    expect(rebindContent(null, values, secretNames).content).toBeNull();
    expect(rebindContent(42 as unknown, values, secretNames).content).toBe(42);
  });
});

describe('variableDiffRows', () => {
  const stages = [
    { id: 'dev', displayName: 'Development', order: 0 },
    { id: 'test', displayName: 'Test', order: 1 },
    { id: 'prod', displayName: 'Production', order: 2 },
  ];
  const rows = variableDiffRows([vars], stages);

  it('flags variables whose value differs across stages', () => {
    const cs = rows.find((r) => r.name === 'connectionString')!;
    expect(cs.differs).toBe(true);
    expect(cs.perStage.dev.value).toBe('dev-sql.database.windows.net');
    expect(cs.perStage.prod.value).toBe('prod-sql.database.windows.net');
    expect(cs.perStage.dev.valueSet).toBe('dev');
  });

  it('masks secret values and never flags them as differing', () => {
    const k = rows.find((r) => r.name === 'ApiKey')!;
    expect(k.isSecret).toBe(true);
    expect(k.perStage.prod.value).not.toContain('kv://');
    expect(k.differs).toBe(false);
  });

  it('sorts rows by name', () => {
    expect(rows.map((r) => r.name)).toEqual(['ApiKey', 'BatchSize', 'connectionString']);
  });
});
