/**
 * POST /api/internal/cost-anomaly/run — C3 scheduled cost-anomaly evaluation.
 *
 * The window the IN-VNET cost-anomaly monitor Container App Job calls once per
 * schedule (per the estate constraint the runner is an ACA Job, NOT a Y1
 * Function — the job is a thin `node e2e/run-cost-anomaly.mjs` that POSTs here
 * with the shared internal token; ALL the real work runs here in the console
 * process where the Cost Management + Cosmos + alert clients already live).
 *
 * What it does per enabled rule (loom-cost-anomaly-rules, PK /scope):
 *   1. Pull the REAL daily cost series (getLoomCostSummaryCached — C1 cached
 *      Cost Management client, honest gate when Cost Management is unconfigured).
 *   2. Run the SHARED pure detector (lib/azure/cost-anomaly-core.detectAnomalies)
 *      with the rule's method/threshold/minAbsDelta — byte-identical to what the
 *      /monitor Cost tab + /admin/finops feed show.
 *   3. For anomalies NEWER than the rule's lastFiredAt (dedup — never re-page the
 *      same day): write an in-product notification (loom-notifications) to each
 *      recipient AND dispatch ONE alert through the shared action group
 *      (lib/azure/alert-dispatch.ts → LOOM_ALERT_ACTION_GROUP_ID, O1).
 *   4. Stamp lastRunAt / lastFiredAt back on the rule.
 *
 * Seeds the default estate-wide rule when the container is empty, so the monitor
 * is functional day-one with zero operator input (loom_default_on_opt_out).
 *
 * Auth: machine-to-machine internal token (LOOM_INTERNAL_TOKEN; fail-closed when
 * unset) — the SAME proven pattern as /api/internal/copilot/eval-probe. Not a
 * user API; a signed-in admin session is not accepted here. Opt-out via
 * LOOM_COST_ANOMALY_ENABLED=false (the route returns a no-op summary).
 *
 * Real backend only (Cost Management + Cosmos + Action Group) — no mock data
 * (no-vaporware). Azure-native (no Fabric dependency).
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { costAnomalyRulesContainer, notificationsContainer } from '@/lib/azure/cosmos-client';
import { getLoomCostSummaryCached, type CostTimeframe, MonitorNotConfiguredError } from '@/lib/azure/cost-client';
import { detectAnomalies, type CostAnomaly } from '@/lib/azure/cost-anomaly-core';
import { dispatchAlert, type AlertSeverity } from '@/lib/azure/alert-dispatch';
import {
  defaultEstateRule,
  COST_ANOMALY_RULES_SCHEMA_VERSION,
  type CostAnomalyRuleDoc,
} from '@/lib/azure/cost-anomaly-rules-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

function enabled(): boolean {
  return (process.env.LOOM_COST_ANOMALY_ENABLED || 'true').trim().toLowerCase() !== 'false';
}

/** The recipients for a rule's notifications — the rule's list, else the
 * bootstrap tenant admin (so a fresh deploy still notifies a real person). */
function recipientsFor(rule: CostAnomalyRuleDoc): string[] {
  const list = (rule.recipients || []).map((r) => String(r).trim()).filter(Boolean);
  if (list.length) return list;
  const admin = (process.env.LOOM_TENANT_ADMIN_OID || '').trim();
  return admin ? [admin] : [];
}

/** Only anomalies strictly newer than the last-fired watermark fire (dedup). */
function newAnomalies(anomalies: CostAnomaly[], lastFiredAt?: string): CostAnomaly[] {
  const watermark = (lastFiredAt || '').slice(0, 10); // compare on the YYYY-MM-DD day
  if (!watermark) return anomalies;
  return anomalies.filter((a) => a.date > watermark);
}

function alertSeverity(rule: CostAnomalyRuleDoc, fired: CostAnomaly[]): AlertSeverity {
  const base: AlertSeverity = (['P1', 'P2', 'P3'] as const).includes(rule.alertSeverity as AlertSeverity)
    ? (rule.alertSeverity as AlertSeverity)
    : 'P3';
  // A 'high'-severity anomaly escalates a P3 email rule to P2 (urgent).
  if (base === 'P3' && fired.some((a) => a.severity === 'high')) return 'P2';
  return base;
}

