import { describe, it, expect } from 'vitest';
import {
  validateRestoreRequest,
  defaultRestorePoint,
  normalizeRestoreStatus,
  SQL_DB_NAME_MAX,
  type RestorableWindow,
} from '../sql-restore-model';

const window: RestorableWindow = {
  earliestRestoreDate: '2026-07-01T00:00:00.000Z',
  latestRestoreDate: '2026-07-08T00:00:00.000Z',
};

describe('validateRestoreRequest — target name', () => {
  it('requires a target name', () => {
    const v = validateRestoreRequest({ window, restorePointInTime: '2026-07-05T00:00:00Z', targetDatabase: '' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/name for the restored database/i);
  });

  it('rejects a name colliding with an existing database (case-insensitive)', () => {
    const v = validateRestoreRequest({
      window, restorePointInTime: '2026-07-05T00:00:00Z',
      targetDatabase: 'Sales', existingNames: ['sales', 'hr'],
    });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/already exists/i);
  });

  it('rejects the source database name (restore always creates a new DB)', () => {
    const v = validateRestoreRequest({
      window, restorePointInTime: '2026-07-05T00:00:00Z',
      targetDatabase: 'sales', sourceDatabase: 'Sales',
    });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/differ from the source/i);
  });

  it('rejects invalid characters and trailing period/space', () => {
    expect(validateRestoreRequest({ window, restorePointInTime: '2026-07-05T00:00:00Z', targetDatabase: 'a/b' }).ok).toBe(false);
    expect(validateRestoreRequest({ window, restorePointInTime: '2026-07-05T00:00:00Z', targetDatabase: 'good.' }).ok).toBe(false);
    expect(validateRestoreRequest({ window, restorePointInTime: '2026-07-05T00:00:00Z', targetDatabase: 'a b' }).ok).toBe(false);
  });

  it('rejects a name longer than the SQL max', () => {
    const long = 'd'.repeat(SQL_DB_NAME_MAX + 1);
    const v = validateRestoreRequest({ window, restorePointInTime: '2026-07-05T00:00:00Z', targetDatabase: long });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/characters or fewer/i);
  });
});

describe('validateRestoreRequest — window bounds', () => {
  it('accepts a restore point inside the window', () => {
    const v = validateRestoreRequest({
      window, restorePointInTime: '2026-07-05T12:00:00Z',
      targetDatabase: 'sales_restore', sourceDatabase: 'sales',
    });
    expect(v.ok).toBe(true);
  });

  it('rejects a restore point before the earliest backup', () => {
    const v = validateRestoreRequest({
      window, restorePointInTime: '2026-06-01T00:00:00Z', targetDatabase: 'sales_restore',
    });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/before the earliest/i);
  });

  it('rejects a restore point after the latest restorable time', () => {
    const v = validateRestoreRequest({
      window, restorePointInTime: '2026-07-20T00:00:00Z', targetDatabase: 'sales_restore',
    });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/after the latest/i);
  });

  it('flags a missing window as not-loaded', () => {
    const v = validateRestoreRequest({ restorePointInTime: '2026-07-05T00:00:00Z', targetDatabase: 'sales_restore' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/window not loaded/i);
  });

  it('rejects an unparseable restore point', () => {
    const v = validateRestoreRequest({ window, restorePointInTime: 'not-a-date', targetDatabase: 'sales_restore' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/valid restore point/i);
  });
});

describe('defaultRestorePoint', () => {
  it('defaults to the latest restorable time', () => {
    expect(defaultRestorePoint(window)).toBe(window.latestRestoreDate);
  });
  it('falls back to now-ish when no window', () => {
    const iso = defaultRestorePoint(null);
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });
});

describe('normalizeRestoreStatus', () => {
  it('maps success/online to Succeeded', () => {
    expect(normalizeRestoreStatus('Succeeded')).toBe('Succeeded');
    expect(normalizeRestoreStatus('Online')).toBe('Succeeded');
  });
  it('maps failed/canceled to Failed', () => {
    expect(normalizeRestoreStatus('Failed')).toBe('Failed');
    expect(normalizeRestoreStatus('Canceled')).toBe('Failed');
  });
  it('maps in-flight states to InProgress', () => {
    expect(normalizeRestoreStatus('InProgress')).toBe('InProgress');
    expect(normalizeRestoreStatus('Creating')).toBe('InProgress');
  });
  it('maps unknown to Unknown', () => {
    expect(normalizeRestoreStatus('whatever')).toBe('Unknown');
    expect(normalizeRestoreStatus(undefined)).toBe('Unknown');
  });
});
