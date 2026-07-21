/**
 * a2a-egress-guard unit tests (WS-5.2) — the gov-safe OUTBOUND egress profile.
 *
 * IP-literal hosts so dns.lookup resolves locally. Covers: fail-closed when the
 * profile is unset (outbound A2A disabled — the sovereign default); the strict
 * allow-list (ONLY whitelisted hosts pass; public hosts are refused unless
 * listed); the allow-listed-host private-IP exemption; and https-only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assertA2aEgressAllowed, A2aEgressError, isA2aEgressEnabled } from '../a2a-egress-guard';

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; });

async function rejects(url: string): Promise<string> {
  try {
    await assertA2aEgressAllowed(url);
  } catch (e) {
    expect(e).toBeInstanceOf(A2aEgressError);
    return (e as Error).message;
  }
  throw new Error(`expected ${url} to be rejected`);
}

describe('assertA2aEgressAllowed', () => {
  it('FAILS CLOSED when LOOM_A2A_EGRESS_ALLOW is unset (sovereign default)', async () => {
    delete process.env.LOOM_A2A_EGRESS_ALLOW;
    expect(isA2aEgressEnabled()).toBe(false);
    expect(await rejects('https://8.8.8.8/a2a')).toMatch(/disabled|egress profile/i);
  });

  it('permits ONLY allow-listed hosts, refusing everything else', async () => {
    process.env.LOOM_A2A_EGRESS_ALLOW = '8.8.8.8';
    expect(isA2aEgressEnabled()).toBe(true);
    await expect(assertA2aEgressAllowed('https://8.8.8.8/a2a')).resolves.toBeUndefined();
    // A different public host is NOT reachable — strict allow-list.
    expect(await rejects('https://1.1.1.1/a2a')).toMatch(/allow-list/i);
  });

  it('exempts an allow-listed private host from the private-IP guard', async () => {
    process.env.LOOM_A2A_EGRESS_ALLOW = '10.0.0.9';
    await expect(assertA2aEgressAllowed('https://10.0.0.9/a2a')).resolves.toBeUndefined();
  });

  it('rejects non-https even when a profile is set', async () => {
    process.env.LOOM_A2A_EGRESS_ALLOW = 'example.com';
    expect(await rejects('http://example.com/a2a')).toMatch(/https/i);
  });

  it('rejects a non-listed private/IMDS host', async () => {
    process.env.LOOM_A2A_EGRESS_ALLOW = 'example.com';
    // 169.254.169.254 is neither listed nor a public host → refused by allow-list.
    expect(await rejects('https://169.254.169.254/metadata')).toMatch(/allow-list/i);
  });
});
