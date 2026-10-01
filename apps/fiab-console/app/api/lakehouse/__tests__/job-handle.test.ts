/**
 * Unit tests for the lakehouse Spark job handle (`../_lib/job-handle`).
 *
 * Each refusal is paired with the acceptance of the SAME handle under the scope
 * it was minted for, so a verifier that refuses everything fails the pair.
 */
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';

process.env.SESSION_SECRET = 'unit-test-session-secret-for-lakehouse-job-handles';

import {
  LAKEHOUSE_JOB_PREFIX, LAKEHOUSE_JOB_TTL_MS, SPARK_POOL_NAME_RE, mintLakehouseJobHandle, verifyLakehouseJobHandle,
} from '../_lib/job-handle';

/**
 * Sign an arbitrary handle body with the same HKDF key the module derives, so a
 * test can present a correctly signed handle `mintLakehouseJobHandle` refuses to
 * produce. Every use is paired with a control (the same signer, a body the
 * verifier accepts) so a signer that disagrees with the module turns the control
 * red rather than making a refusal pass for the wrong reason.
 */
function signBody(body: Record<string, unknown>): string {
  const key = Buffer.from(crypto.hkdfSync(
    'sha256', Buffer.from(String(process.env.SESSION_SECRET), 'utf-8'), Buffer.alloc(32),
    Buffer.from('loom-lakehouse-job-v1'), 32,
  ) as ArrayBuffer);
  const payload = Buffer.from(JSON.stringify(body), 'utf-8').toString('base64url');
  return `${LAKEHOUSE_JOB_PREFIX}${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`;
}

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

  it('refuses to mint for an empty principal, and mints for a named one', () => {
    // Breaks if mint signs a handle bound to no one ('' would then match any
    // other session whose oid is also missing).
    expect(() => mintLakehouseJobHandle({ ...SCOPE, oid: '' }, CLAIMS, T0)).toThrow(/object id/);
    expect(() => mintLakehouseJobHandle(SCOPE, CLAIMS, T0)).not.toThrow();
  });

  it('verifies nothing under an empty polling principal', () => {
    // A MINTED handle cannot witness the empty-oid refusal: mint refuses an empty
    // oid, so its `o` never equals '' and the principal comparison refuses it
    // anyway. Only a signed handle whose `o` IS '' reaches that refusal, so the
    // body is signed here directly. Breaks if verify drops `if (!scope.oid)`:
    // this body then matches item, purpose and principal ('' === '') and verifies.
    const body = {
      i: SCOPE.lakehouseId, u: SCOPE.purpose, p: CLAIMS.pool, s: CLAIMS.sessionId, t: CLAIMS.stmtId,
      c: CLAIMS.container, f: CLAIMS.path, at: T0,
    };
    expect(verifyLakehouseJobHandle({ ...SCOPE, oid: '' }, signBody({ ...body, o: '' }), T0)).toBeNull();
    // Control: the same signer with a named principal verifies, so the refusal
    // above is not a bad signature.
    expect(verifyLakehouseJobHandle(SCOPE, signBody({ ...body, o: SCOPE.oid }), T0)).toEqual(CLAIMS);
  });

  it('carries the bound storage account through a round trip', () => {
    const h = mintLakehouseJobHandle(SCOPE, { ...CLAIMS, account: 'extacct' }, T0);
    // Breaks if mint drops `a` or verify does not return it.
    expect(verifyLakehouseJobHandle(SCOPE, h, T0)).toEqual({ ...CLAIMS, account: 'extacct' });
    // No account minted -> none returned (the round-trip test above pins that shape).
    expect(verifyLakehouseJobHandle(SCOPE, mintLakehouseJobHandle(SCOPE, CLAIMS, T0), T0)).not.toHaveProperty('account');
  });

  it('refuses a signed handle whose account field is not a non-empty string', () => {
    // Minted (so correctly signed) with a numeric account: only the shape check
    // on `a` can refuse it.
    const h = mintLakehouseJobHandle(SCOPE, { ...CLAIMS, account: 123 as unknown as string }, T0);
    expect(verifyLakehouseJobHandle(SCOPE, h, T0)).toBeNull();
    expect(verifyLakehouseJobHandle(SCOPE, mintLakehouseJobHandle(SCOPE, { ...CLAIMS, account: 'acct' }, T0), T0))
      .toMatchObject({ account: 'acct' });
  });
});
