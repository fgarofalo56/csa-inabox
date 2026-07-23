/**
 * N13 — token-budget unit tests: attribution math + under/over-budget behaviour.
 *
 * Contract under test:
 *   • attributeSpend prices REAL token counts with the SHARED cost-estimate
 *     tables (model-exact `usd` + the E6 blended per-tier `tierUsd`);
 *   • applySpend folds a turn into the period row, per tier, without mutating;
 *   • budgetVerdict is DEFAULT-ON/opt-out — missing / disabled / non-positive
 *     budgets are unlimited, and a PREVIOUS period's usage never counts;
 *   • enforceTokenBudget allows an under-budget turn, throws the honest
 *     429-class TokenBudgetExceededError (with the Fix-it) on a breach, and is
 *     BOUNDED + fail-open on any subsystem error (unreadable Cosmos, flag OFF,
 *     no attribution) — an accounting outage can never take the Copilot down;
 *   • recordTurnSpend writes the real usage to both the workspace and the agent
 *     scope, and is a no-op when the FLAG0 kill-switch is OFF.
 *
 * Cosmos, runtime-flags and the SIEM stream are mocked; the REAL enforcement +
 * the REAL pure math run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/azure/cosmos-client', () => ({
  tokenBudgetsContainer: vi.fn(),
  auditLogContainer: vi.fn(),
}));
vi.mock('@/lib/admin/runtime-flags', () => ({ runtimeFlag: vi.fn() }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));

import {
  enforceTokenBudget, recordTurnSpend, upsertBudget, deleteBudget, budgetDashboard,
  withTokenAttribution, resolveAttribution, usageFromResponse, isTokenBudgetExceeded,
  TokenBudgetExceededError,
} from '@/lib/copilot/token-budget';
import { tokenBudgetsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import {
  applySpend, attributeSpend, budgetVerdict, emptyUsage, periodKeyFor, periodResetAt,
} from '@/lib/azure/token-budget-model';

const ACTOR = { oid: 'oid-1', who: 'admin@contoso.com', tenantId: 'tid-1' };
const AT = new Date('2026-07-23T12:00:00Z');

function makeContainer() {
  const docs = new Map<string, any>();
  return {
    docs,
    item: (id: string, _pk: string) => ({
      read: async () => {
        const resource = docs.get(id);
        if (!resource) { const e: any = new Error('NotFound'); e.code = 404; throw e; }
        return { resource };
      },
      delete: async () => { docs.delete(id); return {}; },
    }),
    items: {
      upsert: async (doc: any) => { docs.set(doc.id, doc); return { resource: doc }; },
      create: async (doc: any) => { docs.set(doc.id, doc); return { resource: doc }; },
      query: (spec: any) => ({
        fetchAll: async () => {
          const q = String(spec?.query || '');
          const all = [...docs.values()];
          if (q.includes("'budget'")) return { resources: all.filter((d) => d.docType === 'budget') };
          const keys = spec?.parameters?.find((p: any) => p.name === '@keys')?.value ?? [];
          return { resources: all.filter((d) => d.docType === 'usage' && keys.includes(d.periodKey)) };
        },
      }),
    },
  };
}

let container: ReturnType<typeof makeContainer>;
let audit: { rows: any[]; items: { create: (r: any) => Promise<unknown> } };

beforeEach(() => {
  vi.clearAllMocks();
  container = makeContainer();
  const rows: any[] = [];
  audit = { rows, items: { create: async (r: any) => { rows.push(r); return { resource: r }; } } };
  vi.mocked(tokenBudgetsContainer).mockResolvedValue(container as any);
  vi.mocked(auditLogContainer).mockResolvedValue(audit as any);
  vi.mocked(runtimeFlag).mockResolvedValue(true);
});

// ── pure math ────────────────────────────────────────────────────────────────

describe('token-budget — attribution math (pure)', () => {
  it('prices real token counts with the model-exact AND the blended per-tier rate', () => {
    // gpt-4o-mini: in 0.00015/1K, out 0.0006/1K → 10K in + 2K out = 0.0015 + 0.0012
    const s = attributeSpend('gpt-4o-mini', 'mini', { promptTokens: 10_000, completionTokens: 2_000 });
    expect(s.totalTokens).toBe(12_000);
    expect(s.usd).toBeCloseTo(0.0027, 4);
    // mini blended coefficient ≈ (0.0004 + 0.0016)/2 = 0.001 → 12K × 0.001 = 0.012
    expect(s.tierUsd).toBeCloseTo(0.012, 4);
    expect(s.tier).toBe('mini');
  });

  it('clamps negative / NaN usage to zero and never throws (hot path)', () => {
    const s = attributeSpend('gpt-4.1', 'standard', { promptTokens: -5, completionTokens: Number.NaN });
    expect(s).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0, usd: 0, tierUsd: 0 });
  });

  it('folds turns into a period row per tier without mutating the input', () => {
    const base = emptyUsage('workspace', 'ws-1', 'monthly', '2026-07');
    const one = applySpend(base, attributeSpend('gpt-4.1', 'standard', { promptTokens: 1000, completionTokens: 500 }), AT);
    const two = applySpend(one, attributeSpend('gpt-4o', 'strong', { promptTokens: 200, completionTokens: 100 }), AT);
    expect(base.totalTokens).toBe(0); // no mutation
    expect(one.totalTokens).toBe(1500);
    expect(two.totalTokens).toBe(1800);
    expect(two.turns).toBe(2);
    expect(two.byTier.standard?.tokens).toBe(1500);
    expect(two.byTier.strong?.tokens).toBe(300);
    expect(two.ttl).toBeGreaterThan(0);
  });

  it('derives period keys + reset boundaries in UTC', () => {
    expect(periodKeyFor('monthly', AT)).toBe('2026-07');
    expect(periodKeyFor('daily', AT)).toBe('2026-07-23');
    expect(periodResetAt('daily', AT)).toBe('2026-07-24T00:00:00.000Z');
    expect(periodResetAt('monthly', AT)).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('token-budget — verdict (default-ON / opt-out)', () => {
  const budget = {
    id: 'budget:workspace:ws-1', scopeKey: 'workspace:ws-1', docType: 'budget' as const, schemaVersion: 1,
    scope: 'workspace' as const, scopeId: 'ws-1', period: 'monthly' as const, limitTokens: 1000,
    enabled: true, createdAt: '', createdBy: '', updatedAt: '',
  };

  it('treats a missing / disabled / non-positive budget as unlimited', () => {
    expect(budgetVerdict(null, null, AT)).toBeNull();
    expect(budgetVerdict({ ...budget, enabled: false }, null, AT)).toBeNull();
    expect(budgetVerdict({ ...budget, limitTokens: 0 }, null, AT)).toBeNull();
  });

  it('reports under / warning / over and never counts a previous period', () => {
    const usage = (tokens: number, periodKey: string) => ({
      ...emptyUsage('workspace', 'ws-1', 'monthly', periodKey), totalTokens: tokens, usd: 1,
    });
    expect(budgetVerdict(budget, usage(100, '2026-07'), AT)).toMatchObject({ over: false, warning: false, remainingTokens: 900 });
    expect(budgetVerdict(budget, usage(850, '2026-07'), AT)).toMatchObject({ over: false, warning: true });
    expect(budgetVerdict(budget, usage(1000, '2026-07'), AT)).toMatchObject({ over: true, remainingTokens: 0 });
    // last month's spend is irrelevant to this month's allowance
    expect(budgetVerdict(budget, usage(999_999, '2026-06'), AT)).toMatchObject({ over: false, usedTokens: 0 });
  });
});

// ── hot-path enforcement ─────────────────────────────────────────────────────

async function seedBudget(scopeId: string, limitTokens: number, enabled = true) {
  return upsertBudget({ scope: 'workspace', scopeId, period: 'monthly', limitTokens, enabled }, ACTOR);
}

describe('token-budget — hot-path enforcement', () => {
  it('is a no-op with no attribution (unchanged behaviour for unattributed callers)', async () => {
    await expect(enforceTokenBudget(undefined)).resolves.toEqual([]);
    await expect(recordTurnSpend(undefined, { model: 'gpt-4.1', tier: 'standard', usage: { promptTokens: 5, completionTokens: 5 } })).resolves.toBeNull();
  });

  it('is a no-op when no budget is configured for the scope (opt-out)', async () => {
    await expect(enforceTokenBudget({ workspaceId: 'ws-unbudgeted' })).resolves.toEqual([]);
  });

  it('allows an under-budget turn and reports the live verdict', async () => {
    await seedBudget('ws-1', 10_000);
    await recordTurnSpend({ workspaceId: 'ws-1' }, { model: 'gpt-4.1', tier: 'standard', usage: { promptTokens: 1000, completionTokens: 500 } });
    const verdicts = await enforceTokenBudget({ workspaceId: 'ws-1' });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ over: false, usedTokens: 1500, limitTokens: 10_000 });
  });

  it('refuses an exhausted budget with the honest 429-class refusal + Fix-it (never a truncation)', async () => {
    await seedBudget('ws-1', 1000);
    await recordTurnSpend({ workspaceId: 'ws-1' }, { model: 'gpt-4.1', tier: 'standard', usage: { promptTokens: 900, completionTokens: 200 } });
    await expect(enforceTokenBudget({ workspaceId: 'ws-1' })).rejects.toBeInstanceOf(TokenBudgetExceededError);
    try {
      await enforceTokenBudget({ workspaceId: 'ws-1' });
      throw new Error('expected a refusal');
    } catch (e) {
      expect(isTokenBudgetExceeded(e)).toBe(true);
      const r = (e as TokenBudgetExceededError).refusal;
      expect(r.status).toBe(429);
      expect(r.code).toBe('token_budget_exceeded');
      expect(r.usedTokens).toBe(1100);
      expect(r.limitTokens).toBe(1000);
      expect(r.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r.fixit.href).toContain('/admin/copilot-quality');
      expect(r.fixit.remediation).toMatch(/raise/i);
      expect(r.message).toMatch(/refused rather than truncated/i);
    }
  });

  it('enforces the AGENT scope independently of the workspace scope', async () => {
    await upsertBudget({ scope: 'agent', scopeId: 'agent-x', period: 'monthly', limitTokens: 100 }, ACTOR);
    await recordTurnSpend({ workspaceId: 'ws-free', agentId: 'agent-x' }, { model: 'gpt-4.1', tier: 'standard', usage: { promptTokens: 100, completionTokens: 50 } });
    // the workspace has no budget, but the agent is exhausted → refuse
    await expect(enforceTokenBudget({ workspaceId: 'ws-free', agentId: 'agent-x' })).rejects.toBeInstanceOf(TokenBudgetExceededError);
  });

  it('fails OPEN when the FLAG0 kill-switch is OFF or Cosmos is unreachable', async () => {
    await seedBudget('ws-1', 1);
    await recordTurnSpend({ workspaceId: 'ws-1' }, { model: 'gpt-4.1', tier: 'standard', usage: { promptTokens: 50, completionTokens: 50 } });
    // over budget, but the kill-switch releases it instantly (no roll)
    vi.mocked(runtimeFlag).mockResolvedValue(false);
    await expect(enforceTokenBudget({ workspaceId: 'ws-1' })).resolves.toEqual([]);
    // and an accounting-store outage never gates a turn
    vi.mocked(runtimeFlag).mockResolvedValue(true);
    vi.mocked(tokenBudgetsContainer).mockRejectedValue(new Error('cosmos down'));
    await expect(enforceTokenBudget({ workspaceId: 'ws-1' })).resolves.toEqual([]);
  });

  it('records the same turn against BOTH the workspace and the agent scope', async () => {
    await recordTurnSpend(
      { workspaceId: 'ws-2', agentId: 'agent-y' },
      { model: 'gpt-4o-mini', tier: 'mini', usage: { promptTokens: 400, completionTokens: 100 } },
    );
    const ids = [...container.docs.keys()].filter((k) => k.startsWith('usage:'));
    expect(ids).toContain(`usage:workspace:ws-2:${periodKeyFor('monthly')}`);
    expect(ids).toContain(`usage:agent:agent-y:${periodKeyFor('monthly')}`);
    const ws = container.docs.get(`usage:workspace:ws-2:${periodKeyFor('monthly')}`);
    expect(ws.totalTokens).toBe(500);
    expect(ws.byTier.mini.turns).toBe(1);
  });

  it('does not attribute anything when the kill-switch is OFF', async () => {
    vi.mocked(runtimeFlag).mockResolvedValue(false);
    await recordTurnSpend({ workspaceId: 'ws-3' }, { model: 'gpt-4.1', tier: 'standard', usage: { promptTokens: 10, completionTokens: 10 } });
    expect([...container.docs.keys()].filter((k) => k.startsWith('usage:'))).toHaveLength(0);
  });
});

// ── attribution plumbing + admin CRUD ────────────────────────────────────────

describe('token-budget — attribution plumbing + audited CRUD', () => {
  it('merges an explicit attribution over the ambient AsyncLocalStorage scope', () => {
    expect(resolveAttribution(undefined)).toBeUndefined();
    withTokenAttribution({ workspaceId: 'ws-amb', agentId: 'agent-amb' }, () => {
      expect(resolveAttribution()).toMatchObject({ workspaceId: 'ws-amb', agentId: 'agent-amb' });
      expect(resolveAttribution({ agentId: 'agent-override' })).toMatchObject({
        workspaceId: 'ws-amb', agentId: 'agent-override',
      });
    });
    // the ambient scope does not leak outside the callback
    expect(resolveAttribution()).toBeUndefined();
  });

  it('reads the REAL usage block off a chat-completions response (never invents one)', () => {
    expect(usageFromResponse({ usage: { prompt_tokens: 12, completion_tokens: 7 } })).toEqual({ promptTokens: 12, completionTokens: 7 });
    expect(usageFromResponse({ choices: [] })).toBeNull();
    expect(usageFromResponse(null)).toBeNull();
  });

  it('audits budget create/update and delete', async () => {
    await seedBudget('ws-9', 500);
    expect(audit.rows.map((r) => r.kind)).toContain('llmops.budget.upsert');
    await deleteBudget('workspace', 'ws-9', ACTOR);
    expect(audit.rows.map((r) => r.kind)).toContain('llmops.budget.delete');
    expect(container.docs.has('budget:workspace:ws-9')).toBe(false);
  });

  it('rejects a non-positive limit', async () => {
    await expect(upsertBudget({ scope: 'workspace', scopeId: 'ws-x', period: 'monthly', limitTokens: 0 }, ACTOR))
      .rejects.toThrow(/positive whole number/i);
  });

  it('dashboards budgeted AND unbudgeted scopes, newest spend first', async () => {
    await seedBudget('ws-a', 1000);
    await recordTurnSpend({ workspaceId: 'ws-a' }, { model: 'gpt-4.1', tier: 'standard', usage: { promptTokens: 100, completionTokens: 0 } });
    await recordTurnSpend({ workspaceId: 'ws-b' }, { model: 'gpt-4.1', tier: 'standard', usage: { promptTokens: 900, completionTokens: 0 } });
    const rows = await budgetDashboard();
    expect(rows.map((r) => r.scopeId)).toEqual(['ws-b', 'ws-a']);
    expect(rows.find((r) => r.scopeId === 'ws-b')?.budget).toBeNull(); // spend without a budget still shows
    expect(rows.find((r) => r.scopeId === 'ws-a')?.verdict).toMatchObject({ usedTokens: 100, limitTokens: 1000 });
  });
});
