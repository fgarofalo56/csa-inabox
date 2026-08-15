/**
 * Certification DQ input — MEASURED on WRITE, READ from the record (#3493).
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
 * ── READ vs WRITE (the second half of #3493) ───────────────────────────────
 * Executing the rules is N sequential ADX round-trips, each on a 30 s budget.
 * The first cut of this module ran that from THREE routes, two of which are
 * plain GETs any authenticated user can hit — the marketplace product-detail
 * read and the (deliberately not ownership-gated) certification read. That
 * replaced one Cosmos point-read with unbounded fan-out into ADX, and
 * `computeDqScore` falls back to scoring EVERY enabled rule in the tenant when
 * the product resolves no table names — so 200 authored rules turned every
 * anonymous-ish product view into 200 serial KQL queries. So:
 *
 *   - {@link measureCertificationDq} EXECUTES the rules. It is called only from
 *     owner-gated WRITES (POST /certify: certify / revoke / measure-dq, and the
 *     Observability "rerun DQ check" action), which persist the result with
 *     {@link toDqMeasurement} onto `state.dqMeasurement`.
 *   - {@link readCertificationDq} is a PURE read of that record — zero I/O, zero
 *     ADX — and is what the GET paths use.
 *
 * Because the measurement is now DURABLE state, whose rules it runs matters far
 * more than when it was ephemeral: it takes the OWNER's tenant, resolved from
 * the item's workspace, and never the caller's oid. See `owner-tenant.ts`.
 *
 * The enforcement path never trusts the record: POST /certify re-measures live
 * before a sign-off, so a badge is never granted on a stale number. The record
 * carries `measuredAt` (and {@link isDqMeasurementStale}) so a read surface says
 * WHEN it was measured instead of implying "now".
 *
 * Population floor (an explicit decision, not an emergent one): a product with
 * no measurable rule NEVER certifies. Each distinct not-measured reason returns
 * `null` plus a named `dqGate` — ADX not provisioned, no applicable rules, rules
 * that could not execute, or never measured at all — rather than a fabricated
 * number. Per `deploy-integrity.md` R7 the gate text states what was actually
 * established: a backend failure is never reported as "no rules".
 *
 * Azure-native (ADX + Cosmos); no Fabric / Power BI dependency.
 */

import { adxConfigGate, computeDqScore, type DqRuleResult, type DqScoreResult } from '@/lib/azure/data-quality-client';
import { defaultDatabase } from '@/lib/azure/kusto-client';
import { resolveOwnerTenantId } from '@/lib/dataproducts/owner-tenant';
import {
  evaluateCertification, deriveCertificationState, gatherCertInputs,
  type CertifiableItem, type CertificationRecord, type CertificationState,
} from '@/lib/dataproducts/certification';

/** Why a DQ score could not be measured — the exact remediation (no-vaporware). */
export const DQ_GATE = {
  adx: 'Data quality cannot be measured: Azure Data Explorer is not provisioned for this deployment, so the data-quality rules cannot be executed. Certification requires a measured score.',
  noRules: 'No data-quality rules apply to this data product. Define rules scoped to its tables in Governance → Data quality (authoring rules is a tenant-admin action — ask your Loom admin if that page returns "forbidden") so certification can measure them.',
  unscoreable: 'The data-quality rules for this product ran but none produced a measurement (check the rule scopes and the bound table).',
  notMeasured: 'Data quality has not been measured for this data product yet. Run "Measure data quality" on the Certification tab (or Rerun DQ check on Data observability) to execute this tenant\'s rules against its tables.',
  ownerTenant: 'Data quality could not be measured: the owning workspace of this data product could not be resolved, so there is no way to tell WHICH tenant\'s data-quality rules apply. Nothing was measured and nothing was recorded.',
} as const;

/**
 * The central gate-registry id (`lib/gates/registry`) for the ADX reason, so the
 * UI renders the shared `HonestGate` with its inline Fix-it wizard instead of a
 * bare MessageBar (ux-baseline.md G2). The other reasons are CONTENT states — no
 * rules authored, rules that cannot run — which no env-var wizard can resolve,
 * so they carry no gate id and are surfaced with their own inline action.
 */
