/**
 * A2A outbound egress SSRF guard (WS-5.2) — the gov-safe egress profile.
 *
 * When a Loom agent delegates a task OUT to an external A2A agent (the outbound
 * half of WS-5.2), the Console fetches a caller-supplied agent-card URL + A2A
 * endpoint server-side. That is the same SSRF surface the MCP admin probe has,
 * so it enforces the shared {@link assertEgressAllowed} policy (egress-ssrf.ts) —
 * https-only, private-IP/IMDS rejection, resolve-then-validate.
 *
 * The gov-safe profile is the OPERATOR ALLOW-LIST `LOOM_A2A_EGRESS_ALLOW`
 * (comma-separated host suffixes). Its semantics are deliberately strict:
 *   - UNSET → outbound A2A is DENIED entirely (fail-closed). A sovereign / Gov /
 *     air-gapped deployment therefore reaches ZERO external agents by default —
 *     nothing leaves the boundary unless an operator explicitly whitelists a
 *     host (no-fabric-dependency.md sovereignty; WS-9 in-VNet posture).
 *   - SET   → ONLY the whitelisted host suffixes are reachable; every other host
 *     (incl. the whole public internet) is refused, and a whitelisted host is
 *     also exempted from the private-IP check (an operator opting into an
 *     in-VNet peer agent).
 *
 * This differs from the MCP guard (which allows public hosts when its allow-list
 * is empty): A2A egress is trust-boundary-crossing agent-to-agent delegation, so
 * the safe default is "reach nobody" until the operator declares a profile.
 */

import {
  EgressError, assertEgressAllowed, parseAllowSuffixes, hostOfUrl,
} from './egress-ssrf';

/** Thrown when an outbound A2A endpoint fails the gov-safe egress profile. */
export class A2aEgressError extends EgressError {
  constructor(message: string) {
    super(message);
    this.name = 'A2aEgressError';
  }
}

/** The A2A egress allow-list env var name (the gov-safe profile). */
export const A2A_EGRESS_ALLOW_ENV = 'LOOM_A2A_EGRESS_ALLOW';

/** The configured allow-list suffixes (empty when the profile is unset). */
export function a2aEgressAllowSuffixes(): string[] {
  return parseAllowSuffixes(process.env[A2A_EGRESS_ALLOW_ENV]);
}

/** True when at least one outbound A2A host is permitted (the profile is set). */
export function isA2aEgressEnabled(): boolean {
  return a2aEgressAllowSuffixes().length > 0;
}

/**
 * Throw `A2aEgressError` unless `rawUrl` is permitted by the gov-safe A2A egress
 * profile. FAIL-CLOSED when `LOOM_A2A_EGRESS_ALLOW` is unset (no external agent
 * is reachable). Otherwise delegates to the shared SSRF core with the A2A
 * allow-list. Async because it resolves DNS.
 */
export async function assertA2aEgressAllowed(rawUrl: string): Promise<void> {
  const allow = a2aEgressAllowSuffixes();
  if (allow.length === 0) {
    throw new A2aEgressError(
      'Outbound A2A delegation is disabled — no gov-safe egress profile is configured. ' +
        `Set ${A2A_EGRESS_ALLOW_ENV} to a comma-separated list of allowed external A2A host ` +
        'suffixes (e.g. "partner-agents.example.com") to permit delegation to those hosts. ' +
        'Left unset, Loom reaches no external agents (the sovereign / air-gapped default).',
    );
  }
  await assertEgressAllowed(rawUrl, {
    allowSuffixes: allow,
    // An A2A peer may be an internal in-VNet Container App (private ingress IP);
    // the built-in MCP host is also exempt so a co-deployed agent is reachable.
    builtinHost: hostOfUrl(process.env.LOOM_BUILTIN_MCP_URL),
    allowListName: A2A_EGRESS_ALLOW_ENV,
    makeError: (m) => new A2aEgressError(m),
  });
}
