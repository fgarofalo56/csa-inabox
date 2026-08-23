/**
 * LOOM BRAIN — the EXPLAINER. A finding, turned into something an operator reads.
 *
 * ── THE SPLIT THAT MAKES THE OUTPUT TRUSTWORTHY ────────────────────────────
 * A {@link Narrative} has two parts and only one of them is model-authored:
 *
 *   `evidenceBlock`  built ENTIRELY from the finding's own fields. Present on
 *                    every narrative, including a fully degraded one. A model
 *                    never writes a character of it.
 *   `modelProse`     the readable framing. `null` when no model answered.
 *
 * `body` is prose-then-evidence, so what a reader sees always ENDS in facts that
 * were measured. Nothing about the evidence a reader is shown depends on a model
 * having behaved.
 *
 * ── THE NUMBER GUARD ───────────────────────────────────────────────────────
 * The cheapest way for readable prose to become a false claim is a number that
 * was never measured — "23 of 63 apps" when the finding established neither 23
 * nor 63. So every numeric token in the model's prose is checked against the
 * numbers it was actually GIVEN (the prompt plus the evidence block), and
 * anything left over lands in {@link Narrative.unverifiedNumbers}.
 *
 * Two deliberate properties of that check:
 *   • It flags DERIVED numbers too. If the model is told 23 and 63 and writes
 *     "37%", the 37 is flagged — correctly. A percentage the model computed is
 *     not an established fact, and this system's whole premise is that a
 *     confident number needs a measurement behind it.
 *   • It does not silently delete the prose. Suppressing the sentence would hide
 *     that the model hallucinated; surfacing the token lets a reviewer see it.
 *
 * The guard is deliberately blind to number words ("nine", "a dozen"). That is a
 * stated limitation, not an oversight — a guard whose limits are written down is
 * a guard; one whose limits are assumed is a liability.
 */

import { formatCostFigure, type Finding, type SkippedSubject } from '../types';
import { EDGE_PROVENANCES } from '../types';
import {
  makeAgentPopulation,
  mergeUsage,
  zeroUsage,
  type AgentResult,
  type Critique,
  type Narrative,
} from './contracts';
import { invokeModel, requestFor, type BrainModelClient } from './model-client';
import { usageForCall, usageForFailedCall } from './tokens';

// ---------------------------------------------------------------------------
// §The deterministic evidence block
// ---------------------------------------------------------------------------

/**
 * The receipt. Built from the finding alone; never model-authored.
 *
 * The population line comes FIRST, before the finding's own claim, because that
 * is the order in which the two should be read: what was examined, then what was
 * concluded. A blind population is called out in capitals on its own line — a
 * reader must not have to notice `examined=0` inside a sentence.
 *
 * A cost is always rendered through `formatCostFigure`, which attaches "DERIVED
 * estimate — not a bill" to every derived figure. Interpolating `amountUsd`
 * directly is how a derived number reaches an operator looking like a bill.
 */
