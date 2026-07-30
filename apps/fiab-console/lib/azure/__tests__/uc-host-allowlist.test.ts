/**
 * A request-supplied Unity Catalog host must be a SELECTION from this
 * deployment's own workspaces, never a free-form destination.
 *
 * Why: `POST /api/catalog/permissions` and `POST /api/catalog/register` read
 * `body.host` and passed it to `ucFetch(host, …)`, which attaches a credential.
 * So a caller chose where a credentialed request went — the same class as the
 * Key Vault exfiltration closed in #2683 and the role-grant escalation in
 * #2691. Removing the parameter (as was done for `ucHost` on the governance
 * route) is not possible here: a deployment can legitimately front several
 * workspaces and the UI passes the selected one.
 *
 * These are ATTACK tests. Each asserts the rogue destination is REFUSED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveWorkspaceHostnames = vi.fn();

vi.mock('@/lib/azure/unity-catalog-client', () => ({
  resolveWorkspaceHostnames: () => resolveWorkspaceHostnames(),
}));

const ALLOWED = 'adb-123.4.azuredatabricks.net';

/** The shapes that defeat a naive substring or startsWith check. */
const ATTACKS: Array<[string, string]> = [
  ['a foreign host', 'evil.test'],
  ['a suffix look-alike', `${ALLOWED}.evil.test`],
  ['a prefix look-alike', `evil-${ALLOWED}`],
  ['userinfo smuggling', `https://${ALLOWED}@evil.test/`],
  ['a scheme-relative rogue host', '//evil.test/api'],
  ['an internal metadata endpoint', 'http://169.254.169.254/metadata/identity'],
  ['a file URL', 'file:///etc/passwd'],
  ['empty', ''],
];

describe('assertAllowedUcHost', () => {
  beforeEach(() => {
    resolveWorkspaceHostnames.mockReset();
    resolveWorkspaceHostnames.mockResolvedValue([ALLOWED]);
  });

  it.each(ATTACKS)('ATTACK: refuses %s', async (_label, host) => {
    const { assertAllowedUcHost } = await import('../uc-host-allowlist');
    await expect(assertAllowedUcHost(host)).rejects.toThrow(/not one of this deployment/);
  });

  it('accepts a configured workspace, and returns the CONFIGURED spelling', async () => {
    const { assertAllowedUcHost } = await import('../uc-host-allowlist');
    // Caller shouts it and adds scheme/port/path; the value handed downstream is
    // still the configured spelling, so attacker-formatted text never propagates.
    await expect(assertAllowedUcHost(`HTTPS://${ALLOWED.toUpperCase()}:443/x?y=1`)).resolves.toBe(ALLOWED);
    await expect(assertAllowedUcHost(ALLOWED)).resolves.toBe(ALLOWED);
  });

  it('FAILS CLOSED when the allow-list cannot be resolved', async () => {
    // Falling through to the caller's value on error is precisely the original
    // bug, so an unavailable allow-list must refuse rather than permit.
    resolveWorkspaceHostnames.mockRejectedValue(new Error('ARM unavailable'));
    const { assertAllowedUcHost } = await import('../uc-host-allowlist');
    await expect(assertAllowedUcHost(ALLOWED)).rejects.toThrow(/not one of this deployment/);
  });

  it('refuses everything when the deployment resolved no workspaces', async () => {
    resolveWorkspaceHostnames.mockResolvedValue([]);
    const { assertAllowedUcHost } = await import('../uc-host-allowlist');
    await expect(assertAllowedUcHost(ALLOWED)).rejects.toThrow(/not one of this deployment/);
  });
});
