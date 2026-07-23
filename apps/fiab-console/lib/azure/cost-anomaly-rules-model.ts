/**
 * loom-cost-anomaly-rules — doc shape + MIG1 versioned-migration registration (C3).
 *
 * The scheduled cost-anomaly monitor (an IN-VNET ACA Job → /api/internal/
 * cost-anomaly/run) READS these rules to know which scopes to watch + the
 * per-scope thresholds; the C4 FinOps hub's anomaly-rules editor WRITES them
 * (audited, `kind:'finops.anomaly-rule'`). Both reach the container through
 * `costAnomalyRulesContainer()` (cosmos-client), which wraps it in
 * `withMigrations('loom-cost-anomaly-rules', …)` so every materialized doc
 * passes `migrateOnRead` — the MIG1 convention (lib/azure/cosmos-migrations.ts).
 *
 * PK `/scope` — a subscription id, a resource-group / tag scope, or `'all'` for
 * the whole Loom estate (the default estate-wide series). One rule per scope is
 * the common case; the id may differ from the scope so a scope can carry more
 * than one rule.
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 * A future breaking change bumps COST_ANOMALY_RULES_SCHEMA_VERSION to N+1 and
 * registers its `fromVersion: N` migrator in {@link registerCostAnomalyRulesMigrators}
 * (called at module scope — the chain is live before any read materializes).
 * Per MIG1 there is deliberately NO v1 migrator today.
 */
import { registerMigrator, type DocMigrator } from './cosmos-migrations';
import type { AnomalyMethod } from './cost-anomaly-core';

export const COST_ANOMALY_RULES_CONTAINER = 'loom-cost-anomaly-rules';
export const COST_ANOMALY_RULES_SCHEMA_VERSION = 1;

/** Alert severity dispatched through the shared action group (alert-dispatch O1). */
export type AnomalyAlertSeverity = 'P1' | 'P2' | 'P3';

/** One watch rule for a cost scope. */
export interface CostAnomalyRuleDoc {
  id: string;
  /** PK — the cost scope watched ('all' = the whole Loom estate). */
  scope: string;
  docType: 'cost-anomaly-rule';
  schemaVersion: number;
  /** Opt-out per rule (the monitor skips disabled rules). Default true. */
  enabled: boolean;
  /** Detection method + thresholds (fed verbatim to detectAnomalies). */
  method: AnomalyMethod;
  threshold: number;
  minAbsDelta: number;
  /** Cost window the daily series is pulled over. Default 'Last30Days'. */
  timeframe: 'Last7Days' | 'Last30Days';
  /** Alert severity dispatched when the rule fires (default 'P3' — email band). */
  alertSeverity: AnomalyAlertSeverity;
  /** Entra oids notified in-product (loom-notifications). Empty → the bootstrap
   * tenant admin (LOOM_TENANT_ADMIN_OID) is used as the fallback recipient. */
  recipients: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  /** Last time the monitor evaluated this rule (ISO). */
  lastRunAt?: string;
  /** Last time the rule actually fired an anomaly (ISO). */
  lastFiredAt?: string;
}

/** The seed rule a fresh deploy gets so the monitor is functional day-one:
 * the whole-estate 3σ watch, default-ON. Written by the runner when the
 * container is empty (so no operator input is required). */
export function defaultEstateRule(now = new Date().toISOString()): CostAnomalyRuleDoc {
  return {
    id: 'estate-default',
    scope: 'all',
    docType: 'cost-anomaly-rule',
    schemaVersion: COST_ANOMALY_RULES_SCHEMA_VERSION,
    enabled: true,
    method: '3sigma',
    threshold: 2,
    minAbsDelta: 0,
    timeframe: 'Last30Days',
    alertSeverity: 'P3',
    recipients: [],
    createdAt: now,
    updatedAt: now,
    updatedBy: 'system:seed',
  };
}

/**
 * MIG1 registration point for this container's migrator chain. v1 is current —
 * the chain is empty. The FIRST breaking change adds a `registerMigrator(
 * COST_ANOMALY_RULES_CONTAINER, 1, v1toV2)` here (+ an optional backfill script).
 */
export function registerCostAnomalyRulesMigrators(): void {
  // v1 → (none yet). The registerMigrator reference keeps the wiring live for
  // the first real migration without claiming the one-owner-per-step v1 slot.
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerCostAnomalyRulesMigrators();
