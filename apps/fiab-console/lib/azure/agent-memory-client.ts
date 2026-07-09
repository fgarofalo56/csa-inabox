/**
 * Durable cross-session agent memory + per-agent thread persistence (AIF-14).
 *
 * Backed by the Cosmos `loom-agent-memory` container (PK `/agentId`, NO TTL).
 * Two doc kinds share the container:
 *
 *   • `docType:'thread'`  — a completed run's transcript (question + answer +
 *     steps), so the Agents playground can LIST past threads and RESUME one.
 *     Retained until the per-agent+user retention cap evicts the oldest.
 *   • `docType:'memory'`  — a durable fact/preference an agent recalls across
 *     unrelated threads (Foundry managed-memory parity). Extracted from a
 *     completed run via a single AOAI summarize call and injected (top-K) into
 *     the agent's instructions before the next run.
 *
 * All backends are Cosmos + AOAI — Gov-native, no Fabric/Power BI dependency.
 */
import type { Container } from '@azure/cosmos';
import { agentMemoryContainer } from './cosmos-client';
import { aoaiChatJson } from './aoai-chat-client';
import { normalizeUsage, runLatencyMs, type NormalizedUsage } from '@/lib/foundry/agentops';
import { estCostUsd } from '@/lib/copilot/cost-estimate';

// Caps read per-call (not at module load) so an admin env change takes effect
// without a restart and so they are unit-testable.
const intEnv = (name: string, def: number) => Math.max(1, parseInt(process.env[name] || String(def), 10) || def);
const threadCap = () => intEnv('LOOM_AGENT_THREAD_CAP', 50);
const memoryCap = () => intEnv('LOOM_AGENT_MEMORY_CAP', 200);
const memoryTopK = () => intEnv('LOOM_AGENT_MEMORY_TOPK', 8);

/** A persisted run transcript for the resume UI + AgentOps rollup (AIF-13). */
export interface AgentThreadRecord {
  id: string;              // `thread:<threadId>`
  agentId: string;         // PK
  docType: 'thread';
  userOid: string;
  threadId: string;
  runId?: string;
  status: string;
  tier?: string;           // 'maf' | 'foundry-agent-service'
  question: string;
  answer: string;
  steps?: unknown[];
  createdAt: string;
  // ── AgentOps metrics (AIF-13) — real token counts; cost is an estimate. ──
  model?: string;
  usage?: NormalizedUsage;
  costUsd?: number;
  latencyMs?: number;
}

