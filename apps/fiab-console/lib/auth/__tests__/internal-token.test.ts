/**
 * Unit tests for the MAF-tier internal trust-token gate. This is the security
 * boundary that lets the VNet-internal MAF orchestration app call the Console's
 * /api/internal/copilot/* endpoints WITHOUT an MSAL session, so its fail-closed
 * behaviour is load-bearing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isValidInternalToken } from '@/lib/auth/internal-token';

const ORIG = process.env.LOOM_INTERNAL_TOKEN;

afterEach(() => {
  if (ORIG === undefined) delete process.env.LOOM_INTERNAL_TOKEN;
  else process.env.LOOM_INTERNAL_TOKEN = ORIG;
});

describe('isValidInternalToken', () => {
  it('fails closed when LOOM_INTERNAL_TOKEN is unset', () => {
    delete process.env.LOOM_INTERNAL_TOKEN;
    expect(isValidInternalToken('anything')).toBe(false);
  });

  it('rejects a missing / empty presented token', () => {
    process.env.LOOM_INTERNAL_TOKEN = 'secret-abc';
    expect(isValidInternalToken(null)).toBe(false);
    expect(isValidInternalToken(undefined)).toBe(false);
    expect(isValidInternalToken('')).toBe(false);
  });

  it('rejects a mismatched token', () => {
    process.env.LOOM_INTERNAL_TOKEN = 'secret-abc';
    expect(isValidInternalToken('secret-xyz')).toBe(false);
    // Different length must not throw (digest equalises length).
    expect(isValidInternalToken('s')).toBe(false);
    expect(isValidInternalToken('secret-abc-longer')).toBe(false);
  });

  it('accepts the exact token', () => {
    process.env.LOOM_INTERNAL_TOKEN = 'secret-abc';
    expect(isValidInternalToken('secret-abc')).toBe(true);
  });
});
