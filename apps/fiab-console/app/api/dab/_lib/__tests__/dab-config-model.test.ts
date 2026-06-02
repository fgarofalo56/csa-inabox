/**
 * dab-config-model — pure emit + validate logic (node env, no render).
 *
 * Covers the Synapse (dwsql) additions:
 *  - Synapse Dedicated emits database-type: dwsql (a real DAB type per Learn).
 *  - Synapse Serverless is flagged non-deployable (DAB does not support it).
 */
import { describe, it, expect } from 'vitest';
import {
  emptyDabConfig, emitDabConfig, validateDabConfig, type DabConfig,
} from '../dab-config-model';

function base(partial: Partial<DabConfig['sourceRef']>): DabConfig {
  const cfg = emptyDabConfig('dwsql');
  cfg.sourceRef = { kind: 'dwsql', database: 'pool1', ...partial } as DabConfig['sourceRef'];
  // give it a valid runtime + one entity so unrelated validators stay quiet
  cfg.runtime.host.mode = 'development';
  cfg.entities = [{
    name: 'Book', source: { object: 'dbo.Book', type: 'table' },
    rest: { enabled: true, path: '/book' }, graphql: { enabled: true, singular: 'Book', plural: 'Books' },
    fields: [{ name: 'id', primaryKey: true }],
    permissions: [{ role: 'anonymous', actions: [{ action: 'read' }] }],
  }];
  return cfg;
}

describe('Synapse dwsql data source', () => {
  it('emits database-type: dwsql for a Synapse Dedicated pool', () => {
    const out = emitDabConfig(base({ synapseRole: 'dedicated', server: 'ws.sql.azuresynapse.net' }));
    expect((out['data-source'] as any)['database-type']).toBe('dwsql');
    // never embeds a literal secret — @env reference only.
    expect((out['data-source'] as any)['connection-string']).toContain("@env('");
  });

  it('passes validation for a Synapse Dedicated pool', () => {
    const issues = validateDabConfig(base({ synapseRole: 'dedicated', server: 'ws.sql.azuresynapse.net' }));
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('flags Synapse Serverless as a non-deployable DAB source (honest error)', () => {
    const issues = validateDabConfig(base({ synapseRole: 'serverless', server: 'ws-ondemand.sql.azuresynapse.net' }));
    const err = issues.find((i) => i.severity === 'error' && /serverless/i.test(i.message));
    expect(err).toBeTruthy();
    expect(err?.path).toBe('data-source.database-type');
  });
});
