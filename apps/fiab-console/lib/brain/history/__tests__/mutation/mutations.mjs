/**
 * THE MUTATION TABLE for Loom Brain W9 (graph history, #3935).
 *
 * Each entry breaks ONE property and names the spec that must go RED as a
 * result. A test suite that stays green with the property broken is a finding
 * about the suite, and this harness prints it as ESCAPED rather than passing
 * quietly.
 *
 * ── THE CRLF LANDMINE, AND WHY EVERY NEEDLE IS SINGLE-LINE ───────────────
 *
 * `core.autocrlf` is `true` in this repo, so the same bytes are CRLF in a
 * Windows working tree and LF on a Linux CI checkout. A needle written with the
 * wrong newline matches ZERO times, the harness "applies" nothing, the suite
 * stays green, and the arm reads exactly like a pass. That failure is silent and
 * total, and it has happened here before.
 *
 * The defence is structural rather than careful: EVERY NEEDLE CONTAINS NO
 * NEWLINE AT ALL, so it cannot express a line ending and the entire class is
 * unreachable. `applySubstitution` additionally asserts each needle matched
 * EXACTLY ONCE and throws otherwise — a needle that goes stale or ambiguous
 * after an edit aborts the run instead of no-opping.
 *
 * ── BROAD vs NARROW ──────────────────────────────────────────────────────
 *
 * BROAD is the obvious break. NARROW is the same defect scoped to one
 * provenance, one bound, one branch. The narrow arm is the one that matters: in
 * this repo the narrow form has passed a broad guard AND a full suite while a
 * live defect shipped, whereas the broad form goes red instantly. Every property
 * below that can be narrowed has both arms.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** apps/fiab-console */
export const CONSOLE_ROOT = join(HERE, '..', '..', '..', '..', '..');

const HISTORY = join(CONSOLE_ROOT, 'lib', 'brain', 'history');

export const CAPTURE = join(HISTORY, 'capture.ts');
export const DIGEST = join(HISTORY, 'digest.ts');
export const DIFF = join(HISTORY, 'diff.ts');
export const QUERIES = join(HISTORY, 'queries.ts');
export const ROUTE_TOOLKIT = join(CONSOLE_ROOT, 'lib', 'api', 'route-toolkit.ts');

const DIGEST_SPEC = 'lib/brain/history/__tests__/digest.test.ts';
const DIFF_SPEC = 'lib/brain/history/__tests__/diff.test.ts';
const QUERIES_SPEC = 'lib/brain/history/__tests__/queries.test.ts';
const CAPTURE_SPEC = 'lib/brain/history/__tests__/capture-retention.test.ts';
const ROUTE_SPEC = 'lib/brain/history/__tests__/route-authz.test.ts';

/**
 * @typedef {{ file: string, needle: string, replacement: string }} Substitution
 * @typedef {{ id: string, property: string, arm: 'broad'|'narrow',
 *             what: string, spec: string, substitutions: Substitution[] }} Mutation
 */

