/**
 * Unit tests for the lakehouse Spark job handle (`../_lib/job-handle`).
 *
 * Each refusal is paired with the acceptance of the SAME handle under the scope
 * it was minted for, so a verifier that refuses everything fails the pair.
 */
import { describe, it, expect } from 'vitest';

process.env.SESSION_SECRET = 'unit-test-session-secret-for-lakehouse-job-handles';

import {
  LAKEHOUSE_JOB_TTL_MS, SPARK_POOL_NAME_RE, mintLakehouseJobHandle, verifyLakehouseJobHandle,
} from '../_lib/job-handle';

const SCOPE = { lakehouseId: 'lh-1', purpose: 'table-stats' as const, oid: 'o1' };
const CLAIMS = { pool: 'loompool', sessionId: 4, stmtId: 2, container: 'landing', path: 'lakehouses/a/Tables/t' };
const T0 = 1_700_000_000_000;

describe('lakehouse job handle', () => {
  it('round-trips under the scope it was minted for', () => {
    const h = mintLakehouseJobHandle(SCOPE, CLAIMS, T0);
    expect(verifyLakehouseJobHandle(SCOPE, h, T0 + 1000)).toEqual(CLAIMS);
  });

  it('is refused for another route purpose', () => {
    const h = mintLakehouseJobHandle(SCOPE, CLAIMS, T0);
    expect(verifyLakehouseJobHandle({ ...SCOPE, purpose: 'transform-preview' }, h, T0)).toBeNull();
    expect(verifyLakehouseJobHandle(SCOPE, h, T0)).not.toBeNull();
  });

  it('is refused once older than the TTL, and accepted one millisecond inside it', () => {
    const h = mintLakehouseJobHandle(SCOPE, CLAIMS, T0);
    expect(verifyLakehouseJobHandle(SCOPE, h, T0 + LAKEHOUSE_JOB_TTL_MS)).not.toBeNull();
    expect(verifyLakehouseJobHandle(SCOPE, h, T0 + LAKEHOUSE_JOB_TTL_MS + 1)).toBeNull();
  });

  it('is refused when minted under a different SESSION_SECRET', () => {
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'another-secret-value-for-this-test-only';
    const h = mintLakehouseJobHandle(SCOPE, CLAIMS, T0);
    process.env.SESSION_SECRET = saved;
    expect(verifyLakehouseJobHandle(SCOPE, h, T0)).toBeNull();
    expect(verifyLakehouseJobHandle(SCOPE, mintLakehouseJobHandle(SCOPE, CLAIMS, T0), T0)).not.toBeNull();
  });

  it('pool-name pattern: accepts Synapse pool names, refuses path characters and over-length names', () => {
    expect(SPARK_POOL_NAME_RE.test('loompool')).toBe(true);
    expect(SPARK_POOL_NAME_RE.test('a23456789012345')).toBe(true); // 15 chars
    expect(SPARK_POOL_NAME_RE.test('a234567890123456')).toBe(false); // 16 chars
    expect(SPARK_POOL_NAME_RE.test('pool/sessions')).toBe(false);
    expect(SPARK_POOL_NAME_RE.test('1pool')).toBe(false);
  });
});
