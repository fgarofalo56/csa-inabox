/**
 * POST /api/copilot/memory/flush — "Dump conversation to long-term memory"
 * (CTS-06). Extracts durable facts/preferences from the recent conversation and
 * persists them to the user's long-term memory so a later session recalls them.
 *
 * Real backend, no new infra: reuses the AIF-14 agent-memory extractor
 * (extractAndStoreMemory → a single AOAI summarize call → the Cosmos
 * `loom-agent-memory` container, PK /agentId, docType:'memory'). The cross-item
 * Copilot's user memory lives under a stable agent bucket (LOOM_COPILOT_MEMORY_AGENT_ID,
 * default 'loom-copilot'); facts are keyed by the caller's own oid, so this is a
 * strictly user-scoped write (no cross-user access — getSession authz matches the
 * notebook-assist Copilot sibling).
 *
 *   → { messages:[{role,content}] }              (the visible conversation)
 *   ← { ok:true, stored:number, facts:string[] } (0 stored when nothing durable)
 *   ← { ok:true, stored:0, disabled:true }        (admin kill-switch off)
 *   ← { ok:false, code:'no_aoai', error, hint }   (503 honest gate)
 *
 * Default-ON / opt-out: enabled unless an admin sets LOOM_COPILOT_MEMORY to a
 * falsy value on the Container App. Azure-native; no Fabric / Power BI host.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { flushConversationToMemory } from '@/lib/azure/memory-flush';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import {
  splitConversation,
  isCopilotMemoryEnabled,
  flushWindow,
} from '@/lib/copilot/memory-flush';
import type { MemoryActor } from '@/lib/copilot/memory-types';
import { withSession } from '@/lib/api/route-toolkit';

interface FlushBody {
  messages?: unknown;
  /** Optional session id for provenance on each stored fact. */
  sessionId?: unknown;
  /** Optional workspace id — when present, facts are written to WORKSPACE scope
   *  (shared) instead of the caller's private USER scope. */
  workspaceId?: unknown;
  /** When true with a workspaceId, write to the shared workspace scope. */
  shareToWorkspace?: unknown;
}

export const POST = withSession(async (req: NextRequest, { session }) => {

  if (!isCopilotMemoryEnabled()) {
    return apiOk({ stored: 0, facts: [] as string[], disabled: true });
  }

  let body: FlushBody = {};
  try {
    body = (await req.json()) as FlushBody;
  } catch {
    /* fall through to validation */
  }

  const folded = splitConversation(body.messages, flushWindow());
  if (!folded) {
    return apiError('messages is required (the conversation to remember)', 400);
  }

  const userOid = session.claims.oid || session.claims.upn || session.claims.email || '';
  if (!userOid) return apiUnauthorized('no user identity on session');

  // Honest 503 gate: extractAndStoreMemory swallows AOAI errors (best-effort in
  // the run path), so pre-resolve the target to surface a missing deployment.
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
  try {
    await resolveAoaiTarget(tenantConfig);
  } catch (e: unknown) {
    const hint =
      e instanceof NoAoaiDeploymentError
        ? e.message
        : 'AOAI not configured: set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT, or pick a chat ' +
          'deployment under Admin → Tenant settings → Copilot & Agents.';
    return apiError(e instanceof Error ? e.message : String(e), 503, { code: 'no_aoai', hint });
  }

  try {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 200) : undefined;
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.slice(0, 200) : undefined;
    // WORKSPACE (shared) scope only when explicitly requested AND a workspace is
    // supplied — the guard derives the scopeKey from this actor, never the client.
    const shareToWorkspace = body.shareToWorkspace === true && !!workspaceId;
    const actor: MemoryActor = {
      userOid,
      tenantId: session.claims.tid,
      workspaceId: shareToWorkspace ? workspaceId : undefined,
    };
    const result = await flushConversationToMemory({
      actor,
      question: folded.question,
      answer: folded.answer,
      sessionId,
    });
    return apiOk({ stored: result.stored, rejected: result.rejected, facts: result.facts });
  } catch (e) {
    return apiServerError(e, 'could not save conversation to memory', 'memory_flush_failed');
  }
});
