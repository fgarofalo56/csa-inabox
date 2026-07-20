/**
 * AIF-12 — Loom-native model tier router (pure policy) + CTS-16 tier surfacing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  classifyTaskClass, selectTier, tierPolicyFromConfig, resolveTierForTurn,
  downshiftTier,
  promptFromMessages, routeTurnTier, reasoningTierConfigured,
  bestReasoningModelFor, defaultTierModelsFor,
  DEFAULT_TIER_POLICY, DEFAULT_TASK_TIER_MAP, MODEL_TIERS, TASK_CLASSES,
  type TierPolicy,
} from '../model-tier-router';

describe('classifyTaskClass', () => {
  it('buckets reasoning-heavy prompts', () => {
    expect(classifyTaskClass('Why is my pipeline failing — help me debug the root cause')).toBe('reasoning');
    expect(classifyTaskClass('Design an architecture for a medallion lakehouse')).toBe('reasoning');
    expect(classifyTaskClass('```sql\nSELECT x FROM t\n```')).toBe('reasoning');
    expect(classifyTaskClass('optimize this KQL query | summarize by bin(t, 1h)')).toBe('reasoning');
  });
  it('buckets short lookups/greetings as lightweight', () => {
    expect(classifyTaskClass('hi')).toBe('lightweight');
    expect(classifyTaskClass('what is a lakehouse?')).toBe('lightweight');
    expect(classifyTaskClass('thanks')).toBe('lightweight');
  });
  it('defaults to general', () => {
    expect(classifyTaskClass('Add a column to my dataset and refresh it')).toBe('general');
  });
  it('long prompts escalate to reasoning', () => {
    expect(classifyTaskClass('a'.repeat(700))).toBe('reasoning');
  });
  it('tool-driven medium prompts escalate to reasoning', () => {
    expect(classifyTaskClass('b'.repeat(300), { hasTools: true })).toBe('reasoning');
    expect(classifyTaskClass('b'.repeat(300), { hasTools: false })).toBe('general');
  });
  it('empty prompt is general (never lightweight)', () => {
    expect(classifyTaskClass('')).toBe('general');
  });
  // Regression: CODE_RE must not exhibit polynomial ReDoS (js/polynomial-redos).
  // A `select`/`summarize` keyword followed by a long run of whitespace with no
  // terminating `from`/`by` used to backtrack quadratically (\s+ adjacent to .*).
  it('classifies pathological whitespace runs in bounded time (no ReDoS)', () => {
    // Interior tabs (a trailing non-space defeats trim()) with no `from`/`by`
    // terminator: CODE_RE.test() scans the whole run before the len>600
    // short-circuit, so this drives the previously-quadratic backtracking.
    const evil = `select${'\t'.repeat(100000)}x`;
    const evil2 = `summarize${'\t'.repeat(100000)}x`;
    const start = Date.now();
    expect(classifyTaskClass(evil)).toBe('reasoning'); // via len>600, CODE_RE is false
    expect(classifyTaskClass(evil2)).toBe('reasoning');
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('selectTier — default policy (no tiers wired) is a no-op', () => {
  it('rides the base deployment and never routes', () => {
    const r = selectTier(DEFAULT_TIER_POLICY, { taskClass: 'lightweight', baseDeployment: 'gpt-4o' });
    expect(r.routed).toBe(false);
    expect(r.deployment).toBe('gpt-4o');
    expect(r.tier).toBe('standard'); // falls back to base since no mini configured
  });
});

describe('selectTier — configured tiers', () => {
  const policy: TierPolicy = {
    enabled: true,
    tiers: { mini: 'gpt-4o-mini', standard: 'gpt-4o', strong: 'o3' },
    taskMap: { ...DEFAULT_TASK_TIER_MAP },
  };
  it('routes lightweight → mini', () => {
    const r = selectTier(policy, { taskClass: 'lightweight', baseDeployment: 'gpt-4o' });
    expect(r).toMatchObject({ tier: 'mini', deployment: 'gpt-4o-mini', routed: true });
  });
  it('routes reasoning → strong', () => {
    const r = selectTier(policy, { taskClass: 'reasoning', baseDeployment: 'gpt-4o' });
    expect(r).toMatchObject({ tier: 'strong', deployment: 'o3', routed: true });
  });
  it('general stays on standard (== base) with routed=false', () => {
    const r = selectTier(policy, { taskClass: 'general', baseDeployment: 'gpt-4o' });
    expect(r).toMatchObject({ tier: 'standard', deployment: 'gpt-4o', routed: false });
  });
  it('per-call overrideTier wins over the task mapping', () => {
    const r = selectTier(policy, { taskClass: 'lightweight', overrideTier: 'strong', baseDeployment: 'gpt-4o' });
    expect(r).toMatchObject({ tier: 'strong', deployment: 'o3', routed: true });
  });
});

describe('selectTier — honest fallback when a tier has no deployment', () => {
  it('desired strong but only mini wired → falls back to standard/base (tier reported honestly)', () => {
    const policy: TierPolicy = { enabled: true, tiers: { mini: 'gpt-4o-mini', standard: 'gpt-4o' }, taskMap: { ...DEFAULT_TASK_TIER_MAP } };
    const r = selectTier(policy, { taskClass: 'reasoning', baseDeployment: 'gpt-4o' });
    expect(r.tier).toBe('standard');
    expect(r.deployment).toBe('gpt-4o');
    expect(r.routed).toBe(false);
  });
});

describe('selectTier — disabled policy', () => {
  it('is a hard no-op regardless of task class', () => {
    const policy: TierPolicy = { enabled: false, tiers: { mini: 'm', strong: 's' }, taskMap: { ...DEFAULT_TASK_TIER_MAP } };
    const r = selectTier(policy, { taskClass: 'reasoning', baseDeployment: 'gpt-4o' });
    expect(r).toMatchObject({ tier: 'standard', deployment: 'gpt-4o', routed: false });
  });
});

describe('tierPolicyFromConfig — default-ON / opt-out semantics', () => {
  it('is enabled when the flag is unset (default-ON)', () => {
    expect(tierPolicyFromConfig({}).enabled).toBe(true);
    expect(tierPolicyFromConfig(null).enabled).toBe(true);
    expect(tierPolicyFromConfig({ modelTierRoutingEnabled: true }).enabled).toBe(true);
  });
  it('is disabled ONLY when explicitly false', () => {
    expect(tierPolicyFromConfig({ modelTierRoutingEnabled: false }).enabled).toBe(false);
  });
  it('standard tier falls back to copilotChatDeployment', () => {
    const p = tierPolicyFromConfig({ copilotChatDeployment: 'gpt-4o' });
    expect(p.tiers.standard).toBe('gpt-4o');
  });
  it('explicit standard tier overrides the chat deployment', () => {
    const p = tierPolicyFromConfig({ copilotChatDeployment: 'gpt-4o', modelTiers: { standard: 'gpt-4.1' } });
    expect(p.tiers.standard).toBe('gpt-4.1');
  });
  it('merges a valid task-map override and ignores invalid tiers', () => {
    const p = tierPolicyFromConfig({ modelTierTaskMap: { general: 'strong', lightweight: 'bogus' as any } });
    expect(p.taskMap.general).toBe('strong');
    expect(p.taskMap.lightweight).toBe(DEFAULT_TASK_TIER_MAP.lightweight);
  });
});

describe('resolveTierForTurn — end to end from config', () => {
  it('cheap prompt rides mini, hard prompt rides strong', () => {
    const cfg = { copilotChatDeployment: 'gpt-4o', modelTiers: { mini: 'gpt-4o-mini', strong: 'o3' } };
    expect(resolveTierForTurn(cfg, { prompt: 'hi', baseDeployment: 'gpt-4o' })).toMatchObject({ tier: 'mini', deployment: 'gpt-4o-mini', routed: true });
    expect(resolveTierForTurn(cfg, { prompt: 'debug the root cause of this failure', baseDeployment: 'gpt-4o' })).toMatchObject({ tier: 'strong', deployment: 'o3', routed: true });
  });
  it('opted-out config never routes', () => {
    const cfg = { modelTierRoutingEnabled: false as const, copilotChatDeployment: 'gpt-4o', modelTiers: { mini: 'gpt-4o-mini' } };
    expect(resolveTierForTurn(cfg, { prompt: 'hi', baseDeployment: 'gpt-4o' }).routed).toBe(false);
  });
});

describe('enum guards', () => {
  it('exposes the three tiers and task classes', () => {
    expect([...MODEL_TIERS]).toEqual(['mini', 'standard', 'strong']);
    expect([...TASK_CLASSES]).toEqual(['lightweight', 'general', 'reasoning']);
  });
});

describe('tierPolicyFromConfig — day-one env deployment fallback (model-strategy M3)', () => {
  const ENV_KEYS = [
    'LOOM_AOAI_MINI_DEPLOYMENT',
    'LOOM_AOAI_STRONG_DEPLOYMENT',
    'LOOM_AOAI_DEPLOYMENT',
    'LOOM_AOAI_CHAT_DEPLOYMENT',
  ] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('populates all three tiers from env with NO tenant cfg (best-per-task active day-one)', () => {
    process.env.LOOM_AOAI_MINI_DEPLOYMENT = 'mini';
    process.env.LOOM_AOAI_DEPLOYMENT = 'chat';
    process.env.LOOM_AOAI_STRONG_DEPLOYMENT = 'strong';
    const p = tierPolicyFromConfig(null);
    expect(p.enabled).toBe(true);
    expect(p.tiers).toMatchObject({ mini: 'mini', standard: 'chat', strong: 'strong' });
    expect(p.taskMap).toEqual(DEFAULT_TASK_TIER_MAP);
  });

  it('routes lightweight→mini and reasoning→strong from env deployments (no admin config)', () => {
    process.env.LOOM_AOAI_MINI_DEPLOYMENT = 'mini';
    process.env.LOOM_AOAI_STRONG_DEPLOYMENT = 'strong';
    expect(resolveTierForTurn(null, { prompt: 'hi', baseDeployment: 'chat' }))
      .toMatchObject({ tier: 'mini', deployment: 'mini', routed: true });
    expect(resolveTierForTurn(null, { prompt: 'debug the root cause of this failure', baseDeployment: 'chat' }))
      .toMatchObject({ tier: 'strong', deployment: 'strong', routed: true });
  });

  it('standard tier falls back to LOOM_AOAI_CHAT_DEPLOYMENT when LOOM_AOAI_DEPLOYMENT is unset', () => {
    process.env.LOOM_AOAI_CHAT_DEPLOYMENT = 'chat-alt';
    expect(tierPolicyFromConfig(null).tiers.standard).toBe('chat-alt');
  });

  it('tenant cfg OVERRIDES the env deployments (precedence)', () => {
    process.env.LOOM_AOAI_MINI_DEPLOYMENT = 'env-mini';
    process.env.LOOM_AOAI_STRONG_DEPLOYMENT = 'env-strong';
    const p = tierPolicyFromConfig({ modelTiers: { mini: 'cfg-mini' }, copilotChatDeployment: 'cfg-chat' });
    expect(p.tiers.mini).toBe('cfg-mini');     // tenant cfg wins
    expect(p.tiers.strong).toBe('env-strong'); // env fills the gap cfg left
    expect(p.tiers.standard).toBe('cfg-chat'); // cfg chat wins over env
  });

  it('missing strong env → reasoning turns fall back to standard/base (graceful, no hard fail)', () => {
    process.env.LOOM_AOAI_MINI_DEPLOYMENT = 'mini'; // only mini wired
    const r = resolveTierForTurn(null, { prompt: 'debug the root cause', baseDeployment: 'chat' });
    expect(r.tier).toBe('standard');
    expect(r.deployment).toBe('chat');
    expect(r.routed).toBe(false);
  });

  it('no env + no cfg → pure no-op (rides the base deployment)', () => {
    const r = resolveTierForTurn(null, { prompt: 'hi', baseDeployment: 'chat' });
    expect(r.routed).toBe(false);
    expect(r.deployment).toBe('chat');
  });
});

describe('PSR-8 latency-SLO tier protection', () => {
  const policy: TierPolicy = {
    enabled: true,
    tiers: { mini: 'gpt-mini', standard: 'gpt', strong: 'gpt-strong' },
    taskMap: { ...DEFAULT_TASK_TIER_MAP },
  };

  it('downshiftTier shaves one tier: strong→standard→mini→mini', () => {
    expect(downshiftTier('strong')).toBe('standard');
    expect(downshiftTier('standard')).toBe('mini');
    expect(downshiftTier('mini')).toBe('mini');
  });

  it('breaching SLO (burn > 1) downshifts a GENERAL turn standard→mini', () => {
    const sel = selectTier(policy, { taskClass: 'general', baseDeployment: 'gpt', latencyBurn: 4 });
    expect(sel.tier).toBe('mini');
    expect(sel.deployment).toBe('gpt-mini');
    expect(sel.sloProtected).toBe(true);
  });

  it('NEVER downshifts a REASONING turn, even under heavy breach', () => {
    const sel = selectTier(policy, { taskClass: 'reasoning', baseDeployment: 'gpt', latencyBurn: 10 });
    expect(sel.tier).toBe('strong');
    expect(sel.sloProtected).toBeUndefined();
  });

  it('NEVER overrides an explicit overrideTier', () => {
    const sel = selectTier(policy, { taskClass: 'general', overrideTier: 'strong', baseDeployment: 'gpt', latencyBurn: 9 });
    expect(sel.tier).toBe('strong');
    expect(sel.sloProtected).toBeUndefined();
  });

  it('healthy SLO (burn <= 1) leaves routing byte-identical', () => {
    const withBurn = selectTier(policy, { taskClass: 'general', baseDeployment: 'gpt', latencyBurn: 0.5 });
    const without = selectTier(policy, { taskClass: 'general', baseDeployment: 'gpt' });
    expect(withBurn.tier).toBe(without.tier);
    expect(withBurn.sloProtected).toBeUndefined();
  });
});

// ── WS-1.1: env kill-switch, message classifier, escalate-only shared routing ─

describe('WS-1.1 tierPolicyFromConfig — env kill-switch (opt-out)', () => {
  const KEY = 'LOOM_MODEL_TIER_ROUTING_ENABLED';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
  afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

  it('stays enabled by default (unset env)', () => {
    expect(tierPolicyFromConfig(null).enabled).toBe(true);
  });
  it('disables when LOOM_MODEL_TIER_ROUTING_ENABLED=false (case/space tolerant)', () => {
    process.env[KEY] = ' FALSE ';
    expect(tierPolicyFromConfig(null).enabled).toBe(false);
    // A disabled policy is a hard no-op even for a hard turn with tiers wired.
    const sel = resolveTierForTurn(
      { modelTiers: { strong: 'o3' } },
      { prompt: 'debug the root cause of this failure', baseDeployment: 'gpt-4o' },
    );
    expect(sel.routed).toBe(false);
    expect(sel.deployment).toBe('gpt-4o');
  });
  it('any non-false value leaves routing on', () => {
    process.env[KEY] = 'true';
    expect(tierPolicyFromConfig(null).enabled).toBe(true);
  });
});

describe('WS-1.1 promptFromMessages', () => {
  it('returns the LAST user message text', () => {
    expect(promptFromMessages([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'debug the root cause' },
    ])).toBe('debug the root cause');
  });
  it('flattens multimodal content parts to text', () => {
    expect(promptFromMessages([
      { role: 'user', content: [{ type: 'text', text: 'design an' }, { type: 'text', text: 'architecture' }] },
    ])).toBe('design an architecture');
  });
  it('treats a role-less message as a user message', () => {
    expect(promptFromMessages([{ content: 'hello' }])).toBe('hello');
  });
  it('is empty + safe for no/empty messages', () => {
    expect(promptFromMessages([])).toBe('');
    expect(promptFromMessages(undefined)).toBe('');
    expect(promptFromMessages(null)).toBe('');
  });
});

describe('WS-1.1 routeTurnTier — auto classify + escalate-only', () => {
  const cfg = { copilotChatDeployment: 'gpt-4o', modelTiers: { mini: 'gpt-4o-mini', strong: 'o3' } };

  it('auto-escalates a HARD turn to the strong deployment (no explicit hint)', () => {
    const sel = routeTurnTier({
      cfg,
      messages: [{ role: 'user', content: 'debug the root cause of this failure' }],
      baseDeployment: 'gpt-4o',
    });
    expect(sel).toMatchObject({ tier: 'strong', deployment: 'o3', routed: true });
    expect(sel.taskClass).toBe('reasoning');
  });

  it('does NOT auto-downshift a LIGHTWEIGHT turn to mini (escalate-only default)', () => {
    const sel = routeTurnTier({
      cfg,
      messages: [{ role: 'user', content: 'hi' }],
      baseDeployment: 'gpt-4o',
    });
    // classified lightweight, but the auto path suppresses the mini swap.
    expect(sel.tier).toBe('mini');
    expect(sel.deployment).toBe('gpt-4o');
    expect(sel.routed).toBe(false);
  });

  it('honors an EXPLICIT tier even to mini (explicit opt-in bypasses escalate-only)', () => {
    const sel = routeTurnTier({ cfg, tier: 'mini', baseDeployment: 'gpt-4o' });
    expect(sel).toMatchObject({ tier: 'mini', deployment: 'gpt-4o-mini', routed: true });
  });

  it('allows auto mini-downshift when escalateOnly:false is opted in', () => {
    const sel = routeTurnTier({
      cfg, escalateOnly: false,
      messages: [{ role: 'user', content: 'hi' }],
      baseDeployment: 'gpt-4o',
    });
    expect(sel).toMatchObject({ tier: 'mini', deployment: 'gpt-4o-mini', routed: true });
  });

  it('is a pure no-op (identical to base) when NO strong deployment is configured, even for a hard turn', () => {
    const sel = routeTurnTier({
      cfg: { copilotChatDeployment: 'gpt-4o' }, // no strong tier
      messages: [{ role: 'user', content: 'debug the root cause of this failure' }],
      baseDeployment: 'gpt-4o',
    });
    expect(sel.tier).toBe('standard');
    expect(sel.deployment).toBe('gpt-4o');
    expect(sel.routed).toBe(false);
  });
});

describe('WS-1.1 reasoningTierConfigured', () => {
  it('true when a strong deployment resolves (cfg)', () => {
    expect(reasoningTierConfigured({ modelTiers: { strong: 'o3' } })).toBe(true);
  });
  it('false when no strong tier is wired', () => {
    expect(reasoningTierConfigured({ copilotChatDeployment: 'gpt-4o' })).toBe(false);
    expect(reasoningTierConfigured(null)).toBe(false);
  });
});

describe('WS-1.1 per-cloud default reasoning binding (Commercial + Gov)', () => {
  it('binds the strong tier to the best reasoning model the boundary can serve', () => {
    // Commercial gets the frontier reasoning model; Gov clouds get a Gov-served
    // gpt-5.x (never a Commercial-only model that 404s in *.openai.azure.us).
    expect(bestReasoningModelFor('Commercial')).toBe('gpt-5.6');
    expect(bestReasoningModelFor('GCC-High')).toBe('gpt-5.1');
    expect(bestReasoningModelFor('DoD')).toBe('gpt-5.2');
    // A leaner Gov region still resolves to a Gov-served model, never empty.
    expect(bestReasoningModelFor('GCC-High', 'usgovarizona')).toBe('gpt-5');
  });
  it('defaultTierModelsFor returns a full 3-tier binding per cloud', () => {
    const gov = defaultTierModelsFor('GCC-High');
    expect(gov.strong).toBe('gpt-5.1');
    expect(gov.mini).toBe('gpt-4.1-mini');
    expect(gov.standard).toBeTruthy();
  });
});
