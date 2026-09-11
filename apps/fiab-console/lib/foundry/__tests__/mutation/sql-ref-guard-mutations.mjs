/**
 * THE MUTATION TABLE for the ontology SQL-sink name-space guard (#4219).
 *
 * WHY THIS EXISTS IN THE DIFF AND NOT IN `temp/`. Every "receipt" this PR gave
 * for the guard was a mutation run by hand in a scratch worktree and then
 * deleted. A reviewer cannot re-run that, so it is a CLAIM. Round-4 review then
 * invented a mutation none of those receipts covered — narrow the empty-part
 * refusal to trailing-only — and the spec stayed 42/42 RC=0 while
 * `master..sysobjects` reached `buildSqlSelect`. The counterfactuals live here
 * now, so the next edit to this guard can be challenged by anyone.
 *
 * ── A GREEN MUTATION IS AMBIGUOUS ────────────────────────────────────────
 *
 * A mutant that survives means EITHER the spec is blind OR the mutation was too
 * weak to change behaviour — and the exit code cannot tell you which. So every
 * arm below carries `why`: the MECHANISM by which the mutant changes what
 * `ontologySqlRefViolation` returns for a named input. An arm whose `why` you
 * cannot state is not evidence.
 *
 * ── THE CRLF LANDMINE ────────────────────────────────────────────────────
 *
 * Measured on this tree: `lib/foundry/ontology-binding.ts` is CRLF=623,
 * bareLF=0, while its committed blob is LF (`core.autocrlf=true`). A needle
 * written with the wrong terminator matches ZERO times, the arm "applies"
 * nothing, the suite stays green, and the run reads exactly like a pass.
 *
 * The defence is structural, not careful: EVERY NEEDLE BELOW CONTAINS NO
 * NEWLINE, so it cannot express a line ending and the whole class is
 * unreachable. `applySubstitution` additionally asserts each needle matched
 * EXACTLY ONCE — a stale or ambiguous needle aborts the arm instead of quietly
 * no-opping. `run-arms.mjs` proves both failure modes before any arm runs.
 *
 * ── BROAD vs NARROW ──────────────────────────────────────────────────────
 *
 * BROAD deletes the rule. NARROW keeps a rule that still refuses the spellings
 * anyone thought to try and lets a sibling through. The narrow arms are the ones
 * that matter here: `startsWith('sys')` was proposed by a reviewer as the fix,
 * and `empty-part-trailing-only` and `divergence-first-char-only` are both
 * shapes that a spec built on the obvious cases stays green under.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/fiab-console */
export const CONSOLE_ROOT = join(HERE, '..', '..', '..', '..');

export const GUARD = join(CONSOLE_ROOT, 'lib', 'foundry', 'ontology-binding.ts');
export const RESOLVER = join(CONSOLE_ROOT, 'lib', 'foundry', 'ontology-resolver.ts');

const SPEC = 'lib/foundry/__tests__/ontology-resolver-sql-sink-authz.test.ts';

/** The exact source lines each arm rewrites. Named once so a stale one is obvious. */
const EMPTY_PART_CHECK = "  if (parts.length === 0 || parts.some((p) => p === '')) {";
const SCHEMA_CHECK = '  if (FORBIDDEN_SQL_SCHEMAS.has(schema)) {';
const ONE_PART_CHECK = '  if (parts.length === 1) {';
const SCHEMA_READ = '  const schema = parts[parts.length - 2].toLowerCase();';
const SPLITTER = "  return (ref || '').trim().split('.').map((p) => p.replace(/[[\\]]/g, '').trim());";
const DIVERGENCE_CONSUME = '  const divergence = sqlRefBracketDivergence(ref);';
const DIVERGENCE_OPEN = "      if (c === '[') inside = true;";
const WAREHOUSE_GATE =
  '        const refused = sqlRefGate(kind, binding.source.ref, dedicatedTarget().database);';

/**
 * @typedef {{ file: string, needle: string, replacement: string }} Substitution
 * @typedef {{ id: string, arm: 'broad'|'narrow'|'hollow', what: string, why: string,
 *             spec: string, mustFail: string[], substitutions: Substitution[] }} Mutation
 */

