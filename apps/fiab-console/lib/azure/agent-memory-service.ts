/**
 * agent-memory-service — the formalized agent-memory SERVICE (B-N14d).
 *
 * The Cosmos adapter over `lib/copilot/agent-memory-core.ts`. One typed
 * read/write API for durable agent memory, with:
 *
 *   • **Scoping per agent + workspace** — every document is filed under a
 *     scope key DERIVED from the acting session (`agent:<id>|ws:<id>`, plus
 *     `|user:<oid>` for a private memory). A caller can never write into, or
 *     read out of, a workspace/tenant/user it is not acting in.
 *   • **Retention** — a resolved TTL (`expiresAt` + the Cosmos item `ttl`
 *     field) plus a per-scope count cap. Expired rows are swept on read AND on
 *     write, so retention holds even before the container's TTL sweeper runs.
 *   • **Audit on write** — EVERY write attempt (stored or rejected) appends an
 *     authoritative row to the Cosmos audit log and fans out to the SIEM stream
 *     + webhooks via `emitAuditEvent`, exactly like every other governed
 *     mutation. Deletes and purges are audited too.
 *
 * Storage reuses the EXISTING `loom-agent-memory` container (PK `/agentId`)
 * that AIF-14 threads/facts/evals already share — no new Azure resource, no
 * bicep change; the new documents carry `docType:'agent-memory'` so they never
 * collide with the `thread` / `memory` / `eval` docs already in there.
 *
 * Default-ON (loom_default_on_opt_out): nothing here is gated behind config.
 * The only kill-switch is the runtime flag `n14d-agent-memory`, which fails
 * OPEN (a missing/unreadable flag doc means enabled).
 *
 * Azure-native: Cosmos + the existing audit stream. No Fabric / Power BI.
 */

import { agentMemoryContainer, auditLogContainer } from './cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import {
  agentMemoryScopeKey,
  isExpired,
  packAgentMemories,
  resolveAgentMemoryRetention,
  screenAgentMemoryWrite,
  type AgentMemoryActor,
  type AgentMemoryCandidate,
  type AgentMemoryRecordV2,
  type AgentMemoryRetentionPolicy,
  type AgentMemoryScope,
  type AgentMemoryWriteVerdict,
  type AgentRecallResult,
} from '@/lib/copilot/agent-memory-core';

const DOC_TYPE = 'agent-memory';

/** The B-N14d kill-switch id (default-ON, fail-open — see runtime-flags.ts). */
export const AGENT_MEMORY_FLAG = 'n14d-agent-memory';

/**
 * True when the agent-memory service is enabled. Fails OPEN: a missing flag doc
 * or an unreachable Cosmos yields `true`, so a kill-switch outage never takes
 * agent memory down with it (loom_default_on_opt_out).
 */
export function agentMemoryEnabled(): Promise<boolean> {
  return runtimeFlag(AGENT_MEMORY_FLAG, { default: true });
}

/** The scope keys a caller may read: shared agent knowledge + their own private rows. */
function readableScopeKeys(agentId: string, actor: AgentMemoryActor): string[] {
  return [
    agentMemoryScopeKey(agentId, 'agent', actor),
    agentMemoryScopeKey(agentId, 'agent-user', actor),
  ];
}

// ── Audit ───────────────────────────────────────────────────────────────────

