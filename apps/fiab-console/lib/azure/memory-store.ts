/**
 * CTS-08 — long-term Copilot memory brain: Cosmos system of record + Azure AI
 * Search vector mirror, guarded by CTS-12 on every write.
 *
 * Cosmos `copilot-memory` (PK /scopeKey) holds one durable memory per doc. Every
 * create/update goes through `screenMemoryWrite` (memory-write-guard.ts) — there
 * is NO unguarded path — and every attempt (pass or fail) is appended to
 * `copilot-memory-write-audit`. On a passing write the record is dual-written to
 * the vector mirror (memory-vector-index.ts); a mirror failure is non-fatal (the
 * Cosmos row still stands and recall falls back to a keyword scan).
 *
 * Scope isolation: the persisted scopeKey is derived from the ACTING session by
 * the guard, never from the caller's input, so a write can only ever land in the
 * caller's own `user:<oid>` or a workspace they are acting in — cross-tenant
 * writes are structurally impossible.
 *
 * All backends are Cosmos + Azure AI Search + AOAI — Gov-native, no Fabric/Power
 * BI dependency.
 */

import {
  copilotMemoryContainer,
  copilotMemoryWriteAuditContainer,
  copilotMemoryFlushLogContainer,
} from './cosmos-client';
import { upsertMemoryVector, deleteMemoryVector } from './memory-vector-index';
import {
  screenMemoryWrite,
  type ScreenOptions,
} from '@/lib/copilot/memory-write-guard';
import type {
  MemoryActor,
  MemoryCandidate,
  MemoryRecord,
  MemoryScope,
  GuardVerdict,
} from '@/lib/copilot/memory-types';

const intEnv = (name: string, def: number) => Math.max(1, parseInt(process.env[name] || String(def), 10) || def);
/** Per-scope memory cap — oldest evicted on write (default 500). */
const memoryCap = () => intEnv('LOOM_COPILOT_MEMORY_CAP', 500);

function nowIso(): string {
  return new Date().toISOString();
}