export const DQ_ADX_GATE_ID = 'svc-adx';

/** Item-state key holding the last measurement. Written only by owner-gated writes. */
export const DQ_MEASUREMENT_KEY = 'dqMeasurement';

/** A measurement older than this is still shown, but flagged as stale (never silently "now"). */
export const DQ_MEASUREMENT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rules executed CONCURRENTLY by a certification measurement. The scorer is
 * sequential by default; a product carrying 200 applicable rules would otherwise
 * serialise 200 × up-to-30 s of ADX onto one request and blow every timeout
 * between the browser and the cluster.
 */
export const DQ_MEASURE_CONCURRENCY = 4;

/** Per-rule rows kept in the persisted record (the counts below are always the true totals). */
export const DQ_MAX_PERSISTED_BREAKDOWN = 100;

export interface CertificationDq {
  /** 0–100 = applicable rules that PASSED their own threshold ÷ applicable rules. null = not measured. */
  dqScore: number | null;
  /** Non-null exactly when `dqScore` is null: the precise reason + remediation. */
  dqGate: string | null;
  /** Gate-registry id when the reason is an INFRA gate a Fix-it can resolve; else null. */
  dqGateId: string | null;
  /** The exact env var(s) behind `dqGateId` (drives HonestGate's `missing` list). */
  dqMissing: string[];
  /** The full measured breakdown (per-rule percentage + pass), when a run happened. */
  dqResult: DqScoreResult | null;
  /** ISO-8601 of the measurement this answer came from; null when never measured. */
  measuredAt: string | null;
  /** True when `measuredAt` is older than {@link DQ_MEASUREMENT_STALE_MS}. */
  stale: boolean;
}

/** The record persisted on `state.dqMeasurement` by the owner-gated write paths. */
export interface DqMeasurementRecord {
  /** The passing-rule RATIO certification consumes (0–100), or null when unmeasurable. */
  score: number | null;
  /** The measured MEAN per-rule percentage (what /observability reports), or null. */
  meanPercentage: number | null;
  gate: string | null;
  gateId: string | null;
  missing: string[];
  ruleCount: number;
  passingRules: number;
  /** Capped at {@link DQ_MAX_PERSISTED_BREAKDOWN} rows; the counts above are never capped. */
  breakdown: DqRuleResult[];
  breakdownTruncated?: boolean;
  measuredAt: string;
  /** oid of the identity whose write produced the measurement. */
  measuredBy?: string;
}

/** Datasets carry the ADX table names the tenant's rules are scoped against. */
interface Dataset {
  name?: string;
}

export interface DqTarget {
  /** The ADX database the rules run against. */
  database: string;
  /** The product's dataset table names; empty means "every enabled rule in the tenant". */
  tableNames: string[];
}

/**
 * Resolve the ADX target a data product's DQ rules run against, from item state.
 * ONE derivation shared by certification, `/observability` and `/health-actions`
 * — those two each had their own `(state.databaseName as string) || default`,
 * which passes a whitespace-only name straight into KQL instead of falling back.
 */
export function resolveDqTarget(item: DqItem | null | undefined): DqTarget {
  const state = (item?.state || {}) as Record<string, unknown>;
  const datasets = (Array.isArray(state.datasets) ? state.datasets : []) as Dataset[];
  const tableNames = datasets
    .map((d) => (typeof d?.name === 'string' ? d.name.trim() : ''))
    .filter((n): n is string => !!n);
  const database =
    (typeof state.databaseName === 'string' && state.databaseName.trim()) || defaultDatabase();
  return { database, tableNames };
}

/** Not-measured answer carrying an exact reason. */
function gated(gate: string, opts: { gateId?: string; missing?: string[]; result?: DqScoreResult | null } = {}): CertificationDq {
  return {
    dqScore: null,
    dqGate: gate,
    dqGateId: opts.gateId ?? null,
    dqMissing: opts.missing ?? [],
    dqResult: opts.result ?? null,
    measuredAt: opts.result?.computedAt ?? null,
    stale: false,
  };
}

