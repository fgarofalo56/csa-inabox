/**
 * skill-learner-core.ts — the PURE, dependency-free heart of the CTS-11 skill
 * self-evolution learner (no Azure / React / network imports).
 *
 * WHAT THIS IS
 * ------------
 * Given recent Copilot USAGE rows (a redacted prompt sample + the pane it ran
 * on + the skills that were active), it clusters the prompts BY PANE, tokenizes
 * them, and surfaces recurring keyword "gaps" — panes where users keep asking
 * about the same thing but no existing skill covers it. Each gap becomes a
 * candidate for the AOAI-backed synthesis step (lib/azure/skill-learner.ts),
 * which drafts a SUGGESTED skill an admin then reviews.
 *
 * WHY IT IS PURE (unit-testable in isolation)
 * -------------------------------------------
 * The Azure job (skill-learner.ts) pulls the usage rows + the existing skills
 * from Cosmos and calls these functions; keeping the clustering + threshold
 * policy here — with ZERO side-effecting imports — makes it deterministic and
 * unit-testable (see lib/copilot/__tests__/skill-learner-core.test.ts). Every
 * threshold is a PARAMETER so the caller (and tests) control the sensitivity.
 *
 * NO-VAPORWARE / NO-FABRIC-DEPENDENCY
 * -----------------------------------
 * This module carries no backend at all — it is a pure transform over rows the
 * caller already read. Nothing here reads `fabricWorkspaceId` or a Fabric host.
 */

/** One lightweight usage row (mirrors the persisted `copilot-skill-usage` doc,
 *  but only the fields the learner reads). */
export interface UsageRow {
  /** Pane / persona slug the turn ran on (e.g. 'lakehouse', 'notebook'). */
  pane?: string | null;
  /** REDACTED prompt sample (first ~200 chars, PII-scrubbed by the recorder). */
  promptSample?: string | null;
  /** Names of the skills that were active on this turn. */
  activeSkillNames?: string[] | null;
  /** ISO timestamp the turn was recorded. */
  at?: string | null;
}

/** A recurring-usage "gap": a pane where the same keywords keep coming up but
 *  no existing skill covers them — a candidate for a SUGGESTED skill. */
export interface SkillGap {
  /** The pane the gap was found on. */
  pane: string;
  /** Top recurring keyword group (lowercased, most-frequent first). */
  keywords: string[];
  /** How many prompts on this pane fed the gap. */
  sampleCount: number;
  /** A few representative (already-redacted) prompts for grounding + provenance. */
  samplePrompts: string[];
}

/** Tunable knobs for {@link extractKeywordSignals} — all optional with defaults. */
export interface ExtractOptions {
  /** A keyword must appear in at least this many DISTINCT prompts on a pane to
   *  count as recurring (default 3). Below this it is dropped as noise. */
  minKeywordCount?: number;
  /** Keep at most this many top keywords per gap (default 6). */
  maxKeywords?: number;
  /** Keep at most this many representative prompts per gap (default 5). */
  maxSamplePrompts?: number;
  /** Panes already well-covered by an existing skill — excluded so the learner
   *  never re-proposes a skill for a pane that already has one. */
  coveredPanes?: string[];
  /** Names of existing skills — their tokens are excluded from candidate
   *  keywords so a recurring term that is ALREADY a skill isn't re-proposed. */
  existingSkillNames?: string[];
  /** Extra stopwords to drop on top of the builtin set. */
  extraStopwords?: string[];
}

/** Tunable knobs for {@link shouldProposeSkill}. */
export interface ProposeOptions {
  /** Minimum prompts on a pane before its gap is proposal-worthy (default 5). */
  minSamples?: number;
}

/**
 * A small builtin stopword set — common English + Copilot-chat filler that would
 * otherwise dominate the keyword counts. Intentionally compact (the ≥4-char
 * filter already removes most short function words).
 */
