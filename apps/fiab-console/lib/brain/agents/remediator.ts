/**
 * LOOM BRAIN — the REMEDIATOR. Drafts a fix. Cannot apply one.
 *
 * PRP §3.3: *"Remediator — drafts the PR or the ARM call. **Output is a
 * proposal, never an action.**"* PRP §1 decision 1 gives the measured reason:
 * of the 13 Container App environments visible across these six subscriptions,
 * **one** is Loom's. The other twelve are the operator's blog, Sentinel, two
 * Atlas estates and more. An autonomous mutation on a wrong ownership inference
 * does not cost a rollback — it destroys someone else's production.
 *
 * ── "STRUCTURALLY INCAPABLE OF EXECUTING" — WHAT THAT MEANS HERE ───────────
 * Four independent properties, each checkable:
 *
 *   1. THE TYPE. Every draft carries a {@link RemediationProposal} built through
 *      the substrate's `proposal()` constructor, which supplies
 *      `requiresHumanApproval: true` and `mutatesAzure: false` as LITERAL types.
 *      There is no assignment in TypeScript that produces a self-approving
 *      proposal; the substrate's build-checked assertions fail `next build` if
 *      anyone widens those fields to `boolean`.
 *   2. THE VALUE. A draft is plain JSON — strings, booleans, arrays. It holds no
 *      function, no thunk, no promise, no class instance. {@link isPureData}
 *      proves it by traversal, and a test round-trips every draft through
 *      `JSON.parse(JSON.stringify(...))` and deep-compares.
 *   3. THE MODULE. Nothing in `lib/brain/agents/**` other than `model-client.ts`
 *      reaches the network at all, and `model-client.ts` reaches exactly one
 *      thing: a chat completion. There is no ARM client, no `az`, no `fetch` in
 *      this directory. `__tests__/agents/no-azure-mutation.test.ts` scans the
 *      directory's source with an embedded control that proves the scan fires.
 *   4. THE SHAPE OF THE FIELD. `proposedChange` is a `string`. Rendering it is
 *      the only thing any consumer can do with it.
 *
 * ── THE DESTRUCTIVE-COMMAND FLAG IS NOT A BLOCK ────────────────────────────
 * `containsDestructiveCommand` blocks nothing, because there is nothing here to
 * block — the text never executes. It exists so the surface that renders a draft
 * can warn a human BEFORE they paste it into a terminal, which is the moment the
 * text stops being data. Stating that honestly matters: a flag described as a
 * safety control it is not is the kind of guard this repo keeps finding.
 */

import { proposal, type Finding, type RemediationProposal, type SkippedSubject } from '../types';
import {
  makeAgentPopulation,
  mergeUsage,
  zeroUsage,
  type AgentResult,
  type Critique,
  type RemediationDraft,
} from './contracts';
import { invokeModel, requestFor, type BrainModelClient } from './model-client';
import { usageForCall, usageForFailedCall } from './tokens';

// ---------------------------------------------------------------------------
// §Destructive-command detection
// ---------------------------------------------------------------------------

/**
 * Commands that would remove or overwrite something if a human ran them.
 *
 * Named patterns rather than one regex so a match can say WHICH shape it saw.
 * The list is not claimed to be exhaustive — an unlisted destructive command is
 * simply unflagged, and since nothing executes, an unflagged draft is no more
 * dangerous than a flagged one; it is only less well signposted.
 */
export const DESTRUCTIVE_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'az-delete', re: /\baz\s+[a-z-]+(?:\s+[a-z-]+)?\s+delete\b/i },
  { name: 'az-purge', re: /\baz\s+[a-z-]+(?:\s+[a-z-]+)?\s+purge\b/i },
  { name: 'powershell-remove', re: /\bRemove-Az[A-Za-z]+\b/ },
  { name: 'terraform-destroy', re: /\bterraform\s+destroy\b/i },
  { name: 'kubectl-delete', re: /\bkubectl\s+delete\b/i },
  { name: 'sql-drop', re: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i },
  { name: 'rm-rf', re: /\brm\s+-[a-z]*[rR][a-z]*f\b/ },
  { name: 'force-push', re: /\bgit\s+push\b[^\n]*\s(?:--force|-f)\b/i },
];

/** Which destructive shapes appear in a draft's text. Empty means none matched. */
export function destructiveMatchesIn(text: string): string[] {
  return DESTRUCTIVE_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

// ---------------------------------------------------------------------------
// §Purity
// ---------------------------------------------------------------------------

/**
 * True iff `v` is plain, inert data all the way down.
 *
 * Rejects functions, class instances, Promises, Dates, Maps, Sets and anything
 * else with a prototype other than `Object.prototype` — because "the output is
 * data" is only a guarantee if it holds for the whole object graph. A single
 * callable nested three levels deep would make the claim false, and it would be
 * invisible in a rendered view.
 *
 * Exported so a consumer can assert it at a boundary, not only a test.
 */
export function isPureData(v: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return true;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return false;
  if (Array.isArray(v)) return v.every((x) => isPureData(x, depth + 1));
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v as Record<string, unknown>).every((x) => isPureData(x, depth + 1));
  }
  return false;
}

// ---------------------------------------------------------------------------
// §The model half
// ---------------------------------------------------------------------------

