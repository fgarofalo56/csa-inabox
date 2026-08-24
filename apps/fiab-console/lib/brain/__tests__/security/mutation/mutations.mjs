/**
 * THE MUTATION TABLE.
 *
 * Each entry breaks ONE thing and names which spec must go RED as a result.
 *
 * ── THE CRLF LANDMINE, AND WHY EVERY NEEDLE IS SINGLE-LINE ───────────────
 *
 * This repo's TypeScript is 100% CRLF. Measured on this tree:
 *
 *     lib/auth/workspace-guard.ts   CRLF=531  bareLF=0
 *     lib/estate/pause-state.ts     CRLF=851  bareLF=0
 *     lib/auth/feature-gate.ts      CRLF=217  bareLF=0
 *
 * A mutation needle written with an LF newline matches ZERO times, the harness
 * "applies" nothing, the suite stays green, and the arm reads exactly like a
 * passing test. That failure mode is silent and total.
 *
 * The defence here is structural rather than careful: EVERY NEEDLE CONTAINS NO
 * NEWLINE AT ALL, so it cannot express a line ending and the whole class is
 * unreachable. `apply()` additionally asserts each needle matched EXACTLY ONCE
 * and throws otherwise — a needle that becomes ambiguous or stale after an edit
 * aborts the run instead of quietly no-opping.
 *
 * ── BROAD vs NARROW ──────────────────────────────────────────────────────
 *
 * BROAD is the obvious break. NARROW is the same defect scoped to one item type,
 * one branch, one access path, one failure mode, one scheme, one sibling. The
 * narrow arm is the one that matters: in this repo the narrow form has passed a
 * broad guard, a 27-test spec AND a 259-test suite while granting a live
 * cross-tenant ALLOW, whereas the broad form goes red instantly.
 *
 * ── THE THIRD ARM: HOLLOW ────────────────────────────────────────────────
 *
 * BROAD and NARROW mutate the SUBJECT. That proves the detector notices a defect
 * — but a suite can pass those arms while asserting almost nothing about the
 * detector's real weaknesses.
 *
 * So a third arm mutates the DETECTOR, re-introducing the exact real-world flaw
 * the detector was written to avoid — `check-tid-boundary-chokepoint.mjs:2662`'s
 * parameter-name population filter, which measured 15 candidates / 1 judged /
 * RC=0 with a live defect in the tree. If the suite stays GREEN with that filter
 * in place, the population assertions are decorative and this lane should say so.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/fiab-console */
export const CONSOLE_ROOT = join(HERE, '..', '..', '..', '..', '..');

export const CORPUS = join(HERE, '..', 'fixtures', 'corpus.ts');
export const C1_DETECTOR = join(
  CONSOLE_ROOT,
  'lib',
  'brain',
  'security',
  'detectors',
  'c1-unauthorized-inbound-edge.ts',
);

export const POPULATION_MODULE = join(
  CONSOLE_ROOT,
  'lib',
  'brain',
  'security',
  'population.ts',
);

export const RECOMMEND_ONLY_MODULE = join(
  CONSOLE_ROOT,
  'lib',
  'brain',
  'security',
  'recommend-only.ts',
);

const BASELINE_SPEC = 'lib/brain/__tests__/security/baseline-clean.test.ts';
const C1_SPEC = 'lib/brain/__tests__/security/c1-unauthorized-inbound-edge.test.ts';
const POPULATION_SPEC = 'lib/brain/__tests__/security/population.test.ts';
const REGISTRY_SPEC = 'lib/brain/__tests__/security/registry.test.ts';

/** The single line every detector's candidate set is built from. */
const CANDIDATES_RETURN = '  return graph.nodes.filter((n) => n.kind === kind);';

/**
 * @typedef {{ file: string, needle: string, replacement: string }} Substitution
 * @typedef {{ id: string, taxonomyClass: string, arm: 'broad'|'narrow'|'hollow',
 *             what: string, spec: string, substitutions: Substitution[] }} Mutation
 */

