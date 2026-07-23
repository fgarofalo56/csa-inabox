/** SLO1 shared reader — pure verdict parsing (Blob I/O is not exercised here). */
import { describe, expect, it } from 'vitest';
import { parseVerdicts } from '../synthetic-runs-reader';

const ndjson = [
  JSON.stringify({ surface: 'synthetic:J1', feature: 'Sign-in (MSAL)', status: 'pass', verdict: 'ok', durationMs: 1200, ts: '2026-07-23T12:00:00.000Z' }),
  JSON.stringify({ surface: 'synthetic:J2', feature: 'Create item', status: 'fail', notes: 'editor 500', durationMs: 3400 }),
  JSON.stringify({ surface: 'synthetic:J3', feature: 'Git sync', status: 'skip' }),
  JSON.stringify({ surface: 'other:noise', status: 'pass' }), // ignored — not a synthetic surface
  'not json',
  '',
].join('\n');

describe('parseVerdicts', () => {
  it('counts pass/fail/skip and keeps the first timestamp', () => {
    const r = parseVerdicts('2026-07-23T12-00-00-000Z', ndjson);
    expect(r.pass).toBe(1);
    expect(r.fail).toBe(1);
    expect(r.skip).toBe(1);
    expect(r.journeys).toHaveLength(3); // non-synthetic + junk lines dropped
    expect(r.ts).toBe('2026-07-23T12:00:00.000Z');
  });

  it('names a journey from feature, else the surface slug', () => {
    const r = parseVerdicts('run', JSON.stringify({ surface: 'synthetic:J9', status: 'pass' }));
    expect(r.journeys[0].name).toBe('J9');
  });

  it('coerces an unknown status to fail (fail-safe)', () => {
    const r = parseVerdicts('run', JSON.stringify({ surface: 'synthetic:J1', status: 'weird' }));
    expect(r.journeys[0].status).toBe('fail');
  });

  it('returns an empty summary for empty text', () => {
    const r = parseVerdicts('run', '');
    expect(r.journeys).toHaveLength(0);
    expect(r.pass + r.fail + r.skip).toBe(0);
  });
});
