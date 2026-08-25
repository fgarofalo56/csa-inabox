/**
 * LOOM BRAIN — SECURITY EXTRACTION: `publication` (C4) nodes, from CI scripts.
 *
 * ── THE CLASS, AND WHY LEXICAL ENUMERATION IS THE WRONG DEFAULT ──────────
 *
 * `detectors/c4-unbounded-publication.ts` and #3876 record four measured bypasses
 * of the checker PR #3835 added. THREE of them drive the enumerated write count to
 * ZERO without removing a single write:
 *
 *     const out = process.stdout;      // alias
 *     const { stdout } = process;      // destructured
 *     process['stdout'].write(x);      // bracket
 *
 * A detector whose population can be driven to zero by RENAMING is not a
 * detector — it reports clean because it counted nothing, not because nothing
 * leaks. So {@link PUBLICATION_ACCESS_PATTERNS} enumerates all four access paths
 * explicitly, and the substrate carries `accessPath` as an enumerated field so
 * `c4.population.test.ts` can assert every value is judged.
 *
 * ── THE SINK WITH NO `write()` ANYWHERE IN THE PARENT ────────────────────
 *
 * The fourth is the one that matters most and the one a write-grep can never
 * find. `scripts/ci/deploy-retry.mjs:800` is
 *
 *     stdio: ['inherit', 'inherit', 'pipe']
 *
 * which hands the CHILD the parent's stdout descriptor. The child's bytes reach
 * the public Actions run log with NO `write` call in the parent's source at all.
 * Every assertion of the shape "grep for `process.stdout.write` and prove each one
 * goes through the boundary" is STRUCTURALLY BLIND to it.
 *
 * For those sinks the only question that means anything is whether the CHILD is
 * proven to redact — and this extractor cannot prove that about an arbitrary
 * spawned process. It therefore emits `childProvenRedacting: null`, which the
 * substrate defines as UNKNOWN and which C4 treats as "not proven", never as
 * "fine". That is the correct answer, not a placeholder: an UNKNOWN reported as a
 * negative is the specific defect this repo has shipped before.
 *
 * ── WHAT `carriesSensitive` IS ALLOWED TO MEAN HERE ──────────────────────
 *
 * Whether an arbitrary string carries a secret is not lexically decidable, and
 * guessing in the permissive direction would make C4 report clean over real
 * leaks. So the rule is NARROW and DECLARED: an expression carries sensitive data
 * when it references `process.env`, an identifier whose name matches
 * {@link SENSITIVE_IDENT}, or captured output of a shelled `az` / `gh` command.
 * Anything else is emitted `carriesSensitive: false` and C4 does not fire on it.
 *
 * The consequence is stated rather than buried: this UNDER-reports. A leak
 * carried by a neutrally-named local is not detected. That direction is chosen
 * deliberately — an over-broad rule here produces a finding on every
 * `console.log` in the repo, which is how a detector gets switched off.
 *
 * ── `declaredSinkCount`: WHERE THE DRIFT CHECK IS LIVE, AND WHERE IT IS NOT ─
 *
 * Taxonomy §5.4 wants a module to ASSERT its sink count so a new surface cannot
 * appear silently, and C4 raises a population finding when the declaration and
 * reality disagree. Almost no script in this repo carries such a declaration
 * today. Rather than invent one — setting `declaredSinkCount = sinks.length`
 * unconditionally would produce a check that CANNOT FAIL, which is an
 * anti-pattern this repo has paid for repeatedly — the extractor parses a real
 * marker when present and, when absent, records the module in `skipped` so the
 * inertness is COUNTABLE. See {@link parseDeclaredSinkCount}.
 */

import type { PublicationAccessPath, PublicationFacet, PublicationSink, PublicationSurface, SecurityNode } from '../substrate';
import type { SkippedSubject, SourceFile } from './types';
import { balancedEnd, blankComments, blankNonCode, lineAt, securityNodeId } from './source-facts';
import { assertEveryCandidateJudged } from './population-contract';

