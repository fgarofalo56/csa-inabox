/**
 * nl-governance-copilot — B-N14b: the natural-language GOVERNANCE copilot.
 *
 * Answers questions like "who can read PII in EU?" over this deployment's REAL
 * authorization + governance facts — the PDP's own inputs (the entitlement
 * ledger + live workspace ACLs), the tenant governance policy document, the
 * ODCS data-contract registry's authored column classifications, and the
 * Purview built-in classification catalog — by retrieving over the POLICY GRAPH
 * with the N11 GraphRAG primitives (see `policy-graphrag.ts`, which reuses them
 * rather than forking a second retriever).
 *
 * THE TWO NON-NEGOTIABLES:
 *
 *  1. EVERY ANSWER CITES ITS EDGES. The model is handed ONLY the numbered policy
 *     paths, and the returned {@link GovernanceAnswer} carries those same typed
 *     {@link GraphPathCitation}s. They flow into N10's Answer Receipt through the
 *     existing `graphPathCitations` field — no new receipt type, so an auditor
 *     reviewing a governance answer sees the exact grants/policies it rests on.
 *
 *  2. REFUSE, NEVER GUESS. If the graph produces no path that could support a
 *     claim, the copilot REFUSES with the honest reason and the model is never
 *     called. A partially-readable graph (a silo that failed to read) is
 *     disclosed on the answer — an authorization answer computed from an unknown
 *     subset of the grants is worse than no answer.
 *
 * FLAG0: behind the DEFAULT-ON kill switch {@link NL_GOVERNANCE_FLAG_ID}.
 * Honest gate: no AOAI deployment → the retrieval STILL runs and the cited
 * paths are returned with `gated:true` + the exact remediation, so the operator
 * gets the evidence even without a model (no-vaporware.md).
 *
 * Azure-native only (no-fabric-dependency.md). IL5: in-VNet Cosmos + in-VNet
 * AOAI, zero external egress — the whole capability runs disconnected.
 */

import { aoaiChat } from '@/lib/azure/aoai-chat-client';
import { resolveAoaiTarget, NoAoaiDeploymentError, type AoaiTarget } from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import type { GraphPathCitation } from '@/lib/azure/ontology-graphrag';
import { loadPolicyGraph } from '@/lib/governance/policy-graph-load';
import { retrievePolicyContext, type PolicyGraphRagResult } from '@/lib/governance/policy-graphrag';

/** FLAG0 runtime kill-switch id for the whole N14b path (default ON). */
export const NL_GOVERNANCE_FLAG_ID = 'n14b-nl-governance-copilot';

/** Why an answer was refused (never a model hallucination fallback). */
export type GovernanceRefusalReason =
  | 'flag-off'
  | 'empty-graph'
  | 'no-seed-match'
  | 'no-path'
  | 'model-refused';

/** The honest AOAI infra gate, surfaced verbatim by the route. */
export interface GovernanceAoaiGate {
  code: 'no_aoai';
  error: string;
  hint: string;
}

/** One governance answer + everything an auditor needs to check it. */
export interface GovernanceAnswer {
  question: string;
  /** The narrated answer. EMPTY when refused or gated. */
  answer: string;
  /** True when the copilot declined rather than guess. */
  refused: boolean;
  refusalReason?: GovernanceRefusalReason;
  /** Operator-readable explanation of the refusal / the evidence shortfall. */
  note?: string;
  /** The typed policy-edge citations the answer rests on (N10 receipt shape). */
  citations: GraphPathCitation[];
  /** Distinct node kinds the traversal touched (evidence breadth). */
  kindsTouched: string[];
  /** Nodes in the searched graph. */
  graphSize: number;
  /** Policy-graph nodes scanned while matching seeds. */
  scanned: number;
  /** Silos that could not be read — the answer is explicitly partial. */
  unavailable: Array<{ source: string; reason: string }>;
  /** Honest AOAI gate (retrieval still ran; `citations` are still populated). */
  gate?: GovernanceAoaiGate;
  /** Real elapsed ms: graph assembly + retrieval + model. */
  durationMs: number;
  /** Real ms of the graph assembly alone. */
  graphMs: number;
}

/** The refusal sentence the model is instructed to emit verbatim. */
export const REFUSAL_MARKER = 'INSUFFICIENT_POLICY_EVIDENCE';

/** System prompt — refuse-not-guess is the FIRST rule, not a footnote. */
export function buildGovernanceSystemPrompt(contextText: string, partial: boolean): string {
  return [
    'You are the CSA Loom GOVERNANCE copilot. You answer questions about WHO can access WHAT data, ' +
      'under WHICH policies, with WHICH sensitivity classifications, in WHICH regions — for this ' +
      'deployment only. CSA Loom is an Azure-native data platform (not Microsoft Fabric).',
    '',
    'ABSOLUTE RULES:',
    `1. Answer ONLY from the policy paths below. If they do not establish the answer, reply with exactly "${REFUSAL_MARKER}" followed by one sentence naming what evidence is missing. NEVER guess, never generalize from what is typical, never infer an unlisted grant.`,
    '2. Cite the numbered path(s) each claim rests on, inline, as [path N].',
    '3. Name principals, roles, assets, columns, classifications, and regions EXACTLY as they appear on the paths.',
    '4. An access answer must be conservative: a principal is only "able to read" something when a path actually shows a grant reaching it.',
    ...(partial
      ? ['5. Part of the governance data could not be read this call. Say so plainly in your answer — the list you give may be incomplete.']
      : []),
    '',
    contextText,
  ].join('\n');
}