/** @type {Mutation[]} */
export const MUTATIONS = [
  // ── PROPERTY A: an unchanged estate produces no spurious diff ───────────
  {
    id: 'a-digest-order-sensitive',
    property: 'A — an unchanged estate produces no change',
    arm: 'narrow',
    what:
      'the canonical form stops sorting NODES, so the same estate re-pulled in a ' +
      'different row order hashes differently. Azure Resource Graph does not promise ' +
      'a stable order, so this is the case that actually happens.',
    spec: DIGEST_SPEC,
    substitutions: [
      {
        file: DIGEST,
        needle:
          '  const nodes = [...content.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));',
        replacement: '  const nodes = [...content.nodes];',
      },
    ],
  },
  {
    id: 'a-dedupe-disabled',
    property: 'A — an unchanged estate produces no change',
    arm: 'broad',
    what:
      'BOTH dedupe stages are disabled, so every capture appends a version and the ' +
      'history becomes a log of the polling schedule.',
    spec: CAPTURE_SPEC,
    substitutions: [
      {
        file: CAPTURE,
        needle:
          '  if (head !== null && head.digest === digest && head.formatVersion === HISTORY_FORMAT_VERSION) {',
        replacement:
          '  if (false && head !== null && head.digest === digest && head.formatVersion === HISTORY_FORMAT_VERSION) {',
      },
      {
        file: CAPTURE,
        needle: '      if (isSemanticallyEmpty(probe)) {',
        replacement: '      if (false && isSemanticallyEmpty(probe)) {',
      },
    ],
  },
  {
    id: 'a-dedupe-digest-only',
    property: 'A — an unchanged estate produces no change',
    arm: 'narrow',
    what:
      'only the SECOND stage is disabled, so a wire whose source line moved is stored ' +
      'as a new version with an empty diff — noise that looks like a change.',
    spec: CAPTURE_SPEC,
    substitutions: [
      {
        file: CAPTURE,
        needle: '      if (isSemanticallyEmpty(probe)) {',
        replacement: '      if (false && isSemanticallyEmpty(probe)) {',
      },
    ],
  },

  // ── PROPERTY B: a genuinely new edge is reported as new ─────────────────
  {
    id: 'b-added-edges-dropped',
    property: 'B — a new edge is reported as new',
    arm: 'broad',
    what: 'the head edge set is emptied, so nothing can ever be reported as added.',
    spec: DIFF_SPEC,
    substitutions: [
      {
        file: DIFF,
        needle:
          '  const headEdges = head.content.edges.filter((e) => comparable.has(e.provenance));',
        replacement: '  const headEdges = head.content.edges.filter(() => false);',
      },
    ],
  },
  {
    id: 'b-added-edges-narrowed-to-one-provenance',
    property: 'B — a new edge is reported as new',
    arm: 'narrow',
    what:
      "a single provenance ('owns') is excluded from the head edge set. Every other " +
      'provenance still diffs correctly, which is exactly the evasion that passes a ' +
      'broad guard.',
    spec: QUERIES_SPEC,
    substitutions: [
      {
        file: DIFF,
        needle:
          '  const headEdges = head.content.edges.filter((e) => comparable.has(e.provenance));',
        replacement:
          "  const headEdges = head.content.edges.filter((e) => comparable.has(e.provenance) && e.provenance !== 'owns');",
      },
    ],
  },
  {
    id: 'b-unknown-base-fails-open',
    property: 'B — a new edge is reported as new',
    arm: 'narrow',
    what:
      'an unknown base version is treated as the OLDEST retained one instead of being ' +
      'refused. Plausible-looking, and it silently answers a question nobody asked.',
    spec: QUERIES_SPEC,
    substitutions: [
      {
        file: QUERIES,
        needle: '  if (baseIndex < 0) {',
        replacement: '  if (false) {',
      },
    ],
  },

  // ── PROPERTY C: retention actually bounds ───────────────────────────────
  {
    id: 'c-prune-not-executed',
    property: 'C — retention bounds the history',
    arm: 'broad',
    what:
      'the prune is PLANNED and never executed — the shape where a retention routine ' +
      'exists, is called, computes the right answer and discards it.',
    spec: CAPTURE_SPEC,
    substitutions: [
      {
        file: CAPTURE,
        needle: '  for (const id of doomed) await args.store.remove(args.estateId, id);',
        replacement: '  void doomed;',
      },
    ],
  },
  {
    id: 'c-bound-loosened-slightly',
    property: 'C — retention bounds the history',
    arm: 'narrow',
    what:
      'the bound is raised by five. Still bounded, still prunes, still returns ids — ' +
      'and the estate keeps 10% more than the stated policy forever.',
    spec: CAPTURE_SPEC,
    substitutions: [
      {
        file: CAPTURE,
        needle: '  const doomed = planPrune(after, args.store.policy.maxVersions);',
        replacement: '  const doomed = planPrune(after, args.store.policy.maxVersions + 5);',
      },
    ],
  },

  // ── PROPERTY D: a corrupt version fails CLOSED ──────────────────────────
  {
    id: 'd-integrity-fail-open',
    property: 'D — a corrupt version is refused, never diffed',
    arm: 'broad',
    what:
      'verification is made total-pass: the count checks are dead and the digest is ' +
      'compared against itself. A truncated base then renders as mass deletion.',
    spec: DIFF_SPEC,
    substitutions: [
      {
        file: DIGEST,
        needle: '  if (v.counts.nodes !== v.content.nodes.length) {',
        replacement: '  if (false) {',
      },
      {
        file: DIGEST,
        needle: '  if (v.counts.edges !== v.content.edges.length) {',
        replacement: '  if (false) {',
      },
      {
        file: DIGEST,
        needle: '  const recomputed = computeContentDigest(v.content);',
        replacement: '  const recomputed = v.digest;',
      },
    ],
  },
  {
    id: 'd-integrity-checks-head-only',
    property: 'D — a corrupt version is refused, never diffed',
    arm: 'narrow',
    what:
      'only the HEAD is verified. The BASE — the side whose truncation renders as mass ' +
      'deletion — is trusted.',
    spec: DIFF_SPEC,
    substitutions: [
      {
        file: DIFF,
        needle: '  assertVerified(base); // diff base',
        replacement: '  void base; // diff base',
      },
    ],
  },

  // ── PROPERTY E: the safe-prune predicate does not fire on a fresh node ──
  {
    id: 'e-presence-check-dropped',
    property: 'E — the prune predicate ignores a mid-deploy resource',
    arm: 'narrow',
    what:
      'a node ABSENT from an earlier version counts as unreachable in it, so anything ' +
      'created since the oldest examined version becomes instantly prunable. This is ' +
      'the exact mid-deploy deletion #3935 names.',
    spec: QUERIES_SPEC,
    substitutions: [
      {
        file: QUERIES,
        needle: '      if (!presentPerVersion[i].has(node.id)) {',
        replacement: '      if (false) {',
      },
    ],
  },
  {
    id: 'e-coverage-check-dropped',
    property: 'E — the prune predicate ignores a mid-deploy resource',
    arm: 'narrow',
    what:
      'the coverage refusal is removed, so a version that never COLLECTED `configured` ' +
      'makes every node in the estate vacuously unreachable. Population.blind cannot ' +
      'catch this — the node set is not empty.',
    spec: QUERIES_SPEC,
    substitutions: [
      {
        file: QUERIES,
        needle: '  if (uncovered.length > 0) {',
        replacement: '  if (false) {',
      },
    ],
  },

  // ── PROPERTY F: the route's authorization is the CONSUMED verdict ───────
  {
    id: 'f-authz-verdict-discarded',
    property: 'F — the BFF gate is enforced, not merely called',
    arm: 'narrow',
    what:
      'the gate is still CALLED and its verdict is discarded — the 2026-08-07 shape ' +
      'that defeated authorization on a subscription-scoped ARM deploy path while three ' +
      'merge-blocking controls stayed green. Every text-matching checker still sees ' +
      '`requireTenantAdmin(` in the file.',
    spec: ROUTE_SPEC,
    substitutions: [
      {
        file: ROUTE_TOOLKIT,
        needle: '    const gate = requireTenantAdmin(sctx.session);',
        replacement: '    const gate = (requireTenantAdmin(sctx.session), null);',
      },
    ],
  },
];

/** Read a file as raw text, for byte-exact restore. */
export function readOriginal(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Apply one substitution, asserting the needle matched EXACTLY ONCE.
 *
 * Zero matches is the CRLF failure this file exists to prevent; more than one
 * means the mutation is not the one it claims to be. Both abort.
 */
export function applySubstitution(text, sub, mutationId) {
  const parts = text.split(sub.needle);
  if (parts.length !== 2) {
    throw new Error(
      `[${mutationId}] needle matched ${parts.length - 1} time(s), expected exactly 1.\n` +
        `  file:   ${sub.file}\n` +
        `  needle: ${JSON.stringify(sub.needle)}\n` +
        (parts.length === 1
          ? '  A ZERO match is the silent failure this harness exists to prevent — the arm ' +
            'would "apply" nothing and the suite would stay green.'
          : '  An ambiguous needle mutates more than the arm describes.'),
    );
  }
  return parts.join(sub.replacement);
}

/** Apply every substitution of a mutation. Returns the touched files + originals. */
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