/** @type {Mutation[]} */
export const MUTATIONS = [
  // ── the empty-part refusal — the branch round-4 review found unprotected ──
  {
    id: 'empty-part-trailing-only',
    arm: 'narrow',
    what: "the empty-part refusal keeps only the TRAILING case (`parts[last] === ''`)",
    why:
      "`master..sysobjects` splits to ['master','','sysobjects']: the last part is non-empty so the " +
      "narrowed check passes, `parts.length` is 3 so the one-part rule does not apply, the schema is " +
      "'' which is not in FORBIDDEN_SQL_SCHEMAS, and the 3-part database test compares 'master' to " +
      "ownDatabase 'master' and AGREES — so the function returns null and the ref reaches buildSqlSelect " +
      'as `SELECT TOP 100 * FROM master..sysobjects`. In T-SQL that omitted middle part is exactly the ' +
      'SERVER-chosen default-schema resolution this rule exists to refuse. This arm was measured GREEN ' +
      'against the pre-round-4 spec (42/42, RC=0), because its only empty-part assertion used a database ' +
      'that did NOT match and was therefore refused by the database branch instead.',
    spec: SPEC,
    mustFail: ['empty part in EVERY position', "REFUSES 'master..sysobjects'"],
    substitutions: [
      {
        file: GUARD,
        needle: EMPTY_PART_CHECK,
        replacement: "  if (parts.length === 0 || parts[parts.length - 1] === '') {",
      },
    ],
  },
  {
    id: 'empty-part-removed',
    arm: 'broad',
    what: 'the empty-part refusal is deleted outright',
    why:
      "`dbo.` splits to ['dbo',''] — 2 parts, schema 'dbo', no database test — so it returns null; and " +
      '`master..sysobjects` returns null by the chain above. The broad form is here as the control for ' +
      'the narrow one: if BOTH escape, the finding is about the spec, not about the narrowing.',
    spec: SPEC,
    mustFail: ['refuses an empty part'],
    substitutions: [
      { file: GUARD, needle: EMPTY_PART_CHECK, replacement: '  if (parts.length === 0) {' },
    ],
  },

  // ── the one-part refusal — round-3's fix, kept re-runnable ───────────────
  {
    id: 'one-part-pre-fix',
    arm: 'broad',
    what:
      'the guard reverts to its pre-round-3 shape: no one-part refusal, and the schema test back ' +
      'behind an implicit length check',
    why:
      "a one-part ref like `spt_values` splits to ['spt_values']; with the one-part branch gone " +
      "`parts[parts.length - 2]` is undefined, so the schema read is made total (`|| ''`) exactly as the " +
      "pre-fix code was, '' is not forbidden, `parts.length` is not 3, and the function returns null. " +
      'The server then picks the schema. Review measured ten such spellings reaching the sink.',
    spec: SPEC,
    mustFail: ['one-part ref', 'names no schema'],
    substitutions: [
      { file: GUARD, needle: ONE_PART_CHECK, replacement: '  if (false) {' },
      { file: GUARD, needle: SCHEMA_READ, replacement: "  const schema = (parts[parts.length - 2] || '').toLowerCase();" },
    ],
  },

  // ── the schema set — the fix a previous reviewer proposed, and refused ───
  {
    id: 'schema-startswith-sys',
    arm: 'narrow',
    what: "FORBIDDEN_SQL_SCHEMAS is replaced by the `schema.startsWith('sys')` rule review proposed",
    why:
      '`dbo.spt_values` and `dbo.MSreplication_options` are not the target — the target is the SCHEMA ' +
      "token. `db_owner.t` and `information_schema.tables` do not begin with 'sys', so the narrowed rule " +
      'returns null for them while still refusing every `sys.*` spelling anyone would try first. This is ' +
      'the arm that proves declining that suggestion was a decision and not an oversight.',
    spec: SPEC,
    mustFail: ['ALL NINE fixed-role schemas'],
    substitutions: [
      { file: GUARD, needle: SCHEMA_CHECK, replacement: "  if (schema.startsWith('sys')) {" },
    ],
  },

  // ── the splitter's normalisation ─────────────────────────────────────────
  {
    id: 'per-part-trim-removed',
    arm: 'narrow',
    what: 'each part is no longer trimmed after the brackets are stripped',
    why:
      "`sys .t` splits to ['sys ','t']; without the per-part trim the schema token is 'sys ' with a " +
      "trailing space, which is not 'sys' and misses FORBIDDEN_SQL_SCHEMAS. The string still dies one " +
      'call later on SQL_REF_RE, so this arm shows the guard leaning on a DIFFERENT check’s alphabet ' +
      'rather than being true on its own terms — the reason the trim is there.',
    spec: SPEC,
    mustFail: ['trims each name part'],
    substitutions: [
      {
        file: GUARD,
        needle: SPLITTER,
        replacement: "  return (ref || '').trim().split('.').map((p) => p.replace(/[[\\]]/g, ''));",
      },
    ],
  },
  {
    id: 'bracket-strip-outermost-only',
    arm: 'narrow',
    what: 'bracket stripping reverts to the outermost pair (`/^\\[|\\]$/g`)',
    why:
      "`[[sys]].[sql_logins]` splits to ['[[sys]]','[sql_logins]']; stripping one leading `[` and one " +
      "trailing `]` leaves '[sys]', which is not 'sys' and misses the schema set. Measured through the " +
      'real resolver before the fix: gated=false, one synapseExecute call.',
    spec: SPEC,
    mustFail: ['BRACKET SPELLING'],
    substitutions: [
      {
        file: GUARD,
        needle: SPLITTER,
        replacement: "  return (ref || '').trim().split('.').map((p) => p.replace(/^\\[|\\]$/g, '').trim());",
      },
    ],
  },

  // ── the bracket-divergence rule added in round 4 ─────────────────────────
  {
    id: 'divergence-not-consumed',
    arm: 'hollow',
    what: 'sqlRefBracketDivergence is still CALLED and its verdict is discarded',
    why:
      'the C3 shape this repo keeps re-finding: a gate that runs and whose answer nothing reads. ' +
      '`&& null` keeps the call (so a coverage- or call-counting check still sees it) while forcing ' +
      'both refusal branches unreachable, and `sys.[a.b]` with database `sys` returns null again.',
    spec: SPEC,
    mustFail: ['brackets make this splitter and T-SQL disagree'],
    substitutions: [
      {
        file: GUARD,
        needle: DIVERGENCE_CONSUME,
        replacement: '  const divergence = sqlRefBracketDivergence(ref) && null;',
      },
    ],
  },
  {
    id: 'divergence-first-char-only',
    arm: 'narrow',
    what: 'only a `[` at position 0 opens a delimited identifier',
    why:
      'the positional/outermost narrowing this file already had to fix once for bracket stripping. ' +
      '`[a.b].[c]` still trips the rule because its `[` is at index 0 — so the obvious test case stays ' +
      'green — while `sys.[a.b]`, whose `[` is at index 4, is never seen as opening a bracket, carries ' +
      'dotInside=false, and is permitted straight through to `SELECT TOP 100 * FROM sys.[a.b]`. A spec ' +
      'that only asserted the leading-bracket spelling would not notice.',
    spec: SPEC,
    mustFail: ["REFUSES 'sys.[a.b]'"],
    substitutions: [
      {
        file: GUARD,
        needle: DIVERGENCE_OPEN,
        replacement: "      if (c === '[' && i === 0) inside = true;",
      },
    ],
  },

  // ── the wiring, not the policy ───────────────────────────────────────────
  {
    id: 'warehouse-sink-ungated',
    arm: 'narrow',
    what: 'the gate stays on `lakehouse-table` and is removed from `warehouse-table`',
    why:
      'the "3 of 4 paths consume the refusal" shape. The pure-function assertions and every ' +
      'lakehouse-sink assertion stay green — the policy is untouched — while the Dedicated-pool sink ' +
      'executes whatever ref it is given. Proves the spec asserts WIRING on both sinks and not just on ' +
      'the one that was easiest to write.',
    spec: SPEC,
    mustFail: ['warehouse-table'],
    substitutions: [
      {
        file: RESOLVER,
        needle: WAREHOUSE_GATE,
        replacement: '        const refused: ReturnType<typeof sqlRefGate> | null = null;',
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
 * Zero matches is the CRLF/stale-needle failure this file exists to prevent: the
 * arm would apply nothing and the suite would stay green. More than one means
 * the mutation is not the one the table describes. Both abort.
 */
export function applySubstitution(text, sub, mutationId) {
  const parts = text.split(sub.needle);
  if (parts.length !== 2) {
    throw new Error(
      `[${mutationId}] needle matched ${parts.length - 1} time(s), expected exactly 1.\n` +
        `  file:   ${sub.file}\n` +
        `  needle: ${JSON.stringify(sub.needle)}\n` +
        (parts.length === 1
          ? '  A zero match is the silent failure this harness exists to prevent — the arm would ' +
            '"apply" nothing and the suite would stay green.'
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
