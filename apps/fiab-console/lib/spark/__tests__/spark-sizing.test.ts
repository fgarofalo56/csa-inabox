/**
 * Unit tests for the canonical Spark sizing (R3 #1). These guard the invariant
 * that makes the warm pool actually usable: "no config", "the explicit default
 * config", and the pool's default all normalize to the SAME stable sizingKey,
 * while a genuinely custom config gets its own distinct key.
 *
 * Pure module (config-presets is dependency-free; the LivySessionSizing import
 * is type-only) so no mocks / @azure/identity are needed.
 */
import { describe, it, expect } from 'vitest';
import {
  computeEffectiveSizing,
  defaultSynapseSizing,
  stableStringify,
  DEFAULT_LIVY_SIZING,
} from '@/lib/spark/spark-sizing';
import { toConfigureOptions, DEFAULT_SESSION_CONFIG } from '@/lib/components/notebook/session-config';

describe('DEFAULT_LIVY_SIZING invariant', () => {
  it('stays 1:1 with the editor default (toConfigureOptions(DEFAULT_SESSION_CONFIG))', () => {
    const editorDefault = toConfigureOptions(DEFAULT_SESSION_CONFIG);
    expect(DEFAULT_LIVY_SIZING.numExecutors).toBe(editorDefault.numExecutors);
    expect(DEFAULT_LIVY_SIZING.executorMemory).toBe(editorDefault.executorMemory);
    expect(DEFAULT_LIVY_SIZING.driverMemory).toBe(editorDefault.driverMemory);
    expect(DEFAULT_LIVY_SIZING.heartbeatTimeoutInSecond).toBe(editorDefault.heartbeatTimeoutInSecond);
  });
});

describe('computeEffectiveSizing — key alignment (the R3 #1 fix)', () => {
  it('no config === the explicit default config (same sizingKey)', () => {
    const noConfig = computeEffectiveSizing(null, {});
    const explicitDefault = computeEffectiveSizing(toConfigureOptions(DEFAULT_SESSION_CONFIG), {});
    expect(noConfig.sizingKey).toBe(explicitDefault.sizingKey);
  });

  it("the warm pool default matches a default run's key", () => {
    // defaultSynapseSizing() (used by the pool) must equal a default run.
    const poolDefault = defaultSynapseSizing();
    const defaultRun = computeEffectiveSizing(null);
    expect(poolDefault.sizingKey).toBe(defaultRun.sizingKey);
  });

  it('a custom config produces a DIFFERENT key (its own session)', () => {
    const dflt = computeEffectiveSizing(null, {});
    const custom = computeEffectiveSizing({ numExecutors: 4, executorMemory: '8g', driverMemory: '8g', heartbeatTimeoutInSecond: 1800 }, {});
    expect(custom.sizingKey).not.toBe(dflt.sizingKey);
  });

  it('defaults every missing field from DEFAULT_LIVY_SIZING', () => {
    const partial = computeEffectiveSizing({ numExecutors: 3 }, {});
    expect(partial.sizing.numExecutors).toBe(3);
    expect(partial.sizing.executorMemory).toBe(DEFAULT_LIVY_SIZING.executorMemory);
    expect(partial.sizing.driverMemory).toBe(DEFAULT_LIVY_SIZING.driverMemory);
    expect(partial.sizing.heartbeatTimeoutInSecond).toBe(DEFAULT_LIVY_SIZING.heartbeatTimeoutInSecond);
  });
});

describe('sizingKey stability', () => {
  it('is independent of conf key order', () => {
    const a = computeEffectiveSizing({ conf: { b: '2', a: '1' } as any }, {});
    const b = computeEffectiveSizing({ conf: { a: '1', b: '2' } as any }, {});
    expect(a.sizingKey).toBe(b.sizingKey);
  });

  it('merges LA conf and lets user conf win on conflicts', () => {
    const { sizing } = computeEffectiveSizing({ conf: { logLevel: 'DEBUG' } as any }, { logLevel: 'INFO', laKey: 'x' });
    expect(sizing.conf).toEqual({ logLevel: 'DEBUG', laKey: 'x' });
  });

  it('stableStringify sorts keys recursively and omits undefined', () => {
    expect(stableStringify({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });
});
