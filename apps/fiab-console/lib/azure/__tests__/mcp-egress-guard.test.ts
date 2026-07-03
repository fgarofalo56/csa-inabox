/**
 * mcp-egress-guard unit tests (rel-T13 / SSRF blocker B17).
 *
 * Every assertion uses an IP-LITERAL host so `dns.lookup` resolves locally (no
 * network): the guard classifies literal addresses directly. Covers the scheme
 * check, the private/loopback/link-local/IMDS rejections (IPv4 + IPv6), the
 * public-host allow, the restrictive LOOM_MCP_EGRESS_ALLOW mode, and the
 * built-in-host private-IP exemption.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assertMcpEgressAllowed, McpEgressError } from '../mcp-egress-guard';

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
});

async function rejects(url: string): Promise<string> {
  try {
    await assertMcpEgressAllowed(url);
  } catch (e) {
    expect(e).toBeInstanceOf(McpEgressError);
    return (e as Error).message;
  }
  throw new Error(`expected ${url} to be rejected`);
}

describe('assertMcpEgressAllowed', () => {
  it('rejects non-https schemes', async () => {
    await rejects('http://8.8.8.8/mcp');
    await rejects('file:///etc/passwd');
  });

  it('rejects the cloud instance-metadata endpoint (IMDS)', async () => {
    expect(await rejects('https://169.254.169.254/metadata')).toMatch(/private|link-local/i);
  });

  it('rejects RFC-1918, loopback, and CGNAT IPv4', async () => {
    await rejects('https://10.1.2.3/mcp');
    await rejects('https://172.16.0.1/mcp');
    await rejects('https://192.168.1.10/mcp');
    await rejects('https://127.0.0.1/mcp');
    await rejects('https://100.64.0.1/mcp');
    await rejects('https://0.0.0.0/mcp');
  });

  it('rejects IPv6 loopback / unique-local / link-local', async () => {
    await rejects('https://[::1]/mcp');
    await rejects('https://[fc00::1]/mcp');
    await rejects('https://[fe80::1]/mcp');
  });

  it('allows a public IPv4 host', async () => {
    await expect(assertMcpEgressAllowed('https://8.8.8.8/mcp')).resolves.toBeUndefined();
  });

  it('enforces LOOM_MCP_EGRESS_ALLOW as a restrictive allow-list', async () => {
    process.env.LOOM_MCP_EGRESS_ALLOW = '8.8.8.8';
    await expect(assertMcpEgressAllowed('https://8.8.8.8/mcp')).resolves.toBeUndefined();
    expect(await rejects('https://1.1.1.1/mcp')).toMatch(/allow-list/i);
  });

  it('exempts the configured built-in MCP host from the private-IP guard', async () => {
    process.env.LOOM_BUILTIN_MCP_URL = 'https://10.0.0.9/api/mcp';
    await expect(assertMcpEgressAllowed('https://10.0.0.9/api/mcp')).resolves.toBeUndefined();
    // A DIFFERENT private host is still rejected.
    await rejects('https://10.0.0.10/api/mcp');
  });

  it('exempts a LOOM_MCP_EGRESS_ALLOW-listed private host', async () => {
    process.env.LOOM_MCP_EGRESS_ALLOW = '10.0.0.9';
    await expect(assertMcpEgressAllowed('https://10.0.0.9/api/mcp')).resolves.toBeUndefined();
  });
});