function summarize(scope: string, fired: CostAnomaly[]): { title: string; body: string } {
  const worst = fired[0];
  const scopeLabel = scope === 'all' ? 'the Loom estate' : `scope ${scope}`;
  const title = `Cost anomaly detected — ${scopeLabel}`;
  const lines = fired
    .slice(0, 5)
    .map((a) => `• ${a.date}: $${a.cost.toFixed(2)} (${a.deviationPct > 0 ? '+' : ''}${a.deviationPct}% vs $${a.expected.toFixed(2)} expected, ${a.severity})`);
  const body =
    `${fired.length} anomalous day${fired.length === 1 ? '' : 's'} in ${scopeLabel}. ` +
    `Worst: ${worst.date} at $${worst.cost.toFixed(2)} (${worst.deviationPct > 0 ? '+' : ''}${worst.deviationPct}% over the $${worst.expected.toFixed(2)} run-rate).\n` +
    lines.join('\n');
  return { title, body };
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return apiError('invalid internal token', 401, { code: 'bad_internal_token' });

  if (!enabled()) {
    return apiOk({ enabled: false, evaluated: 0, fired: 0, rules: [], note: 'LOOM_COST_ANOMALY_ENABLED=false — monitor is opted out.' });
  }

  let body: { scopes?: string[]; trigger?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* body is optional — a bare scheduled tick has none */
  }
  const scopeFilter = Array.isArray(body?.scopes) ? new Set(body!.scopes!.map(String)) : null;
  const trigger = String(body?.trigger || 'scheduled');

  try {
    const container = await costAnomalyRulesContainer();

    // Load enabled rules; seed the default estate rule when the store is empty.
    let { resources: rules } = await container.items
      .query<CostAnomalyRuleDoc>({ query: 'SELECT * FROM c WHERE c.docType = @t', parameters: [{ name: '@t', value: 'cost-anomaly-rule' }] })
      .fetchAll();
    if (!rules.length) {
      const seed = defaultEstateRule();
      await container.items.upsert(seed);
      rules = [seed];
    }

    const active = rules.filter((r) => r.enabled !== false && (!scopeFilter || scopeFilter.has(r.scope)));

    const notifications = await notificationsContainer();
    const now = new Date().toISOString();
    const perRule: Array<{ scope: string; evaluated: boolean; anomalies: number; fired: number; alert?: string; note?: string }> = [];
    let totalFired = 0;
    let configGate: string | null = null;

    for (const rule of active) {
      const timeframe: CostTimeframe = rule.timeframe === 'Last7Days' ? 'Last7Days' : 'Last30Days';
      let anomalies: CostAnomaly[] = [];
      try {
        const summary = (await getLoomCostSummaryCached({ timeframe })).value;
        anomalies = detectAnomalies(summary.daily, {
          scope: rule.scope,
          method: rule.method,
          threshold: rule.threshold,
          minAbsDelta: rule.minAbsDelta,
        });
      } catch (e) {
        if (e instanceof MonitorNotConfiguredError) {
          // Honest infra gate — Cost Management not wired yet. Record + move on;
          // the C4 hub surfaces the svc-cost-management Fix-it.
          configGate = 'Cost Management not configured (set LOOM_SUBSCRIPTION_ID / grant Cost Management Reader — svc-cost-management gate).';
          perRule.push({ scope: rule.scope, evaluated: false, anomalies: 0, fired: 0, note: configGate });
          continue;
        }
        throw e;
      }

      const fired = newAnomalies(anomalies, rule.lastFiredAt);
      let alertResultNote: string | undefined;

      if (fired.length) {
        const severity = alertSeverity(rule, fired);
        const { title, body: bodyText } = summarize(rule.scope, fired);

        // In-product notifications (loom-notifications, one per recipient).
        for (const oid of recipientsFor(rule)) {
          await notifications.items.create({
            id: crypto.randomUUID(),
            userId: oid,
            title,
            body: bodyText,
            severity: fired.some((a) => a.severity === 'high') ? 'error' : 'warning',
            link: '/admin/finops',
            source: 'cost-anomaly-monitor',
            scope: rule.scope,
            read: false,
            createdAt: now,
          });
        }

        // ONE alert through the shared action group (O1 convention).
        const dispatch = await dispatchAlert({
          source: 'cost-anomaly-monitor',
          severity,
          title,
          body: bodyText,
          dedupKey: `cost-anomaly:${rule.scope}:${fired[0].date}`,
        });
        alertResultNote = dispatch.ok ? `${severity} dispatched` : `${severity} not delivered (no channel configured)`;
        totalFired += fired.length;
      }

      // Stamp run/fire watermarks back on the rule.
      const updated: CostAnomalyRuleDoc = {
        ...rule,
        schemaVersion: rule.schemaVersion || COST_ANOMALY_RULES_SCHEMA_VERSION,
        lastRunAt: now,
        lastFiredAt: fired.length ? fired.map((a) => a.date).sort().slice(-1)[0] : rule.lastFiredAt,
      };
      await container.item(rule.id, rule.scope).replace(updated).catch(async () => {
        await container.items.upsert(updated);
      });

      perRule.push({ scope: rule.scope, evaluated: true, anomalies: anomalies.length, fired: fired.length, alert: alertResultNote });
    }

    return apiOk({
      enabled: true,
      trigger,
      evaluated: perRule.filter((r) => r.evaluated).length,
      fired: totalFired,
      configGate,
      rules: perRule,
      ranAt: now,
    });
  } catch (e) {
    return apiServerError(e, 'cost-anomaly run failed', 'cost_anomaly_run_failed');
  }
}