/** A durable memory fact an agent recalls across threads. */
export interface AgentMemoryRecord {
  id: string;              // `mem:<uuid>`
  agentId: string;         // PK
  docType: 'memory';
  userOid: string;
  fact: string;
  sourceThreadId?: string;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Threads ───────────────────────────────────────────────────────────────────

export interface SaveThreadInput {
  agentId: string;
  userOid: string;
  threadId: string;
  runId?: string;
  status: string;
  tier?: string;
  question: string;
  answer: string;
  steps?: unknown[];
  /** AgentOps (AIF-13): the run's model + raw usage for cost/latency rollup. */
  model?: string;
  usage?: Record<string, unknown> | null;
}

/**
 * Persist a completed run as a resumable thread, then prune the oldest beyond
 * the per-agent+user retention cap. Best-effort: never throws into the run path
 * (a memory-store hiccup must not fail the agent run itself).
 */
export async function saveThread(input: SaveThreadInput): Promise<AgentThreadRecord | null> {
  try {
    const c = await agentMemoryContainer();
    // AgentOps metrics (AIF-13): real token counts from the run's usage; cost is
    // an ESTIMATE (rel-T85 list price); latency is derived from the step spans.
    const usage = normalizeUsage(input.usage);
    const model = input.model || '';
    const steps = Array.isArray(input.steps) ? (input.steps as { createdAt?: number; completedAt?: number }[]) : [];
    const rec: AgentThreadRecord = {
      id: `thread:${input.threadId}`,
      agentId: input.agentId,
      docType: 'thread',
      userOid: input.userOid,
      threadId: input.threadId,
      runId: input.runId,
      status: input.status,
      tier: input.tier,
      question: input.question,
      answer: input.answer,
      steps: input.steps,
      createdAt: nowIso(),
      model: model || undefined,
      usage,
      costUsd: estCostUsd(model, usage.promptTokens, usage.completionTokens),
      latencyMs: runLatencyMs(steps),
    };
    await c.items.upsert(rec);
    await pruneThreads(c, input.agentId, input.userOid);
    return rec;
  } catch {
    return null;
  }
}

/** List a user's threads for an agent, newest first (capped). */
export async function listThreads(
  agentId: string,
  userOid: string,
  limit = threadCap(),
): Promise<AgentThreadRecord[]> {
  const c = await agentMemoryContainer();
  const { resources } = await c.items
    .query<AgentThreadRecord>({
      query:
        "SELECT * FROM c WHERE c.agentId = @a AND c.userOid = @u AND c.docType = 'thread' " +
        'ORDER BY c.createdAt DESC OFFSET 0 LIMIT @n',
      parameters: [
        { name: '@a', value: agentId },
        { name: '@u', value: userOid },
        { name: '@n', value: Math.max(1, limit) },
      ],
    })
    .fetchAll();
  return resources;
}

/** Fetch one persisted thread (single-partition point read via query). */
export async function getThread(
  agentId: string,
  userOid: string,
  threadId: string,
): Promise<AgentThreadRecord | null> {
  const c = await agentMemoryContainer();
  try {
    const { resource } = await c.item(`thread:${threadId}`, agentId).read<AgentThreadRecord>();
    if (!resource || resource.userOid !== userOid || resource.docType !== 'thread') return null;
    return resource;
  } catch {
    return null;
  }
}

/** Delete one persisted thread (owner-scoped). */
export async function deleteThread(
  agentId: string,
  userOid: string,
  threadId: string,
): Promise<boolean> {
  const existing = await getThread(agentId, userOid, threadId);
  if (!existing) return false;
  const c = await agentMemoryContainer();
  await c.item(`thread:${threadId}`, agentId).delete();
  return true;
}

/** Evict oldest thread docs beyond THREAD_CAP for one agent+user. */
async function pruneThreads(c: Container, agentId: string, userOid: string): Promise<void> {
  try {
    const { resources } = await c.items
      .query<{ id: string }>({
        query:
          "SELECT c.id FROM c WHERE c.agentId = @a AND c.userOid = @u AND c.docType = 'thread' " +
          'ORDER BY c.createdAt DESC OFFSET @cap LIMIT 1000',
        parameters: [
          { name: '@a', value: agentId },
          { name: '@u', value: userOid },
          { name: '@cap', value: threadCap() },
        ],
      })
      .fetchAll();
    for (const r of resources) {
      await c.item(r.id, agentId).delete().catch(() => undefined);
    }
  } catch {
    /* prune is best-effort */
  }
}

// ── Durable memory facts ────────────────────────────────────────────────────

/** Retrieve the top-K most recent memory facts for an agent+user. */
export async function retrieveMemories(
  agentId: string,
  userOid: string,
  topK = memoryTopK(),
): Promise<AgentMemoryRecord[]> {
  try {
    const c = await agentMemoryContainer();
    const { resources } = await c.items
      .query<AgentMemoryRecord>({
        query:
          "SELECT * FROM c WHERE c.agentId = @a AND c.userOid = @u AND c.docType = 'memory' " +
          'ORDER BY c.createdAt DESC OFFSET 0 LIMIT @n',
        parameters: [
          { name: '@a', value: agentId },
          { name: '@u', value: userOid },
          { name: '@n', value: Math.max(1, topK) },
        ],
      })
      .fetchAll();
    return resources;
  } catch {
    return [];
  }
}

/**
 * Render a memory block for prepending to an agent's instructions. Empty string
 * when there are no memories (so the caller adds nothing).
 */
export function memoryPreamble(memories: AgentMemoryRecord[]): string {
  if (!memories.length) return '';
  const lines = memories.map((m) => `- ${m.fact}`).join('\n');
  return (
    'Durable memory — facts and preferences you have learned about this user across ' +
    `previous sessions. Use them when relevant:\n${lines}\n`
  );
}

/**
 * Summarize a completed run into 1-5 durable memory facts and persist them.
 * Best-effort (never throws into the run path). Skips storage when the model
 * decides there is nothing memorable (returns an empty facts array).
 */
export async function extractAndStoreMemory(input: {
  agentId: string;
  userOid: string;
  question: string;
  answer: string;
  sourceThreadId?: string;
}): Promise<AgentMemoryRecord[]> {
  const { agentId, userOid, question, answer } = input;
  if (!question.trim() || !answer.trim()) return [];
  try {
    const parsed = await aoaiChatJson<{ facts?: string[] }>({
      maxCompletionTokens: 512,
      messages: [
        {
          role: 'system',
          content:
            'You extract DURABLE facts and stable preferences worth remembering about a user ' +
            'across future, unrelated conversations with an AI agent. Return STRICT JSON ' +
            '{"facts": string[]} with 0-5 concise, self-contained facts (each < 160 chars). ' +
            'Include only durable information (names, roles, stable preferences, standing ' +
            'constraints, recurring entities). EXCLUDE one-off task details, transient values, ' +
            'greetings, or anything already obvious. Return {"facts": []} when nothing is durable.',
        },
        { role: 'user', content: `User said:\n${question}\n\nAgent replied:\n${answer}` },
      ],
    });
    const facts = Array.isArray(parsed?.facts)
      ? parsed.facts.map((f) => String(f || '').trim()).filter((f) => f.length > 0 && f.length <= 200).slice(0, 5)
      : [];
    if (!facts.length) return [];

    const c = await agentMemoryContainer();
    const stored: AgentMemoryRecord[] = [];
    for (const fact of facts) {
      const rec: AgentMemoryRecord = {
        id: `mem:${crypto.randomUUID()}`,
        agentId,
        docType: 'memory',
        userOid,
        fact,
        sourceThreadId: input.sourceThreadId,
        createdAt: nowIso(),
      };
      await c.items.create(rec);
      stored.push(rec);
    }
    await pruneMemories(c, agentId, userOid);
    return stored;
  } catch {
    return [];
  }
}

/** Evict oldest memory docs beyond MEMORY_CAP for one agent+user. */
async function pruneMemories(c: Container, agentId: string, userOid: string): Promise<void> {
  try {
    const { resources } = await c.items
      .query<{ id: string }>({
        query:
          "SELECT c.id FROM c WHERE c.agentId = @a AND c.userOid = @u AND c.docType = 'memory' " +
          'ORDER BY c.createdAt DESC OFFSET @cap LIMIT 1000',
        parameters: [
          { name: '@a', value: agentId },
          { name: '@u', value: userOid },
          { name: '@cap', value: memoryCap() },
        ],
      })
      .fetchAll();
    for (const r of resources) {
      await c.item(r.id, agentId).delete().catch(() => undefined);
    }
  } catch {
    /* prune is best-effort */
  }
}

// ── Eval runs (AIF-13) ──────────────────────────────────────────────────────
//
// A stored evaluation of an agent against a prompt-set: each prompt was run
// through the agent, then an AOAI judge scored the answer 1-5. Shares the
// loom-agent-memory container (PK /agentId, docType:'eval') — no new resource.
const evalCap = () => intEnv('LOOM_AGENT_EVAL_CAP', 50);

export interface AgentEvalResultRow {
  prompt: string;
  criteria?: string;
  answer: string;
  /** 1-5 (0 when the run/judge failed). */
  score: number;
  rationale?: string;
  status: string;
}

export interface AgentEvalRecord {
  id: string;              // `eval:<uuid>`
  agentId: string;         // PK
  docType: 'eval';
  userOid: string;
  name: string;
  model?: string;
  results: AgentEvalResultRow[];
  /** Mean score across scored rows (0..5). */
  avgScore: number;
  passRate: number;        // rows with score >= passThreshold / total, 0..1
  passThreshold: number;
  createdAt: string;
}

export interface SaveEvalInput {
  agentId: string;
  userOid: string;
  name: string;
  model?: string;
  results: AgentEvalResultRow[];
  avgScore: number;
  passRate: number;
  passThreshold: number;
}

/** Persist a completed eval run, then prune the oldest beyond the cap. */
export async function saveEvalRun(input: SaveEvalInput): Promise<AgentEvalRecord> {
  const c = await agentMemoryContainer();
  const rec: AgentEvalRecord = {
    id: `eval:${crypto.randomUUID()}`,
    agentId: input.agentId,
    docType: 'eval',
    userOid: input.userOid,
    name: input.name,
    model: input.model,
    results: input.results,
    avgScore: input.avgScore,
    passRate: input.passRate,
    passThreshold: input.passThreshold,
    createdAt: nowIso(),
  };
  await c.items.create(rec);
  await pruneEvals(c, input.agentId, input.userOid);
  return rec;
}

/** List a user's stored eval runs for an agent, newest first (capped). */
export async function listEvalRuns(agentId: string, userOid: string, limit = evalCap()): Promise<AgentEvalRecord[]> {
  const c = await agentMemoryContainer();
  const { resources } = await c.items
    .query<AgentEvalRecord>({
      query:
        "SELECT * FROM c WHERE c.agentId = @a AND c.userOid = @u AND c.docType = 'eval' " +
        'ORDER BY c.createdAt DESC OFFSET 0 LIMIT @n',
      parameters: [
        { name: '@a', value: agentId },
        { name: '@u', value: userOid },
        { name: '@n', value: Math.max(1, limit) },
      ],
    })
    .fetchAll();
  return resources;
}

async function pruneEvals(c: Container, agentId: string, userOid: string): Promise<void> {
  try {
    const { resources } = await c.items
      .query<{ id: string }>({
        query:
          "SELECT c.id FROM c WHERE c.agentId = @a AND c.userOid = @u AND c.docType = 'eval' " +
          'ORDER BY c.createdAt DESC OFFSET @cap LIMIT 1000',
        parameters: [
          { name: '@a', value: agentId },
          { name: '@u', value: userOid },
          { name: '@cap', value: evalCap() },
        ],
      })
      .fetchAll();
    for (const r of resources) {
      await c.item(r.id, agentId).delete().catch(() => undefined);
    }
  } catch {
    /* prune is best-effort */
  }
}
