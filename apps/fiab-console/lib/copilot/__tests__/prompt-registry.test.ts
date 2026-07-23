/**
 * N13 — prompt-registry unit tests (semver publish / audited approve / rollback /
 * getActivePrompt) + the pure semver + approval-eligibility layer.
 *
 * Contract under test:
 *   • registerPrompt mints 1.0.0 as a DRAFT and audits the registration;
 *   • publishVersion bumps the semver AND calls the EXISTING E2 evaluator
 *     (triggerEvaluatorRun) — this test asserts the registry reuses WS-E's
 *     harness rather than running a second one;
 *   • attachLatestEvalScore stamps the REAL eval-run rollup + its floor verdict
 *     computed from content/evals/eval-floors.json;
 *   • approveVersion REFUSES an unscored version and a below-floor version, and
 *     writes the {kind:'llmops.prompt.approve'} audit row when it succeeds;
 *   • getActivePrompt only ever serves an APPROVED active version;
 *   • rollbackTo restores an earlier approved version (audited) and refuses a
 *     version that was never approved.
 *
 * Cosmos, the evaluator client, the floors file, and the SIEM stream are mocked;
 * the REAL registry logic + the REAL pure semver layer run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/azure/cosmos-client', () => ({
  promptRegistryContainer: vi.fn(),
  auditLogContainer: vi.fn(),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
vi.mock('@/lib/azure/copilot-evaluator-client', () => ({
  triggerEvaluatorRun: vi.fn(),
  evaluatorRunGate: vi.fn(),
}));
vi.mock('@/lib/azure/copilot-quality-store', () => ({
  surfaceRunHistory: vi.fn(),
  loadEvalFloors: vi.fn(),
}));

import {
  registerPrompt, publishVersion, approveVersion, rollbackTo, getActivePrompt, listPrompts,
  attachLatestEvalScore, listVersions,
} from '@/lib/copilot/prompt-registry';
import { promptRegistryContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { triggerEvaluatorRun, evaluatorRunGate } from '@/lib/azure/copilot-evaluator-client';
import { surfaceRunHistory, loadEvalFloors } from '@/lib/azure/copilot-quality-store';
import {
  bumpSemver, compareSemver, latestVersion, parseSemver, approvalEligibility,
} from '@/lib/azure/prompt-registry-model';

const ACTOR = { oid: 'oid-1', who: 'admin@contoso.com', tenantId: 'tid-1' };

/** In-memory Cosmos container honoring the (id, partitionKey) point-read shape. */
function makeRegistryContainer() {
  const docs = new Map<string, any>();
  return {
    docs,
    item: (id: string, _pk: string) => ({
      read: async () => {
        const resource = docs.get(id);
        if (!resource) {
          const err: any = new Error('NotFound');
          err.code = 404;
          throw err;
        }
        return { resource };
      },
    }),
    items: {
      create: async (doc: any) => { docs.set(doc.id, doc); return { resource: doc }; },
      upsert: async (doc: any) => { docs.set(doc.id, doc); return { resource: doc }; },
      query: (spec: any) => ({
        fetchAll: async () => {
          const q = String(spec?.query || '');
          const all = [...docs.values()];
          if (q.includes("'prompt-version'")) {
            const pid = spec.parameters.find((p: any) => p.name === '@p')?.value;
            return { resources: all.filter((d) => d.docType === 'prompt-version' && d.promptId === pid) };
          }
          return { resources: all.filter((d) => d.docType === 'prompt') };
        },
      }),
    },
  };
}

function makeAuditContainer() {
  const rows: any[] = [];
  return { rows, items: { create: async (r: any) => { rows.push(r); return { resource: r }; } } };
}

const RUN = (over: Partial<Record<string, unknown>> = {}) => ({
  runId: 'run-1',
  finishedAt: '2026-07-23T10:00:00Z',
  totals: {
    questions: 12, retrievalHitRate: 0.9, mrrAvg: 0.8, groundingAvg: 4.3,
    answerAvg: 4.1, passRate: 0.85, judged: 12, deferred: 0, autoFailed: 0,
    ...(over.totals as object ?? {}),
  },
});

let registry: ReturnType<typeof makeRegistryContainer>;
let audit: ReturnType<typeof makeAuditContainer>;

