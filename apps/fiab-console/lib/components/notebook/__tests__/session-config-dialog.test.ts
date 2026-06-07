import { describe, it, expect } from 'vitest';
import {
  normalizeSessionConfig,
  toConfigureOptions,
  sessionConfigEquals,
  DEFAULT_SESSION_CONFIG,
  type SessionConfig,
} from '../session-config';

describe('session-config-dialog helpers', () => {
  it('clamps out-of-range values to the dialog bounds', () => {
    const c = normalizeSessionConfig({ numExecutors: 999, executorMemoryGb: 0, timeoutMinutes: 99999 });
    expect(c.numExecutors).toBe(100);
    expect(c.executorMemoryGb).toBe(1);
    expect(c.timeoutMinutes).toBe(1440);
  });

  it('falls back to defaults for non-numeric input', () => {
    const c = normalizeSessionConfig({ numExecutors: NaN as unknown as number, executorMemoryGb: undefined, timeoutMinutes: 'x' as unknown as number });
    expect(c).toEqual(DEFAULT_SESSION_CONFIG);
  });

  it('rounds fractional executor counts', () => {
    expect(normalizeSessionConfig({ numExecutors: 2.6 } as Partial<SessionConfig>).numExecutors).toBe(3);
  });

  it('maps to the real Livy session-create body (executors=2 → numExecutors:2)', () => {
    const opts = toConfigureOptions({ numExecutors: 2, executorMemoryGb: 2, timeoutMinutes: 60 });
    expect(opts).toEqual({
      numExecutors: 2,
      executorMemory: '2g',
      driverMemory: '2g',
      heartbeatTimeoutInSecond: 3600,
    });
  });

  it('serializes memory as "<n>g"', () => {
    expect(toConfigureOptions({ numExecutors: 4, executorMemoryGb: 8, timeoutMinutes: 30 }).executorMemory).toBe('8g');
  });

  it('compares configs by normalized value', () => {
    expect(sessionConfigEquals(
      { numExecutors: 2, executorMemoryGb: 4, timeoutMinutes: 60 },
      { numExecutors: 2.2, executorMemoryGb: 4, timeoutMinutes: 60 },
    )).toBe(true);
    expect(sessionConfigEquals(
      { numExecutors: 2, executorMemoryGb: 4, timeoutMinutes: 60 },
      { numExecutors: 3, executorMemoryGb: 4, timeoutMinutes: 60 },
    )).toBe(false);
  });
});
