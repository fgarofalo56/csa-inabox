/**
 * Constrain a REQUEST-SUPPLIED Unity Catalog host to the workspaces this
 * deployment actually knows about.
 *
 * Why this exists: several routes accepted `body.host` and passed it to
 * `ucFetch(host, …)`, which attaches a managed-identity / pre-shared bearer.
 * A caller therefore chose the destination of a CREDENTIALED request — the same
 * class as the Key Vault exfiltration closed in #2683 (destination taken from
 * item state) and the role-grant escalation in #2691 (role taken from the
 * request body). The credential goes wherever the caller points it.
 *
 * `body.host` cannot simply be dropped the way `ucHost` was on the governance
 * route: a deployment can legitimately front more than one workspace, and the
 * UI passes the host of the one the user selected. So the value stays a
 * SELECTION rather than becoming a free-form destination — it must match a
 * hostname this deployment resolved for itself.
 *
 * Comparison is on the HOSTNAME only, case-folded, with any scheme/port/path
 * stripped, so `https://ws.example.net/x?y` and `WS.EXAMPLE.NET` both reduce to
 * the same key. That closes the look-alike tricks a substring check would let
 * through (`ws.example.net.evil.test`, userinfo smuggling like
 * `https://ws.example.net@evil.test`).
 */
import { resolveWorkspaceHostnames } from '@/lib/azure/unity-catalog-client';

/** Reduce any host-ish string to a bare lower-case hostname, or '' if unusable. */
export function bareHostname(value: string | undefined | null): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  // Parse as a URL so userinfo (`user@host`) and ports resolve the way the HTTP
  // stack will resolve them, not the way a regex would.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export class UcHostNotAllowedError extends Error {
  readonly code = 'uc_host_not_allowed';
  constructor(requested: string) {
    super(
      `Unity Catalog host ${JSON.stringify(requested)} is not one of this deployment's `
        + `known workspaces. The host must be selected from the workspaces Loom resolved, `
        + `not supplied freely — a credentialed request is issued to it.`,
    );
  }
}

/**
 * Resolve a request-supplied host to an allowed one.
 *
 * Fails CLOSED: if the allow-list cannot be resolved we refuse rather than fall
 * through to the caller's value, because falling through is exactly the bug.
 */
export async function assertAllowedUcHost(requested: string | undefined | null): Promise<string> {
  const wanted = bareHostname(requested);
  if (!wanted) throw new UcHostNotAllowedError(String(requested ?? ''));

  let allowed: string[] = [];
  try {
    allowed = await resolveWorkspaceHostnames();
  } catch {
    throw new UcHostNotAllowedError(String(requested ?? ''));
  }

  const match = allowed.find((h) => bareHostname(h) === wanted);
  if (!match) throw new UcHostNotAllowedError(String(requested ?? ''));
  // Return the CONFIGURED spelling, not the caller's — so nothing downstream
  // ever sees attacker-formatted text even when it names a legitimate host.
  return match;
}
