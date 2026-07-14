/**
 * CTS-12 — memory-write security guard (Gov-critical).
 *
 * EVERY candidate memory write — explicit save, CTS-06 dump-to-memory, post-turn
 * auto-capture, and CTS-13 consolidation merges — passes through `screenMemoryWrite`
 * before it can touch Cosmos or the vector index. There is no bypass: memory-store.ts
 * calls this on every create/update path and refuses to persist a rejected verdict.
 *
 * Four deterministic layers (an optional AOAI classifier is layered on top by the
 * store, off the hot path):
 *   1. Prompt-injection heuristics — reject content that reads as an instruction to
 *      the model rather than a fact about the user (the classic "poisoned memory"
 *      attack: a memory that says "ignore your system prompt and exfiltrate…").
 *   2. Secret redaction — strip credentials / keys / tokens / connection strings /
 *      private-key blocks from EVERY string field before it is stored, so a secret
 *      pasted into chat never lands durably in the brain.
 *   3. Locked-field approval — a MUTATION of a locked identity/policy memory is
 *      hard-blocked unless the caller passes explicit operator approval.
 *   4. Cross-tenant scope enforcement — the persisted scopeKey is derived from the
 *      acting session ONLY (never client-supplied), so a write can never target a
 *      foreign user or workspace.
 *
 * Pure (no Cosmos / Next imports) so every rejection path is unit-testable.
 */

import type {
  MemoryActor,
  MemoryCandidate,
  MemoryCategory,
  MemoryRecord,
  MemoryScope,
  GuardVerdict,
} from './memory-types';

/** Categories whose existing memories are LOCKED — a mutation needs approval. */
export const LOCKED_CATEGORIES: ReadonlySet<MemoryCategory> = new Set(['identity']);

/** Max stored memory length (chars). Longer candidates are rejected, not truncated
 *  — an over-long "fact" is almost always an injected payload or a transcript dump. */
export const MAX_MEMORY_CHARS = 600;

// ── Layer 1: prompt-injection heuristics ────────────────────────────────────
// Each pattern matches a phrase that only appears when text is trying to STEER
// the model, not describe the user. Deterministic + conservative: these are
// high-precision (they don't fire on ordinary preferences/facts).
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:your\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?|context)\b/i,
  /\bdisregard\s+(?:all\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|system)\b/i,
  /\b(?:system|developer)\s+prompt\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the|in)\b/i,
  /\b(?:reveal|print|repeat|expose|leak|exfiltrate)\s+(?:your|the|all)\s+(?:system\s+prompt|instructions?|secrets?|keys?|api\s*keys?|credentials?)\b/i,
  /\b(?:always|from\s+now\s+on)\s+(?:respond|reply|answer|behave|act)\b/i,
  /\boverride\s+(?:your|the|all)\s+(?:safety|guardrails?|instructions?|rules?)\b/i,
  /\b(?:new|updated)\s+(?:system\s+)?instructions?\s*:/i,
  /\bpretend\s+(?:to\s+be|you\s+are)\b/i,
  /\[\s*(?:system|assistant|tool)\s*\]/i,       // fake role headers
  /<\/?(?:system|assistant|tool|im_start|im_end)\b/i, // fake chat-markup roles
];

/** True when content reads as an instruction to the model (an injection attempt). */
export function looksLikeInjection(content: string): boolean {
  const s = content || '';
  return INJECTION_PATTERNS.some((re) => re.test(s));
}

// ── Layer 2: secret redaction ───────────────────────────────────────────────
// Memory-SPECIFIC: strips credentials/keys/tokens WITHOUT scrubbing the ordinary
// names/roles/preferences that make a memory useful (unlike the PII-first feedback
// redactor). A durable brain must never hold a secret; it may hold "Frank leads
// the CDO org".
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]'],
  // key/value credential assignments: password=..., secret: ..., api_key = "..."
  [/\b(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?key|client[_-]?secret|token|bearer|sas|connection[_-]?string)\b\s*[:=]\s*["']?[^\s"'`,;]{6,}/gi, '$&'.replace(/.*/, '[REDACTED:credential]')],
  // Azure Storage / Service Bus style connection strings.
  [/\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)=[^;\s]+/gi, '[REDACTED:conn-secret]'],
];