beforeEach(() => {
  vi.clearAllMocks();
  registry = makeRegistryContainer();
  audit = makeAuditContainer();
  vi.mocked(promptRegistryContainer).mockResolvedValue(registry as any);
  vi.mocked(auditLogContainer).mockResolvedValue(audit as any);
  vi.mocked(evaluatorRunGate).mockReturnValue(null);
  vi.mocked(triggerEvaluatorRun).mockResolvedValue({ ok: true, status: 200, body: { ok: true } });
  vi.mocked(surfaceRunHistory).mockResolvedValue([RUN()] as any);
  vi.mocked(loadEvalFloors).mockReturnValue({
    floors: { help: { retrievalHitRate: 0.5, groundingAvg: 3, passRate: 0.4, provisional: true } },
    searchFloors: {}, tierFloors: {},
  } as any);
});

async function seedPrompt() {
  return registerPrompt(
    { promptId: 'help-system', surface: 'help', label: 'Help system prompt', template: 'You are Loom help.' },
    ACTOR,
  );
}

// ── pure semver layer ────────────────────────────────────────────────────────

describe('prompt-registry — pure semver layer', () => {
  it('parses, compares and bumps semvers', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('v1.2.3')).toBeNull();
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
    expect(bumpSemver('1.2.3', 'patch')).toBe('1.2.4');
    expect(bumpSemver('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpSemver('1.2.3', 'major')).toBe('2.0.0');
  });

  it('sorts an unparseable version below every valid one (a corrupt doc can never be "latest")', () => {
    expect(latestVersion(['1.0.0', 'garbage', '1.4.0', '1.3.9'])).toBe('1.4.0');
    expect(latestVersion(['nope'])).toBeNull();
  });

  it('blocks approval with no score, and below-floor without an explicit override', () => {
    expect(approvalEligibility({ status: 'published' }).reason).toBe('no-eval');
    const below = {
      status: 'published' as const,
      evalScore: { surface: 'help', runId: 'r', finishedAt: '', questions: 1, retrievalHitRate: 0.1, groundingAvg: 1, passRate: 0.1, belowFloor: true, belowFloorMetrics: ['passRate'], provisionalFloor: false },
    };
    expect(approvalEligibility(below).reason).toBe('below-floor');
    expect(approvalEligibility(below, { overrideBelowFloor: true }).allowed).toBe(true);
  });
});

// ── register / publish ───────────────────────────────────────────────────────

describe('prompt-registry — register + publish', () => {
  it('registers a prompt at 1.0.0 as a draft and audits it', async () => {
    const { prompt, version } = await seedPrompt();
    expect(prompt.activeVersion).toBeNull();
    expect(version.version).toBe('1.0.0');
    expect(version.status).toBe('draft');
    expect(audit.rows.map((r) => r.kind)).toContain('llmops.prompt.register');
  });

  it('refuses a duplicate promptId (approval history can never be silently overwritten)', async () => {
    await seedPrompt();
    await expect(seedPrompt()).rejects.toThrow(/already registered/i);
  });

  it('publish bumps the semver and hands scoring to the EXISTING E2 evaluator (no second harness)', async () => {
    await seedPrompt();
    const res = await publishVersion('help-system', { template: 'v2 text', bump: 'minor' }, ACTOR);
    expect(res.version.version).toBe('1.1.0');
    expect(res.version.status).toBe('published');
    expect(res.evalRequested).toBe(true);
    // The registry calls WS-E's evaluator client for the prompt's surface —
    // the same trigger E5's "Run now" + the E4 workflow use.
    expect(vi.mocked(triggerEvaluatorRun)).toHaveBeenCalledWith({ surfaces: ['help'], trigger: 'manual' });
    expect(audit.rows.map((r) => r.kind)).toContain('llmops.prompt.publish');
  });

  it('records an HONEST gate (never a fake run) when the evaluator Function is unwired', async () => {
    await seedPrompt();
    vi.mocked(evaluatorRunGate).mockReturnValue({
      gated: true, gateId: 'svc-copilot-evaluator', missing: ['LOOM_COPILOT_EVALUATOR_URL'], remediation: 'Deploy it.',
    } as any);
    const res = await publishVersion('help-system', { template: 'v2' }, ACTOR);
    expect(res.evalRequested).toBe(false);
    expect(res.evalGate?.missing).toContain('LOOM_COPILOT_EVALUATOR_URL');
    expect(vi.mocked(triggerEvaluatorRun)).not.toHaveBeenCalled();
  });

  it('rejects a pinned version that already exists or is not semver', async () => {
    await seedPrompt();
    await expect(publishVersion('help-system', { template: 'x', version: '1.0.0' }, ACTOR)).rejects.toThrow(/already exists/i);
    await expect(publishVersion('help-system', { template: 'x', version: 'nope' }, ACTOR)).rejects.toThrow(/valid semver/i);
  });
});