export interface PublicationExtraction {
  readonly nodes: readonly SecurityNode[];
  readonly skipped: readonly SkippedSubject[];
  /**
   * Modules that ENTERED the population — and, because
   * {@link assertEveryCandidateJudged} runs before this is returned, every one of
   * them also received a verdict (a node, or the explicit "no sinks" answer).
   */
  readonly filesMatched: number;
  /**
   * Sink counts, so the INERTNESS of an arm is countable rather than invisible.
   *
   * Measured on this tree by mutating `carriesSensitive` to `return false` and
   * observing that the C4 finding count did NOT move (14 -> 14): every C4
   * finding comes from the spawn-stdio arm, and `carriesSensitive` matched 0 of
   * 2,182 non-spawn sinks. A rule that never fires is not evidence of safety, so
   * the numbers are carried into the artifact meta where a reader sees them.
   */
  readonly sinkCounts: {
    readonly total: number;
    readonly spawnStdio: number;
    readonly sensitiveNonSpawn: number;
  };
}

/** Identifier names that make an emitted expression sensitive. */
const SENSITIVE_IDENT =
  /\b\w*(?:secret|token|password|passwd|credential|connstr|connectionstring|apikey|sastoken|bearer)\w*\b/i;

/** The shared redaction boundary exported by `scripts/ci/_azure-redact.mjs`. */
const BOUNDARIES: readonly string[] = ['redact', 'redactedLine'] as const;

