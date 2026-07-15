import { describe, it, expect } from 'vitest';
import {
  diffContracts, bumpVersion, parseSemver, suggestNextVersion, isPastSunset,
} from '../versioning';
import type { DataContract } from '../contract';

const base: DataContract = {
  version: '1.2.3',
  schema: [
    { name: 'id', type: 'string', primaryKey: true, nullable: false },
    { name: 'amount', type: 'number', nullable: true },
  ],
  slo: { freshness: '24h' },
  quality: [],
};

describe('diffContracts — breaking-change taxonomy', () => {
  it('no change → patch, not breaking', () => {
    const d = diffContracts(base, base);
    expect(d.changes).toHaveLength(0);
    expect(d.level).toBe('patch');
    expect(d.breaking).toBe(false);
  });

  it('removing a column is MAJOR + breaking', () => {
    const next = { ...base, schema: [base.schema![0]] };
    const d = diffContracts(base, next);
    expect(d.breaking).toBe(true);
    expect(d.level).toBe('major');
    expect(d.changes[0].kind).toBe('column-removed');
  });

  it('changing a column type is MAJOR + breaking', () => {
    const next = { ...base, schema: [base.schema![0], { name: 'amount', type: 'string' as const, nullable: true }] };
    expect(diffContracts(base, next).level).toBe('major');
  });

  it('tightening nullable→required is MAJOR', () => {
    const next = { ...base, schema: [base.schema![0], { name: 'amount', type: 'number' as const, nullable: false }] };
    const d = diffContracts(base, next);
    expect(d.level).toBe('major');
    expect(d.changes.some((c) => c.kind === 'nullable-tightened')).toBe(true);
  });

  it('adding a column is MINOR, not breaking', () => {
    const next = { ...base, schema: [...base.schema!, { name: 'region', type: 'string' as const, nullable: true }] };
    const d = diffContracts(base, next);
    expect(d.level).toBe('minor');
    expect(d.breaking).toBe(false);
  });

  it('an SLO change alone is MINOR; a quality-only change is PATCH', () => {
    expect(diffContracts(base, { ...base, slo: { freshness: '1h' } }).level).toBe('minor');
    expect(diffContracts(base, { ...base, quality: [{ id: 'q', rule: 'not_null', severity: 'error' }] }).level).toBe('patch');
  });
});

describe('semver bump', () => {
  it('parses tolerant semver', () => {
    expect(parseSemver('2.5.1')).toEqual([2, 5, 1]);
    expect(parseSemver('3')).toEqual([3, 0, 0]);
    expect(parseSemver(undefined)).toEqual([1, 0, 0]);
  });
  it('bumps correctly', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  });
  it('suggestNextVersion classifies a dropped column as a major bump', () => {
    const next = { ...base, schema: [base.schema![0]] };
    const s = suggestNextVersion(base, next);
    expect(s.level).toBe('major');
    expect(s.version).toBe('2.0.0');
  });
});

describe('isPastSunset', () => {
  it('true once the sunset date has passed', () => {
    expect(isPastSunset({ deprecatedAt: 'x', sunsetAt: '2020-01-01', noticeDays: 60 })).toBe(true);
    expect(isPastSunset({ deprecatedAt: 'x', sunsetAt: '2999-01-01', noticeDays: 60 })).toBe(false);
    expect(isPastSunset(undefined)).toBe(false);
  });
});