/** The default-ON / opt-out kill-switch shared with CTS-06 (memory-flush.ts). */
export function isMemoryBrainEnabled(): boolean {
  const v = (process.env.LOOM_COPILOT_MEMORY || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

// ── Write-audit (CTS-12) ────────────────────────────────────────────────────

interface WriteAuditRecord {
  id: string;
  scopeKey: string;
  docType: 'write-audit';
  outcome: 'stored' | 'rejected';
  reason?: string;
  detail?: string;
  flags: string[];
  redacted: boolean;
  category?: string;
  source?: string;
  actorOid: string;
  tenantId?: string;
  at: string;
}

async function auditWrite(
  actor: MemoryActor,
  scopeKey: string,
  verdict: GuardVerdict,
  candidate: MemoryCandidate,
): Promise<void> {
  try {
    const c = await copilotMemoryWriteAuditContainer();
    const rec: WriteAuditRecord = {
      id: `wa:${crypto.randomUUID()}`,
      scopeKey,
      docType: 'write-audit',
      outcome: verdict.ok ? 'stored' : 'rejected',
      reason: verdict.reason,
      detail: verdict.detail,
      flags: verdict.flags,
      redacted: verdict.redacted,
      category: candidate.category,
      source: candidate.source,
      actorOid: actor.userOid,
      tenantId: actor.tenantId,
      at: nowIso(),
    };
    await c.items.create(rec);
  } catch {
    /* audit is best-effort but must never block the write path */
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateMemoryResult {
  ok: boolean;
  record?: MemoryRecord;
  reason?: string;
  detail?: string;
  flags: string[];
  redacted: boolean;
}

/**
 * Screen → persist → dual-write → audit one candidate. The single write entry
 * point: every path (explicit save, CTS-06 flush, auto-capture, consolidation)
 * calls this so the CTS-12 guard cannot be bypassed. Rejections are audited and
 * returned (never thrown) so the caller can surface the reason; a missing-actor
 * candidate DOES throw (no safe partition).
 */
export async function createMemory(
  candidate: MemoryCandidate,
  actor: MemoryActor,
  opts: ScreenOptions = {},
): Promise<CreateMemoryResult> {
  const verdict = screenMemoryWrite(candidate, actor, opts);
  const scopeKey = verdict.record?.scopeKey
    ?? (candidate.scope === 'workspace' ? `workspace:${actor.workspaceId}` : `user:${actor.userOid}`);
  await auditWrite(actor, scopeKey, verdict, candidate);
  if (!verdict.ok || !verdict.record) {
    return { ok: false, reason: verdict.reason, detail: verdict.detail, flags: verdict.flags, redacted: verdict.redacted };
  }

  const c = await copilotMemoryContainer();
  const rec = verdict.record;
  // Best-effort vector mirror (honest-gates to null when AI Search is absent).
  rec.embeddingId = (await upsertMemoryVector(rec)) ?? undefined;
  await c.items.create(rec);
  await pruneScope(rec.scopeKey).catch(() => undefined);
  return { ok: true, record: rec, flags: verdict.flags, redacted: verdict.redacted };
}

// ── Read / list ─────────────────────────────────────────────────────────────

/** List memories for the given scope keys, newest first, capped. */
export async function listMemories(scopeKeys: string[], limit = 200): Promise<MemoryRecord[]> {
  if (scopeKeys.length === 0) return [];
  const c = await copilotMemoryContainer();
  const out: MemoryRecord[] = [];
  for (const scopeKey of scopeKeys) {
    const { resources } = await c.items
      .query<MemoryRecord>({
        query: 'SELECT * FROM c WHERE c.scopeKey = @s ORDER BY c.createdAt DESC OFFSET 0 LIMIT @n',
        parameters: [{ name: '@s', value: scopeKey }, { name: '@n', value: Math.max(1, limit) }],
      }, { partitionKey: scopeKey })
      .fetchAll();
    out.push(...resources);
  }
  return out;
}

/** Fetch high-confidence memories in specific categories (the L0/L1 recall layers). */
export async function listByCategory(
  scopeKeys: string[],
  categories: string[],
  minConfidence: number,
  limit: number,
): Promise<MemoryRecord[]> {
  if (scopeKeys.length === 0 || categories.length === 0) return [];
  const c = await copilotMemoryContainer();
  const out: MemoryRecord[] = [];
  for (const scopeKey of scopeKeys) {
    const { resources } = await c.items
      .query<MemoryRecord>({
        query:
          'SELECT * FROM c WHERE c.scopeKey = @s AND ARRAY_CONTAINS(@cats, c.category) AND c.confidence >= @mc ' +
          'ORDER BY c.confidence DESC OFFSET 0 LIMIT @n',
        parameters: [
          { name: '@s', value: scopeKey },
          { name: '@cats', value: categories },
          { name: '@mc', value: minConfidence },
          { name: '@n', value: Math.max(1, limit) },
        ],
      }, { partitionKey: scopeKey })
      .fetchAll();
    out.push(...resources);
  }
  return out;
}

/** Cosmos keyword/tag fallback scan for a query (used when the vector mirror is
 *  unconfigured/unavailable — the honest-gate recall path). */
export async function keywordScan(scopeKeys: string[], query: string, limit: number): Promise<MemoryRecord[]> {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2).slice(0, 8);
  const all = await listMemories(scopeKeys, 500);
  if (terms.length === 0) return all.slice(0, limit);
  const scored = all
    .map((m) => {
      const hay = `${m.content} ${(m.tags || []).join(' ')}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((x) => x.m);
}

/** Point-read a set of memory ids within one scope (used to hydrate vector hits). */
export async function getByIds(scopeKeys: string[], ids: string[]): Promise<MemoryRecord[]> {
  if (ids.length === 0 || scopeKeys.length === 0) return [];
  const c = await copilotMemoryContainer();
  const out: MemoryRecord[] = [];
  for (const scopeKey of scopeKeys) {
    const { resources } = await c.items
      .query<MemoryRecord>({
        query: 'SELECT * FROM c WHERE c.scopeKey = @s AND ARRAY_CONTAINS(@ids, c.id)',
        parameters: [{ name: '@s', value: scopeKey }, { name: '@ids', value: ids }],
      }, { partitionKey: scopeKey })
      .fetchAll();
    out.push(...resources);
  }
  return out;
}

// ── Delete / purge ──────────────────────────────────────────────────────────

/** Delete one memory (scope-scoped so a caller can only delete within a scope
 *  they own/administer). Returns true when a row was removed. */
export async function deleteMemory(scopeKey: string, id: string): Promise<boolean> {
  const c = await copilotMemoryContainer();
  try {
    await c.item(id, scopeKey).delete();
    await deleteMemoryVector(id);
    return true;
  } catch {
    return false;
  }
}

/** Purge every memory in a scope (admin bulk action). Returns the count removed. */
export async function purgeScope(scopeKey: string): Promise<number> {
  const c = await copilotMemoryContainer();
  const { resources } = await c.items
    .query<{ id: string }>({
      query: 'SELECT c.id FROM c WHERE c.scopeKey = @s',
      parameters: [{ name: '@s', value: scopeKey }],
    }, { partitionKey: scopeKey })
    .fetchAll();
  let n = 0;
  for (const r of resources) {
    try {
      await c.item(r.id, scopeKey).delete();
      await deleteMemoryVector(r.id);
      n += 1;
    } catch {
      /* continue */
    }
  }
  return n;
}

/** Increment a memory's recall salience (CTS-13 usage-weighted reinforcement).
 *  Best-effort — a recall must never fail because the counter write did. */
export async function reinforceRecall(memories: MemoryRecord[]): Promise<void> {
  if (memories.length === 0) return;
  try {
    const c = await copilotMemoryContainer();
    for (const m of memories) {
      const next = { ...m, recallCount: (m.recallCount || 0) + 1, lastRecalledAt: nowIso() };
      await c.item(m.id, m.scopeKey).replace(next).catch(() => undefined);
    }
  } catch {
    /* best-effort */
  }
}

/** Evict oldest memories beyond the per-scope cap. */
async function pruneScope(scopeKey: string): Promise<void> {
  const c = await copilotMemoryContainer();
  const { resources } = await c.items
    .query<{ id: string }>({
      query: 'SELECT c.id FROM c WHERE c.scopeKey = @s ORDER BY c.createdAt DESC OFFSET @cap LIMIT 1000',
      parameters: [{ name: '@s', value: scopeKey }, { name: '@cap', value: memoryCap() }],
    }, { partitionKey: scopeKey })
    .fetchAll();
  for (const r of resources) {
    await c.item(r.id, scopeKey).delete().catch(() => undefined);
    await deleteMemoryVector(r.id);
  }
}

// ── Flush receipt log (CTS-06) ──────────────────────────────────────────────

export interface FlushLogRecord {
  id: string;
  scopeKey: string;
  docType: 'flush-log';
  sessionId?: string;
  candidates: number;
  stored: number;
  rejected: number;
  actorOid: string;
  at: string;
}

/** Append one dump-to-memory receipt. Best-effort. */
export async function logFlush(rec: Omit<FlushLogRecord, 'id' | 'docType' | 'at'>): Promise<void> {
  try {
    const c = await copilotMemoryFlushLogContainer();
    await c.items.create({ ...rec, id: `fl:${crypto.randomUUID()}`, docType: 'flush-log', at: nowIso() });
  } catch {
    /* best-effort */
  }
}

// ── Admin visibility ────────────────────────────────────────────────────────

export interface ScopeSummary {
  scopeKey: string;
  scope: MemoryScope;
  count: number;
}

/** Enumerate distinct memory scopes with per-scope counts (admin browse). Cross-
 *  partition — an infrequent admin read, bounded by `limit`. */
export async function listScopes(limit = 500): Promise<ScopeSummary[]> {
  const c = await copilotMemoryContainer();
  const { resources } = await c.items
    .query<{ scopeKey: string; scope: MemoryScope; n: number }>({
      query: 'SELECT c.scopeKey, c.scope, COUNT(1) AS n FROM c GROUP BY c.scopeKey, c.scope OFFSET 0 LIMIT @n',
      parameters: [{ name: '@n', value: Math.max(1, limit) }],
    })
    .fetchAll();
  return resources.map((r) => ({ scopeKey: r.scopeKey, scope: r.scope, count: r.n }));
}

/** Read the write-audit log for a scope (admin — CTS-12 verdict trail). */
export async function listWriteAudit(scopeKey: string, limit = 100): Promise<WriteAuditRecord[]> {
  const c = await copilotMemoryWriteAuditContainer();
  const { resources } = await c.items
    .query<WriteAuditRecord>({
      query: 'SELECT * FROM c WHERE c.scopeKey = @s ORDER BY c.at DESC OFFSET 0 LIMIT @n',
      parameters: [{ name: '@s', value: scopeKey }, { name: '@n', value: Math.max(1, limit) }],
    }, { partitionKey: scopeKey })
    .fetchAll();
  return resources;
}

/** Build the scope-key list for an actor (USER always; WORKSPACE when acting in one). */
export function scopeKeysForActor(actor: MemoryActor): string[] {
  const keys = [`user:${actor.userOid}`];
  if (actor.workspaceId) keys.push(`workspace:${actor.workspaceId}`);
  return keys;
}

export type { MemoryScope };