/** The item shape every function here needs: its workspace (whose tenant owns the rules) + state. */
export interface DqItem {
  workspaceId?: string;
  state?: Record<string, unknown>;
}

/**
 * EXECUTE the owning tenant's applicable DQ rules against the product's bound
 * ADX tables and return the passing-rule ratio. **Write paths only** — this is N
 * live KQL round-trips; read paths use {@link readCertificationDq}.
 *
 * The tenant is NOT a parameter. Every call site used to pass
 * `session.claims.oid`, which is the CALLER — and `loadOwnedItem` gates on
 * workspace WRITE access, not ownership, so a shared-workspace collaborator
 * measured someone else's product against their OWN (usually empty) rule set.
 * It is resolved here from the item's workspace instead, and an unresolvable
 * owner GATES rather than falling back to the caller (see `owner-tenant.ts`).
 *
 * The ratio — not the mean per-rule percentage — is what certification consumes.
 * A mean can sit above the bar while every rule is under its OWN threshold
 * (three rules measured at 80% against a 95% threshold average to 80 and clear a
 * 70 bar with zero rules passing), which is the same "green over failing rules"
 * defect this replaces.
 */
export async function measureCertificationDq(item: DqItem | null | undefined): Promise<CertificationDq> {
  const { database, tableNames } = resolveDqTarget(item);

  // WHOSE rules? Never the caller's. Unknown owner = nothing measured, and
  // nothing recorded — a wrong-tenant reading is now durable state (#3499).
  const ownerTenantId = await resolveOwnerTenantId(item?.workspaceId);
  if (!ownerTenantId) return gated(DQ_GATE.ownerTenant);

  // ADX executes the rules. Unprovisioned = unmeasurable, and unmeasurable is
  // NEVER a pass — this path used to return a silent 100.
  const gate = adxConfigGate();
  if (gate) {
    return gated(`${DQ_GATE.adx} (missing ${gate.missing})`, {
      gateId: DQ_ADX_GATE_ID,
      missing: [gate.missing],
    });
  }

  let result: DqScoreResult;
  try {
    result = await computeDqScore(ownerTenantId, database, tableNames, { concurrency: DQ_MEASURE_CONCURRENCY });
  } catch (e: any) {
    // R7 — report what actually happened; never assert "no rules" for a backend failure.
    const msg = e?.message || String(e);
    return gated(`Data quality could not be measured — the rule run failed: ${msg}`);
  }

  // Population floor: no applicable rule → no score → certification refused.
  if (result.ruleCount === 0) {
    return gated(DQ_GATE.noRules, { result });
  }
  // Rules ran but NONE yielded a percentage (bad scope, missing table, KQL error).
  // Reporting 0 here would assert a measurement that never happened.
  if (result.score === null) {
    return gated(DQ_GATE.unscoreable, { result });
  }

  return {
    dqScore: Math.round((result.passingRules / result.ruleCount) * 100),
    dqGate: null,
    dqGateId: null,
    dqMissing: [],
    dqResult: result,
    measuredAt: result.computedAt,
    stale: false,
  };
}

/** True when a measurement is older than {@link DQ_MEASUREMENT_STALE_MS}. */
export function isDqMeasurementStale(measuredAt: string | null | undefined, now = Date.now()): boolean {
  if (!measuredAt) return false;
  const t = Date.parse(measuredAt);
  return Number.isFinite(t) && now - t > DQ_MEASUREMENT_STALE_MS;
}

/**
 * The state patch a measurement produces — the ONE shape both measuring writes
 * (POST /certify `measure-dq` and the Observability rerun) apply, so they cannot
 * reconcile differently.
 *
 * It carries two fields:
 *   - `dqMeasurement` — the reading itself, which every read surface renders.
 *   - `certificationState` — the DISCOVERY badge. It is written nowhere else but
 *     certify/revoke, and the marketplace search doc projects it as
 *     `certification`, so a product whose rules started failing kept a green
 *     "Certified" pill in Discover — and a green badge in its own editor header
 *     while its Certification tab said Validated — indefinitely.
 *
 * `state.certification` (the SIGN-OFF, with `certifiedBy`) is deliberately left
 * alone: `deriveCertificationState` needs it intact to restore `certified` once
 * the rules pass again, without a second reviewer signature.
 */