/** The disclosed, deliberate exception, also exported by `_azure-redact.mjs`. */
const UNREDACTED_BY_DESIGN = /\bunredactedByDesign\s*\(/;

interface AccessPattern {
  readonly re: RegExp;
  readonly surface: PublicationSurface;
  readonly accessPath: PublicationAccessPath;
  /** Match against comments-blanked-but-strings-KEPT text (bracket access). */
  readonly needsStrings?: boolean;
}

/**
 * Every way a byte reaches a public surface, INCLUDING the three renaming
 * bypasses that drive a lexical write-count to zero.
 */
const PUBLICATION_ACCESS_PATTERNS: readonly AccessPattern[] = [
  { re: /\bprocess\s*\.\s*stdout\s*\.\s*write\s*\(/g, surface: 'stdout', accessPath: 'member' },
  { re: /\bprocess\s*\.\s*stderr\s*\.\s*write\s*\(/g, surface: 'stderr', accessPath: 'member' },
  { re: /\bprocess\s*\[\s*['"]stdout['"]\s*\]\s*\.\s*write\s*\(/g, surface: 'stdout', accessPath: 'bracket', needsStrings: true },
  { re: /\bprocess\s*\[\s*['"]stderr['"]\s*\]\s*\.\s*write\s*\(/g, surface: 'stderr', accessPath: 'bracket', needsStrings: true },
  { re: /\bconsole\s*\.\s*(?:log|info|warn|error|debug)\s*\(/g, surface: 'console', accessPath: 'member' },
] as const;

/**
 * A declared sink count, when the module states one.
 *
 * Recognised marker, chosen so it is greppable and unambiguous:
 *
 *     // PUBLICATION-SINKS: 3
 *
 * Returns `null` when the module declares nothing, so the caller can record the
 * drift check as inert for that module instead of manufacturing agreement.
 */
export function parseDeclaredSinkCount(rawText: string): number | null {
  const m = /PUBLICATION-SINKS:\s*(\d+)/.exec(rawText);
  return m ? Number(m[1]) : null;
}

/** Is the WHOLE emitted expression produced by a redaction boundary? */
function wholeExpressionBounded(argsText: string): { bounded: boolean; boundary: string | null } {
  const trimmed = argsText.trim();
  for (const boundary of BOUNDARIES) {
    const prefix = new RegExp(`^${boundary}\\s*\\(`);
    if (!prefix.test(trimmed)) continue;
    const open = trimmed.indexOf('(');
    const end = balancedEnd(trimmed, open);
    // #3876 bypass 1: `write(redact(a) + raw)` STARTS WITH the boundary while
    // `raw` is never examined. The boundary call must be the WHOLE expression.
    const bounded = trimmed.slice(end).trim() === '';
    return { bounded, boundary };
  }
  return { bounded: false, boundary: null };
}

function carriesSensitive(argsText: string): boolean {
  if (/\bprocess\s*\.\s*env\b/.test(argsText)) return true;
  if (SENSITIVE_IDENT.test(argsText)) return true;
  // Captured output of a shelled Azure/GitHub command.
  if (/\b(?:stdout|stderr|result|out)\b/.test(argsText) && /\b(?:az|gh)\b/.test(argsText)) return true;
  return false;
}

/** Extract publication nodes from repository scripts. */
export function extractPublicationNodes(files: readonly SourceFile[]): PublicationExtraction {
  const nodes: SecurityNode[] = [];
  const skipped: SkippedSubject[] = [];

  // The same verdict ledger the route walk carries — see `population-contract.ts`.
  // A `continue` injected below the extension filter drops the module out of
  // `judged` and the assertion at the end throws, rather than silently shrinking
  // the publication population while `filesScanned` and `inputsDigest` hold still.
  const candidates: string[] = [];
  const judged: string[] = [];

  for (const file of files) {
    // NOT a skip: a `.sh` / `.yml` / `.py` module was never in this extractor's
    // population. That narrowing is REPORTED, with counts, by `build.ts`.
    if (!/\.(?:mjs|cjs|js|ts)$/.test(file.path)) continue;
    candidates.push(file.path);

    const blanked = blankNonCode(file.text);
    // Comments blanked, STRINGS PRESERVED — required for the two sink shapes
    // whose evidence IS a string literal (`process['stdout']`, `stdio: ['inherit']`).
    // See `blankComments` in source-facts.ts for the measurement.
    const stringsKept = blankComments(file.text);
    const sinks: PublicationSink[] = [];

    for (const pattern of PUBLICATION_ACCESS_PATTERNS) {
      const haystack = pattern.needsStrings ? stringsKept : blanked;
      const re = new RegExp(pattern.re.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(haystack)) !== null) {
        const paren = haystack.indexOf('(', m.index + m[0].length - 1);
        const end = balancedEnd(haystack, paren);
        // Arguments are always read from the FULLY blanked text so a string
        // literal's contents can never be mistaken for an identifier.
        const argsText = blanked.slice(paren + 1, Math.max(paren + 1, end - 1));
        const { bounded, boundary } = wholeExpressionBounded(argsText);
        sinks.push({
          id: `${pattern.surface}:${pattern.accessPath}:${lineAt(haystack, m.index)}`,
          surface: pattern.surface,
          accessPath: pattern.accessPath,
          wholeExpressionBounded: bounded,
          boundary,
          unredactedByDesign: UNREDACTED_BY_DESIGN.test(argsText),
          carriesSensitive: carriesSensitive(argsText),
          childProvenRedacting: null,
        });
      }
    }

    sinks.push(...aliasSinks(blanked));
    sinks.push(...inheritedFdSinks(stringsKept));

    if (sinks.length === 0) {
      // "This module publishes nothing" IS the verdict, established by running
      // every access pattern over it. Judged, not skipped.
      judged.push(file.path);
      continue;
    }

    const declared = parseDeclaredSinkCount(file.text);
    if (declared === null) {
      skipped.push({
        subject: file.path,
        reason:
          `module declares no PUBLICATION-SINKS marker, so C4's declared-count drift check is ` +
          `INERT for it (declaredSinkCount is set to the observed ${sinks.length}). Recorded so ` +
          'the inertness is countable rather than invisible — a check that cannot fail must not ' +
          'be mistaken for a check that passed.',
      });
    }

    const facet: PublicationFacet = {
      kind: 'publication',
      module: file.path,
      declaredSinkCount: declared ?? sinks.length,
      sinks,
    };

    nodes.push({
      id: securityNodeId('publication', file.path, 'module'),
      kind: 'publication',
      provenance: 'declared',
      label: file.path,
      facet,
    });

    judged.push(file.path);
  }

  assertEveryCandidateJudged('extractPublicationNodes', candidates, judged);

  return {
    nodes,
    skipped,
    filesMatched: candidates.length,
    sinkCounts: countSinks(nodes),
  };
}

/** Aggregate sink counts across the emitted publication nodes. */
function countSinks(nodes: readonly SecurityNode[]): PublicationExtraction['sinkCounts'] {
  let total = 0;
  let spawnStdio = 0;
  let sensitiveNonSpawn = 0;
  for (const node of nodes) {
    if (node.kind !== 'publication') continue;
    for (const sink of (node.facet as PublicationFacet).sinks) {
      total += 1;
      if (sink.accessPath === 'spawn-stdio') spawnStdio += 1;
      else if (sink.carriesSensitive) sensitiveNonSpawn += 1;
    }
  }
  return { total, spawnStdio, sensitiveNonSpawn };
}

/**
 * Alias and destructure sinks — #3876 bypasses 2 and 3.
 *
 * `const out = process.stdout; out.write(x)` and
 * `const { stdout } = process; stdout.write(x)`. Both are invisible to a
 * `process.stdout.write` matcher and both publish exactly the same bytes.
 */
function aliasSinks(blanked: string): PublicationSink[] {
  const out: PublicationSink[] = [];

  const aliasRe = /\bconst\s+([A-Za-z0-9_$]+)\s*=\s*process\s*\.\s*(stdout|stderr)\b/g;
  let m: RegExpExecArray | null;
  while ((m = aliasRe.exec(blanked)) !== null) {
    out.push(...writesVia(blanked, m[1], m[2] as PublicationSurface, 'alias'));
  }

  const destrRe = /\bconst\s*\{([^}]*)\}\s*=\s*process\b/g;
  while ((m = destrRe.exec(blanked)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop()?.trim();
      if (name === 'stdout' || name === 'stderr') {
        out.push(...writesVia(blanked, name, name, 'destructured'));
      }
    }
  }

  return out;
}

function writesVia(
  blanked: string,
  ident: string,
  surface: PublicationSurface,
  accessPath: PublicationAccessPath,
): PublicationSink[] {
  const out: PublicationSink[] = [];
  const re = new RegExp(`\\b${ident}\\s*\\.\\s*write\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    const paren = blanked.indexOf('(', m.index);
    const end = balancedEnd(blanked, paren);
    const argsText = blanked.slice(paren + 1, Math.max(paren + 1, end - 1));
    const { bounded, boundary } = wholeExpressionBounded(argsText);
    out.push({
      id: `${surface}:${accessPath}:${lineAt(blanked, m.index)}`,
      surface,
      accessPath,
      wholeExpressionBounded: bounded,
      boundary,
      unredactedByDesign: false,
      carriesSensitive: carriesSensitive(argsText),
      childProvenRedacting: null,
    });
  }
  return out;
}

/**
 * `stdio: [... 'inherit' ...]` — the sink with no `write()` in this file.
 *
 * Takes COMMENTS-BLANKED-BUT-STRINGS-KEPT text: the evidence for this sink IS a
 * string literal, so the fully blanked variant reads `stdio: ['       ']` and
 * finds nothing. That was a real miss — measured 0 findings over 205 judged
 * publication candidates until it was fixed.
 *
 * `childProvenRedacting` is `null` because this extractor cannot establish what
 * an arbitrary spawned child does with the descriptor it was handed. C4 reads
 * `null` as "not proven" and fires at `confidence: 'medium'`, which is the
 * honest grade for an UNKNOWN.
 */
function inheritedFdSinks(stringsKept: string): PublicationSink[] {
  const out: PublicationSink[] = [];
  const re = /\bstdio\s*:\s*(\[[^\]]*\]|['"]inherit['"])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stringsKept)) !== null) {
    if (!/inherit/.test(m[1])) continue;
    out.push({
      id: `inherited-fd:spawn-stdio:${lineAt(stringsKept, m.index)}`,
      surface: 'inherited-fd',
      accessPath: 'spawn-stdio',
      // There is no expression in the parent to bound — that is the whole point.
      wholeExpressionBounded: false,
      boundary: null,
      unredactedByDesign: false,
      carriesSensitive: true,
      childProvenRedacting: null,
    });
  }
  return out;
}
