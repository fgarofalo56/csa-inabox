/**
 * Pure-helper unit tests for networking-client (F15 Advanced networking).
 *
 * These exercise the deterministic helpers (CIDR validation, ARM-safe rule
 * naming, priority allocation) + the honest-gate config reader — no live ARM,
 * no Cosmos. Per no-vaporware.md these do not pretend to cover backend behavior
 * they don't exercise; the ARM write paths are validated live (see the parity
 * doc's E2E receipt).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  isValidCidr, nsgRuleNameFor, nextPriority,
  readNetworkingConfig, NetworkingNotConfiguredError,
} from '@/lib/clients/networking-client';

describe('isValidCidr', () => {
  it('accepts valid IPv4 CIDRs', () => {
    expect(isValidCidr('203.0.113.0/24')).toBe(true);
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
    expect(isValidCidr('192.168.1.1')).toBe(true); // bare address ok
    expect(isValidCidr('255.255.255.255/32')).toBe(true);
  });
  it('rejects malformed / out-of-range CIDRs', () => {
    expect(isValidCidr('not-a-cidr')).toBe(false);
    expect(isValidCidr('203.0.113.0/33')).toBe(false);
    expect(isValidCidr('256.0.0.1/24')).toBe(false);
    expect(isValidCidr('10.0.0/24')).toBe(false);
    expect(isValidCidr('')).toBe(false);
    // @ts-expect-error — non-string guard
    expect(isValidCidr(null)).toBe(false);
  });
});

describe('nsgRuleNameFor', () => {
  it('produces an ARM-safe rule name (no slashes/dots, <= 80 chars)', () => {
    const n = nsgRuleNameFor('ws-12345678-abcd', '203.0.113.0/24', 'in');
    expect(n).not.toMatch(/[./]/);
    expect(n.length).toBeLessThanOrEqual(80);
    expect(n).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9\-._]{0,78}[a-zA-Z0-9_]$/);
  });
  it('caps an over-long input and keeps a legal final char', () => {
    const n = nsgRuleNameFor('w'.repeat(50), '203.0.113.0/24', 's'.repeat(60));
    expect(n.length).toBeLessThanOrEqual(80);
    expect(n).toMatch(/[a-zA-Z0-9_]$/);
  });
  it('is deterministic for the same inputs', () => {
    expect(nsgRuleNameFor('ws1', '10.0.0.0/8', 'in')).toBe(nsgRuleNameFor('ws1', '10.0.0.0/8', 'in'));
  });
});

describe('nextPriority', () => {
  it('starts at the base when there are no rules', () => {
    expect(nextPriority([])).toBe(200);
  });
  it('advances past the current max by the step', () => {
    expect(nextPriority([200, 210])).toBe(220);
    expect(nextPriority([200])).toBe(210);
  });
  it('skips a taken slot', () => {
    // max is 215; next would be 225 (max+step rounded), already not taken
    expect(nextPriority([200, 215])).toBe(225);
  });
  it('honors a custom base + step', () => {
    expect(nextPriority([100, 110], 100, 10)).toBe(120);
  });
});

describe('readNetworkingConfig (honest gate)', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('throws NetworkingNotConfiguredError naming the missing subscription', () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    delete process.env.LOOM_NETWORKING_RG;
    delete process.env.LOOM_ADMIN_RG;
    let err: unknown;
    try { readNetworkingConfig(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NetworkingNotConfiguredError);
    expect((err as NetworkingNotConfiguredError).missing).toContain('LOOM_SUBSCRIPTION_ID');
  });

  it('falls back to LOOM_ADMIN_RG and defaults the NSG name', () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-123';
    delete process.env.LOOM_NETWORKING_RG;
    process.env.LOOM_ADMIN_RG = 'rg-admin';
    delete process.env.LOOM_NSG_NAME;
    const cfg = readNetworkingConfig();
    expect(cfg.subscriptionId).toBe('sub-123');
    expect(cfg.networkingRg).toBe('rg-admin');
    expect(cfg.nsgName).toBe('nsg-snet-private-endpoints');
  });
});
