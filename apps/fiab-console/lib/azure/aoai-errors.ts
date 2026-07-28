/**
 * aoai-errors — the two AOAI target-resolution failure types, kept apart so the
 * DIFFERENCE between them is unmissable (#2557 review).
 *
 * `resolveAoaiTarget` used to collapse every failure into
 * {@link NoAoaiDeploymentError}: a paging deadline while listing the Foundry
 * hub's connections came out of Copilot as "Deploy a gpt-4o / gpt-4.1-class
 * model first" — for a model that already existed. Naming the wrong remediation
 * is precisely what `no-vaporware.md`'s honest-gate rule forbids, and it sends
 * an operator down completely the wrong path.
 *
 * Re-exported from copilot-orchestrator (and aoai-chat-client /
 * data-agent-client) so every existing `instanceof` import keeps working.
 */

/** No model is deployed / selected — a real, actionable configuration gate. */
export class NoAoaiDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAoaiDeploymentError';
  }
}

/**
 * Resolution TIMED OUT talking to ARM. Deliberately NOT a
 * {@link NoAoaiDeploymentError}: the backend was slow, nothing is missing, and
 * the operator must not deploy anything in response.
 */
export class AoaiDiscoveryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AoaiDiscoveryTimeoutError';
  }
}

/**
 * Build the timeout error from whatever the connections walk rejected with.
 * The wording is deliberately blunt about NOT deploying anything: the whole
 * defect was an operator being told to deploy a model that already existed.
 */
export function aoaiDiscoveryTimeout(cause: unknown): AoaiDiscoveryTimeoutError {
  const detail = (cause as any)?.message || String(cause);
  return new AoaiDiscoveryTimeoutError(
    `Timed out listing the Foundry hub's connections while resolving the Copilot model (${detail}). ` +
      `This is a TIMEOUT talking to Azure Resource Manager, NOT a missing deployment — do not deploy ` +
      `anything in response to it. Retry; if it persists, check ARM / private-endpoint reachability ` +
      `from the Console, or raise LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS.`,
  );
}