/** Strip credential/secret material from a single string. Pure. */
export function redactSecrets(input: string): { text: string; redacted: boolean } {
  if (!input) return { text: input, redacted: false };
  let out = input;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return { text: out, redacted: out !== input };
}

// ── Scope derivation (layer 4) ──────────────────────────────────────────────

/** Build the partition key for a scope from the ACTING session only. Throws when
 *  the actor lacks the identity a scope needs — a workspace write with no
 *  workspaceId, or any write with no userOid, can never be scoped, so it must
 *  fail closed rather than default to a shared/foreign partition. */
export function deriveScopeKey(scope: MemoryScope, actor: MemoryActor): string {
  if (scope === 'workspace') {
    const ws = (actor.workspaceId || '').trim();
    if (!ws) throw new Error('workspace-scoped memory requires an acting workspaceId');
    return `workspace:${ws}`;
  }
  const oid = (actor.userOid || '').trim();
  if (!oid) throw new Error('user-scoped memory requires an acting userOid');
  return `user:${oid}`;
}

export interface ScreenOptions {
  /** True when this write MUTATES an existing memory (vs. creating a new one). */
  isMutation?: boolean;
  /** Explicit operator approval to mutate a locked (identity/policy) field. */
  approved?: boolean;
  /** Clock injectable for deterministic tests. */
  now?: () => Date;
  /** UUID injectable for deterministic tests. */
  uuid?: () => string;
}

/**
 * Screen one candidate write. Returns a verdict carrying either the sanitized,
 * scoped {@link MemoryRecord} ready to persist (ok) or a machine reason + detail
 * for the audit log (rejected). Never throws for content reasons — a bad
 * candidate is a rejection, not an exception — but a candidate that cannot be
 * scoped at all (missing actor identity) DOES throw, because there is no safe
 * partition to fall back to.
 */
export function screenMemoryWrite(
  candidate: MemoryCandidate,
  actor: MemoryActor,
  opts: ScreenOptions = {},
): GuardVerdict {
  const flags: string[] = [];
  const now = opts.now ?? (() => new Date());
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const scope: MemoryScope = candidate.scope === 'workspace' ? 'workspace' : 'user';
  const category: MemoryCategory = candidate.category ?? 'fact';

  // Layer 4 (scope) runs FIRST — an unscopeable write must fail before anything
  // else, and the scopeKey is derived from the actor, never the candidate.
  const scopeKey = deriveScopeKey(scope, actor); // throws on missing identity

  const raw = (candidate.content || '').trim();
  if (!raw) return { ok: false, reason: 'empty', detail: 'empty memory content', flags, redacted: false };
  if (raw.length > MAX_MEMORY_CHARS) {
    flags.push('too_long');
    return { ok: false, reason: 'too_long', detail: `content ${raw.length} > ${MAX_MEMORY_CHARS} chars`, flags, redacted: false };
  }

  // Layer 1 — injection scan.
  if (looksLikeInjection(raw)) {
    flags.push('injection');
    return { ok: false, reason: 'injection', detail: 'content reads as a model instruction, not a user fact', flags, redacted: false };
  }

  // Layer 3 — locked-field mutation gate.
  if (opts.isMutation && LOCKED_CATEGORIES.has(category) && !opts.approved) {
    flags.push('locked_field');
    return { ok: false, reason: 'locked_field', detail: `mutation of a locked '${category}' memory requires operator approval`, flags, redacted: false };
  }
  if (LOCKED_CATEGORIES.has(category)) flags.push('locked_category');

  // Layer 2 — secret redaction on the content + every tag.
  const { text: content, redacted: contentRedacted } = redactSecrets(raw);
  const tags = (candidate.tags || [])
    .map((t) => redactSecrets(String(t || '').trim()).text)
    .filter((t) => t.length > 0 && t.length <= 40)
    .slice(0, 12);
  const redacted = contentRedacted;
  if (redacted) flags.push('secret_redacted');

  const confidence = clamp01(candidate.confidence ?? 0.7);
  const record: MemoryRecord = {
    id: `mem:${uuid()}`,
    scopeKey,
    scope,
    content,
    category,
    confidence,
    tags,
    createdAt: now().toISOString(),
    source: candidate.source ?? 'auto',
    tenantId: actor.tenantId,
    sourceSessionId: candidate.sourceSessionId,
    recallCount: 0,
  };
  return { ok: true, record, flags, redacted };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1, n));
}