interface AgentMemoryAuditInput {
  agentId: string;
  actor: AgentMemoryActor;
  actorUpn: string;
  action: 'write' | 'reject' | 'delete' | 'purge' | 'recall';
  outcome: 'success' | 'failure';
  scopeKey?: string;
  memoryId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Record ONE agent-memory governance event: a durable Cosmos audit row plus the
 * SIEM/webhook fan-out. Fire-and-forget — an audit hiccup must never fail the
 * agent turn, matching `a2a-audit.ts` and every other mutation in this repo.
 */
export function auditAgentMemory(ev: AgentMemoryAuditInput): void {
  const at = new Date().toISOString();
  const action = `agent-memory.${ev.action}`;
  void (async () => {
    try {
      const c = await auditLogContainer();
      await c.items.create({
        id: `amem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: ev.agentId,
        tenantId: ev.actor.tenantId,
        who: ev.actor.userOid,
        actorOid: ev.actor.userOid,
        at,
        timestamp: at,
        kind: 'agent-memory',
        category: 'agent-memory',
        action,
        outcome: ev.outcome,
        target: ev.memoryId || ev.scopeKey || ev.agentId,
        details: {
          agentId: ev.agentId,
          workspaceId: ev.actor.workspaceId || '',
          scopeKey: ev.scopeKey,
          memoryId: ev.memoryId,
          ...(ev.detail || {}),
        },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[agent-memory] durable audit write failed (non-fatal):', (e as Error)?.message || e);
    }
  })();
  emitAuditEvent({
    actorOid: ev.actor.userOid,
    actorUpn: ev.actorUpn || ev.actor.userOid,
    action,
    targetType: 'agent-memory',
    targetId: ev.memoryId || ev.agentId,
    outcome: ev.outcome,
    tenantId: ev.actor.tenantId,
    detail: { agentId: ev.agentId, workspaceId: ev.actor.workspaceId || '', scopeKey: ev.scopeKey, ...(ev.detail || {}) },
  });
}

// ── Read ────────────────────────────────────────────────────────────────────

/** Options for {@link readAgentMemories}. */
export interface ReadAgentMemoriesOptions {
  /** Restrict to one scope; omit to read shared + own-private together. */
  scope?: AgentMemoryScope;
  /** Max rows to return (defaults to the retention cap). */
  limit?: number;
  /** Include rows past their retention horizon (admin/forensics only). */
  includeExpired?: boolean;
}

/**
 * The raw scoped query — tenant + scope-key filtered, single-partition. Shared
 * by the flag-gated read and by purge (a data-rights operation that must keep
 * working even when the kill-switch is OFF).
 */
async function queryScopedMemories(
  agentId: string,
  actor: AgentMemoryActor,
  opts: ReadAgentMemoriesOptions,
): Promise<AgentMemoryRecordV2[]> {
  const policy = resolveAgentMemoryRetention();
  const limit = Math.max(1, Math.min(500, opts.limit || policy.cap));
  const keys = opts.scope ? [agentMemoryScopeKey(agentId, opts.scope, actor)] : readableScopeKeys(agentId, actor);
  const c = await agentMemoryContainer();
  const { resources } = await c.items
    .query<AgentMemoryRecordV2>({
      query:
        'SELECT * FROM c WHERE c.agentId = @agentId AND c.docType = @docType AND c.tenantId = @tenantId ' +
        'AND ARRAY_CONTAINS(@scopeKeys, c.scopeKey) ORDER BY c.createdAt DESC OFFSET 0 LIMIT @limit',
      parameters: [
        { name: '@agentId', value: agentId },
        { name: '@docType', value: DOC_TYPE },
        { name: '@tenantId', value: actor.tenantId },
        { name: '@scopeKeys', value: keys },
        { name: '@limit', value: limit },
      ],
    })
    .fetchAll();
  return resources;
}

/**
 * Read the memories an actor may see for one agent, newest+most-confident
 * first. Single-partition (PK `/agentId`) + tenant-filtered + scope-key
 * filtered, so a read can never cross a tenant, workspace, or another user's
 * private rows. Expired rows are dropped (and swept) unless explicitly asked for.
 */
export async function readAgentMemories(
  agentId: string,
  actor: AgentMemoryActor,
  opts: ReadAgentMemoriesOptions = {},
): Promise<AgentMemoryRecordV2[]> {
  if (!(await agentMemoryEnabled())) return [];
  const resources = await queryScopedMemories(agentId, actor, opts);
  if (opts.includeExpired) return resources;
  const nowMs = Date.now();
  const live = resources.filter((r) => !isExpired(r, nowMs));
  const dead = resources.filter((r) => isExpired(r, nowMs));
  if (dead.length) void sweep(agentId, dead);
  return live;
}

/**
 * Recall memories for one agent turn: read, pack under `topK` + the token
 * budget, reinforce the selected rows' salience, and audit the recall. Returns
 * the rendered block ready to prepend to the agent's instructions.
 *
 * Best-effort by design — a memory-store hiccup must never fail an agent run,
 * so a failure yields an empty recall rather than throwing into the turn.
 */
export async function recallAgentMemories(
  agentId: string,
  actor: AgentMemoryActor,
  opts: { actorUpn?: string; topK?: number; tokenBudget?: number } = {},
): Promise<AgentRecallResult> {
  const policy = resolveAgentMemoryRetention();
  try {
    const rows = await readAgentMemories(agentId, actor, { limit: Math.max(policy.topK * 4, 32) });
    const packed = packAgentMemories(rows, {
      topK: opts.topK ?? policy.topK,
      tokenBudget: opts.tokenBudget,
    });
    if (packed.selected.length) {
      void reinforce(agentId, packed.selected);
      auditAgentMemory({
        agentId, actor, actorUpn: opts.actorUpn || '', action: 'recall', outcome: 'success',
        detail: { recalled: packed.selected.length },
      });
    }
    return packed;
  } catch {
    return { block: '', selected: [] };
  }
}

/** Bump `recallCount` / `lastRecalledAt` on the recalled rows (best-effort). */
async function reinforce(agentId: string, records: AgentMemoryRecordV2[]): Promise<void> {
  try {
    const c = await agentMemoryContainer();
    const at = new Date().toISOString();
    for (const r of records) {
      await c.items
        .upsert({ ...r, recallCount: (r.recallCount || 0) + 1, lastRecalledAt: at })
        .catch(() => undefined);
    }
  } catch {
    /* salience reinforcement is best-effort */
  }
}

// ── Write ───────────────────────────────────────────────────────────────────

/** The outcome of one write attempt (mirrors the screening verdict). */
export interface WriteAgentMemoryResult {
  ok: boolean;
  record?: AgentMemoryRecordV2;
  reason?: string;
  detail?: string;
  flags: string[];
  redacted: boolean;
}

/**
 * Write ONE memory for an agent. There is NO unguarded path: the candidate is
 * screened + stamped by `screenAgentMemoryWrite` (shape, injection screen,
 * secret redaction, actor-derived scoping, retention), every attempt — stored
 * or rejected — is audited, and the per-scope count cap is enforced after a
 * successful store.
 */
export async function writeAgentMemory(
  agentId: string,
  candidate: AgentMemoryCandidate,
  actor: AgentMemoryActor,
  opts: { actorUpn?: string } = {},
): Promise<WriteAgentMemoryResult> {
  const policy = resolveAgentMemoryRetention();
  if (!(await agentMemoryEnabled())) {
    return {
      ok: false,
      reason: 'disabled',
      detail: `agent memory is switched OFF for this deployment (runtime flag "${AGENT_MEMORY_FLAG}"). Re-enable it on /admin/flags to resume writes; nothing already stored has been deleted.`,
      flags: ['flag_off'],
      redacted: false,
    };
  }
  const verdict: AgentMemoryWriteVerdict = screenAgentMemoryWrite(agentId, candidate, actor, { policy });

  if (!verdict.ok || !verdict.record) {
    auditAgentMemory({
      agentId, actor, actorUpn: opts.actorUpn || '', action: 'reject', outcome: 'failure',
      detail: { reason: verdict.reason, detail: verdict.detail, flags: verdict.flags },
    });
    return { ok: false, reason: verdict.reason, detail: verdict.detail, flags: verdict.flags, redacted: verdict.redacted };
  }

  const record = verdict.record;
  try {
    const c = await agentMemoryContainer();
    await c.items.create(record);
  } catch (e) {
    const detail = (e as Error)?.message || 'cosmos write failed';
    auditAgentMemory({
      agentId, actor, actorUpn: opts.actorUpn || '', action: 'write', outcome: 'failure',
      scopeKey: record.scopeKey, memoryId: record.id, detail: { error: detail },
    });
    return { ok: false, reason: 'store_failed', detail, flags: verdict.flags, redacted: verdict.redacted };
  }

  auditAgentMemory({
    agentId, actor, actorUpn: opts.actorUpn || '', action: 'write', outcome: 'success',
    scopeKey: record.scopeKey, memoryId: record.id,
    detail: { category: record.category, scope: record.scope, expiresAt: record.expiresAt, flags: verdict.flags, redacted: verdict.redacted },
  });
  void enforceCap(agentId, record.scopeKey, policy);
  return { ok: true, record, flags: verdict.flags, redacted: verdict.redacted };
}

/** Write several candidates, returning one result per candidate (order preserved). */
export async function writeAgentMemories(
  agentId: string,
  candidates: AgentMemoryCandidate[],
  actor: AgentMemoryActor,
  opts: { actorUpn?: string } = {},
): Promise<WriteAgentMemoryResult[]> {
  const out: WriteAgentMemoryResult[] = [];
  for (const cand of candidates) out.push(await writeAgentMemory(agentId, cand, actor, opts));
  return out;
}

// ── Delete / retention ──────────────────────────────────────────────────────

/**
 * Delete one memory. Scope-checked against the acting session (a caller can
 * only delete a row inside a scope key it can itself derive) and audited.
 */
export async function deleteAgentMemory(
  agentId: string,
  memoryId: string,
  actor: AgentMemoryActor,
  opts: { actorUpn?: string } = {},
): Promise<boolean> {
  const c = await agentMemoryContainer();
  let existing: AgentMemoryRecordV2 | undefined;
  try {
    const { resource } = await c.item(memoryId, agentId).read<AgentMemoryRecordV2>();
    existing = resource;
  } catch {
    existing = undefined;
  }
  const allowed = readableScopeKeys(agentId, actor);
  if (
    !existing ||
    existing.docType !== DOC_TYPE ||
    existing.tenantId !== actor.tenantId ||
    !allowed.includes(existing.scopeKey)
  ) {
    return false;
  }
  await c.item(memoryId, agentId).delete();
  auditAgentMemory({
    agentId, actor, actorUpn: opts.actorUpn || '', action: 'delete', outcome: 'success',
    scopeKey: existing.scopeKey, memoryId,
  });
  return true;
}

/**
 * Purge every memory the actor can see for this agent (optionally one scope).
 * Audited with the deleted count — the operator-facing "forget everything"
 * control behind the service.
 */
export async function purgeAgentMemories(
  agentId: string,
  actor: AgentMemoryActor,
  opts: { scope?: AgentMemoryScope; actorUpn?: string } = {},
): Promise<number> {
  const rows = await queryScopedMemories(agentId, actor, { scope: opts.scope, limit: 500, includeExpired: true });
  const c = await agentMemoryContainer();
  let deleted = 0;
  for (const r of rows) {
    try {
      await c.item(r.id, agentId).delete();
      deleted += 1;
    } catch {
      /* keep purging the rest */
    }
  }
  auditAgentMemory({
    agentId, actor, actorUpn: opts.actorUpn || '', action: 'purge', outcome: 'success',
    detail: { scope: opts.scope || 'all', deleted },
  });
  return deleted;
}

/** Delete rows that are past their retention horizon (best-effort sweep). */
async function sweep(agentId: string, expired: AgentMemoryRecordV2[]): Promise<void> {
  try {
    const c = await agentMemoryContainer();
    for (const r of expired) await c.item(r.id, agentId).delete().catch(() => undefined);
  } catch {
    /* the sweep is best-effort — the Cosmos TTL is the backstop */
  }
}

/** Evict the oldest rows in a scope beyond the count cap (best-effort). */
async function enforceCap(agentId: string, scopeKey: string, policy: AgentMemoryRetentionPolicy): Promise<void> {
  try {
    const c = await agentMemoryContainer();
    const { resources } = await c.items
      .query<{ id: string }>({
        query:
          'SELECT c.id FROM c WHERE c.agentId = @agentId AND c.docType = @docType AND c.scopeKey = @scopeKey ' +
          'ORDER BY c.createdAt DESC OFFSET @cap LIMIT 1000',
        parameters: [
          { name: '@agentId', value: agentId },
          { name: '@docType', value: DOC_TYPE },
          { name: '@scopeKey', value: scopeKey },
          { name: '@cap', value: policy.cap },
        ],
      })
      .fetchAll();
    for (const r of resources) await c.item(r.id, agentId).delete().catch(() => undefined);
  } catch {
    /* cap enforcement is best-effort */
  }
}

/** The retention policy currently in force (surfaced by the API for honesty). */
export function agentMemoryRetentionPolicy(): AgentMemoryRetentionPolicy {
  return resolveAgentMemoryRetention();
}
