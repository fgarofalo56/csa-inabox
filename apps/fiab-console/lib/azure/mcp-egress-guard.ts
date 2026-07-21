/**
 * MCP egress SSRF guard (rel-T13 / blocker B17).
 *
 * The MCP admin surface fetches a CALLER-SUPPLIED URL server-side — both the
 * `test-connection` probe and the connectivity probe on save/update run from the
 * Console Container App's network position. Without a guard an authenticated
 * caller could point that fetch at the cloud instance-metadata endpoint
 * (169.254.169.254), a localhost admin port, or any RFC-1918 host reachable from
 * the app — a classic authenticated server-side request forgery.
 *
 * The SSRF policy (https-only, private-IP rejection, restrictive allow-list,
 * built-in-host exemption) lives in the shared {@link assertEgressAllowed} core
 * (egress-ssrf.ts) so the MCP probe and the WS-5.2 A2A outbound client enforce
 * byte-for-byte the same rules. This module binds that core to the MCP operator
 * env: the allow-list `LOOM_MCP_EGRESS_ALLOW` (comma-separated host suffixes) and
 * the built-in server host `LOOM_BUILTIN_MCP_URL` (exempt from the private-IP
 * check, since a deployed internal Container App has a private ingress IP).
 */

import {
  EgressError, assertEgressAllowed, parseAllowSuffixes, hostOfUrl,
} from './egress-ssrf';

/** Thrown when a caller-supplied MCP endpoint fails the egress guard. Callers
 *  return its `message` as a 400 so the admin sees the exact reason. */
export class McpEgressError extends EgressError {
  constructor(message: string) {
    super(message);
    this.name = 'McpEgressError';
  }
}

/**
 * Throw `McpEgressError` unless `rawUrl` is a safe MCP egress target. See
 * egress-ssrf.ts for the full policy. Async because it resolves DNS.
 */
export async function assertMcpEgressAllowed(rawUrl: string): Promise<void> {
  await assertEgressAllowed(rawUrl, {
    allowSuffixes: parseAllowSuffixes(process.env.LOOM_MCP_EGRESS_ALLOW),
    builtinHost: hostOfUrl(process.env.LOOM_BUILTIN_MCP_URL),
    allowListName: 'LOOM_MCP_EGRESS_ALLOW',
    makeError: (m) => new McpEgressError(m),
  });
}
