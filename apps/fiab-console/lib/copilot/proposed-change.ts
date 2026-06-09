/**
 * proposed-change — the approval-gated change contract, factored out of
 * copilot-orchestrator so the sentinel/parse logic can be unit-tested without
 * pulling the orchestrator's heavy Azure SDK dependency graph.
 *
 * A Copilot tool that wants to propose a code/query/transform edit returns a
 * normal result object with a `__proposedChange__` sentinel attached. The
 * orchestrator strips the sentinel BEFORE feeding the result back to the model
 * (the model must never be told the edit is applied — it isn't, until the user
 * clicks Keep) and emits a `proposed_change` step the pane renders as a Monaco
 * DiffEditor.
 */

/** Sentinel key a tool attaches to its result to request an approval-gated diff. */
export const PROPOSED_CHANGE_KEY = '__proposedChange__' as const;

/** Normalized payload the pane needs to render the before/after diff. */
export interface ProposedChangePayload {
  target: string;
  before: string;
  after: string;
  lang?: string;
  summary?: string;
}

/**
 * Peel an approval-gated change off a tool result. Returns the sanitized
 * `publicResult` (sentinel removed — never fed to the model) and the parsed
 * `proposed` payload when present + valid. Pure; safe to unit-test in isolation.
 */
export function extractProposedChange(result: unknown): {
  publicResult: unknown;
  proposed: ProposedChangePayload | null;
} {
  if (!result || typeof result !== 'object' || !(PROPOSED_CHANGE_KEY in (result as any))) {
    return { publicResult: result, proposed: null };
  }
  const raw = (result as any)[PROPOSED_CHANGE_KEY];
  let proposed: ProposedChangePayload | null = null;
  if (raw && typeof raw === 'object' && typeof raw.target === 'string') {
    proposed = {
      target: String(raw.target),
      before: String(raw.before ?? ''),
      after: String(raw.after ?? ''),
      lang: raw.lang ? String(raw.lang) : undefined,
      summary: raw.summary ? String(raw.summary) : undefined,
    };
  }
  const clone: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  delete clone[PROPOSED_CHANGE_KEY];
  return { publicResult: clone, proposed };
}
