/**
 * Unit tests for the sign-in-boundary access-request validation + helpers.
 * Pure functions — no Cosmos / fetch, so these run with zero mocking.
 */
import { describe, it, expect } from 'vitest';
import {
  validateSigninAccessRequest,
  hashClientIp,
  deploymentTenantBucket,
} from '../signin-access-request';

const valid = {
  displayName: 'Ada Lovelace',
  email: 'Ada@Contoso.com',
  organization: 'Contoso',
  reason: 'I lead the analytics team and need to build reports in Loom.',
};

describe('validateSigninAccessRequest', () => {
  it('accepts a well-formed request and lower-cases the email', () => {
    const r = validateSigninAccessRequest({ ...valid });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.email).toBe('ada@contoso.com');
      expect(r.value.displayName).toBe('Ada Lovelace');
      expect(r.value.organization).toBe('Contoso');
    }
  });

  it('flags the honeypot when the hidden field is populated', () => {
    const r = validateSigninAccessRequest({ ...valid, company_website: 'http://spam.example' });
    expect(r.ok).toBe(false);
    expect('honeypot' in r && r.honeypot).toBe(true);
  });

  it('requires a name', () => {
    const r = validateSigninAccessRequest({ ...valid, displayName: '  ' });
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid email', () => {
    const r = validateSigninAccessRequest({ ...valid, email: 'not-an-email' });
    expect(r.ok).toBe(false);
  });

  it('requires a reason', () => {
    const r = validateSigninAccessRequest({ ...valid, reason: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects a reason over 500 chars', () => {
    const r = validateSigninAccessRequest({ ...valid, reason: 'x'.repeat(501) });
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed Entra object id', () => {
    const r = validateSigninAccessRequest({ ...valid, aadObjectId: 'nope' });
    expect(r.ok).toBe(false);
  });

  it('accepts a well-formed Entra object id', () => {
    const r = validateSigninAccessRequest({ ...valid, aadObjectId: '00000000-0000-0000-0000-000000000000' });
    expect(r.ok).toBe(true);
  });

  it('treats non-string fields as empty (no throw)', () => {
    const r = validateSigninAccessRequest({ displayName: 123 as any, email: null as any, reason: {} as any });
    expect(r.ok).toBe(false);
  });
});

describe('helpers', () => {
  it('hashClientIp is deterministic and does not leak the raw ip', () => {
    const h = hashClientIp('203.0.113.7');
    expect(h).toHaveLength(12);
    expect(h).not.toContain('203');
    expect(hashClientIp('203.0.113.7')).toBe(h);
  });

  it('deploymentTenantBucket is a stable 16-char hash', () => {
    const a = deploymentTenantBucket();
    expect(a).toHaveLength(16);
    expect(deploymentTenantBucket()).toBe(a);
  });
});
