/**
 * LOOM BRAIN — the CORRELATOR. Findings that share a root cause, grouped.
 *
 * The measured case this exists for (issue #3893): **nine bicep findings that
 * are one dead gate.** `platform/fiab/bicep/modules/landing-zone/main.bicep` is
 * never instantiated on any shipped params file, so 24 module invocations and
 * 146 resource declarations inside it are inert. Nine separate findings, one
 * fix. A report that lists nine costs an operator nine investigations.
 *
 * ── MEMBERSHIP IS MEASURED. NAMING IS MODEL WORK. ──────────────────────────
 * The grouping itself is a connected-components pass over SHARED EVIDENCE
 * ARTIFACTS — it needs no model, and all nine of those findings collapse because
 * all nine cite the same artifact. The model's contribution is to NAME the root
 * cause and, optionally, to propose merging two components that the artifact
 * pass could not connect.
 *
 * A model can therefore never invent membership. It cannot add a finding that
 * shares no artifact with the group, and every group's `members` is a union of
 * deterministic components — never an arbitrary set the model listed. A
 * fabricated correlation reads exactly like a real one, and there is no field an
 * operator could inspect to tell them apart; so the shape forbids it instead.
 *
 * Corollary worth stating plainly: **this agent still does its headline job with
 * the model switched off.** The nine collapse to one either way. What is lost
 * without a model is the sentence naming why.
 *
 * ── WHAT COUNTS AS A SHARED ARTIFACT ───────────────────────────────────────
 *   `deploy:<path>` / `code:<path>` node ids — the path is IN the id, so this
 *       works with no graph at all. This is the #3893 key.
 *   `azure:<arm-id>` subject ids — two findings about the same resource are
 *       plausibly one cause.
 *   With a graph: each evidence edge's `evidence.artifact`, which reaches the
 *       bicep file and line a wire was read from even when no node names it.
 *
 * Grouping is TRANSITIVE by construction: A–B sharing X and B–C sharing Y puts
 * all three in one component. That is the correct behaviour for root-cause
 * grouping and it is also the direction in which this can over-merge, so the
 * `sharedArtifacts` of every group is reported and a reader can see exactly what
 * connected it.
 *
 * ONE model call per run, on the strong tier — the model sees every component's
 * summary at once, which is both cheaper and better than N independent calls
 * that cannot see each other.
 */

import type { BrainGraphView, Confidence, Finding, SkippedSubject } from '../types';
import {
  makeAgentPopulation,
  mergeUsage,
  zeroUsage,
  type AgentResult,
  type CorrelationGroup,
} from './contracts';
import { invokeModel, requestFor, type BrainModelClient } from './model-client';
import { usageForCall, usageForFailedCall } from './tokens';

// ---------------------------------------------------------------------------
// §Artifact extraction
// ---------------------------------------------------------------------------

/**
 * Every artifact key a finding touches.
 *
 * Node ids are used directly because `node-id.ts` encodes the path INSIDE the id
 * (`deploy:platform/fiab/bicep/modules/landing-zone/main.bicep`), already
 * normalized to lowercase forward slashes. That normalization is what makes two
 * findings written on different machines agree, and it is why this does not
 * re-derive a key from a display name.
 */
