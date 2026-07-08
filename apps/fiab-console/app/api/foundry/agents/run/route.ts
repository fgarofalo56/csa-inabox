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
 * Default-on; opt out with LOOM_AGENT_MEMORY_ENABLED=false.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const memoryEnabled = () => (process.env.LOOM_AGENT_MEMORY_ENABLED || '').toLowerCase() !== 'false';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
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
    if (memoryEnabled()) {
      const preamble = memoryPreamble(await retrieveMemories(agent, userOid));
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
    if (memoryEnabled() && inspection?.threadId) {
      await saveThread({
        agentId: agent, userOid, threadId: inspection.threadId, runId: inspection.runId,
        status: inspection.status, tier, question, answer: inspection.answer || '',
        steps: inspection.steps,
      });
      if (inspection.status === 'completed' && inspection.answer) {
        await extractAndStoreMemory({
          agentId: agent, userOid, question, answer: inspection.answer,
          sourceThreadId: inspection.threadId,
        });
      }
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
}
