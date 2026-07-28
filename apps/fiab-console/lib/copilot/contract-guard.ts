/**
 * contract-guard — B-N14c: the impure half of copilot contract validation.
 *
 * Loads the tenant's REAL N6 contracts from the `loom-data-contracts` registry
 * (`data-contract-store.listContractDocs`) and grades a copilot proposal against
 * them with the pure rules in `contract-validation.ts`.
 *
 * FLAG0: behind the DEFAULT-ON kill switch {@link CONTRACT_COPILOT_FLAG_ID}.
 * Flipping it OFF stops the pre-proposal check on the very next turn (seconds,
 * no roll) and leaves every copilot answering exactly as it did before — N6
 * INGESTION enforcement is a separate path and is completely unaffected.
 *
 * FAIL-OPEN, ALWAYS: this is a guard on an assistive suggestion, not an
 * authorization decision. An unreadable registry returns a `skipped` result
 * carrying the honest reason — a Cosmos hiccup must never break a copilot turn.
 * (An unreadable registry at INGESTION time is handled separately, by
 * `contractsForTarget`, which has the same discipline.)
 */

import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { listContractDocs } from '@/lib/azure/data-contract-store';
import {
  validateProposal,
  type ContractCheckResult,
  type CopilotProposal,
} from '@/lib/copilot/contract-validation';

/** FLAG0 runtime kill-switch id for the whole N14c path (default ON). */
export const CONTRACT_COPILOT_FLAG_ID = 'n14c-contract-validating-copilots';

/** A check result plus why it may not have run. `undefined` = the check ran. */
export interface ContractCheck extends ContractCheckResult {
  /** Set when the check did NOT grade the proposal (flag off / registry unread). */
  skipped?: 'flag-off' | 'registry-unavailable';
  /** Honest reason for the skip, rendered next to the proposal. */
  skipReason?: string;
  /** Real elapsed ms of the registry read + grading. */
  durationMs: number;
}

function skipped(
  proposal: CopilotProposal,
  why: NonNullable<ContractCheck['skipped']>,
  reason: string,
  startedAt: number,
): ContractCheck {
  return {
    ok: true,
    blocked: false,
    kind: proposal.kind,
    contractsChecked: [],
    ungovernedDatasets: [],
    violations: [],
    note: reason,
    skipped: why,
    skipReason: reason,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Grade a copilot proposal against the tenant's live data contracts.
 * Never throws.
 *
 * @param tenantId the contract-registry partition (the owner's Entra oid)
 */
export async function checkProposalContracts(
  tenantId: string,
  proposal: CopilotProposal,
): Promise<ContractCheck> {
  const started = Date.now();
  if (!(await runtimeFlag(CONTRACT_COPILOT_FLAG_ID))) {
    return skipped(
      proposal,
      'flag-off',
      'Contract validation of copilot proposals is switched off for this deployment (Admin → Runtime flags → n14c-contract-validating-copilots). Ingestion-time contract enforcement is unaffected.',
      started,
    );
  }
  let contracts: Awaited<ReturnType<typeof listContractDocs>>;
  try {
    contracts = await listContractDocs(tenantId);
  } catch (e: unknown) {
    return skipped(
      proposal,
      'registry-unavailable',
      `The data-contract registry could not be read (${e instanceof Error ? e.message : String(e)}), so this proposal was NOT checked against any contract.`,
      started,
    );
  }
  const result = validateProposal(proposal, contracts);
  return { ...result, durationMs: Date.now() - started };
}

/**
 * Fold a check into a one-line note a copilot can append to its own summary
 * text (for surfaces whose response is plain prose, e.g. the pipeline
 * generation summary). Returns '' when there is nothing worth saying.
 */
export function contractCheckSummary(check: ContractCheck | null | undefined): string {
  if (!check || check.skipped) return '';
  if (!check.contractsChecked.length) return '';
  const errors = check.violations.filter((v) => v.severity === 'error').length;
  const warnings = check.violations.filter((v) => v.severity === 'warning').length;
  if (check.blocked) return `⛔ Data contract: ${check.note}`;
  if (errors) return `⚠ Data contract: ${errors} error(s) against ${check.contractsChecked.length} governing contract(s).`;
  if (warnings) return `⚠ Data contract: ${warnings} governance warning(s) across ${check.contractsChecked.length} governing contract(s).`;
  return `✓ Data contract: conforms to ${check.contractsChecked.length} governing contract(s).`;
}
