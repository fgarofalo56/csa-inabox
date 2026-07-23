/**
 * /api/admin/finops/anomalies — C4 FinOps hub anomaly feed + rules editor.
 *
 *   GET → { ok, rules: CostAnomalyRuleDoc[], feed: AnomalyFeedRow[] }
 *         real anomaly feed computed from the REAL Cost Management daily series
 *         (getLoomCostSummaryCached) via the SHARED detector (cost-anomaly-core)
 *         per enabled rule — byte-identical to what the C3 monitor fires on.
 *   PUT → upsert one rule (threshold/method/recipients/enabled) — AUDITED
 *         (kind:'finops.anomaly-rule'); writes loom-cost-anomaly-rules (C3).
 *
 * Tenant-admin gated (org-wide $ + alert config). Real backend only
 * (no-vaporware): Cosmos rules + Cost Management. Azure-native (no Fabric).
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import { costAnomalyRulesContainer } from '@/lib/azure/cosmos-client';
import { getLoomCostSummaryCached, MonitorNotConfiguredError, type CostTimeframe } from '@/lib/azure/cost-client';
import { detectAnomalies, normalizeRule } from '@/lib/azure/cost-anomaly-core';
import { anomalyFeed } from '@/lib/admin/finops-view';
import { auditFinopsMutation } from '@/lib/admin/finops-audit';
import {
  defaultEstateRule,
  COST_ANOMALY_RULES_SCHEMA_VERSION,
  type CostAnomalyRuleDoc,
  type AnomalyAlertSeverity,
} from '@/lib/azure/cost-anomaly-rules-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

async function loadRules(): Promise<CostAnomalyRuleDoc[]> {
  const c = await costAnomalyRulesContainer();
  const { resources } = await c.items
    .query<CostAnomalyRuleDoc>({ query: 'SELECT * FROM c WHERE c.docType = @t', parameters: [{ name: '@t', value: 'cost-anomaly-rule' }] })
    .fetchAll();
  return resources;
}

export const GET = withTenantAdmin(async () => {
  try {
    let rules = await loadRules();
    if (!rules.length) rules = [defaultEstateRule()];
    // Compute the live feed from the REAL daily series per enabled rule.
    const byScope: Record<string, ReturnType<typeof detectAnomalies>> = {};
    try {
      for (const rule of rules.filter((r) => r.enabled !== false)) {
        const timeframe: CostTimeframe = rule.timeframe === 'Last7Days' ? 'Last7Days' : 'Last30Days';
        const summary = (await getLoomCostSummaryCached({ timeframe })).value;
        byScope[rule.scope] = detectAnomalies(summary.daily, {
          scope: rule.scope, method: rule.method, threshold: rule.threshold, minAbsDelta: rule.minAbsDelta,
        });
      }
    } catch (e) {
      if (e instanceof MonitorNotConfiguredError) {
        return apiOk({ rules, feed: [], gate: { missing: e.missing, message: e.message } });
      }
      throw e;
    }
    return apiOk({ rules, feed: anomalyFeed(byScope) });
  } catch (e) {
    return apiServerError(e, 'Failed to load the anomaly feed', 'finops_anomalies_failed');
  }
});

export const PUT = withTenantAdmin(async (req: NextRequest, { session }) => {
  let body: Partial<CostAnomalyRuleDoc>;
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }
  const scope = String(body?.scope || '').trim();
  if (!scope) return apiError('scope is required', 400);
  const norm = normalizeRule({ scope, method: body.method, threshold: body.threshold, minAbsDelta: body.minAbsDelta });
  const alertSeverity: AnomalyAlertSeverity = (['P1', 'P2', 'P3'] as const).includes(body.alertSeverity as AnomalyAlertSeverity)
    ? (body.alertSeverity as AnomalyAlertSeverity)
    : 'P3';
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.map((r) => String(r).trim()).filter(Boolean).slice(0, 50)
    : [];

  try {
    const c = await costAnomalyRulesContainer();
    const id = String(body.id || '').trim() || (scope === 'all' ? 'estate-default' : `rule-${crypto.randomUUID().slice(0, 8)}`);
    let prior: CostAnomalyRuleDoc | null = null;
    try {
      const { resource } = await c.item(id, scope).read<CostAnomalyRuleDoc>();
      prior = resource ?? null;
    } catch { /* new rule */ }

    const now = new Date().toISOString();
    const who = session.claims.upn || session.claims.email || session.claims.oid;
    const next: CostAnomalyRuleDoc = {
      id,
      scope,
      docType: 'cost-anomaly-rule',
      schemaVersion: COST_ANOMALY_RULES_SCHEMA_VERSION,
      enabled: body.enabled !== false,
      method: norm.method,
      threshold: norm.threshold,
      minAbsDelta: norm.minAbsDelta,
      timeframe: body.timeframe === 'Last7Days' ? 'Last7Days' : 'Last30Days',
      alertSeverity,
      recipients,
      createdAt: prior?.createdAt || now,
      updatedAt: now,
      updatedBy: who,
      lastRunAt: prior?.lastRunAt,
      lastFiredAt: prior?.lastFiredAt,
    };
    await c.items.upsert(next);

    await auditFinopsMutation(
      { oid: session.claims.oid, who, tenantId: tenantScopeId(session) },
      { kind: 'finops.anomaly-rule', action: prior ? 'update' : 'create', target: id, scope, prior, next },
    );
    return apiOk({ rule: next });
  } catch (e) {
    return apiServerError(e, 'Failed to save the anomaly rule', 'finops_anomaly_rule_failed');
  }
});

export const DELETE = withTenantAdmin(async (req: NextRequest, { session }) => {
  const id = (req.nextUrl.searchParams.get('id') || '').trim();
  const scope = (req.nextUrl.searchParams.get('scope') || '').trim();
  if (!id || !scope) return apiError('id and scope are required', 400);
  if (id === 'estate-default') return apiError('the default estate rule cannot be deleted (disable it instead)', 400);
  try {
    const c = await costAnomalyRulesContainer();
    let prior: CostAnomalyRuleDoc | null = null;
    try {
      const { resource } = await c.item(id, scope).read<CostAnomalyRuleDoc>();
      prior = resource ?? null;
    } catch { /* already gone */ }
    await c.item(id, scope).delete().catch(() => undefined);
    const who = session.claims.upn || session.claims.email || session.claims.oid;
    await auditFinopsMutation(
      { oid: session.claims.oid, who, tenantId: tenantScopeId(session) },
      { kind: 'finops.anomaly-rule', action: 'delete', target: id, scope, prior, next: null },
    );
    return apiOk({ deleted: id });
  } catch (e) {
    return apiServerError(e, 'Failed to delete the anomaly rule', 'finops_anomaly_rule_delete_failed');
  }
});
