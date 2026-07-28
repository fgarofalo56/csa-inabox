/**
 * agent-memory-core — the PURE policy core of the formalized agent-memory
 * service (B-N14d).
 *
 * Loom already had two *separate* memory stacks and neither was a service:
 *   - `lib/copilot/memory-*-core.ts` + `lib/azure/memory-store.ts` — the CTS-08
 *     Copilot brain, scoped `user:<oid>` / `workspace:<id>`. Nothing agent-aware.
 *   - `lib/azure/agent-memory-client.ts` — AIF-14 per-agent threads + facts,
 *     scoped agent+**user** only, with a COUNT cap and no time retention, no
 *     workspace dimension, and no audit on write.
 *
 * N14d formalizes an agent-memory SERVICE over both: one typed read/write API,
 * scoping per **agent + workspace** (with an optional user dimension for private
 * recall), an explicit **retention policy** (TTL seconds + a count cap), and an
 * **audit row on every write** — the same standard every other governed mutation
 * in Loom meets.
 *
 * This module is PURE (no Cosmos / Next / Fluent import): scope-key derivation,
 * the retention policy resolver, write screening (reusing the CTS-12 redactor +
 * injection screen so there is ONE sanitizer, not a second one), expiry
 * evaluation, and recall packing. `lib/azure/agent-memory-service.ts` is the
 * thin Cosmos adapter that calls into here.
 *
 * Azure-native: Cosmos only, no Fabric / Power BI dependency.
 */

