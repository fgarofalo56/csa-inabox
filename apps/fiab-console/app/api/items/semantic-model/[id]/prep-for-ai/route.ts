/**
 * /api/items/semantic-model/[id]/prep-for-ai — "Prep for AI" curation surface
 * (Fabric-parity G5), the Loom-native equivalent of Power BI's Prep-for-AI /
 * Verified Answers.
 *
 * Curates three things on a Loom-native semantic model, persisted Azure-native
 * on the Cosmos item (`state.prepForAi`) and consumed by the Loom data-agent
 * grounding path — NO Power BI / Microsoft Fabric dependency, no fabricWorkspaceId
 * gate (.claude/rules/no-fabric-dependency.md):
 *   1. AI data schema  — expose/hide tables + columns to AI (default-ON).
 *   2. AI instructions — grounding text the agent applies for this model.
 *   3. Verified Answers — curated NL → DAX pairs, each validated by ACTUALLY
 *      running the DAX read-only against the Azure-native tabular backend
 *      (Synapse serverless SQL by default; opt-in AAS XMLA) via evalDax — the
 *      SAME proven path the DAX-query view uses. No mocks (.claude/rules/no-vaporware.md).
 *
 *   GET                                   → { ok, prepForAi }
 *   POST { op:'save', aiInstructions?, schema? }        → persist curation
 *   POST { op:'upsert-answer', answer:{id?,question,dax} } → add/edit a Verified Answer
 *   POST { op:'verify-answer', id }        → run the DAX, record ok/at/note, persist
 *   POST { op:'delete-answer', id }        → remove a Verified Answer
 *
 * AUTH: owner-scoped — the caller's oid is threaded through readPrepForAi /
 * writePrepForAi (loadOwnedItem) and evalDax (listOwnedItems), so a caller can
 * only touch a model they own. Not gated on getSession alone.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { evalDax, TabularError } from '@/lib/azure/tabular-eval-client';
import { looksLikeDaxQuery } from '@/lib/semantic-model/semantic-link';
import { readPrepForAi, writePrepForAi } from '../../_lib/prep-for-ai-store';
import {
  normalizeSchema,
  normalizeVerifiedAnswer,
  upsertVerifiedAnswer,
  removeVerifiedAnswer,
  type PrepForAiState,
} from '../../_lib/prep-for-ai-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  op?: string;
  aiInstructions?: unknown;
  schema?: unknown;
  answer?: unknown;
  id?: unknown;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const { state, itemFound } = await readPrepForAi(id, session.claims.oid);
  if (!itemFound) return apiError('Semantic model not found or not owned by you.', 404);
  return apiOk({ prepForAi: state });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const tenantId = session.claims.oid;
  const body = (await req.json().catch(() => ({}))) as Body;
  const op = String(body?.op || '').trim();

  const { state: current, itemFound } = await readPrepForAi(id, tenantId);
  if (!itemFound) return apiError('Semantic model not found or not owned by you.', 404);

  // ── save: AI instructions + AI data schema (expose/hide flags) ──────────────
  if (op === 'save') {
    const next: PrepForAiState = {
      ...current,
      aiInstructions:
        body.aiInstructions === undefined
          ? current.aiInstructions
          : String(body.aiInstructions || '').slice(0, 15_000),
      schema: body.schema === undefined ? current.schema : normalizeSchema(body.schema),
    };
    const wrote = await writePrepForAi(id, tenantId, next);
    if (!wrote) return apiServerError(new Error('writePrepForAi returned false'), 'Failed to save Prep for AI settings.');
    return apiOk({ prepForAi: next, note: 'Prep for AI settings saved.' });
  }

  // ── upsert-answer: add / edit a Verified Answer (unverified until run) ───────
  if (op === 'upsert-answer') {
    const answer = normalizeVerifiedAnswer(body.answer);
    if (!answer) return apiError('A Verified Answer requires a non-empty question and DAX.', 400);
    if (!looksLikeDaxQuery(answer.dax)) {
      return apiError('The DAX must be an evaluatable query — start it with EVALUATE (or DEFINE … EVALUATE).', 400);
    }
    // Preserve the prior verification result when the DAX text is unchanged.
    const prior = current.verifiedAnswers.find((a) => a.id === answer.id);
    if (prior && prior.dax === answer.dax) {
      answer.lastVerifiedAt = prior.lastVerifiedAt;
      answer.lastVerifiedOk = prior.lastVerifiedOk;
      answer.lastVerifiedNote = prior.lastVerifiedNote;
    }
    const next = upsertVerifiedAnswer(current, answer);
    const wrote = await writePrepForAi(id, tenantId, next);
    if (!wrote) return apiServerError(new Error('writePrepForAi returned false'), 'Failed to save the Verified Answer.');
    return apiOk({ prepForAi: next, answer, note: `Saved Verified Answer "${answer.question}". Run it to verify.` });
  }

  // ── verify-answer: run the DAX against the real backend, record the result ───
  if (op === 'verify-answer') {
    const answerId = String(body.id || '').trim();
    const target = current.verifiedAnswers.find((a) => a.id === answerId);
    if (!target) return apiError('Verified Answer not found on this model.', 404);
    if (!looksLikeDaxQuery(target.dax)) {
      return apiError('The stored DAX is not an evaluatable query (must start with EVALUATE).', 400);
    }

    const now = new Date().toISOString();
    let ok = false;
    let note: string;
    let backend: string | undefined;
    try {
      const result = await evalDax(id, target.dax, tenantId);
      ok = true;
      backend = result.backend;
      note = `Verified against ${result.backend}: ${result.rows.length} row(s), ${result.columns.length} column(s).`;
    } catch (e) {
      ok = false;
      if (e instanceof TabularError) {
        backend = e.backend;
        note = `Not verified (${e.backend || 'tabular'}): ${e.message}`.slice(0, 500);
      } else {
        note = `Not verified: ${(e as Error)?.message || String(e)}`.slice(0, 500);
      }
    }

    const updated = { ...target, lastVerifiedAt: now, lastVerifiedOk: ok, lastVerifiedNote: note, updatedAt: now };
    const next = upsertVerifiedAnswer(current, updated);
    const wrote = await writePrepForAi(id, tenantId, next);
    if (!wrote) return apiServerError(new Error('writePrepForAi returned false'), 'Failed to persist the verification result.');
    return apiOk({ prepForAi: next, answer: updated, verified: ok, backend, note });
  }

  // ── delete-answer ───────────────────────────────────────────────────────────
  if (op === 'delete-answer') {
    const answerId = String(body.id || '').trim();
    if (!answerId) return apiError('id is required to delete a Verified Answer.', 400);
    const next = removeVerifiedAnswer(current, answerId);
    const wrote = await writePrepForAi(id, tenantId, next);
    if (!wrote) return apiServerError(new Error('writePrepForAi returned false'), 'Failed to delete the Verified Answer.');
    return apiOk({ prepForAi: next, note: 'Verified Answer deleted.' });
  }

  return apiError(`unknown op "${op}" — expected save | upsert-answer | verify-answer | delete-answer`, 400);
}