const REMEDIATOR_SYSTEM = [
  'You are the Remediator in an Azure estate-analysis system. You DRAFT a fix for one finding.',
  'Your output is text that a human reads, reviews and decides about. Nothing you write is',
  'executed by this system.',
  '',
  'Rules:',
  '- Write the change as a concrete artifact: a unified diff, a bicep edit, or an exact command.',
  '- Name real file paths and symbols ONLY if they appear in the evidence you were given.',
  '- Never invent a resource name, resource group, subscription or id.',
  '- Prefer the least destructive change that addresses the cause. Where the finding is a wire',
  '  that was never connected, the fix is to connect it — not to delete the thing it points at.',
  '- If the evidence does not support any specific change, say what would need to be measured',
  '  first and propose that instead.',
  '- State explicitly that the change requires human review before it is applied.',
  '',
  'Reply with JSON only: {"summary":"...","change":"..."}',
  'summary is one line. change is the artifact, and may be multi-line.',
].join('\n');

function remediatorUserPrompt(f: Finding, critique?: Critique): string {
  const lines = [
    `finding: ${f.title}`,
    `summary: ${f.summary}`,
    `detector: ${f.detector} severity: ${f.severity} confidence: ${f.confidence}`,
    `query: ${f.evidence.query}`,
    `population: ${f.population.scope}`,
    `subjects: ${f.subjects.length}`,
    `evidence notes: ${f.evidence.notes.length ? f.evidence.notes.join(' | ') : '(none)'}`,
    `detector's own proposal: ${f.remediation.summary}`,
    `detector's own change: ${f.remediation.proposedChange}`,
  ];
  if (critique) {
    lines.push(`critic verdict: ${critique.verdict} (confidence now ${critique.resultingConfidence})`);
    for (const r of critique.deterministic) lines.push(`critic [${r.severity}] ${r.code}: ${r.statement}`);
  }
  return lines.join('\n');
}

/** Read the reply, DEFENSIVELY. Either field missing falls back to the detector's own. */
export function parseDraft(json: unknown): { summary: string | null; change: string | null } {
  const o = (json ?? {}) as Record<string, unknown>;
  return {
    summary: typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim().slice(0, 300) : null,
    change: typeof o.change === 'string' && o.change.trim() ? o.change.trim().slice(0, 6000) : null,
  };
}

// ---------------------------------------------------------------------------
// §The agent
// ---------------------------------------------------------------------------

/**
 * Build the proposal for one finding.
 *
 * `proposal()` — the substrate's ONLY constructor — supplies the two literals.
 * There is deliberately no code path in this module that constructs a
 * `RemediationProposal` object literal by hand, because a hand-written literal
 * is where `requiresHumanApproval: false` would first become typeable.
 */
function buildProposal(f: Finding, drafted: { summary: string | null; change: string | null }): RemediationProposal {
  const summary = drafted.summary ?? f.remediation.summary;
  const change = drafted.change ?? f.remediation.proposedChange;
  return proposal(
    summary,
    `${change}\n\n--- This is a PROPOSAL. It requires human review and approval. Nothing in Loom Brain applies it. ---`,
  );
}

export interface RemediatorInput {
  readonly findings: readonly Finding[];
  readonly critiques?: ReadonlyMap<string, Critique>;
  readonly client?: BrainModelClient;
}

/**
 * Draft a fix for every finding.
 *
 * With no model, every draft is still produced — carrying the detector's own
 * `remediation`, which is required on a `Finding` and therefore always present.
 * The Remediator's model half enriches a draft; it is never the only thing
 * standing between a finding and a remediation.
 */
export async function draftRemediations(
  input: RemediatorInput,
): Promise<AgentResult<readonly RemediationDraft[]>> {
  const drafts: RemediationDraft[] = [];
  const skipped: SkippedSubject[] = [];
  let usage = zeroUsage();
  let consulted = 0;
  let unavailable = 0;

  for (const f of input.findings) {
    const critique = input.critiques?.get(f.id);
    const req = requestFor('remediator', REMEDIATOR_SYSTEM, remediatorUserPrompt(f, critique));
    const outcome = await invokeModel(input.client, req);

    let drafted: { summary: string | null; change: string | null } = { summary: null, change: null };
    if (outcome.ok) {
      drafted = parseDraft(outcome.reply.json);
      consulted += 1;
      usage = mergeUsage(
        usage,
        usageForCall({
          tier: req.tier,
          system: req.system,
          user: req.user,
          replyJson: outcome.reply.json,
          reported: outcome.reply.usage,
        }),
      );
    } else {
      unavailable += 1;
      skipped.push({ subject: f.id, reason: `remediator model unavailable: ${outcome.error}` });
      if (input.client) {
        usage = mergeUsage(
          usage,
          usageForFailedCall({ tier: req.tier, system: req.system, user: req.user }),
        );
      }
    }

    const p = buildProposal(f, drafted);
    const matches = destructiveMatchesIn(`${p.summary}\n${p.proposedChange}`);
    drafts.push({
      findingId: f.id,
      proposal: p,
      containsDestructiveCommand: matches.length > 0,
      destructiveMatches: matches,
      degraded: drafted.change === null,
    });
  }

  return {
    agent: 'remediator',
    result: drafts,
    population: makeAgentPopulation({
      subject: 'findings',
      findings: input.findings,
      scope:
        `${input.findings.length} finding(s) drafted; every draft is a RemediationProposal with ` +
        `requiresHumanApproval=true and mutatesAzure=false pinned as literal types`,
      modelConsulted: consulted,
      modelUnavailable: unavailable,
    }),
    usage,
    skipped,
  };
}