export interface AskGovernanceOptions {
  question: string;
  /** The tenant partition to read the governance silos from (session oid). */
  tenantId: string;
  /** Pre-resolved AOAI target (route already surfaced its gate). */
  target?: AoaiTarget;
  /** Traversal depth override (tests). */
  maxHops?: number;
}

/**
 * Answer a governance question. Never throws for a backend problem — a
 * refusal or an honest gate is always returned so the surface has something
 * truthful to render.
 */
export async function askGovernance(opts: AskGovernanceOptions): Promise<GovernanceAnswer> {
  const started = Date.now();
  const question = String(opts.question || '').trim();
  const shell = (extra: Partial<GovernanceAnswer>): GovernanceAnswer => ({
    question,
    answer: '',
    refused: true,
    citations: [],
    kindsTouched: [],
    graphSize: 0,
    scanned: 0,
    unavailable: [],
    durationMs: Date.now() - started,
    graphMs: 0,
    ...extra,
  });

  if (!(await runtimeFlag(NL_GOVERNANCE_FLAG_ID))) {
    return shell({
      refusalReason: 'flag-off',
      note: 'The NL governance copilot is switched off for this deployment (Admin → Runtime flags → n14b-nl-governance-copilot). Every other governance surface is unaffected.',
    });
  }

  // ── Retrieval over the REAL policy graph ─────────────────────────────────
  const loaded = await loadPolicyGraph(opts.tenantId);
  const graphMs = loaded.durationMs;
  const retrieved: PolicyGraphRagResult = retrievePolicyContext({
    question,
    graph: loaded.graph,
    maxHops: opts.maxHops,
  });

  const common = {
    citations: retrieved.paths,
    kindsTouched: retrieved.kindsTouched,
    graphSize: retrieved.graphSize,
    scanned: retrieved.scanned,
    unavailable: loaded.unavailable,
    graphMs,
  };

  if (!retrieved.ok) {
    return shell({
      ...common,
      refusalReason: retrieved.graphSize === 0 ? 'empty-graph' : 'no-seed-match',
      note: retrieved.note || 'The policy graph could not ground this question.',
    });
  }
  if (retrieved.paths.length === 0) {
    return shell({
      ...common,
      refusalReason: 'no-path',
      note:
        retrieved.note ||
        'The question matched governance entities, but no policy edge connects them — refusing rather than inferring a relationship that is not recorded.',
    });
  }

  // ── Model turn (honest gate keeps the evidence visible) ───────────────────
  let target = opts.target;
  if (!target) {
    try {
      const cfg = await loadTenantCopilotConfig(opts.tenantId).catch(() => null);
      target = await resolveAoaiTarget(cfg);
    } catch (e: unknown) {
      return shell({
        ...common,
        refused: false,
        note: 'Azure OpenAI is not wired in this deployment, so the evidence below is returned uninterpreted.',
        gate: {
          code: 'no_aoai',
          error:
            e instanceof NoAoaiDeploymentError ? e.message : e instanceof Error ? e.message : String(e),
          hint:
            'Set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT, or pick a chat deployment under ' +
            'Admin → Tenant settings → Copilot & Agents (deploy the AI Foundry project — ' +
            'platform/fiab/bicep/modules/ai/foundry-project.bicep, agentFoundryEnabled=true).',
        },
      });
    }
  }

  let raw = '';
  try {
    raw = await aoaiChat({
      target,
      temperature: 0,
      taskClass: 'reasoning',
      messages: [
        { role: 'system', content: buildGovernanceSystemPrompt(retrieved.contextText, loaded.unavailable.length > 0) },
        { role: 'user', content: question },
      ],
    });
  } catch (e: unknown) {
    return shell({
      ...common,
      refusalReason: 'model-refused',
      note: `The governance model turn failed: ${e instanceof Error ? e.message : String(e)}. The cited policy paths below are still the real evidence retrieved for this question.`,
    });
  }

  const text = String(raw || '').trim();
  if (!text || text.includes(REFUSAL_MARKER)) {
    return shell({
      ...common,
      refusalReason: 'model-refused',
      note:
        text.replace(REFUSAL_MARKER, '').trim() ||
        'The retrieved policy paths do not establish an answer to this question.',
    });
  }

  return {
    question,
    answer: text,
    refused: false,
    ...common,
    unavailable: loaded.unavailable,
    durationMs: Date.now() - started,
  };
}