const STOPWORDS = new Set<string>([
  'the', 'this', 'that', 'these', 'those', 'then', 'than', 'with', 'without',
  'from', 'into', 'onto', 'your', 'yours', 'have', 'here', 'there', 'what',
  'when', 'where', 'which', 'while', 'will', 'would', 'could', 'should', 'shall',
  'about', 'above', 'below', 'over', 'under', 'again', 'more', 'most', 'some',
  'such', 'only', 'same', 'other', 'been', 'being', 'they', 'them', 'their',
  'were', 'does', 'done', 'doing', 'each', 'also', 'just', 'like', 'want',
  'need', 'make', 'made', 'help', 'please', 'thanks', 'thank', 'show', 'give',
  'tell', 'find', 'using', 'used', 'into', 'able', 'must', 'cant', 'dont',
  'wont', 'lets', 'okay', 'yeah', 'sure', 'good', 'great', 'copilot', 'loom',
  'how', 'why', 'can', 'you', 'and', 'for', 'are', 'but', 'not', 'get',
]);

/** Lowercase, split on non-alphanumerics, keep ≥4-char non-stopword tokens. */
function tokenize(text: string, stop: Set<string>): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !stop.has(t) && !/^\d+$/.test(t));
}

/**
 * Cluster recent prompts BY PANE and return the recurring-keyword gaps.
 *
 * For each pane (case-insensitively normalized): if it is already covered by an
 * existing skill it is skipped; otherwise every prompt is tokenized and each
 * candidate keyword is counted by how many DISTINCT prompts contain it. Keywords
 * that recur at least `minKeywordCount` times (and are not already an existing
 * skill's own token) form the gap's keyword group; the pane becomes a gap only
 * when at least one such keyword survives. Gaps are returned most-sampled first.
 *
 * Pure + deterministic — no I/O. Missing/empty panes bucket under 'default'.
 */
export function extractKeywordSignals(
  usageRows: readonly UsageRow[],
  opts: ExtractOptions = {},
): SkillGap[] {
  const minKeywordCount = opts.minKeywordCount ?? 3;
  const maxKeywords = opts.maxKeywords ?? 6;
  const maxSamplePrompts = opts.maxSamplePrompts ?? 5;
  const covered = new Set((opts.coveredPanes ?? []).map((p) => String(p).trim().toLowerCase()).filter(Boolean));
  const stop = new Set(STOPWORDS);
  for (const w of opts.extraStopwords ?? []) stop.add(String(w).toLowerCase());
  // Tokens that belong to an existing skill's NAME are not novel — drop them so
  // a recurring term that is already a skill isn't re-proposed as a gap keyword.
  const existingTokens = new Set<string>();
  for (const n of opts.existingSkillNames ?? []) {
    for (const t of tokenize(String(n), stop)) existingTokens.add(t);
  }

  // Bucket prompts by pane.
  const byPane = new Map<string, string[]>();
  for (const row of usageRows ?? []) {
    const sample = (row?.promptSample ?? '').trim();
    if (!sample) continue;
    const pane = String(row?.pane ?? '').trim().toLowerCase() || 'default';
    if (!byPane.has(pane)) byPane.set(pane, []);
    byPane.get(pane)!.push(sample);
  }

  const gaps: SkillGap[] = [];
  for (const [pane, prompts] of byPane) {
    if (covered.has(pane)) continue; // already has a skill — not a gap
    // Per-prompt DISTINCT keyword presence count.
    const counts = new Map<string, number>();
    for (const p of prompts) {
      const seen = new Set(tokenize(p, stop));
      for (const t of seen) {
        if (existingTokens.has(t)) continue; // already a skill's own token
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    const keywords = [...counts.entries()]
      .filter(([, c]) => c >= minKeywordCount)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxKeywords)
      .map(([t]) => t);
    if (keywords.length === 0) continue; // nothing recurs enough — no gap
    gaps.push({
      pane,
      keywords,
      sampleCount: prompts.length,
      samplePrompts: prompts.slice(0, maxSamplePrompts),
    });
  }
  // Most-sampled gaps first (stable secondary sort by pane for determinism).
  gaps.sort((a, b) => b.sampleCount - a.sampleCount || a.pane.localeCompare(b.pane));
  return gaps;
}

/**
 * Whether a gap recurs enough to be worth proposing a skill for. A gap is
 * proposal-worthy when it has at least one recurring keyword AND enough prompts
 * fed it (`minSamples`, default 5). Pure + deterministic.
 */
export function shouldProposeSkill(gap: SkillGap, opts: ProposeOptions = {}): boolean {
  const minSamples = opts.minSamples ?? 5;
  if (!gap || !Array.isArray(gap.keywords) || gap.keywords.length === 0) return false;
  return gap.sampleCount >= minSamples;
}
