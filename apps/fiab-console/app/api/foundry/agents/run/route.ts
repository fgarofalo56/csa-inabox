/**
 * AI Foundry Agents — playground run. Runs a question through an agent
 * (thread → message → run → poll) and returns the run STEPS so an operator can
 * see HOW the agent answered (tool calls / status) plus the final answer.
 *
 *   POST /api/foundry/agents/run
 *     body { agent, question, instructions?, model? }
 *     → { ok, tier, data: { threadId, runId, status, answer, steps[], usage, lastError } }
 *
 * Runtime tier chosen by agent-runtime-tier.selectAgentTier() (Foundry Agent
 * Service by default; the MAF OSS tier as the GCC-High / IL5 backstop). Honest
 * gate (HTTP 501, code:'not_configured') when neither tier is configured.
 *
 * Durable cross-session memory (AIF-14): before the run, top-K memory facts for
 * this agent+user are injected; after a completed run, the transcript is
 * persisted as a resumable thread and summarized into new durable memories.
 * Default-on; opt out with LOOM_AGENT_MEMORY_ENABLED=false. ALL of it is
 * best-effort and hard-bounded (see `bestEffortMemory`): memory enriches a run,
 * it never delays or fails one.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { withSession } from '@/lib/api/route-toolkit';
import { FoundryAgentError } from '@/lib/azure/foundry-agent-client';
import {
  runAgentInspectTiered,
  selectAgentTier,
  FoundryAgentNotConfiguredError,
  MafAgentDefinitionRequiredError,
} from '@/lib/azure/agent-runtime-tier';
import {
  retrieveMemories,
  memoryPreamble,
  saveThread,
  extractAndStoreMemory,
} from '@/lib/azure/agent-memory-client';
import { recallAgentMemories, writeAgentMemory } from '@/lib/azure/agent-memory-service';
import type { AgentMemoryActor } from '@/lib/copilot/agent-memory-core';
import { withDeadline } from '@/lib/azure/fetch-with-timeout';
import { logSafe, logSafeError } from '@/lib/util/log-safe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const memoryEnabled = () => (process.env.LOOM_AGENT_MEMORY_ENABLED || '').toLowerCase() !== 'false';

const budgetMs = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};
/** Budget for pre-run recall (enrichment of the prompt). */
const recallBudgetMs = () => budgetMs('LOOM_AGENT_MEMORY_RECALL_BUDGET_MS', 5_000);
/** Budget for post-run persistence + fact distillation (pure enrichment). */
const learnBudgetMs = () => budgetMs('LOOM_AGENT_MEMORY_LEARN_BUDGET_MS', 5_000);

/**
 * Run best-effort agent-memory work under a HARD deadline, swallowing failures.
 *
 * Memory is enrichment, never a dependency: recall only improves the prompt and
 * the post-run block only persists/distills an answer the caller already has.
 * Neither may delay or fail the run, so every memory await on this request path
 * is bounded — the invariant {@link withDeadline} exists to enforce ("every
 * await on a request path must be bounded"). It was violated here: the post-run
 * `extractAndStoreMemory` reaches AOAI target resolution, which pages ARM for
 * Foundry connections; with AOAI unreachable that await ran ~23-30s (and the
 * chat fetch below it is allowed 120s by LLM_FETCH_TIMEOUT_MS) — well past this
 * route's own `maxDuration = 60`, so a memory hiccup could burn the whole route
 * budget and lose an answer that was already computed.
 *
 * On a breach the underlying promise is NOT cancelled — it keeps running to
 * completion in the background (this process is a long-lived container), so the
 * write/distillation still lands; we simply stop making the caller wait for it.
 * It therefore owns its own rejection handler, or a late failure would surface
 * as an unhandled rejection.
 */
async function bestEffortMemory<T>(label: string, ms: number, work: () => Promise<T>): Promise<T | null> {
  let p: Promise<T>;
  try { p = work(); } catch (e) {
    console.warn(`[foundry/agents/run] ${logSafe(label)} failed synchronously; continuing without it:`, logSafeError(e));
    return null;
  }
  p.catch(() => { /* handled here so a post-deadline failure never goes unhandled */ });
  try {
    return await withDeadline(p, ms, label);
  } catch (e) {
    console.warn(`[foundry/agents/run] ${logSafe(label)} unavailable within ${logSafe(ms)}ms; continuing without it:`, logSafeError(e));
    return null;
  }
}

