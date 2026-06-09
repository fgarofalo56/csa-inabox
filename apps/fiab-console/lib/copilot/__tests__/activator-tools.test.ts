/**
 * Contract tests for the Activator Copilot tools (lib/copilot/activator-tools).
 *
 * Per no-vaporware.md these exercise the REAL backend call shapes:
 *   - activator_author_rule        deterministic NL → draft (SigninLogs etc.)
 *   - activator_suggest_threshold  stubs the Log Analytics KQL query API and
 *                                  asserts p95-derived suggestedThreshold
 *   - activator_create_rule        confirm=false → no ARM PUT; confirm=true →
 *                                  real scheduledQueryRules ARM PUT
 *   - activator_list_rules         scheduledQueryRules ARM list
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_ADMIN_RG = 'rg-admin';
  process.env.LOOM_ALERT_RG = 'rg-alerts';
  process.env.LOOM_LOG_ANALYTICS_WORKSPACE_ID = 'ws-guid-123';
  process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID =
    '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.OperationalInsights/workspaces/law';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

async function getTool(name: string) {
  const { buildActivatorTools } = await import('../activator-tools');
  const tool = buildActivatorTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

const ctx = { userOid: 'u-1', session: { claims: { oid: 'u-1' } } } as any;

describe('activator_author_rule', () => {
  it('maps "failed logins exceed normal" to SigninLogs + GreaterThan', async () => {
    const tool = await getTool('activator_author_rule');
    const out: any = await tool.handler({ nlIntent: 'alert when failed logins exceed normal' }, ctx);
    expect(out.sourceTable).toBe('SigninLogs');
    expect(out.whereClause).toContain('ResultType');
    expect(out.operator).toBe('GreaterThan');
    expect(out.kqlOp).toBe('>');
    expect(out.metricColumn).toBe('failedSignIns');
  });

  it('maps "CPU spike" to Perf', async () => {
    const tool = await getTool('activator_author_rule');
    const out: any = await tool.handler({ nlIntent: 'alert when CPU spikes above normal' }, ctx);
    expect(out.sourceTable).toBe('Perf');
    expect(out.summarizeExpr).toContain('avg(');
  });
});

describe('activator_suggest_threshold', () => {
  it('runs a real LA query and returns a p95-derived suggestedThreshold', async () => {
    const calls = captureFetch((url) => {
      if (url.includes('/v1/workspaces/') && url.endsWith('/query')) {
        return {
          body: {
            tables: [{
              columns: [
                { name: 'p50' }, { name: 'p95' }, { name: 'p99' },
                { name: 'meanVal' }, { name: 'maxVal' }, { name: 'sampleWindows' },
              ],
              rows: [[3, 11.4, 18, 4.2, 25, 2016]],
            }],
          },
        };
      }
      return { status: 404, body: {} };
    });
    const tool = await getTool('activator_suggest_threshold');
    const out: any = await tool.handler(
      { sourceTable: 'SigninLogs', whereClause: "ResultType != '0'", summarizeExpr: 'count()' },
      ctx,
    );
    // ceil(p95=11.4) = 12
    expect(out.suggestedThreshold).toBe(12);
    expect(out.sampleWindows).toBe(2016);
    expect(out.p95).toBe(11.4);
    // The KQL bins per window and computes percentiles against the real workspace.
    const queryCall = calls.find((c) => c.url.endsWith('/query'));
    expect(queryCall).toBeTruthy();
    const sentBody = JSON.parse(String(queryCall!.init!.body));
    expect(sentBody.query).toContain('percentile(metricVal, 95)');
    expect(sentBody.query).toContain('bin(TimeGenerated');
  });

  it('returns a heuristic estimate when there is no historical data', async () => {
    captureFetch((url) => {
      if (url.endsWith('/query')) {
        return { body: { tables: [{ columns: [{ name: 'sampleWindows' }], rows: [[0]] }] } };
      }
      return { status: 404, body: {} };
    });
    const tool = await getTool('activator_suggest_threshold');
    const out: any = await tool.handler({ sourceTable: 'New_CL' }, ctx);
    expect(out.sampleWindows).toBe(0);
    expect(out.suggestedThreshold).toBeGreaterThan(0);
    expect(out.note).toMatch(/heuristic|estimate/i);
  });
});

describe('activator_create_rule', () => {
  it('does NOT provision anything without confirm', async () => {
    const calls = captureFetch(() => ({ body: {} }));
    const tool = await getTool('activator_create_rule');
    const out: any = await tool.handler({
      name: 'failed-logins-alert',
      sourceTable: 'SigninLogs',
      summarizeExpr: 'count()',
      metricColumn: 'failedSignIns',
      threshold: 12,
    }, ctx);
    expect(out.needsConfirmation).toBe(true);
    expect(calls.length).toBe(0); // no ARM call fired
  });

  it('provisions a real scheduledQueryRule with the threshold embedded in the KQL', async () => {
    const calls = captureFetch((url) => {
      if (url.includes('/providers/Microsoft.Insights/scheduledQueryRules/')) {
        return {
          body: {
            id: '/subscriptions/sub-1/resourceGroups/rg-alerts/providers/microsoft.insights/scheduledQueryRules/loom-x',
          },
        };
      }
      return { status: 200, body: {} };
    });
    const tool = await getTool('activator_create_rule');
    const out: any = await tool.handler({
      name: 'failed-logins-alert',
      activatorName: 'security-reflex',
      sourceTable: 'SigninLogs',
      whereClause: "ResultType != '0'",
      summarizeExpr: 'count()',
      metricColumn: 'failedSignIns',
      operator: 'GreaterThan',
      threshold: 12,
      severity: 2,
      confirm: true,
    }, ctx);
    expect(out.ok).toBe(true);
    expect(out.ruleId).toBeTruthy();
    expect(out.query).toContain('| where failedSignIns > 12');
    expect(out.portalUrl).toContain('scheduledQueryRules');

    const put = calls.find((c) => c.init?.method === 'PUT' && c.url.includes('scheduledQueryRules'));
    expect(put).toBeTruthy();
    expect(put!.url).toContain('api-version=2023-12-01');
    const body = JSON.parse(String(put!.init!.body));
    expect(body.properties.criteria.allOf[0].query).toContain('failedSignIns > 12');
  });
});

describe('activator_list_rules', () => {
  it('lists real scheduledQueryRules from the alert RG', async () => {
    captureFetch((url) => {
      if (url.includes('/providers/Microsoft.Insights/scheduledQueryRules?')) {
        return {
          body: {
            value: [{
              id: '/subscriptions/sub-1/resourceGroups/rg-alerts/providers/microsoft.insights/scheduledQueryRules/r1',
              name: 'r1',
              properties: { enabled: true, severity: 2, criteria: { allOf: [{ query: 'X | count', operator: 'GreaterThan', threshold: 0 }] } },
            }],
          },
        };
      }
      return { status: 200, body: { value: [] } };
    });
    const tool = await getTool('activator_list_rules');
    const out: any = await tool.handler({}, ctx);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].name).toBe('r1');
    expect(out[0].enabled).toBe(true);
  });
});