/** @type {Mutation[]} */
export const MUTATIONS = [
  // ── C1 ────────────────────────────────────────────────────────────────
  {
    id: 'c1-broad',
    taxonomyClass: 'C1',
    arm: 'broad',
    what: 'the authorizer grants on isTenantAdmin alone, before any read (shape 1)',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'allowPaths: [AP_CLEAN_DELEGATION], // MUT-C1',
        replacement: 'allowPaths: [AP_ADMIN_SHORT_CIRCUIT], // MUT-C1',
      },
    ],
  },
  {
    id: 'c1-narrow',
    taxonomyClass: 'C1',
    arm: 'narrow',
    what: "the correct delegation is KEPT and one ALLOW is scoped to itemType === 'lakehouse'",
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'allowPaths: [AP_CLEAN_DELEGATION], // MUT-C1',
        replacement: 'allowPaths: [AP_CLEAN_DELEGATION, AP_LAKEHOUSE_SCOPED_BYPASS], // MUT-C1',
      },
    ],
  },

  // ── C2 ────────────────────────────────────────────────────────────────
  {
    id: 'c2-broad',
    taxonomyClass: 'C2',
    arm: 'broad',
    what: 'the caller-supplied scope reaches the query unresolved, disclosing a count',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'scopeResolvedBeforeQuery: true, // MUT-C2-SCOPE',
        replacement: 'scopeResolvedBeforeQuery: false, // MUT-C2-SCOPE',
      },
    ],
  },
  {
    id: 'c2-narrow',
    taxonomyClass: 'C2',
    arm: 'narrow',
    what: 'the same unresolved scope, but truncated to ONE BIT — `anyExcluded: true`',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'scopeResolvedBeforeQuery: true, // MUT-C2-SCOPE',
        replacement: 'scopeResolvedBeforeQuery: false, // MUT-C2-SCOPE',
      },
      {
        file: CORPUS,
        needle: 'disclosures: [DISCLOSURE_COUNT], // MUT-C2-SHAPE',
        replacement: 'disclosures: [DISCLOSURE_BOOLEAN], // MUT-C2-SHAPE',
      },
    ],
  },

  // ── C3 ────────────────────────────────────────────────────────────────
  {
    id: 'c3-broad',
    taxonomyClass: 'C3',
    arm: 'broad',
    what: 'the gate is called and its verdict never consumed (the 2026-08-07 shape)',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: "consumption: 'returned', // MUT-C3-CONSUMPTION",
        replacement: "consumption: 'ignored', // MUT-C3-CONSUMPTION",
      },
    ],
  },
  {
    id: 'c3-narrow',
    taxonomyClass: 'C3',
    arm: 'narrow',
    what: 'the verdict IS tested and returned — on 3 of 4 paths. GET reaches the sink unrefused',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'pathsConsumingAsRefusal: 4, // MUT-C3-PATHS',
        replacement: 'pathsConsumingAsRefusal: 3, // MUT-C3-PATHS',
      },
    ],
  },

  // ── C4 ────────────────────────────────────────────────────────────────
  {
    id: 'c4-broad',
    taxonomyClass: 'C4',
    arm: 'broad',
    what: 'a sensitive value reaches stderr through an unbounded expression',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle:
          "c4Node('fx:base:c4', [SINK_BOUNDED, SINK_BY_DESIGN, SINK_INHERITED_FD_SAFE], 'baseline-publisher'), // MUT-C4",
        replacement:
          "c4Node('fx:base:c4', [SINK_PREFIX_ONLY, SINK_BY_DESIGN, SINK_INHERITED_FD_SAFE], 'baseline-publisher'), // MUT-C4",
      },
    ],
  },
  {
    id: 'c4-narrow',
    taxonomyClass: 'C4',
    arm: 'narrow',
    what: 'the leak is added through an ALIAS — a lexical enumerator counts ZERO writes',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle:
          "c4Node('fx:base:c4', [SINK_BOUNDED, SINK_BY_DESIGN, SINK_INHERITED_FD_SAFE], 'baseline-publisher'), // MUT-C4",
        replacement:
          "c4Node('fx:base:c4', [SINK_BOUNDED, SINK_BY_DESIGN, SINK_INHERITED_FD_SAFE, SINK_ALIASED], 'baseline-publisher'), // MUT-C4",
      },
    ],
  },

  // ── C5 ────────────────────────────────────────────────────────────────
  {
    id: 'c5-broad',
    taxonomyClass: 'C5',
    arm: 'broad',
    what: 'UNKNOWN is mapped to ALLOW — the verdict function is not total',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: "unknownMapsTo: 'deny', // MUT-C5-UNKNOWN",
        replacement: "unknownMapsTo: 'allow', // MUT-C5-UNKNOWN",
      },
    ],
  },
  {
    id: 'c5-narrow',
    taxonomyClass: 'C5',
    arm: 'narrow',
    what: '7 of 9 failure modes refuse correctly and 2 invert (#3834 exactly)',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'failureModes: MODES_ALL_REFUSING, // MUT-C5',
        replacement: 'failureModes: MODES_TWO_OF_NINE_INVERTED, // MUT-C5',
      },
    ],
  },

  // ── C6 ────────────────────────────────────────────────────────────────
  {
    id: 'c6-broad',
    taxonomyClass: 'C6',
    arm: 'broad',
    what: 'the credential follows redirects with no origin check at all',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: "redirectPolicy: 'none', // MUT-C6-REDIRECT",
        replacement: "redirectPolicy: 'follow', // MUT-C6-REDIRECT",
      },
      {
        file: CORPUS,
        needle: 'stripsCredentialOnHostChange: true, // MUT-C6-STRIP',
        replacement: 'stripsCredentialOnHostChange: false, // MUT-C6-STRIP',
      },
    ],
  },
  {
    id: 'c6-narrow',
    taxonomyClass: 'C6',
    arm: 'narrow',
    what: 'the FTP-ONLY fix — a scheme allowlist that a plain http cross-host redirect walks through',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: "redirectPolicy: 'none', // MUT-C6-REDIRECT",
        replacement: "redirectPolicy: 'follow', // MUT-C6-REDIRECT",
      },
      {
        file: CORPUS,
        needle: 'stripsCredentialOnHostChange: true, // MUT-C6-STRIP',
        replacement: 'stripsCredentialOnHostChange: false, // MUT-C6-STRIP',
      },
      {
        file: CORPUS,
        needle: 'schemeAllowlist: null, // MUT-C6-SCHEME',
        replacement: "schemeAllowlist: ['https', 'http'], // MUT-C6-SCHEME",
      },
    ],
  },

  // ── C7 ────────────────────────────────────────────────────────────────
  {
    id: 'c7-broad',
    taxonomyClass: 'C7',
    arm: 'broad',
    what: 'an unvalidated literal can reach the partition key',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle:
          "sources: [{ origin: 'live-token', validation: 'value', bypassesMinter: false }], // MUT-C7",
        replacement:
          "sources: [{ origin: 'literal', validation: 'none', bypassesMinter: false }], // MUT-C7",
      },
    ],
  },
  {
    id: 'c7-narrow',
    taxonomyClass: 'C7',
    arm: 'narrow',
    what: 'the guard checks PRESENCE (`-z`) — an explicitly-set placeholder passes it',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle:
          "sources: [{ origin: 'live-token', validation: 'value', bypassesMinter: false }], // MUT-C7",
        replacement:
          "sources: [{ origin: 'env', validation: 'presence', bypassesMinter: false }], // MUT-C7",
      },
    ],
  },

  // ── C8 ────────────────────────────────────────────────────────────────
  {
    id: 'c8-broad',
    taxonomyClass: 'C8',
    arm: 'broad',
    what: 'a caller-supplied value reaches the emitted shell command unescaped',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle:
          "{ name: 'clientId', source: 'caller-supplied', escaped: true, allowlisted: true, validatedAs: 'guid' }, // MUT-C8-ESCAPE",
        replacement:
          "{ name: 'clientId', source: 'caller-supplied', escaped: false, allowlisted: false, validatedAs: null }, // MUT-C8-ESCAPE",
      },
    ],
  },
  {
    id: 'c8-narrow',
    taxonomyClass: 'C8',
    arm: 'narrow',
    what: 'THIS field stays fully escaped and a SIBLING emitter is left uncovered (#3602)',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'siblingEmittersCovered: 2, // MUT-C8-SIBLING',
        replacement: 'siblingEmittersCovered: 1, // MUT-C8-SIBLING',
      },
    ],
  },

  // ── C9 ────────────────────────────────────────────────────────────────
  {
    id: 'c9-broad',
    taxonomyClass: 'C9',
    arm: 'broad',
    what: 'a second implementation drifts to the NON-CONTRADICTION truth table',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'C9_EQUIVALENT_DUPLICATE, // MUT-C9',
        replacement: 'C9_DRIFTED, // MUT-C9',
      },
    ],
  },
  {
    id: 'c9-narrow',
    taxonomyClass: 'C9',
    arm: 'narrow',
    what: 'the truth table matches EXACTLY and only the input provenance differs (#3843)',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'C9_EQUIVALENT_DUPLICATE, // MUT-C9',
        replacement: 'C9_DIFFERENT_INPUTS, // MUT-C9',
      },
    ],
  },
  {
    id: 'c9-size',
    taxonomyClass: 'C9',
    arm: 'narrow',
    what: 'copy N+1 is added in a file the declaration does not know about',
    spec: BASELINE_SPEC,
    substitutions: [
      {
        file: CORPUS,
        needle: 'expectedPredicateClusterSize: { [CLUSTER_KEY]: 2 }, // MUT-C9-SIZE',
        replacement: 'expectedPredicateClusterSize: { [CLUSTER_KEY]: 1 }, // MUT-C9-SIZE',
      },
    ],
  },

  // ── THE HOLLOW CONTROLS — mutate the DETECTOR, not the subject ────────
  //
  // Two arms, deliberately, because they answer DIFFERENT questions and this
  // lane reports both rather than the flattering one.
  {
    id: 'hollow-c1-loop-skip',
    taxonomyClass: 'C1',
    arm: 'hollow',
    what:
      'skip a node at LOOP level, before `judged.push` — the population contract should ' +
      'refuse the result outright rather than report a narrowed sweep as clean',
    spec: C1_SPEC,
    substitutions: [
      {
        file: C1_DETECTOR,
        needle: '    findings.push(...judgeAuthorizer(node));',
        replacement:
          '    if (node.id.length > 0) continue; findings.push(...judgeAuthorizer(node));',
      },
    ],
  },
  {
    id: 'hollow-c1-predicate-param-filter',
    taxonomyClass: 'C1',
    arm: 'hollow',
    what:
      "re-introduce check-tid-boundary-chokepoint.mjs:2662's parameter-name filter INSIDE " +
      'the predicate (measured live: 15 candidates, 1 judged, RC=0, live defect in tree)',
    spec: C1_SPEC,
    substitutions: [
      {
        file: C1_DETECTOR,
        needle: '  for (const path of facet.allowPaths) {',
        replacement:
          "  if (!/\\bworkspace(Id|_id)?\\b/i.test(facet.params.join(','))) return findings; " +
          'for (const path of facet.allowPaths) {',
      },
    ],
  },
  // ── THE CANDIDATE-LEVEL ARMS — the bypass that escaped review ─────────
  //
  // Added 2026-08-23 after an independent review defeated the population
  // contract without touching a detector. All three below were MEASURED as
  // ESCAPED against the previous revision: mutated RC=0, `100 passed (100)`,
  // `ratio: 1.0`, `incompleteDetectors: []`, `unjudged: 0` — while a live C1
  // defect disappeared from the findings of a 14-node graph.
  //
  // Each is gated on `graph.nodes.length > 13`, one node above the largest
  // fixture at the time, which is exactly what made them invisible: every test
  // graph stayed under the gate, so only a real estate would cross it. The
  // `census` block in population.test.ts is deliberately built on 14 nodes so
  // these arms are now INSIDE the tested range. If a future edit shrinks that
  // block back below the gate, these three arms go ESCAPED again and say so.
  //
  // Why `judged`/`candidates` cannot see them: both descend from the array
  // this function returns, so they agree by construction. Only the independent
  // census in `detectorResult()` has a denominator that does not move.
  {
    id: 'hollow-candidates-first-of-kind',
    taxonomyClass: 'POP',
    arm: 'hollow',
    what:
      'candidatesOfKind keeps only the FIRST node of each kind, gated above fixture ' +
      'cardinality (review arm A2 — measured ESCAPED before the census cross-check)',
    spec: POPULATION_SPEC,
    substitutions: [
      {
        file: POPULATION_MODULE,
        needle: CANDIDATES_RETURN,
        replacement:
          '  const all = graph.nodes.filter((n) => n.kind === kind); ' +
          'return graph.nodes.length > 13 ? all.slice(0, 1) : all;',
      },
    ],
  },
  {
    id: 'hollow-candidates-param-filter',
    taxonomyClass: 'POP',
    arm: 'hollow',
    what:
      "check-tid-boundary-chokepoint.mjs:2662's parameter-name filter re-applied at " +
      'CANDIDATE level (review arm A3 — the same filter as hollow-c1-predicate-param-filter, ' +
      'one step upstream, where judged/candidates provably cannot see it)',
    spec: POPULATION_SPEC,
    substitutions: [
      {
        file: POPULATION_MODULE,
        needle: CANDIDATES_RETURN,
        replacement:
          '  const all = graph.nodes.filter((n) => n.kind === kind); ' +
          "if (graph.nodes.length > 13 && kind === 'authorizer') return all.filter((n) => " +
          "/\\bworkspace(Id|_id)?\\b/i.test(((n.facet as { params?: readonly string[] })" +
          ".params ?? []).join(','))); return all;",
      },
    ],
  },
  {
    id: 'hollow-candidates-drop-one',
    taxonomyClass: 'POP',
    arm: 'hollow',
    what:
      'drop exactly ONE node from the candidate set, gated above fixture cardinality ' +
      '(review arm A4 — the sharpest form: 13 of 14 still judged, ratio still 1.0)',
    spec: POPULATION_SPEC,
    substitutions: [
      {
        file: POPULATION_MODULE,
        needle: CANDIDATES_RETURN,
        replacement:
          '  const all = graph.nodes.filter((n) => n.kind === kind); ' +
          "return graph.nodes.length > 13 ? all.filter((n) => !n.id.endsWith('n7')) : all;",
      },
    ],
  },
  {
    id: 'hollow-recommend-only-shallow',
    taxonomyClass: 'POP',
    arm: 'hollow',
    what:
      'revert assertInertRemediation to a ONE-LEVEL walk — the exact previous implementation, ' +
      'whose docstring claimed it caught "any function-valued property whatsoever" while a ' +
      'nested `plan.apply` and an array element `proposedCommands[0].apply` both passed',
    spec: REGISTRY_SPEC,
    substitutions: [
      {
        file: RECOMMEND_ONLY_MODULE,
        needle: '    walkInert(descriptor.value, childPath, findingId, seen);',
        replacement:
          "    if (typeof descriptor.value === 'function') " +
          'walkInert(descriptor.value, childPath, findingId, seen);',
      },
    ],
  },
];

