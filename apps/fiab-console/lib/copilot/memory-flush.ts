/**
 * memory-flush — PURE logic behind POST /api/copilot/memory/flush (CTS-06).
 *
 * "Dump conversation to long-term memory": takes the recent visible turns of a
 * Copilot conversation and folds them into a single {question, answer} pair that
 * the AIF-14 agent-memory extractor (extractAndStoreMemory) summarizes into 0-5
 * durable facts persisted to the Cosmos `loom-agent-memory` container. Kept free
 * of Next/Azure imports so it is unit-testable.
 *
 * Real backend, no new infra: reuses the existing agent-memory Cosmos container.
 * Default-ON / opt-out kill-switch: LOOM_COPILOT_MEMORY (falsy → disabled).
 */

export interface FlushMessage {
  role: string;
  content: string;
}

/** The stable "agent" bucket that the cross-item Copilot's user memory lives in. */
export function copilotMemoryAgentId(): string {
  return (process.env.LOOM_COPILOT_MEMORY_AGENT_ID || 'loom-copilot').trim() || 'loom-copilot';
}

/** Max recent messages folded into one flush (admin-tunable). */
export function flushWindow(): number {
  const n = parseInt(process.env.LOOM_COPILOT_MEMORY_FLUSH_N || '20', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20;
}

/**
 * The default-ON / opt-out kill-switch. Memory flush is ENABLED unless an admin
 * sets LOOM_COPILOT_MEMORY to an explicit falsy value (0 / false / off / no).
 */
export function isCopilotMemoryEnabled(): boolean {
  const v = (process.env.LOOM_COPILOT_MEMORY || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Fold the last `maxN` messages into a single {question, answer} the extractor
 * can summarize: user/human turns → question, assistant/agent turns → answer.
 * Returns null when there is nothing usable (no user or no assistant text).
 */
export function splitConversation(
  messages: unknown,
  maxN: number,
): { question: string; answer: string } | null {
  if (!Array.isArray(messages)) return null;
  const clean: FlushMessage[] = messages
    .map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      const role = typeof o.role === 'string' ? o.role.trim().toLowerCase() : '';
      const content = typeof o.content === 'string' ? o.content.trim() : '';
      return { role, content };
    })
    .filter((m) => m.content.length > 0)
    .slice(-Math.max(1, maxN));

  const userText = clean
    .filter((m) => m.role === 'user' || m.role === 'human')
    .map((m) => m.content)
    .join('\n\n')
    .slice(0, 8000);
  const answerText = clean
    .filter((m) => m.role === 'assistant' || m.role === 'agent' || m.role === 'ai')
    .map((m) => m.content)
    .join('\n\n')
    .slice(0, 8000);

  if (!userText && !answerText) return null;
  // extractAndStoreMemory requires both sides non-empty; supply a neutral
  // placeholder for a missing side so a one-sided conversation still flushes.
  return {
    question: userText || '(no user messages captured)',
    answer: answerText || '(no assistant messages captured)',
  };
}
