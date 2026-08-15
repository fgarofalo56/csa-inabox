/**
 * Certification DQ input — MEASURED, never assumed (#3493).
 *
 * The three data-product certification routes each carried a private
 * `computeDqScore` that scored `enabled ÷ total` over the tenant's DQ-rule
 * document. It read the rules out of Cosmos and never executed one, so a product
 * whose every rule was FAILING still scored 100, cleared `CERT_THRESHOLDS
 * .dqScoreMin`, and certified. The gate could not fail.
 *
 * This module is the single adoption point for the real scorer
 * (`lib/azure/data-quality-client.computeDqScore`), which runs each applicable
 * enabled rule as a live ADX/KQL aggregate and reports which rules actually
 * PASSED their own threshold. Certification consumes the passing-rule RATIO:
 *   - every rule failing → 0    → below the bar → certification refused
 *   - nothing measurable → null → the `dq` check honest-gates → refused
 *
 * Population floor (an explicit decision, not an emergent one): a product with
 * no measurable rule NEVER certifies. Each distinct not-measured reason returns
 * `null` plus a named `dqGate` — ADX not provisioned, no applicable rules, or
 * rules that could not execute — rather than a fabricated number. Per
 * `deploy-integrity.md` R7 the gate text states what was actually established:
 * a backend failure is never reported as "no rules".
 *
 * Azure-native (ADX + Cosmos); no Fabric / Power BI dependency.
 */

import { adxConfigGate, computeDqScore, type DqScoreResult } from '@/lib/azure/data-quality-client';
import { defaultDatabase } from '@/lib/azure/kusto-client';

/** Why a DQ score could not be measured — the exact remediation (no-vaporware). */
export const DQ_GATE = {
  adx: 'Data quality cannot be measured: Azure Data Explorer is not provisioned for this deployment, so the data-quality rules cannot be executed. Certification requires a measured score.',
  noRules: 'No data-quality rules apply to this data product. Define rules scoped to its tables in Governance → Data quality so certification can measure them.',
  unscoreable: 'The data-quality rules for this product ran but none produced a measurement (check the rule scopes and the bound table).',
} as const;

export interface CertificationDq {
  /** 0–100 = applicable rules that PASSED their own threshold ÷ applicable rules. null = not measured. */
  dqScore: number | null;
  /** Non-null exactly when `dqScore` is null: the precise reason + remediation. */
  dqGate: string | null;
  /** The full measured breakdown (per-rule percentage + pass), when a run happened. */
  dqResult: DqScoreResult | null;
}

/** Datasets carry the ADX table names the tenant's rules are scoped against. */
interface Dataset {
  name?: string;
}

/**
 * Measure the DQ score that feeds `evaluateCertification`. Resolves the
 * product's bound ADX database + dataset tables from item state (the same
 * derivation `/observability` and `/health-actions` use), executes every
 * applicable enabled rule for real, and returns the passing-rule ratio.
 *
 * The ratio — not the mean per-rule percentage — is what certification consumes.
 * A mean can sit above the bar while every rule is under its OWN threshold
 * (three rules measured at 80% against a 95% threshold average to 80 and clear a
 * 70 bar with zero rules passing), which is the same "green over failing rules"
 * defect this replaces.
 */
export async function measureCertificationDq(
  tenantId: string,
  item: { state?: Record<string, unknown> } | null | undefined,
): Promise<CertificationDq> {
  const state = (item?.state || {}) as Record<string, unknown>;
  const datasets = (Array.isArray(state.datasets) ? state.datasets : []) as Dataset[];
  const tableNames = datasets.map((d) => d?.name).filter((n): n is string => !!n);
  const database =
    (typeof state.databaseName === 'string' && state.databaseName.trim()) || defaultDatabase();

  // ADX executes the rules. Unprovisioned = unmeasurable, and unmeasurable is
  // NEVER a pass — this path used to return a silent 100.
  const gate = adxConfigGate();
  if (gate) {
    return { dqScore: null, dqGate: `${DQ_GATE.adx} (missing ${gate.missing})`, dqResult: null };
  }

  let result: DqScoreResult;
  try {
    result = await computeDqScore(tenantId, database, tableNames);
  } catch (e: any) {
    // R7 — report what actually happened; never assert "no rules" for a backend failure.
    const msg = e?.message || String(e);
    return {
      dqScore: null,
      dqGate: `Data quality could not be measured — the rule run failed: ${msg}`,
      dqResult: null,
    };
  }

  // Population floor: no applicable rule → no score → certification refused.
  if (result.ruleCount === 0) {
    return { dqScore: null, dqGate: DQ_GATE.noRules, dqResult: result };
  }
  // Rules ran but NONE yielded a percentage (bad scope, missing table, KQL error).
  // Reporting 0 here would assert a measurement that never happened.
  if (result.score === null) {
    return { dqScore: null, dqGate: DQ_GATE.unscoreable, dqResult: result };
  }

  return {
    dqScore: Math.round((result.passingRules / result.ruleCount) * 100),
    dqGate: null,
    dqResult: result,
  };
}