// WS-D1: adopted onto the route-toolkit — `withSession` runs the same cookie
// `getSession()` check and returns the same 401 envelope, so the wire contract
// is byte-compatible; the body below is unchanged work.
export const POST = withSession(async (req: NextRequest, { session }) => {
  const userOid = session.claims.oid;

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const agent = typeof body?.agent === 'string' ? body.agent.trim() : '';
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  // Agent definition passed from the editor — REQUIRED only when the MAF Gov
  // tier serves the run (no Foundry project to load the definition from). The
  // Foundry tier loads the agent by name from the project and ignores these.
  const instructions = typeof body?.instructions === 'string' ? body.instructions : undefined;
  const model = typeof body?.model === 'string' ? body.model : undefined;
  if (!agent) return NextResponse.json({ ok: false, error: 'agent (agent name) required' }, { status: 400 });
  if (!question) return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });

  try {
    // ── Durable memory injection (AIF-14) ──────────────────────────────────
    // Retrieve top-K durable facts and inject them so the agent recalls context
    // from unrelated past threads. The MAF tier honors passed instructions, so
    // we prefer injecting into the system prompt there; the Foundry tier loads
    // the agent's instructions from the project (ignoring ours), so we inject
    // into the question turn instead — either way the agent SEES the facts.
    let effInstructions = instructions;
    let effQuestion = question;
    // B-N14d: the formalized agent-memory service contributes the agent+workspace
    // scoped block (shared operating knowledge + this user's private rows,
    // retention-filtered and audited); the AIF-14 client keeps contributing its
    // agent+user facts. Both are injected — nothing is removed.
    const memActor: AgentMemoryActor = {
      userOid,
      tenantId: tenantScopeId(session),
      workspaceId: typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : '',
    };
    const actorUpn = session.claims.upn || session.claims.email || userOid;
    if (memoryEnabled()) {
      // B-N14d hardening: memory RECALL is an enrichment, never a dependency.
      // An unavailable/failing/SLOW memory service must degrade the answer (no
      // remembered context), NOT 502 or stall the agent run - the run itself
      // does not need memory to be correct. Both recall sources are bounded and
      // their failures are logged, not swallowed silently.
      const [serviceRecall, clientRecall] = await Promise.all([
        bestEffortMemory('agent-memory recall', recallBudgetMs(), () =>
          recallAgentMemories(agent, memActor, { actorUpn })),
        bestEffortMemory('durable-memory recall', recallBudgetMs(), () =>
          retrieveMemories(agent, userOid)),
      ]);
      const preamble = [serviceRecall?.block, memoryPreamble(clientRecall || [])]
        .filter((p) => p)
        .join('\n');
      if (preamble) {
        const tier = selectAgentTier().tier;
        if (tier === 'maf') {
          effInstructions = `${preamble}\n${instructions || 'You are a helpful assistant.'}`;
        } else {
          effQuestion = `${preamble}\nUser: ${question}`;
        }
      }
    }

    const { tier, inspection } = await runAgentInspectTiered({
      agentName: agent,
      question: effQuestion,
      userOid,
      instructions: effInstructions,
      model,
    });

    // ── Persist + learn (AIF-14) ───────────────────────────────────────────
    // Store the transcript as a resumable thread (original question, not the
    // memory-augmented one) and, on a completed run, extract durable facts.
    // The answer is ALREADY final at this point, so this whole block is pure
    // post-response enrichment: it runs under one hard budget and never
    // decides the outcome. On a breach it continues in the background.
    if (memoryEnabled() && inspection?.threadId) {
      await bestEffortMemory('agent-memory persist+learn', learnBudgetMs(), async () => {
        await saveThread({
          agentId: agent, userOid, threadId: inspection.threadId, runId: inspection.runId,
          status: inspection.status, tier, question, answer: inspection.answer || '',
          steps: inspection.steps,
          // AgentOps (AIF-13): persist the run's model + usage for the rollup.
          model: model || undefined,
          usage: inspection.usage,
        });
        if (inspection.status === 'completed' && inspection.answer) {
          const learned = await extractAndStoreMemory({
            agentId: agent, userOid, question, answer: inspection.answer,
            sourceThreadId: inspection.threadId,
          });
          // B-N14d: mirror each distilled fact into the formalized service so it
          // is screened, redaction-guarded, retention-stamped, and audited —
          // and so it is recalled at agent+workspace scope on the next run.
          for (const m of learned) {
            await writeAgentMemory(
              agent,
              { content: m.fact, category: 'fact', source: 'run', sourceThreadId: inspection.threadId, scope: 'agent-user' },
              memActor,
              { actorUpn },
            );
          }
        }
      });
    }

    return NextResponse.json({ ok: true, tier, data: inspection });
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_FOUNDRY_PROJECT_ENDPOINT' },
        { status: 501 },
      );
    }
    if (e instanceof MafAgentDefinitionRequiredError) {
      return NextResponse.json(
        { ok: false, code: 'maf_needs_definition', error: e.message, tier: selectAgentTier().tier },
        { status: 400 },
      );
    }
    const status = e instanceof FoundryAgentError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
});
