/**
 * C17 — sweep-auth: the machine-caller gate for the access-governance sweep
 * routes.
 *
 * REGRESSION THIS LOCKS DOWN. Before C17 the three sweep routes accepted a
 * machine caller ONLY when `process.env.LOOM_SWEEPER_TOKEN` was set, and no
 * deploy ever set it (measured 2026-08-08: `grep -rn LOOM_SWEEPER_TOKEN
 * platform/ scripts/ .github/` → exit 1, zero hits). Every scheduled call was
 * therefore rejected and expiry auto-revoke was admin-button-only, so access
 * that should have expired stayed live.
 *
 * The tests below assert the property that actually matters: with ONLY the
 * deploy-minted LOOM_INTERNAL_TOKEN present — i.e. the real default state of a
 * deployed estate — a scheduled caller is accepted. A test that merely asserted
 * "returns false when nothing is set" would have passed in the broken world too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isSweepSystemCaller } from '../sweep-auth';

const INTERNAL = 'aaaaaaaa-1111-2222-3333-444444444444';
const LEGACY = 'legacy-sweeper-secret-value';

function reqWith(headers: Record<string, string>): NextRequest {
  return new NextRequest(new URL('http://internal/api/access-governance/sweep'), {
    method: 'POST',
    headers,
  });
}

describe('isSweepSystemCaller', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.LOOM_INTERNAL_TOKEN;
    delete process.env.LOOM_SWEEPER_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('accepts the scheduled job on the deploy-minted internal token alone (the C17 fix)', () => {
    // The ONLY var a real deploy sets. This case returned FALSE before C17 —
    // which is precisely why the sweeper never ran.
    process.env.LOOM_INTERNAL_TOKEN = INTERNAL;
    expect(isSweepSystemCaller(reqWith({ 'x-loom-internal-token': INTERNAL }))).toBe(true);
  });

  it('accepts the same token presented as a Bearer authorization header', () => {
    process.env.LOOM_INTERNAL_TOKEN = INTERNAL;
    expect(isSweepSystemCaller(reqWith({ authorization: `Bearer ${INTERNAL}` }))).toBe(true);
  });

  it('rejects a WRONG internal token even though the var is set', () => {
    process.env.LOOM_INTERNAL_TOKEN = INTERNAL;
    expect(isSweepSystemCaller(reqWith({ 'x-loom-internal-token': 'not-the-token' }))).toBe(false);
  });

  it('fails closed when no server-side secret is configured at all', () => {
    expect(isSweepSystemCaller(reqWith({ 'x-loom-internal-token': INTERNAL }))).toBe(false);
    expect(isSweepSystemCaller(reqWith({ 'x-loom-system-token': LEGACY }))).toBe(false);
  });

  it('fails closed on a request carrying no credential headers', () => {
    process.env.LOOM_INTERNAL_TOKEN = INTERNAL;
    expect(isSweepSystemCaller(reqWith({}))).toBe(false);
  });

  it('still honours the legacy LOOM_SWEEPER_TOKEN when an operator explicitly set it', () => {
    process.env.LOOM_SWEEPER_TOKEN = LEGACY;
    expect(isSweepSystemCaller(reqWith({ 'x-loom-system-token': LEGACY }))).toBe(true);
  });

  it('does not let the legacy header pass on a mismatched value', () => {
    process.env.LOOM_SWEEPER_TOKEN = LEGACY;
    expect(isSweepSystemCaller(reqWith({ 'x-loom-system-token': 'wrong' }))).toBe(false);
  });

  it('does not accept the legacy header just because the internal token is set', () => {
    // The two secrets are distinct; presenting the legacy header with no legacy
    // secret configured must not fall back to the internal one.
    process.env.LOOM_INTERNAL_TOKEN = INTERNAL;
    expect(isSweepSystemCaller(reqWith({ 'x-loom-system-token': INTERNAL }))).toBe(false);
  });
});