/** Read a file as raw text, preserving whatever line endings it has. */
export function readOriginal(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Apply one substitution, asserting the needle matched EXACTLY ONCE.
 *
 * A needle that matches zero times is the CRLF failure this file exists to
 * prevent; a needle that matches more than once means the mutation is not the
 * one it claims to be. Both abort.
 */
export function applySubstitution(text, sub, mutationId) {
  const parts = text.split(sub.needle);
  if (parts.length !== 2) {
    throw new Error(
      `[${mutationId}] needle matched ${parts.length - 1} time(s), expected exactly 1.\n` +
        `  file:   ${sub.file}\n` +
        `  needle: ${JSON.stringify(sub.needle)}\n` +
        (parts.length === 1
          ? '  A zero match is the silent failure this harness exists to prevent — the arm ' +
            'would "apply" nothing and the suite would stay green.'
          : '  An ambiguous needle mutates more than the arm describes.'),
    );
  }
  return parts.join(sub.replacement);
}

/** Apply every substitution of a mutation. Returns the files it touched + their originals. */
export function applyMutation(mutation) {
  /** @type {Map<string,string>} */
  const originals = new Map();
  try {
    for (const sub of mutation.substitutions) {
      if (!originals.has(sub.file)) originals.set(sub.file, readOriginal(sub.file));
      const current = readFileSync(sub.file, 'utf8');
      writeFileSync(sub.file, applySubstitution(current, sub, mutation.id), 'utf8');
    }
  } catch (err) {
    restore(originals);
    throw err;
  }
  return originals;
}

/** Put every touched file back byte-for-byte. */
export function restore(originals) {
  for (const [file, text] of originals) writeFileSync(file, text, 'utf8');
}
