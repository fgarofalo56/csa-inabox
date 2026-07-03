/**
 * Unit tests for the MAF-tier internal trust-token gate. This is the security
 * boundary that lets the VNet-internal MAF orchestration app call the Console's
 * /api/internal/copilot/* endpoints WITHOUT an MSAL session, so its fail-closed
 * behaviour is load-bearing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isValidInternalToken, validateInternalOid } from '@/lib/auth/internal-token';

const ORIG = process.env.LOOM_INTERNAL_TOKEN;
const ORIG_IQ = process.env.LOOM_IQ_MCP_TOKEN;
const ORIG_ALLOW = process.env.LOOM_INTERNAL_ALLOWED_OIDS;

function restore(name: string, val: string | undefined) {
  if (val === undefined) delete process.env[name];
  else process.env[name] = val;
}

afterEach(() => {
  restore('LOOM_INTERNAL_TOKEN', ORIG);
  restore('LOOM_IQ_MCP_TOKEN', ORIG_IQ);
  restore('LOOM_INTERNAL_ALLOWED_OIDS', ORIG_ALLOW);
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

  it('prefers a dedicated env var EXCLUSIVELY when set (per-service isolation)', () => {
    process.env.LOOM_INTERNAL_TOKEN = 'shared-secret';
    process.env.LOOM_IQ_MCP_TOKEN = 'iq-only';
    // Once the dedicated var is set, the shared internal token must NOT open it.
    expect(isValidInternalToken('shared-secret', 'LOOM_IQ_MCP_TOKEN')).toBe(false);
    expect(isValidInternalToken('iq-only', 'LOOM_IQ_MCP_TOKEN')).toBe(true);
  });

  it('falls back to the shared token when the dedicated var is unset/empty', () => {
    process.env.LOOM_INTERNAL_TOKEN = 'shared-secret';
    delete process.env.LOOM_IQ_MCP_TOKEN;
    expect(isValidInternalToken('shared-secret', 'LOOM_IQ_MCP_TOKEN')).toBe(true);
    process.env.LOOM_IQ_MCP_TOKEN = '   ';
    expect(isValidInternalToken('shared-secret', 'LOOM_IQ_MCP_TOKEN')).toBe(true);
  });
});

describe('validateInternalOid', () => {
  const GUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  it('rejects a missing or malformed oid', () => {
    expect(validateInternalOid(null)).toBeNull();
    expect(validateInternalOid(undefined)).toBeNull();
    expect(validateInternalOid('')).toBeNull();
    expect(validateInternalOid('not-a-guid')).toBeNull();
    expect(validateInternalOid('tenant-123')).toBeNull();
    expect(validateInternalOid(`${GUID}/../etc`)).toBeNull();
  });

  it('accepts a well-formed GUID and normalizes to lowercase', () => {
    expect(validateInternalOid(GUID)).toBe(GUID);
    expect(validateInternalOid(`  ${GUID.toUpperCase()}  `)).toBe(GUID);
  });

  it('enforces LOOM_INTERNAL_ALLOWED_OIDS when configured', () => {
    const other = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';
    process.env.LOOM_INTERNAL_ALLOWED_OIDS = `${GUID}, ${other}`;
    expect(validateInternalOid(GUID)).toBe(GUID);
    expect(validateInternalOid('11111111-2222-3333-4444-555555555555')).toBeNull();
  });
});