export function artifactsOf(f: Finding, graph?: BrainGraphView): string[] {
  const keys = new Set<string>();
  for (const id of [...f.subjects, ...f.evidence.nodes]) {
    const s = String(id);
    if (s.startsWith('deploy:') || s.startsWith('code:') || s.startsWith('azure:')) {
      keys.add(s);
    }
  }
  if (graph) {
    const byId = new Map(graph.edges.map((e) => [String(e.id), e]));
    for (const eid of f.evidence.edges) {
      const e = byId.get(String(eid));
      if (e?.evidence.artifact) keys.add(`artifact:${e.evidence.artifact.toLowerCase()}`);
    }
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
// §Connected components (union-find)
// ---------------------------------------------------------------------------

class DisjointSet {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i]! !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/** A raw component: the findings that share artifacts, and what they share. */
export interface Component {
  readonly indices: readonly number[];
  readonly sharedArtifacts: readonly string[];
}

/**
 * Group finding indices into connected components over shared artifacts.
 *
 * `sharedArtifacts` is the INTERSECTION when the component has more than one
 * member and that intersection is non-empty; otherwise it is the set of keys
 * that actually did the connecting (the union, capped). Reporting the
 * intersection where one exists is what makes the #3893 group legible — all nine
 * members name `landing-zone/main.bicep` and nothing else in common.
 */
export function componentsOf(findings: readonly Finding[], graph?: BrainGraphView): Component[] {
  const keysPer = findings.map((f) => artifactsOf(f, graph));
  const ds = new DisjointSet(findings.length);
  const firstSeen = new Map<string, number>();
  for (let i = 0; i < keysPer.length; i += 1) {
    for (const k of keysPer[i]!) {
      const prev = firstSeen.get(k);
      if (prev === undefined) firstSeen.set(k, i);
      else ds.union(prev, i);
    }
  }
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < findings.length; i += 1) {
    const r = ds.find(i);
    const b = buckets.get(r);
    if (b) b.push(i);
    else buckets.set(r, [i]);
  }
  const out: Component[] = [];
  for (const indices of buckets.values()) {
    indices.sort((a, b) => a - b);
    let shared: string[];
    if (indices.length === 1) {
      shared = [...keysPer[indices[0]!]!];
    } else {
      const sets = indices.map((i) => new Set(keysPer[i]!));
      const inter = [...sets[0]!].filter((k) => sets.every((s) => s.has(k)));
      shared = inter.length > 0 ? inter : [...new Set(indices.flatMap((i) => keysPer[i]!))].slice(0, 12);
    }
    shared.sort();
    out.push({ indices, sharedArtifacts: shared });
  }
  out.sort((a, b) => b.indices.length - a.indices.length || a.indices[0]! - b.indices[0]!);
  return out;
}

// ---------------------------------------------------------------------------
// §The model half
// ---------------------------------------------------------------------------

const CORRELATOR_SYSTEM = [
  'You are the Correlator in an Azure estate-analysis system. You are shown groups of findings',
  'that a deterministic pass has ALREADY grouped by shared evidence artifacts. Membership is',
  'settled and is not yours to change.',
  '',
  'Your job:',
  '1. Name the single ROOT CAUSE each group shares, in one short phrase.',
  '2. Explain in one or two sentences why one fix addresses all of its members.',
  '3. Where two groups plainly share ONE underlying cause, say so by listing their component',
  '   numbers together.',
  '',
  'Rules:',
  '- Never list a component number you were not shown.',
  '- Never claim a cause you cannot support from the text given. If a group has no single cause,',
  '  set rootCause to null.',
  '- Do not invent file paths, resource names or counts.',
  '',
  'Reply with JSON only:',
  '{"groups":[{"components":[0],"rootCause":"...","explanation":"...","confidence":"high|medium|low"}]}',
].join('\n');

function correlatorUserPrompt(components: readonly Component[], findings: readonly Finding[]): string {
  return components
    .map((c, i) => {
      const titles = c.indices.map((idx) => `    - ${findings[idx]!.detector}: ${findings[idx]!.title}`);
      return [
        `component ${i} (${c.indices.length} finding(s))`,
        `  shared artifacts: ${c.sharedArtifacts.slice(0, 8).join(', ') || '(none)'}`,
        ...titles.slice(0, 12),
        c.indices.length > 12 ? `    … and ${c.indices.length - 12} more` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

/** One model-proposed naming/merge. Validated before anything is applied. */
interface ProposedGroup {
  readonly components: number[];
  readonly rootCause: string | null;
  readonly explanation: string | null;
  readonly confidence: Confidence;
}

const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];

/**
 * Read the model's proposals, DEFENSIVELY.
 *
 * Component indices are coerced through `Number.isInteger` and nothing else is
 * trusted; validation against the real component count happens in
 * {@link applyProposals}, which is where an out-of-range index becomes a
 * recorded skip rather than a silent drop.
 */
export function parseProposals(json: unknown): ProposedGroup[] {
  const raw = (json as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(raw)) return [];
  const out: ProposedGroup[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const comps = Array.isArray(o.components)
      ? o.components.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
      : [];
    if (comps.length === 0) continue;
    const conf = typeof o.confidence === 'string' && (CONFIDENCES as readonly string[]).includes(o.confidence)
      ? (o.confidence as Confidence)
      : 'low';
    out.push({
      components: comps,
      rootCause: typeof o.rootCause === 'string' && o.rootCause.trim() ? o.rootCause.trim().slice(0, 200) : null,
      explanation: typeof o.explanation === 'string' && o.explanation.trim() ? o.explanation.trim().slice(0, 800) : null,
      confidence: conf,
    });
  }
  return out;
}

/**
 * Turn components + validated proposals into groups.
 *
 * THE VALIDATION IS THE POINT:
 *   • a component index the model invented is DROPPED and recorded in `skipped`;
 *   • a component the model lists twice is assigned to the first proposal only —
 *     a finding cannot have two root causes, and silently letting the later one
 *     win would make the output order-dependent on a model reply;
 *   • a merged group's confidence is CAPPED at `'medium'`, because the merge is
 *     an inference where the component itself was a measurement.
 *
 * Components no proposal covered still become groups, with `rootCause: null` and
 * `degraded: true`. Nothing is lost when the model says nothing.
 */
export function applyProposals(
  components: readonly Component[],
  findings: readonly Finding[],
  proposals: readonly ProposedGroup[],
): { groups: CorrelationGroup[]; skipped: SkippedSubject[] } {
  const skipped: SkippedSubject[] = [];
  const claimed = new Set<number>();
  const groups: CorrelationGroup[] = [];

  for (const p of proposals) {
    const valid: number[] = [];
    for (const ci of p.components) {
      if (ci < 0 || ci >= components.length) {
        skipped.push({
          subject: `model component index ${ci}`,
          reason: `out of range — only ${components.length} component(s) exist; membership is not model-decided`,
        });
        continue;
      }
      if (claimed.has(ci)) {
        skipped.push({
          subject: `model component index ${ci}`,
          reason: 'already assigned to an earlier proposed group; a finding cannot have two root causes',
        });
        continue;
      }
      valid.push(ci);
    }
    if (valid.length === 0) continue;
    for (const ci of valid) claimed.add(ci);

    const merged = valid.length > 1;
    const indices = valid.flatMap((ci) => components[ci]!.indices).sort((a, b) => a - b);
    const shared = [...new Set(valid.flatMap((ci) => components[ci]!.sharedArtifacts))].sort();
    if (indices.length < 2) {
      // A "group" of one finding is not a correlation. Emit nothing; the finding
      // simply has no groupId.
      continue;
    }
    groups.push({
      id: `grp-${valid.join('+')}`,
      members: indices.map((i) => findings[i]!.id),
      sharedArtifacts: shared,
      rootCause: p.rootCause,
      explanation: p.explanation,
      mergeSource: merged ? 'model' : 'deterministic',
      // A model merge is an inference over measured components — never 'high'.
      confidence: merged && p.confidence === 'high' ? 'medium' : p.confidence,
      degraded: false,
    });
  }

  for (let ci = 0; ci < components.length; ci += 1) {
    if (claimed.has(ci)) continue;
    const c = components[ci]!;
    if (c.indices.length < 2) continue;
    groups.push({
      id: `grp-${ci}`,
      members: c.indices.map((i) => findings[i]!.id),
      sharedArtifacts: [...c.sharedArtifacts],
      rootCause: null,
      explanation: null,
      mergeSource: 'deterministic',
      // Measured: these findings demonstrably cite the same artifact.
      confidence: 'high',
      // No proposal covered this component, so no model text was applied to it —
      // the grouping stands on the artifact match alone. `degraded` records the
      // absence of the NAMING, not a defect in the grouping.
      degraded: true,
    });
  }

  groups.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
  return { groups, skipped };
}

// ---------------------------------------------------------------------------
// §The agent
// ---------------------------------------------------------------------------

export interface CorrelatorInput {
  readonly findings: readonly Finding[];
  readonly graph?: BrainGraphView;
  readonly client?: BrainModelClient;
}

/**
 * Group findings by root cause.
 *
 * The population's `examined` counts COMPONENTS, not findings — that is the
 * subject this agent ranges over — while `byDetector` still describes the
 * findings that went in, so a reader can see both "41 findings" and "7 groups"
 * without doing arithmetic on a single number.
 */
export async function correlate(
  input: CorrelatorInput,
): Promise<AgentResult<readonly CorrelationGroup[]>> {
  const components = componentsOf(input.findings, input.graph);
  let usage = zeroUsage();
  let proposals: ProposedGroup[] = [];
  let modelAnswered = false;
  const skipped: SkippedSubject[] = [];

  if (components.length > 0) {
    const req = requestFor(
      'correlator',
      CORRELATOR_SYSTEM,
      correlatorUserPrompt(components, input.findings),
    );
    const outcome = await invokeModel(input.client, req);
    if (outcome.ok) {
      proposals = parseProposals(outcome.reply.json);
      modelAnswered = true;
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
      skipped.push({ subject: 'correlator naming pass', reason: `model unavailable: ${outcome.error}` });
      if (input.client) {
        usage = mergeUsage(
          usage,
          usageForFailedCall({ tier: req.tier, system: req.system, user: req.user }),
        );
      }
    }
  }

  const applied = applyProposals(components, input.findings, proposals);

  return {
    agent: 'correlator',
    result: applied.groups,
    population: makeAgentPopulation({
      subject: 'groups',
      findings: input.findings,
      examined: components.length,
      scope:
        `${input.findings.length} finding(s) → ${components.length} deterministic component(s) ` +
        `over shared evidence artifacts → ${applied.groups.length} group(s) of 2+ ` +
        (input.graph ? '; graph supplied (edge artifacts available)' : '; NO graph — edge-borne artifacts NOT available'),
      modelConsulted: modelAnswered ? components.length : 0,
      modelUnavailable: modelAnswered ? 0 : components.length,
    }),
    usage,
    skipped: [...skipped, ...applied.skipped],
  };
}