export function evidenceBlock(f: Finding, critique?: Critique): string {
  const lines: string[] = [];
  lines.push('EVIDENCE (measured — not model-authored)');
  lines.push(`  detector      : ${f.detector}`);
  lines.push(`  severity      : ${f.severity}`);
  lines.push(`  query         : ${f.evidence.query}`);
  lines.push(`  population    : ${f.population.scope}`);
  lines.push(
    `  examined      : ${f.population.examined} node(s), ${f.population.edgesExamined} edge(s) ` +
      `(subject: ${f.population.subject})`,
  );
  if (f.population.blind) {
    lines.push('  ** POPULATION IS BLIND — the examined set was EMPTY. This establishes nothing. **');
  }
  lines.push(
    `  edges by prov.: ` +
      EDGE_PROVENANCES.map((p) => `${p}=${f.population.byProvenance[p] ?? 0}`).join(' '),
  );
  lines.push(`  subjects      : ${f.subjects.length}`);
  lines.push(`  evidence chain: ${f.evidence.nodes.length} node id(s), ${f.evidence.edges.length} edge id(s)`);
  for (const n of f.evidence.notes) lines.push(`  note          : ${n}`);
  lines.push(`  cost          : ${f.cost ? formatCostFigure(f.cost) : '(none established)'}`);
  lines.push(`  confidence    : ${f.confidence} (as declared by the detector)`);
  if (critique) {
    lines.push(`  critic verdict: ${critique.verdict} → confidence ${critique.resultingConfidence}`);
    for (const r of critique.deterministic) {
      lines.push(`  critic [${r.severity}] ${r.code}: ${r.statement}`);
    }
    for (const c of critique.modelChallenges) {
      lines.push(`  challenge     : ${c.claim}${c.checkable ? ` — check: ${c.checkable}` : ''}`);
    }
    if (!critique.modelConsulted) {
      lines.push('  critic model  : NOT CONSULTED — measured checks only');
    }
  }
  lines.push(`  remediation   : ${f.remediation.summary}`);
  lines.push(
    `  approval      : requiresHumanApproval=${f.remediation.requiresHumanApproval}, ` +
      `mutatesAzure=${f.remediation.mutatesAzure}`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// §The number guard
// ---------------------------------------------------------------------------

const NUMBER_RE = /\d+(?:\.\d+)?/g;

/** Every numeric token in a string, as written. */
function numbersIn(text: string): string[] {
  return text.match(NUMBER_RE) ?? [];
}

/**
 * Numeric tokens in `prose` that do not appear anywhere in `given`.
 *
 * Comparison is on the token as WRITTEN, after stripping a trailing `.0`-style
 * zero so `2` and `2.0` are the same number. It is deliberately not a numeric
 * comparison across the whole allowlist: "1" appearing inside "2026-08-23" is a
 * substring, not a number the model was given, and matching on tokens rather
 * than substrings is what keeps this from silently allowing everything.
 */
export function unverifiedNumbers(prose: string, given: string): string[] {
  const allow = new Set(numbersIn(given).map(normalizeNumberToken));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of numbersIn(prose)) {
    const n = normalizeNumberToken(raw);
    if (allow.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(raw);
  }
  return out;
}

function normalizeNumberToken(t: string): string {
  if (!t.includes('.')) return t.replace(/^0+(?=\d)/, '');
  const trimmed = t.replace(/0+$/, '').replace(/\.$/, '');
  return (trimmed || '0').replace(/^0+(?=\d)/, '');
}

// ---------------------------------------------------------------------------
// §The model half
// ---------------------------------------------------------------------------

const EXPLAINER_SYSTEM = [
  'You are the Explainer in an Azure estate-analysis system. You are given ONE finding and the',
  'measured evidence behind it. Write a short, plain explanation for an operator.',
  '',
  'Rules — these are not style preferences:',
  '- Use ONLY numbers that appear in the text you were given. Never compute a new one, never',
  '  estimate, never round into a new figure. Numbers you invent are detected and flagged.',
  '- Never state a cause the evidence does not establish. If the evidence shows a correlation',
  '  and not a cause, say so.',
  '- If the population is marked BLIND, lead with that: the finding establishes nothing.',
  '- Never describe a cost as a bill. The figures here are estimates of a price.',
  '- No preamble, no headings, no bullet points. Two to four sentences.',
  '',
  'Reply with JSON only: {"headline":"...","prose":"..."}',
  'The headline is at most 90 characters and states the situation, not a recommendation.',
].join('\n');

function explainerUserPrompt(f: Finding, block: string): string {
  return [`title: ${f.title}`, `summary: ${f.summary}`, '', block].join('\n');
}

/** Read the reply, DEFENSIVELY. A missing or non-string field is simply absent. */
export function parseNarrative(json: unknown): { headline: string | null; prose: string | null } {
  const o = (json ?? {}) as Record<string, unknown>;
  const headline = typeof o.headline === 'string' && o.headline.trim() ? o.headline.trim().slice(0, 200) : null;
  const prose = typeof o.prose === 'string' && o.prose.trim() ? o.prose.trim().slice(0, 2000) : null;
  return { headline, prose };
}

// ---------------------------------------------------------------------------
// §The agent
// ---------------------------------------------------------------------------

export interface ExplainerInput {
  readonly findings: readonly Finding[];
  /** Critiques by finding id, so the narrative carries the review it survived. */
  readonly critiques?: ReadonlyMap<string, Critique>;
  readonly client?: BrainModelClient;
}

/**
 * Narrate every finding.
 *
 * A model failure degrades ONE narrative and nothing else: the evidence block is
 * already built, `modelProse` becomes `null`, `degraded` becomes true, and the
 * population's `modelUnavailable` count goes up. The report is still complete
 * and still true — it is only less pleasant to read.
 */
export async function explain(input: ExplainerInput): Promise<AgentResult<readonly Narrative[]>> {
  const narratives: Narrative[] = [];
  const skipped: SkippedSubject[] = [];
  let usage = zeroUsage();
  let consulted = 0;
  let unavailable = 0;

  for (const f of input.findings) {
    const critique = input.critiques?.get(f.id);
    const block = evidenceBlock(f, critique);
    const req = requestFor('explainer', EXPLAINER_SYSTEM, explainerUserPrompt(f, block));
    const outcome = await invokeModel(input.client, req);

    let prose: string | null = null;
    let headline: string | null = null;
    if (outcome.ok) {
      const parsed = parseNarrative(outcome.reply.json);
      prose = parsed.prose;
      headline = parsed.headline;
      if (prose === null) {
        skipped.push({ subject: f.id, reason: 'explainer reply carried no usable prose field' });
      }
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
      skipped.push({ subject: f.id, reason: `explainer model unavailable: ${outcome.error}` });
      if (input.client) {
        usage = mergeUsage(
          usage,
          usageForFailedCall({ tier: req.tier, system: req.system, user: req.user }),
        );
      }
    }

    // The allowlist is exactly what the model was shown — the prompt it received.
    const given = `${req.user}\n${f.title}\n${f.summary}`;
    const flagged = prose ? unverifiedNumbers(prose, given) : [];

    narratives.push({
      findingId: f.id,
      headline: headline ?? f.title,
      body: prose ? `${prose}\n\n${block}` : block,
      evidenceBlock: block,
      modelProse: prose,
      degraded: prose === null,
      unverifiedNumbers: flagged,
    });
  }

  return {
    agent: 'explainer',
    result: narratives,
    population: makeAgentPopulation({
      subject: 'findings',
      findings: input.findings,
      scope:
        `${input.findings.length} finding(s) narrated; every narrative carries a deterministic ` +
        `evidence block whether or not a model answered`,
      modelConsulted: consulted,
      modelUnavailable: unavailable,
    }),
    usage,
    skipped,
  };
}
