/**
 * CTS-06 — "Dump conversation to long-term memory", persisted through the CTS-08
 * brain and the CTS-12 write guard.
 *
 * `flushConversationToMemory` folds the recent visible turns into one
 * {question, answer} pair, prompts AOAI (the unified aoai-chat-client) to extract
 * a TYPED fact array ({content, category, confidence, tags}), and persists each
 * through `createMemory` — so every extracted fact is injection-scanned, secret-
 * redacted, and scope-enforced before it lands, and the flush is logged. A later
 * session recalls these via getLayeredContext (CTS-08), proving cross-session
 * memory.
 *
 * Real backend: AOAI extraction + Cosmos `copilot-memory` + the AI Search vector
 * mirror. No Fabric / Power BI. The AOAI extraction call is pre-gated by the route
 * (resolveAoaiTarget) so a missing deployment surfaces as an honest 503.
 */

import { aoaiChatJson } from './aoai-chat-client';
import { createMemory, logFlush } from './memory-store';
import type { MemoryActor, MemoryCandidate, MemoryCategory } from '@/lib/copilot/memory-types';

const VALID_CATEGORIES: ReadonlySet<string> = new Set(['identity', 'preference', 'fact', 'decision', 'context']);

interface ExtractedFact {
  content?: string;
  category?: string;
  confidence?: number;
  tags?: string[];
}

/** Coerce a raw model fact into a validated MemoryCandidate (or null to drop). */
export function toCandidate(raw: ExtractedFact, source: MemoryCandidate['source']): MemoryCandidate | null {
  const content = String(raw?.content || '').trim();
  if (!content || content.length > 600) return null;
  const category: MemoryCategory = VALID_CATEGORIES.has(String(raw?.category))
    ? (raw!.category as MemoryCategory)
    : 'fact';
  const confidence = typeof raw?.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.7;
  const tags = Array.isArray(raw?.tags)
    ? raw!.tags!.map((t) => String(t || '').trim()).filter((t) => t.length > 0 && t.length <= 40).slice(0, 8)
    : [];
  return { content, category, confidence, tags, source };
}

export interface FlushResult {
  stored: number;
  rejected: number;
  facts: string[];
}

/**
 * Extract durable facts from a folded {question, answer} and persist each through
 * the guarded store. Returns the stored facts + counts. Best-effort on the AOAI
 * call (an extraction failure yields zero stored, never throws), but each store
 * write's guard verdict is authoritative.
 */
export async function flushConversationToMemory(input: {
  actor: MemoryActor;
  question: string;
  answer: string;
  sessionId?: string;
}): Promise<FlushResult> {
  const { actor, question, answer } = input;
  if (!question.trim() && !answer.trim()) return { stored: 0, rejected: 0, facts: [] };

  let parsed: { facts?: ExtractedFact[] } = {};
  try {
    parsed = await aoaiChatJson<{ facts?: ExtractedFact[] }>({
      maxCompletionTokens: 700,
      messages: [
        {
          role: 'system',
          content:
            'You extract DURABLE facts and stable preferences worth remembering about a user across ' +
            'future, unrelated conversations. Return STRICT JSON {"facts": [{"content": string, ' +
            '"category": "identity"|"preference"|"fact"|"decision"|"context", "confidence": number, ' +
            '"tags": string[]}]} with 0-6 concise, self-contained facts (each < 200 chars). Use ' +
            '"identity" for stable identity (name/role/org), "preference" for standing preferences, ' +
            '"decision" for choices made, "context" for recurring entities, else "fact". confidence is ' +
            '0..1. NEVER include secrets, credentials, or one-off/transient task values. Return ' +
            '{"facts": []} when nothing is durable.',
        },
        { role: 'user', content: `User said:\n${question}\n\nAssistant replied:\n${answer}` },
      ],
    });
  } catch {
    parsed = {};
  }

  const candidates = Array.isArray(parsed?.facts)
    ? parsed.facts.map((f) => toCandidate(f, 'flush')).filter((c): c is MemoryCandidate => c !== null).slice(0, 6)
    : [];

  const facts: string[] = [];
  let stored = 0;
  let rejected = 0;
  for (const cand of candidates) {
    const res = await createMemory(cand, actor);
    if (res.ok && res.record) {
      stored += 1;
      facts.push(res.record.content);
    } else {
      rejected += 1;
    }
  }

  await logFlush({
    scopeKey: `user:${actor.userOid}`,
    sessionId: input.sessionId,
    candidates: candidates.length,
    stored,
    rejected,
    actorOid: actor.userOid,
  });

  return { stored, rejected, facts };
}
