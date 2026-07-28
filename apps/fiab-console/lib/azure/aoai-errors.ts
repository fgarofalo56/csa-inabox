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

/**
 * The SECOND half of the same distinction, and the one that is easy to lose:
 * the walk returned rows, but it was cut short, and the AOAI connection was not
 * among the rows it did return. "Absent from a COMPLETE list" is a real answer;
 * "absent from a TRUNCATED list" is not an answer at all — it is a deadline
 * wearing the costume of one.
 *
 * Raised only AFTER the search misses, never before it: a truncated walk that
 * already contains the AOAI connection is a perfectly good outcome and must
 * resolve normally (#2557 re-review — requiring completeness up-front made the
 * fix defeat itself, failing turns whose answer was already in hand).
 */
export function aoaiDiscoveryIncomplete(truncatedBy: 'pages' | 'time'): AoaiDiscoveryTimeoutError {
  const knob =
    truncatedBy === 'pages' ? 'LOOM_ARM_PAGING_MAX_PAGES' : 'LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS';
  return new AoaiDiscoveryTimeoutError(
    `Could not resolve the Copilot model: the Foundry hub's connection list was cut short by its ` +
      `${truncatedBy} ceiling, and no Azure OpenAI connection appeared in the part that was read. ` +
      `Because the list is INCOMPLETE this does NOT mean no model is deployed — do not deploy ` +
      `anything in response to it. Retry; if it persists, check ARM / private-endpoint reachability ` +
      `from the Console, or raise ${knob}.`,
  );
}
