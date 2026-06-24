import { describe, it, expect } from 'vitest';
import { redactSparkConf, redactReceiptSecrets } from '../config-presets';

describe('redactSparkConf', () => {
  it('masks the LA shared key but keeps non-secret confs', () => {
    const out = redactSparkConf({
      'spark.synapse.logAnalytics.enabled': 'true',
      'spark.synapse.logAnalytics.workspaceId': 'guid-1234',
      'spark.synapse.logAnalytics.secret': 'SUPERSECRETKEY==',
      'spark.sql.shuffle.partitions': '400',
    })!;
    expect(out['spark.synapse.logAnalytics.secret']).toBe('***redacted***');
    expect(out['spark.synapse.logAnalytics.workspaceId']).toBe('guid-1234');
    expect(out['spark.synapse.logAnalytics.enabled']).toBe('true');
    expect(out['spark.sql.shuffle.partitions']).toBe('400');
  });
  it('passes through undefined', () => {
    expect(redactSparkConf(undefined)).toBeUndefined();
  });
});

describe('redactReceiptSecrets', () => {
  it('deep-masks secret-bearing keys in a Livy receipt', () => {
    const receipt = {
      id: 293,
      reused: true,
      numExecutors: 2,
      conf: {
        'spark.synapse.logAnalytics.secret': 'SUPERSECRETKEY==',
        'spark.synapse.logAnalytics.workspaceId': 'guid-1234',
      },
      nested: { accountKey: 'abc', sharedKey: 'def', token: 'ghi', name: 'keep-me' },
    };
    const out = redactReceiptSecrets(receipt);
    expect(out.conf['spark.synapse.logAnalytics.secret']).toBe('***redacted***');
    expect(out.conf['spark.synapse.logAnalytics.workspaceId']).toBe('guid-1234');
    expect(out.nested.accountKey).toBe('***redacted***');
    expect(out.nested.sharedKey).toBe('***redacted***');
    expect(out.nested.token).toBe('***redacted***');
    expect(out.nested.name).toBe('keep-me');
    expect(out.numExecutors).toBe(2);
    expect(out.reused).toBe(true);
    // original is untouched (pure)
    expect(receipt.conf['spark.synapse.logAnalytics.secret']).toBe('SUPERSECRETKEY==');
  });
  it('handles arrays + primitives + null', () => {
    expect(redactReceiptSecrets(null)).toBeNull();
    expect(redactReceiptSecrets('x')).toBe('x');
    const arr = redactReceiptSecrets([{ password: 'p' }, { ok: 'v' }]);
    expect(arr[0].password).toBe('***redacted***');
    expect(arr[1].ok).toBe('v');
  });
});