import { redactSecrets, looksLikeInjection } from './memory-write-guard';

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * How far a memory reaches.
 *   - `agent`     — visible to every user of the agent in that workspace
 *                   (the agent's own operating knowledge).
 *   - `agent-user`— private to one user's conversations with the agent
 *                   (the AIF-14 behaviour, preserved).
 */
export type AgentMemoryScope = 'agent' | 'agent-user';

/** Coarse class the writer assigns — mirrors the Copilot brain's vocabulary. */
export type AgentMemoryCategory = 'fact' | 'preference' | 'decision' | 'context' | 'instruction';

/** How the memory entered the store. */
export type AgentMemorySource = 'run' | 'explicit' | 'consolidation' | 'import';

/** Every category a caller may write. Used to validate untrusted input. */
export const AGENT_MEMORY_CATEGORIES: readonly AgentMemoryCategory[] = [
  'fact', 'preference', 'decision', 'context', 'instruction',
];

/** Every source a caller may declare. */
export const AGENT_MEMORY_SOURCES: readonly AgentMemorySource[] = [
  'run', 'explicit', 'consolidation', 'import',
];

/** Max characters of a single memory (matches the Copilot brain's cap). */
export const MAX_AGENT_MEMORY_CHARS = 600;

/** The acting identity — the ONLY source of a write's scope (never the body). */
export interface AgentMemoryActor {
  /** Entra object id of the signed-in user driving the agent. */
  userOid: string;
  /** Entra tenant — a second isolation dimension enforced on every read. */
  tenantId: string;
  /** The workspace the agent is running in ('' when the agent is unscoped). */
  workspaceId?: string;
}

/**
 * Derive the **scope key** a memory is filed under. Composed from the agent id,
 * the workspace, and (for `agent-user`) the acting user — so a memory can only
 * ever land in the caller's own reach. Cross-workspace and cross-user leakage
 * are structurally impossible because the key is derived here from the ACTOR,
 * never from caller-supplied fields.
 *
 * Shape: `agent:<agentId>|ws:<workspaceId|_>` (+ `|user:<oid>` for agent-user).
 */
export function agentMemoryScopeKey(
  agentId: string,
  scope: AgentMemoryScope,
  actor: AgentMemoryActor,
): string {
  const ws = (actor.workspaceId || '').trim() || '_';
  const base = `agent:${agentId}|ws:${ws}`;
  return scope === 'agent-user' ? `${base}|user:${actor.userOid}` : base;
}

/** Parse a scope key back into its parts (`null` when malformed). */
export function parseAgentMemoryScopeKey(
  key: string,
): { agentId: string; workspaceId: string; userOid?: string } | null {
  const m = /^agent:([^|]+)\|ws:([^|]+)(?:\|user:(.+))?$/.exec(key || '');
  if (!m) return null;
  return { agentId: m[1], workspaceId: m[2] === '_' ? '' : m[2], userOid: m[3] };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The persisted agent-memory document (Cosmos `loom-agent-memory`, PK /agentId). */
export interface AgentMemoryRecordV2 {
  /** `amem:<uuid>` */
  id: string;
  /** Cosmos partition key — the agent this memory belongs to. */
  agentId: string;
  /** Discriminator inside the shared container (threads/evals also live there). */
  docType: 'agent-memory';
  /** Derived scope key (see {@link agentMemoryScopeKey}). */
  scopeKey: string;
  scope: AgentMemoryScope;
  workspaceId: string;
  /** Present only for `agent-user` memories. */
  userOid?: string;
  /** Entra tenant of the acting session — enforced on every read. */
  tenantId: string;
  /** Redacted, sanitized memory text. */
  content: string;
  category: AgentMemoryCategory;
  /** 0..1 writer confidence — higher packs first on recall. */
  confidence: number;
  tags: string[];
  source: AgentMemorySource;
  /** Provenance — the run/thread this memory was distilled from. */
  sourceThreadId?: string;
  createdAt: string;
  updatedAt?: string;
  /** ISO instant the memory expires (retention). Absent → never expires. */
  expiresAt?: string;
  /**
   * Cosmos item-level TTL in seconds. Honored natively once the container has
   * TTL enabled; the service ALSO sweeps `expiresAt` on read/write so retention
   * holds regardless of container configuration.
   */
  ttl?: number;
  /** Usage-weighted salience — incremented each time the memory is recalled. */
  recallCount?: number;
  lastRecalledAt?: string;
}

/** A candidate memory before it is scoped, screened, and stamped. */
export interface AgentMemoryCandidate {
  content: string;
  category?: AgentMemoryCategory;
  confidence?: number;
  tags?: string[];
  scope?: AgentMemoryScope;
  source?: AgentMemorySource;
  sourceThreadId?: string;
  /** Per-write retention override, in days (clamped to the policy maximum). */
  retentionDays?: number;
}

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

/** The resolved retention policy applied to a write. */
export interface AgentMemoryRetentionPolicy {
  /** Default lifetime in days. `0` = keep forever (no expiry stamped). */
  retentionDays: number;
  /** Hard ceiling a per-write `retentionDays` override is clamped to. */
  maxRetentionDays: number;
  /** Per-scope-key count cap — the oldest beyond it are evicted on write. */
  cap: number;
  /** Top-K packed into a recall. */
  topK: number;
}

/** The built-in defaults when no operator override is present. */
export const DEFAULT_AGENT_MEMORY_RETENTION: AgentMemoryRetentionPolicy = {
  retentionDays: 180,
  maxRetentionDays: 730,
  cap: 200,
  topK: 8,
};

function positiveInt(raw: string | undefined, fallback: number, allowZero = false): number {
  const n = parseInt((raw || '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  if (n === 0 && !allowZero) return fallback;
  return n;
}

/**
 * Resolve the retention policy from operator env (read per call, so an admin
 * change takes effect without a restart — the same discipline as the AIF-14
 * caps). These are numeric TUNING knobs with safe built-in defaults, following
 * the established precedent of `LOOM_AGENT_MEMORY_CAP` / `LOOM_AGENT_THREAD_CAP`
 * — they are NOT day-one gates, so nothing is blocked when they are unset.
 */
export function resolveAgentMemoryRetention(
  env: Record<string, string | undefined> = process.env,
): AgentMemoryRetentionPolicy {
  const maxRetentionDays = positiveInt(env.LOOM_AGENT_MEMORY_MAX_RETENTION_DAYS, DEFAULT_AGENT_MEMORY_RETENTION.maxRetentionDays);
  const retentionDays = Math.min(
    positiveInt(env.LOOM_AGENT_MEMORY_RETENTION_DAYS, DEFAULT_AGENT_MEMORY_RETENTION.retentionDays, true),
    maxRetentionDays,
  );
  return {
    retentionDays,
    maxRetentionDays,
    cap: positiveInt(env.LOOM_AGENT_MEMORY_CAP, DEFAULT_AGENT_MEMORY_RETENTION.cap),
    topK: positiveInt(env.LOOM_AGENT_MEMORY_TOPK, DEFAULT_AGENT_MEMORY_RETENTION.topK),
  };
}

/** Effective lifetime in days for one write (0 → keep forever). */
export function effectiveRetentionDays(
  candidate: AgentMemoryCandidate,
  policy: AgentMemoryRetentionPolicy,
): number {
  const override = candidate.retentionDays;
  if (typeof override !== 'number' || !Number.isFinite(override) || override < 0) return policy.retentionDays;
  if (override === 0) return 0;
  return Math.min(Math.floor(override), policy.maxRetentionDays);
}

/** True when `record` has passed its retention horizon at `nowMs`. */
export function isExpired(record: Pick<AgentMemoryRecordV2, 'expiresAt'>, nowMs: number): boolean {
  if (!record.expiresAt) return false;
  const t = Date.parse(record.expiresAt);
  return Number.isFinite(t) && t <= nowMs;
}

// ---------------------------------------------------------------------------
// Write screening
// ---------------------------------------------------------------------------

/** The verdict of screening one candidate write. */
export interface AgentMemoryWriteVerdict {
  ok: boolean;
  /** The stamped record ready to persist (present only when `ok`). */
  record?: AgentMemoryRecordV2;
  /** Machine reason on rejection ('empty' | 'too_long' | 'injection' | 'bad_category' …). */
  reason?: string;
  /** Human detail for the audit row. */
  detail?: string;
  /** Deterministic flags raised during screening (always populated). */
  flags: string[];
  /** True when secret redaction changed the content or a tag. */
  redacted: boolean;
}

/** Options for {@link screenAgentMemoryWrite} — injectable for tests. */
export interface ScreenAgentMemoryOptions {
  now?: () => Date;
  newId?: () => string;
  policy?: AgentMemoryRetentionPolicy;
}

function defaultId(): string {
  // CSPRNG only. The previous fallback used Math.random() when
  // globalThis.crypto.randomUUID was absent (CodeQL js/insecure-randomness,
  // HIGH). These ids name Cosmos documents holding distilled user facts, so a
  // guessable id is a real weakness even though access is separately scoped by
  // agent + workspace + actor. globalThis.crypto.randomUUID exists on Node 18+
  // and every modern browser; the getRandomValues path is a belt-and-braces
  // fallback that is still cryptographically strong, and we THROW rather than
  // silently degrade to a weak source.
  const c = globalThis.crypto as
    | { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array }
    | undefined;
  if (c?.randomUUID) return `amem:${c.randomUUID()}`;
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `amem:${hex}`;
  }
  throw new Error('agent-memory: no cryptographic RNG available to mint a record id');
}

/**
 * Screen + stamp ONE candidate agent memory. There is no unguarded write path:
 * the Cosmos service calls this for every write, and persists only `verdict.record`.
 *
 * Screening layers (deliberately the SAME ones the CTS-12 Copilot guard uses, by
 * importing its pure primitives rather than re-implementing them):
 *   1. shape — non-empty, within {@link MAX_AGENT_MEMORY_CHARS}, known category/source;
 *   2. prompt-injection screen — a memory that reads as a model instruction is rejected;
 *   3. secret redaction — credentials/keys/tokens stripped from content AND tags;
 *   4. scoping — `scopeKey` / `workspaceId` / `userOid` / `tenantId` are derived
 *      from the ACTOR, never from the candidate;
 *   5. retention — `expiresAt` + Cosmos `ttl` stamped from the resolved policy.
 */
export function screenAgentMemoryWrite(
  agentId: string,
  candidate: AgentMemoryCandidate,
  actor: AgentMemoryActor,
  opts: ScreenAgentMemoryOptions = {},
): AgentMemoryWriteVerdict {
  const flags: string[] = [];
  const now = (opts.now || (() => new Date()))();
  const policy = opts.policy || resolveAgentMemoryRetention();

  if (!agentId || !agentId.trim()) {
    return { ok: false, reason: 'no_agent', detail: 'agentId is required', flags, redacted: false };
  }
  if (!actor?.userOid || !actor?.tenantId) {
    return { ok: false, reason: 'no_actor', detail: 'an authenticated actor (userOid + tenantId) is required', flags, redacted: false };
  }

  const raw = String(candidate?.content ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty', detail: 'empty memory content', flags, redacted: false };
  if (raw.length > MAX_AGENT_MEMORY_CHARS) {
    flags.push('too_long');
    return { ok: false, reason: 'too_long', detail: `content ${raw.length} > ${MAX_AGENT_MEMORY_CHARS} chars`, flags, redacted: false };
  }

  const category = candidate.category || 'fact';
  if (!AGENT_MEMORY_CATEGORIES.includes(category)) {
    return { ok: false, reason: 'bad_category', detail: `unknown category "${String(category)}"`, flags, redacted: false };
  }
  const source = candidate.source || 'explicit';
  if (!AGENT_MEMORY_SOURCES.includes(source)) {
    return { ok: false, reason: 'bad_source', detail: `unknown source "${String(source)}"`, flags, redacted: false };
  }

  if (looksLikeInjection(raw)) {
    flags.push('injection');
    return { ok: false, reason: 'injection', detail: 'content reads as a model instruction, not a durable fact', flags, redacted: false };
  }

  const { text: content, redacted: contentRedacted } = redactSecrets(raw);
  const tags = (candidate.tags || [])
    .map((t) => redactSecrets(String(t || '').trim()).text)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (contentRedacted) flags.push('secret_redacted');

  const scope: AgentMemoryScope = candidate.scope === 'agent-user' ? 'agent-user' : 'agent';
  const scopeKey = agentMemoryScopeKey(agentId, scope, actor);
  const days = effectiveRetentionDays(candidate, policy);
  const expiresAt = days > 0 ? new Date(now.getTime() + days * 86_400_000).toISOString() : undefined;

  const rawConfidence = typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
    ? candidate.confidence
    : 0.7;
  const confidence = Math.min(1, Math.max(0, rawConfidence));

  const record: AgentMemoryRecordV2 = {
    id: (opts.newId || defaultId)(),
    agentId,
    docType: 'agent-memory',
    scopeKey,
    scope,
    workspaceId: (actor.workspaceId || '').trim(),
    ...(scope === 'agent-user' ? { userOid: actor.userOid } : {}),
    tenantId: actor.tenantId,
    content,
    category,
    confidence,
    tags,
    source,
    ...(candidate.sourceThreadId ? { sourceThreadId: candidate.sourceThreadId } : {}),
    createdAt: now.toISOString(),
    ...(expiresAt ? { expiresAt, ttl: days * 86_400 } : {}),
    recallCount: 0,
  };

  return { ok: true, record, flags, redacted: contentRedacted };
}

// ---------------------------------------------------------------------------
// Recall packing
// ---------------------------------------------------------------------------

/** The result of packing memories for injection into an agent turn. */
export interface AgentRecallResult {
  /** Rendered block to prepend to the agent's instructions ('' when empty). */
  block: string;
  /** The selected records, in packing order. */
  selected: AgentMemoryRecordV2[];
}

/** Cheap token estimate (≈4 chars/token) — matches the Copilot brain estimator. */
export function estimateAgentMemoryTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/**
 * Select + render the memories for one turn: drop expired rows, prefer
 * agent-scoped operating knowledge over private user memories at equal
 * confidence, then pack newest/most-confident first under `topK` and the token
 * budget. Pure and total.
 */
export function packAgentMemories(
  records: AgentMemoryRecordV2[],
  opts: { topK: number; tokenBudget?: number; nowMs?: number } ,
): AgentRecallResult {
  const nowMs = opts.nowMs ?? Date.now();
  const topK = Math.max(0, Math.floor(opts.topK) || 0);
  if (topK === 0) return { block: '', selected: [] };
  const budget = Math.max(0, Math.floor(opts.tokenBudget ?? Number.MAX_SAFE_INTEGER));

  const live = records
    .filter((r) => r && r.docType === 'agent-memory' && !isExpired(r, nowMs))
    .sort((a, b) => {
      const c = (b.confidence ?? 0) - (a.confidence ?? 0);
      if (c !== 0) return c;
      if (a.scope !== b.scope) return a.scope === 'agent' ? -1 : 1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

  const header =
    'Durable agent memory — facts, preferences, and decisions this agent has retained for this workspace ' +
    'across previous sessions. Use them when relevant; never invent beyond them.';
  let used = estimateAgentMemoryTokens(header);
  if (used > budget) return { block: '', selected: [] };

  const selected: AgentMemoryRecordV2[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const r of live) {
    if (selected.length >= topK) break;
    const key = r.content.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    const line = `- (${r.category}${r.scope === 'agent-user' ? ', about you' : ''}) ${r.content}`;
    const cost = estimateAgentMemoryTokens(line) + 1;
    if (used + cost > budget) continue;
    seen.add(key);
    selected.push(r);
    lines.push(line);
    used += cost;
  }
  if (!selected.length) return { block: '', selected: [] };
  return { block: `${header}\n${lines.join('\n')}`, selected };
}