export function dqMeasurementPatch(
  item: DqItem & CertifiableItem,
  dq: CertificationDq,
  measuredBy?: string,
): { dqMeasurement: DqMeasurementRecord; certificationState: CertificationState } {
  const st = (item.state || {}) as Record<string, unknown>;
  const existing = (st.certification && typeof st.certification === 'object'
    ? st.certification as CertificationRecord
    : undefined);
  const evaluation = evaluateCertification(gatherCertInputs(item, dq.dqScore));
  return {
    dqMeasurement: toDqMeasurement(dq, measuredBy),
    certificationState: deriveCertificationState(evaluation, existing),
  };
}

/**
 * Project a live measurement into the record persisted on `state.dqMeasurement`.
 * A gated (unmeasurable) outcome is persisted too — with its reason — so the
 * read surfaces state WHY there is no score instead of an indistinguishable
 * "never measured".
 */
export function toDqMeasurement(dq: CertificationDq, measuredBy?: string): DqMeasurementRecord {
  const breakdown = dq.dqResult?.breakdown ?? [];
  return {
    score: dq.dqScore,
    meanPercentage: dq.dqResult?.score ?? null,
    gate: dq.dqGate,
    gateId: dq.dqGateId,
    missing: dq.dqMissing,
    ruleCount: dq.dqResult?.ruleCount ?? 0,
    passingRules: dq.dqResult?.passingRules ?? 0,
    breakdown: breakdown.slice(0, DQ_MAX_PERSISTED_BREAKDOWN),
    ...(breakdown.length > DQ_MAX_PERSISTED_BREAKDOWN ? { breakdownTruncated: true } : {}),
    measuredAt: dq.measuredAt || new Date().toISOString(),
    ...(measuredBy ? { measuredBy } : {}),
  };
}

/**
 * READ the last persisted measurement off item state. **Pure — no Cosmos, no
 * ADX, no rule execution.** This is what every GET uses; a product that has
 * never been measured honest-gates with the exact action that measures it,
 * rather than making a read path pay for N KQL queries (#3493).
 */
export function readCertificationDq(
  item: DqItem | null | undefined,
  now = Date.now(),
): CertificationDq {
  const state = (item?.state || {}) as Record<string, unknown>;
  const rec = state[DQ_MEASUREMENT_KEY] as DqMeasurementRecord | undefined;
  if (!rec || typeof rec !== 'object' || typeof rec.measuredAt !== 'string') {
    return gated(DQ_GATE.notMeasured);
  }

  const score = typeof rec.score === 'number' ? rec.score : null;
  const ruleCount = typeof rec.ruleCount === 'number' ? rec.ruleCount : 0;
  const passingRules = typeof rec.passingRules === 'number' ? rec.passingRules : 0;
  const dqResult: DqScoreResult = {
    score: typeof rec.meanPercentage === 'number' ? rec.meanPercentage : null,
    ruleCount,
    passingRules,
    breakdown: Array.isArray(rec.breakdown) ? rec.breakdown : [],
    computedAt: rec.measuredAt,
  };

  return {
    dqScore: score,
    // A persisted record without a score MUST carry its reason; a record written
    // by an older build that lacks one is reported as unmeasured, never as a pass.
    dqGate: score === null ? (typeof rec.gate === 'string' && rec.gate ? rec.gate : DQ_GATE.notMeasured) : null,
    dqGateId: score === null && typeof rec.gateId === 'string' ? rec.gateId : null,
    dqMissing: score === null && Array.isArray(rec.missing) ? rec.missing : [],
    dqResult,
    measuredAt: rec.measuredAt,
    stale: isDqMeasurementStale(rec.measuredAt, now),
  };
}