// ── eval score + approve ─────────────────────────────────────────────────────

describe('prompt-registry — eval score + audited approval', () => {
  it('stamps the REAL eval-run rollup with the floor verdict from eval-floors.json', async () => {
    await seedPrompt();
    await publishVersion('help-system', { template: 'v2', skipEval: true }, ACTOR);
    const score = await attachLatestEvalScore('help-system', '1.1.0');
    expect(score?.runId).toBe('run-1');
    expect(score?.retrievalHitRate).toBe(0.9);
    expect(score?.belowFloor).toBe(false);
    expect(score?.provisionalFloor).toBe(true);
  });

  it('refuses approval while the version has no eval score', async () => {
    await seedPrompt();
    await publishVersion('help-system', { template: 'v2', skipEval: true }, ACTOR);
    vi.mocked(surfaceRunHistory).mockResolvedValue([] as any); // no runs at all
    await expect(approveVersion('help-system', '1.1.0', ACTOR)).rejects.toThrow(/no eval score yet/i);
    const refusal = audit.rows.filter((r) => r.kind === 'llmops.prompt.approve');
    expect(refusal[0].detail.outcome).toBe('refused');
  });

  it('refuses a below-floor version, and allows it with an explicit (audited) override', async () => {
    await seedPrompt();
    await publishVersion('help-system', { template: 'v2', skipEval: true }, ACTOR);
    vi.mocked(surfaceRunHistory).mockResolvedValue([
      RUN({ totals: { questions: 12, retrievalHitRate: 0.2, mrrAvg: 0.1, groundingAvg: 2, answerAvg: 2, passRate: 0.1, judged: 12, deferred: 0, autoFailed: 0 } }),
    ] as any);
    await expect(approveVersion('help-system', '1.1.0', ACTOR)).rejects.toThrow(/below the help floor/i);

    const ok = await approveVersion('help-system', '1.1.0', ACTOR, { overrideBelowFloor: true, note: 'known-good copy fix' });
    expect(ok.version.status).toBe('approved');
    expect(ok.version.approval?.overrodeFloor).toBe(true);
    const approved = audit.rows.filter((r) => r.kind === 'llmops.prompt.approve' && r.detail.outcome === 'approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].detail.overrodeFloor).toBe(true);
    expect(approved[0].itemId).toBe('llmops-prompt:help-system');
  });

  it('approves a clean version, makes it active, and getActivePrompt serves it', async () => {
    await seedPrompt();
    await publishVersion('help-system', { template: 'v2 text', skipEval: true }, ACTOR);
    // Before approval there is no active version — a draft is NEVER served.
    expect(await getActivePrompt('help-system')).toBeNull();

    await approveVersion('help-system', '1.1.0', ACTOR, { note: 'looks good' });
    const active = await getActivePrompt('help-system');
    expect(active?.version.version).toBe('1.1.0');
    expect(active?.version.template).toBe('v2 text');
    expect(active?.version.approval?.approvedBy).toBe('admin@contoso.com');

    const summaries = await listPrompts();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].activeVersion).toBe('1.1.0');
    expect(summaries[0].pendingApproval).toBe(false);
  });
});

// ── rollback ─────────────────────────────────────────────────────────────────

describe('prompt-registry — rollback', () => {
  it('restores an earlier APPROVED version, marks the one it left, and audits it', async () => {
    await seedPrompt();
    await publishVersion('help-system', { template: 'v1.1', skipEval: true }, ACTOR);
    await approveVersion('help-system', '1.1.0', ACTOR);
    await publishVersion('help-system', { template: 'v1.2 (regressed)', skipEval: true }, ACTOR);
    await approveVersion('help-system', '1.2.0', ACTOR);
    expect((await getActivePrompt('help-system'))?.version.version).toBe('1.2.0');

    const rolled = await rollbackTo('help-system', '1.1.0', ACTOR, { reason: 'answers regressed live' });
    expect(rolled.prompt.activeVersion).toBe('1.1.0');
    expect((await getActivePrompt('help-system'))?.version.template).toBe('v1.1');
    const versions = await listVersions('help-system');
    expect(versions.find((v) => v.version === '1.2.0')?.status).toBe('rolled-back');
    expect(audit.rows.map((r) => r.kind)).toContain('llmops.prompt.rollback');
  });

  it('refuses to roll back to a version that was never approved', async () => {
    await seedPrompt();
    await publishVersion('help-system', { template: 'never reviewed', skipEval: true }, ACTOR);
    await expect(rollbackTo('help-system', '1.1.0', ACTOR)).rejects.toThrow(/never approved/i);
  });
});
