/**
 * M2 — copy-in JOB model unit tests (pure state helpers).
 *
 * Pins: copyJobId is stable; summarizeCopyJob rolls per-object status + real row
 * counts into the right job status (running / succeeded / partial / failed) and
 * totals — the shape the /admin/migrate "Copy in" monitor renders.
 */
import { describe, it, expect } from 'vitest';
import {
  copyJobId, summarizeCopyJob, type CopyObjectResult,
} from '@/lib/migrate/copy-job-model';

function obj(over: Partial<CopyObjectResult>): CopyObjectResult {
  return {
    source: 's.t', targetTable: 't', targetKind: 'lakehouse', status: 'running',
    rows: null, activityName: 'Copy_s_t', ...over,
  };
}

describe('copyJobId', () => {
  it('prefixes and trims the migration id', () => {
    expect(copyJobId('snowflake-abc')).toBe('copy:snowflake-abc');
    expect(copyJobId('  x ')).toBe('copy:x');
  });
});

describe('summarizeCopyJob', () => {
  it('is running while any object is pending/running', () => {
    const { status } = summarizeCopyJob([obj({ status: 'succeeded', rows: 5 }), obj({ status: 'running' })]);
    expect(status).toBe('running');
  });

  it('is succeeded when all done with no failures', () => {
    const { status, totals } = summarizeCopyJob([
      obj({ status: 'succeeded', rows: 10 }),
      obj({ status: 'succeeded', rows: 7 }),
    ]);
    expect(status).toBe('succeeded');
    expect(totals).toEqual({ objects: 2, succeeded: 2, failed: 0, rows: 17 });
  });

  it('is partial when some succeed and some fail', () => {
    const { status, totals } = summarizeCopyJob([
      obj({ status: 'succeeded', rows: 3 }),
      obj({ status: 'failed' }),
    ]);
    expect(status).toBe('partial');
    expect(totals.succeeded).toBe(1);
    expect(totals.failed).toBe(1);
    expect(totals.rows).toBe(3);
  });

  it('is failed when every settled object failed', () => {
    const { status } = summarizeCopyJob([obj({ status: 'failed' }), obj({ status: 'failed' })]);
    expect(status).toBe('failed');
  });
});
