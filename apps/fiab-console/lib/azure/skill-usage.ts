/**
 * skill-usage.ts — CTS-11 Copilot skill USAGE telemetry (Cosmos-backed).
 *
 * WHAT THIS IS
 * ------------
 * A lightweight, append-only ledger of Copilot turns: one row per turn holding a
 * REDACTED prompt sample, the pane it ran on, and which skills were active. The
 * CTS-11 learner (lib/azure/skill-learner.ts) scans this ledger to find recurring
 * usage patterns no existing skill covers, and drafts SUGGESTED skills an admin
 * reviews. This module owns the write (fire-and-forget from the orchestrator) and
 * the learner's read.
 *
 * NO-VAPORWARE (.claude/rules/no-vaporware.md)
 * --------------------------------------------
 * Real Cosmos writes/reads — no mock arrays. {@link recordSkillUsage} is STRICTLY
 * best-effort: it swallows every error (Cosmos unconfigured, throttle, bad input)
 * so a telemetry failure can NEVER affect the Copilot turn it observes. Rows carry
 * a 90-day TTL (container defaultTtl) so the ledger self-evicts.
 *
 * PRIVACY
 * -------
 * The prompt is truncated to ~200 chars and passed through the shared feedback
 * redactor (`@/lib/feedback/redaction` `redact`) before persistence — emails,
 * GUIDs, hosts, IPs, and long hex are scrubbed, so no customer data or tenant
 * topology leaves the turn.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md)
 * -----------------------------------------------------------
 * Cosmos via the same Console UAMI every other Loom container uses; no Fabric host.
 */

import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@azure/cosmos';
import { copilotSkillUsageContainer } from '@/lib/azure/cosmos-client';
import { redact } from '@/lib/feedback/redaction';
import type { UsageRow } from '@/lib/copilot/skill-learner-core';

/** The persisted `copilot-skill-usage` doc. PK /tenantId; TTL 90d (container defaultTtl). */
export interface SkillUsageDoc {
  id: string;
  /** Partition key — the caller's tenant id (falls back to the user oid). */
  tenantId: string;
  /** Caller oid (redaction still scrubs it from promptSample). */
  userOid: string;
  /** Pane / persona slug the turn ran on. */
  pane?: string;
  /** REDACTED prompt sample (first ~200 chars). */
  promptSample: string;
  /** Names of the skills active on this turn. */
  activeSkillNames: string[];
  /** ISO timestamp. */
  at: string;
}

const PROMPT_SAMPLE_MAX = 200;

/** Input for {@link recordSkillUsage}. */
export interface RecordSkillUsageInput {
  tenantId?: string | null;
  userOid: string;
  pane?: string | null;
  prompt: string;
  activeSkillNames: string[];
}

/**
 * Best-effort append of ONE usage row. NEVER throws — every failure is swallowed
 * so a telemetry write can't break (or slow, when `void`-ed) the Copilot turn.
 * The prompt is truncated + redacted before persistence.
 */
export async function recordSkillUsage(input: RecordSkillUsageInput): Promise<void> {
  try {
    const userOid = String(input?.userOid ?? '').trim();
    if (!userOid) return;
    const tenantId = String(input?.tenantId ?? '').trim() || userOid; // never a null partition
    const rawPrompt = String(input?.prompt ?? '');
    const promptSample = redact(rawPrompt.slice(0, PROMPT_SAMPLE_MAX));
    const activeSkillNames = Array.isArray(input?.activeSkillNames)
      ? input.activeSkillNames.map((n) => String(n)).filter(Boolean).slice(0, 24)
      : [];
    const pane = input?.pane ? String(input.pane).trim().toLowerCase() : undefined;
    const doc: SkillUsageDoc = {
      id: randomUUID(),
      tenantId,
      userOid,
      pane,
      promptSample,
      activeSkillNames,
      at: new Date().toISOString(),
    };
    const c = await copilotSkillUsageContainer();
    await c.items.create(doc);
  } catch {
    /* best-effort telemetry — never affect the turn */
  }
}

/**
 * Recent usage rows for one tenant, most-recent first, capped at `limit`.
 * Filters to rows on/after `sinceIso` when supplied. Single-partition query
 * (PK /tenantId). Returns the {@link UsageRow} shape the pure learner reads.
 */
export async function listRecentUsage(
  tenantId: string,
  sinceIso?: string,
  limit = 1000,
): Promise<UsageRow[]> {
  const tid = String(tenantId ?? '').trim();
  if (!tid) return [];
  const cap = Math.max(1, Math.min(5000, Number(limit) || 1000));
  const c = await copilotSkillUsageContainer();
  const params: SqlParameter[] = [{ name: '@t', value: tid }];
  let where = 'c.tenantId = @t';
  if (sinceIso) {
    where += ' AND c.at >= @since';
    params.push({ name: '@since', value: sinceIso });
  }
  const { resources } = await c.items
    .query<SkillUsageDoc>(
      {
        query: `SELECT TOP @lim c.pane, c.promptSample, c.activeSkillNames, c.at FROM c WHERE ${where} ORDER BY c.at DESC`,
        parameters: [...params, { name: '@lim', value: cap }],
      },
      { partitionKey: tid },
    )
    .fetchAll();
  return resources.map((r) => ({
    pane: r.pane,
    promptSample: r.promptSample,
    activeSkillNames: r.activeSkillNames,
    at: r.at,
  }));
}

/**
 * Distinct tenant ids that have usage rows on/after `sinceIso` — the set of
 * tenants the scheduled learner should scan. Cross-partition (an infrequent
 * admin/machine read), bounded by `maxTenants`.
 */
export async function listUsageTenantIds(sinceIso?: string, maxTenants = 200): Promise<string[]> {
  const cap = Math.max(1, Math.min(1000, Number(maxTenants) || 200));
  const c = await copilotSkillUsageContainer();
  const params: SqlParameter[] = [];
  let where = 'IS_DEFINED(c.tenantId)';
  if (sinceIso) {
    where += ' AND c.at >= @since';
    params.push({ name: '@since', value: sinceIso });
  }
  const { resources } = await c.items
    .query<{ tenantId: string }>(
      { query: `SELECT DISTINCT c.tenantId FROM c WHERE ${where}`, parameters: params },
    )
    .fetchAll();
  return resources
    .map((r) => String(r?.tenantId ?? '').trim())
    .filter(Boolean)
    .slice(0, cap);
}
