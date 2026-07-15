/**
 * lib/dataproducts/contract-gate.ts — BR-CONTRACT-GATE (W10).
 *
 * The publish-time enforcement of a bound data contract: when a data product
 * (or dataset) publish is attempted and the effective data contract carries
 * error-severity quality expectations, those expectations are EXECUTED against
 * the bound Azure Data Explorer table (real KQL via runContractQuality). If any
 * error-severity expectation is measurable and fails, the publish is BLOCKED
 * with a precise message naming the failed expectation.
 *
 * Design (no-vaporware.md): the gate only ever blocks on a REAL, measured
 * failure. It NEVER blocks on missing infra — no bound table, ADX not
 * configured, no error-severity expectations, or a validator error all resolve
 * to "not evaluated, not blocked" so an honest infra gap can't masquerade as a
 * contract violation. Azure-native, no Microsoft Fabric dependency
 * (no-fabric-dependency.md).
 *
 * This module is server-side but dependency-light (data-quality-client +
 * kusto-client only — both lib) so it stays unit-testable by mocking the
 * validator; the ROUTES resolve the effective contract (inline `state.contract`
 * or a bound `data-contract` item) and pass it in.
 */
import { adxConfigGate, runContractQuality } from '@/lib/azure/data-quality-client';
import { defaultDatabase } from '@/lib/azure/kusto-client';
import type { DataContract, QualityExpectation } from './contract';

export interface ContractGateFailedExpectation {
  rule: string;
  /** '' for a table-level expectation. */
  column: string;
  detail: string;
}

export interface ContractGateBlock {
  reason: 'contract_validation_failed';
  message: string;
  field: string;
  failed: ContractGateFailedExpectation[];
  score: number | null;
}

export interface ContractGateOutcome {
  /** True only on a real, measured error-severity failure. */
  blocked: boolean;
  /** True when the validator actually ran (real KQL executed). */
  evaluated: boolean;
  /** Why the gate did not evaluate (never a block). */
  skippedReason?:
    | 'no_error_expectations'
    | 'no_bound_table'
    | 'adx_not_configured'
    | 'validator_error';
  block?: ContractGateBlock;
}

/** The error-severity expectations — the only ones that BLOCK a publish. */
export function blockingExpectations(contract: DataContract | undefined | null): QualityExpectation[] {
  const q = Array.isArray(contract?.quality) ? (contract!.quality as QualityExpectation[]) : [];
  return q.filter((e) => e.severity === 'error');
}

/** True when the contract has ≥1 error-severity expectation (the gate can bite). */
export function contractHasBlockingExpectations(contract: DataContract | undefined | null): boolean {
  return blockingExpectations(contract).length > 0;
}

/** Resolve the bound ADX database + table to validate against (pure). */
export function resolveContractTable(state: Record<string, unknown> | undefined | null): { database: string; tableName: string } {
  const datasets = Array.isArray(state?.datasets) ? (state!.datasets as Array<{ name?: string }>) : [];
  const tableName = String((state?.databaseTable as string) || datasets[0]?.name || '').trim();
  const database = String((state?.databaseName as string) || '') || defaultDatabase();
  return { database, tableName };
}

/**
 * Evaluate the contract gate. Returns `{ blocked: true, block }` ONLY when a
 * real error-severity expectation was measured and failed; every infra gap
 * resolves to `{ blocked: false, evaluated: false, skippedReason }`.
 */
export async function evaluateContractGate(opts: {
  contract: DataContract | undefined | null;
  database?: string;
  tableName?: string;
}): Promise<ContractGateOutcome> {
  const blocking = blockingExpectations(opts.contract);
  if (blocking.length === 0) return { blocked: false, evaluated: false, skippedReason: 'no_error_expectations' };

  const tableName = (opts.tableName || '').trim();
  if (!tableName) return { blocked: false, evaluated: false, skippedReason: 'no_bound_table' };

  if (adxConfigGate()) return { blocked: false, evaluated: false, skippedReason: 'adx_not_configured' };

  const database = opts.database || defaultDatabase();
  let run;
  try {
    // Run the FULL declared quality set (warnings included) so the score is
    // meaningful; only error-severity failures block below.
    run = await runContractQuality(database, tableName, opts.contract!.quality as QualityExpectation[]);
  } catch {
    return { blocked: false, evaluated: false, skippedReason: 'validator_error' };
  }

  // `run.failed` counts error-severity, ran, unmet expectations — the block signal.
  if (run.failed === 0) return { blocked: false, evaluated: true };

  const failed: ContractGateFailedExpectation[] = run.results
    .filter((r) => r.severity === 'error' && r.percentage != null && !r.pass)
    .map((r) => ({ rule: r.rule, column: r.column, detail: r.detail }));

  const first = failed[0];
  const target = first?.column ? `column "${first.column}"` : 'the table';
  const message =
    `Cannot publish: the bound data contract's validation failed. ` +
    `${failed.length} error-severity expectation${failed.length === 1 ? '' : 's'} did not pass` +
    (first ? ` — e.g. ${first.rule} on ${target}: ${first.detail}` : '') +
    `. Fix the data or relax the contract, then publish.`;

  return {
    blocked: true,
    evaluated: true,
    block: { reason: 'contract_validation_failed', message, field: 'contract', failed, score: run.score },
  };
}
