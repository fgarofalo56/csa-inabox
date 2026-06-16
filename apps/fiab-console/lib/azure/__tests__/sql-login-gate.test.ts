/**
 * Unit tests for the SQL-login honest gate (audit B3).
 */
import { describe, it, expect } from 'vitest';
import { isSqlLoginFailure, sqlLoginGateBody } from '../sql-login-gate';

describe('isSqlLoginFailure', () => {
  it('detects the ELOGIN driver code', () => {
    expect(isSqlLoginFailure({ code: 'ELOGIN', message: 'whatever' })).toBe(true);
  });

  it('detects the 18456 SQL error number', () => {
    expect(isSqlLoginFailure({ number: 18456 })).toBe(true);
  });

  it('detects the "Login failed for user" message', () => {
    expect(isSqlLoginFailure(new Error("Login failed for user '<token-identified principal>'."))).toBe(true);
  });

  it('matches a raw string error', () => {
    expect(isSqlLoginFailure('Login failed for user X')).toBe(true);
  });

  it('does not flag unrelated errors', () => {
    expect(isSqlLoginFailure(new Error('Invalid object name dbo.foo'))).toBe(false);
    expect(isSqlLoginFailure({ code: 'ETIMEOUT' })).toBe(false);
    expect(isSqlLoginFailure(null)).toBe(false);
    expect(isSqlLoginFailure(undefined)).toBe(false);
  });
});

describe('sqlLoginGateBody', () => {
  it('returns a structured, non-faked remediation naming CREATE USER FROM EXTERNAL PROVIDER', () => {
    const body = sqlLoginGateBody({ target: 'the warehouse' });
    expect(body.ok).toBe(false);
    expect(body.code).toBe('sql_login_required');
    expect(body.gate.remediation).toMatch(/FROM EXTERNAL PROVIDER/i);
    expect(body.gate.sql).toMatch(/CREATE USER/);
    // Explicitly NOT a Fabric dependency.
    expect(body.gate.remediation).toMatch(/No Microsoft Fabric is required/i);
  });
});
