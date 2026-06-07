import { describe, it, expect } from 'vitest';
import { sparkConfigWarnings, cloudFabricNote } from '../lakehouse-spark-conf';

describe('sparkConfigWarnings', () => {
  it('returns nothing for a clean, correct conf', () => {
    const out = sparkConfigWarnings('spark.sql.shuffle.partitions=200\nspark.executor.memory=4g');
    expect(out).toHaveLength(0);
  });

  it('ignores blank lines and comments', () => {
    const out = sparkConfigWarnings('\n# a comment\n   \nspark.executor.memory=4g\n');
    expect(out).toHaveLength(0);
  });

  it('flags a missing spark.sql. prefix typo as an error with the correct key', () => {
    const out = sparkConfigWarnings('spark.shufflePartitions=200');
    expect(out).toHaveLength(1);
    expect(out[0].intent).toBe('error');
    expect(out[0].body).toContain('spark.sql.shuffle.partitions');
  });

  it('flags the BroadCast casing typo', () => {
    const out = sparkConfigWarnings('spark.sql.autoBroadCastJoinThreshold=10485760');
    expect(out.some((w) => w.intent === 'error' && w.body.includes('spark.sql.autoBroadcastJoinThreshold'))).toBe(true);
  });

  it('flags abbreviated memory keys', () => {
    const out = sparkConfigWarnings('spark.executor.mem=4g\nspark.driver.mem=2g');
    expect(out.filter((w) => w.intent === 'error')).toHaveLength(2);
  });

  it('flags enable→enabled typos', () => {
    const out = sparkConfigWarnings('spark.sql.adaptive.enable=true');
    expect(out[0].intent).toBe('error');
    expect(out[0].body).toContain('spark.sql.adaptive.enabled');
  });

  it('does NOT flag the correctly-spelled adaptive.enabled key', () => {
    const out = sparkConfigWarnings('spark.sql.adaptive.enabled=true');
    expect(out).toHaveLength(0);
  });

  it('warns (not errors) on a Fabric-only spark.ms.* key', () => {
    const out = sparkConfigWarnings('spark.ms.autotune.enabled=true');
    expect(out).toHaveLength(1);
    expect(out[0].intent).toBe('warning');
    expect(out[0].title).toContain('Fabric-only');
  });

  it('warns on a Fabric-only V-Order key', () => {
    const out = sparkConfigWarnings('spark.sql.parquet.vorder.default=true');
    expect(out.some((w) => w.intent === 'warning')).toBe(true);
  });

  it('flags the legacy vorder.enable key as a typo for vorder.default', () => {
    const out = sparkConfigWarnings('spark.sql.parquet.vorder.enable=true');
    // both a typo (error) and a fabric-only (warning) fire for this key
    expect(out.some((w) => w.intent === 'error' && w.body.includes('spark.sql.parquet.vorder.default'))).toBe(true);
  });

  it('does not duplicate a warning for a repeated key', () => {
    const out = sparkConfigWarnings('spark.ms.autotune.enabled=true\nspark.ms.autotune.enabled=false');
    expect(out.filter((w) => w.title.includes('spark.ms.autotune.enabled'))).toHaveLength(1);
  });
});

describe('cloudFabricNote', () => {
  it('is empty in commercial (Fabric F-SKUs exist there)', () => {
    expect(cloudFabricNote('commercial')).toBe('');
  });

  it('discloses no F-SKU in GCC', () => {
    expect(cloudFabricNote('gcc')).toContain('GCC');
    expect(cloudFabricNote('gcc')).toContain('no Fabric F-SKU');
  });

  it('discloses unavailability in GCC-High and IL5', () => {
    expect(cloudFabricNote('gcch')).toContain('GCC-High');
    expect(cloudFabricNote('il5')).toContain('IL5');
  });
});
