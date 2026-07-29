/**
 * `trustedClientIp` / `claimedClientIp` — the key every anonymous control in
 * Loom hangs off.
 *
 * The shape this replaces (`x-forwarded-for.split(',')[0]`) read the CLIENT-most
 * hop, i.e. a header value the caller types. Every anonymous rate limit
 * (sign-in, the auth callback, anonymous feedback, public access requests) and
 * the Delta Sharing anonymous-deny burst guard were keyed on it, so all of them
 * were bypassable by rotating one header, and every `sourceIp` they recorded was
 * attacker-chosen.
 */
import { describe, it, expect } from 'vitest';
import { trustedClientIp, claimedClientIp } from '../client-ip';

const h = (o: Record<string, string>) => new Headers(o);

describe('trustedClientIp', () => {
  it('takes the RIGHTMOST x-forwarded-for hop — the one our own ingress appended', () => {
    // The caller wrote 9.9.9.9; our ingress appended the real peer 10.0.0.1.
    expect(trustedClientIp(h({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('a caller cannot choose its own key by rotating x-forwarded-for', () => {
    const keys = new Set(
      Array.from({ length: 50 }, (_, i) => trustedClientIp(h({ 'x-forwarded-for': `203.0.113.${i}, 10.0.0.7` }))),
    );
    // 50 distinct claims, ONE bucket.
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('10.0.0.7');
  });

  it('prefers x-azure-socketip, the one Front Door derives from the TCP connection', () => {
    // learn.microsoft.com/azure/frontdoor/front-door-http-headers-protocol says
    // x-azure-clientip "can be arbitrarily overwritten by a user" (it is
    // XFF-derived); x-azure-socketip is the socket the request arrived on.
    expect(trustedClientIp(h({
      'x-azure-socketip': '198.51.100.5',
      'x-azure-clientip': '203.0.113.9',
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
    }))).toBe('198.51.100.5');
  });

  it('survives a client that PRE-SETS x-azure-socketip (repeated headers join, ours is last)', () => {
    expect(trustedClientIp(h({ 'x-azure-socketip': '203.0.113.9, 198.51.100.5' }))).toBe('198.51.100.5');
  });

  it('never trusts x-azure-clientip on its own', () => {
    expect(trustedClientIp(h({ 'x-azure-clientip': '203.0.113.9' }))).toBe('unknown-ip');
  });

  it('falls back to x-real-ip, then a single shared bucket', () => {
    expect(trustedClientIp(h({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
    expect(trustedClientIp(h({}))).toBe('unknown-ip');
  });

  it('bounds the value so a giant header cannot blow up a key', () => {
    expect(trustedClientIp(h({ 'x-forwarded-for': 'a'.repeat(5000) })).length).toBe(64);
  });
});

describe('claimedClientIp', () => {
  it('returns what the caller claimed, so it can be RECORDED without being trusted', () => {
    expect(claimedClientIp(h({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(claimedClientIp(h({ 'x-azure-clientip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('is empty when the caller claimed nothing', () => {
    expect(claimedClientIp(h({}))).toBe('');
  });
});
