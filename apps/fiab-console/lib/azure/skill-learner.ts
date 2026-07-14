/**
 * skill-learner.ts — CTS-11 skill self-evolution JOB (Azure-backed).
 *
 * WHAT THIS IS
 * ------------
 * The per-tenant learner run. It pulls recent Copilot USAGE telemetry
 * (lib/azure/skill-usage.ts) + the tenant's existing skills (lib/azure/skill-store.ts),
 * runs the PURE clustering core (lib/copilot/skill-learner-core.ts) to find
 * recurring usage gaps no skill covers, and for each proposal-worthy gap asks
 * AOAI to draft a candidate skill grounded ONLY in the observed pattern. Each
 * draft is persisted as a SUGGESTED skill (scope `suggested:<tid>`, status
 * 'suggested') — inert until a tenant admin reviews + PROMOTES it.
 *
 * ADMIN-REVIEWED + OPT-IN
 * -----------------------
 * Nothing here publishes a skill or injects anything into a turn. A suggestion is
 * only ever surfaced in the admin review queue (/api/copilot/skills/suggested).
 *
 * FAIL-OPEN
 * ---------
 * Per-tenant AND per-gap: one bad gap (AOAI error, malformed draft) is skipped,
 * never failing the run. The scheduled route calls this once per tenant; a
 * throwing tenant does not abort the others.
 *
 * NO-VAPORWARE / NO-FABRIC-DEPENDENCY
 * -----------------------------------
 * Real Cosmos reads/writes + a real AOAI call (aoai-chat-client). No mock data.
 * Azure-native throughout — Cosmos + Azure OpenAI via the Console UAMI; no Fabric.
 */

import { listRecentUsage } from '@/lib/azure/skill-usage';
import {
  listSkills,
  listSuggestedSkills,
  createSuggestedSkill,
  type SuggestedSkillDraft,
  type SkillProvenance,
} from '@/lib/azure/skill-store';
import {
  extractKeywordSignals,
  shouldProposeSkill,
  type SkillGap,
} from '@/lib/copilot/skill-learner-core';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';

/** Report of one tenant's learner run. */
export interface SkillLearnerReport {
  tenantId: string;
  /** Whether the learner ran (false when disabled or no usage). */
  ran: boolean;
  /** Reason it was a no-op (when ran === false). */
  reason?: string;
  /** Usage rows scanned. */
  scanned: number;
  /** Candidate gaps the core surfaced. */
  gaps: number;
  /** Suggestions persisted this run. */
  proposed: number;
  /** Names of the drafted suggestions (for the receipt). */
  proposedNames: string[];
}

/** Whether the learner is enabled (default ON; opt-out via LOOM_SKILL_LEARNER_ENABLED=false). */
export function skillLearnerEnabled(): boolean {
  return (process.env.LOOM_SKILL_LEARNER_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function minSamples(): number {
  const v = Number(process.env.LOOM_SKILL_LEARNER_MIN_SAMPLES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 5;
}

function maxProposalsPerRun(): number {
  const v = Number(process.env.LOOM_SKILL_LEARNER_MAX_PROPOSALS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 3;
}

/** The lookback window (30 days) for the usage scan. */
const WINDOW_DAYS = 30;

/** Shape the model must return for a drafted candidate skill. */
interface DraftReply {
  name?: string;
  whenToUse?: string;
  guidance?: string;
  toolNames?: string[];
}

/** Ask AOAI to draft ONE candidate skill grounded strictly in the gap. */
async function draftSkillForGap(gap: SkillGap): Promise<SuggestedSkillDraft | null> {
  const system =
    'You draft a single reusable Copilot "skill" for the CSA Loom data platform, grounded STRICTLY in an ' +
    'observed usage pattern. A skill is best-practice system guidance the assistant loads when a user works ' +
    'on a specific pane. Rules: (1) Ground the skill ONLY in the observed keywords + sample prompts — invent ' +
    'nothing. (2) The guidance must be concrete, actionable, Azure-native, and reference only REAL tools/ ' +
    'workflows implied by the samples — no vaporware, no Fabric dependency. (3) Return STRICT JSON with keys: ' +
    'name (short title), whenToUse (one line), guidance (2-6 sentences of system text), toolNames (array of ' +
    'likely real tool names, may be empty). No prose outside the JSON.';
  const user = JSON.stringify({
    pane: gap.pane,
    recurringKeywords: gap.keywords,
    sampleCount: gap.sampleCount,
    samplePrompts: gap.samplePrompts,
  });
  let reply: DraftReply;
  try {
    reply = await aoaiChatJson<DraftReply>({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Observed pattern (JSON):\n${user}\n\nDraft the skill as strict JSON.` },
      ],
      taskClass: 'general',
      maxCompletionTokens: 900,
    });
  } catch {
    return null; // AOAI unconfigured / error — skip this gap (fail-open)
  }
  const name = String(reply?.name ?? '').trim();
  const guidance = String(reply?.guidance ?? '').trim();
  if (!name || !guidance) return null; // malformed draft — skip
  const toolNames = Array.isArray(reply?.toolNames)
    ? reply.toolNames.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    name,
    whenToUse: String(reply?.whenToUse ?? '').trim(),
    guidance,
    // Panes are FORCED to the observed pane — the model never widens the scope.
    panes: [gap.pane],
    toolNames,
    category: 'Suggested',
    tags: gap.keywords.slice(0, 6),
  };
}

/**
 * Run the CTS-11 learner for ONE tenant. Pulls recent usage + existing skills,
 * finds gaps, drafts + persists SUGGESTED skills for the proposal-worthy ones.
 * Fail-open per gap. Returns a report; NEVER throws for an expected empty/gated
 * state (returns ran:false with a reason instead).
 */
export async function runSkillLearner(tenantId: string): Promise<SkillLearnerReport> {
  const tid = String(tenantId ?? '').trim();
  const base: SkillLearnerReport = { tenantId: tid, ran: false, scanned: 0, gaps: 0, proposed: 0, proposedNames: [] };
  if (!tid) return { ...base, reason: 'no tenantId' };
  if (!skillLearnerEnabled()) return { ...base, reason: 'learner disabled (LOOM_SKILL_LEARNER_ENABLED=false)' };

  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  let usage: Awaited<ReturnType<typeof listRecentUsage>>;
  try {
    usage = await listRecentUsage(tid, sinceIso, 1000);
  } catch (e: any) {
    return { ...base, reason: `usage read failed: ${e?.message || e}` };
  }
  if (usage.length === 0) return { ...base, ran: true, reason: 'no recent usage' };

  // Existing published skills + already-pending suggestions define what is
  // "covered" — so we never re-propose a pane/skill that already exists.
  let existingPanes: string[] = [];
  let existingNames: string[] = [];
  try {
    const [published, pending] = await Promise.all([listSkills(tid), listSuggestedSkills(tid)]);
    for (const sk of [...published, ...pending]) {
      existingNames.push(sk.name);
      for (const p of sk.panes ?? []) existingPanes.push(String(p).toLowerCase());
    }
  } catch {
    /* fail-open — a store hiccup just means less de-duplication this run */
  }

  const gaps = extractKeywordSignals(usage, {
    coveredPanes: existingPanes,
    existingSkillNames: existingNames,
  }).filter((g) => shouldProposeSkill(g, { minSamples: minSamples() }));

  const cap = maxProposalsPerRun();
  const proposedNames: string[] = [];
  for (const gap of gaps.slice(0, cap)) {
    try {
      const draft = await draftSkillForGap(gap);
      if (!draft) continue;
      const provenance: SkillProvenance = {
        keywords: gap.keywords,
        sampleCount: gap.sampleCount,
        pane: gap.pane,
        samplePrompts: gap.samplePrompts,
      };
      const suggestion = await createSuggestedSkill(tid, draft, provenance);
      proposedNames.push(suggestion.name);
    } catch {
      /* one bad gap must not fail the run (fail-open) */
    }
  }

  return {
    tenantId: tid,
    ran: true,
    scanned: usage.length,
    gaps: gaps.length,
    proposed: proposedNames.length,
    proposedNames,
  };
}
