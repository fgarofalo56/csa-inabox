/**
 * LOOM BRAIN W10 — the READ boundary for stored finding documents (#3936).
 *
 * PURE. No Azure SDK, no `node:*`, no environment. `./__tests__/purity.test.ts`
 * enforces that, and it matters here more than anywhere: this module is the
 * thing that decides whether a document Cosmos handed back is safe to reconcile
 * against, and that decision has to be provable with fixtures.
 *
 * ── WHY THIS EXISTS (review of #4014, S1) ──────────────────────────────────
 * `lifecycle.ts` states the defence in its header — *"Rejected at the type level
 * by `Suppression` … and again at runtime here, because a record can also arrive
 * from Cosmos as untyped JSON"* — and that sentence was HALF TRUE. The runtime
 * validation lives in `acceptFinding()`, which is the WRITE path. The READ path
 * did `out.push(record as unknown as FindingRecord)` with a single id/fingerprint
 * check, and `reconcile()` then dereferenced `prior.suppression.expiresAt`.
 *
 * Two input SHAPES had no fixture anywhere in this repo, and they fail in
 * opposite directions:
 *
 *   (a) `state:'accepted'`, correct `schemaVersion`, and NO `suppression`.
 *       `suppressionExpired(prior.suppression, at)` reads `.expiresAt` of
 *       `undefined` -> `TypeError`, the run exits 1, and it does so again every
 *       night until somebody hand-edits Cosmos. Note the schema-version guard
 *       catches a document with NO `schemaVersion`; it does not catch one with a
 *       CORRECT `schemaVersion` and a missing field.
 *
 *   (b) an UNPARSEABLE `expiresAt` — `''`, `'never'`, a date-only string a
 *       future writer emits. `Date.parse(at) >= NaN` is `false`, so the
 *       suppression NEVER EXPIRES. The finding is counted under `suppressed`
 *       and is never listed again. That is byte-for-byte the outcome of the
 *       `suppressions-never-expire` mutation arm, reached through DATA instead
 *       of CODE — so the mutation sweep cannot see it, P-EXP is defeated, and
 *       there is no error, no note and no log line to say so.
 *
 * The lesson recorded from this repo's own null-deref incident is the one that
 * applies: ask "what INPUT SHAPE has no fixture?", not only "what mutation?".
 * A type-correct fixture cannot reach a lie told to the compiler.
 *
 * ── WHY THIS THROWS RATHER THAN DROPPING ───────────────────────────────────
 * Skipping a malformed document would SHRINK the backlog silently, which is the
 * dominant evasion class this repo measures — a record that leaves the examined
 * population is invisible in every artifact except a count. Returning it
 * unvalidated is what shipped. So the only remaining option is to fail closed
 * and NAME the document, which is exactly the stance
 * `FindingDocumentIntegrityError` already takes one check earlier in the same
 * loop. Consistency with that precedent is deliberate.
 */

import {
  FINDING_STATES,
  type FindingRecord,
  type FindingState,
} from './model';

/**
 * A stored document that cannot be trusted as a {@link FindingRecord}.
 *
 * Carries the document id, the offending field and what was actually seen —
 * `deploy-integrity.md` R7: the message states only what was established, and
 * R6: it names the repair rather than emitting a stack trace.
 */
export class FindingDocumentShapeError extends Error {
  readonly documentId: string;
  readonly field: string;
  constructor(documentId: string, field: string, saw: string, why: string) {
    super(
      `finding document '${documentId}' cannot be reconciled: field '${field}' ${why} ` +
        `(saw ${saw}). REFUSING to continue. A malformed record is not skipped, because a ` +
        'record that silently leaves the backlog is the population-shrinking failure this ' +
        'lane exists to detect; and it is not passed through, because the reconcile would ' +
        'either throw on a missing field or read an unparseable expiry as "not yet expired", ' +
        'which suppresses a real finding FOREVER with nothing printed. Repair or delete the ' +
        'document in the brain-findings container, then re-run.',
    );
    this.name = 'FindingDocumentShapeError';
    this.documentId = documentId;
    this.field = field;
  }
}

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function saw(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return `the string '${v}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return `${typeof v} ${String(v)}`;
  if (Array.isArray(v)) return `an array of ${v.length}`;
  return typeof v;
}

function requireNonEmptyString(
  doc: Record<string, unknown>,
  id: string,
  field: string,
): string {
  const v = doc[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new FindingDocumentShapeError(id, field, saw(v), 'must be a non-empty string');
  }
  return v;
}

function requireFiniteNumber(doc: Record<string, unknown>, id: string, field: string): number {
  const v = doc[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new FindingDocumentShapeError(id, field, saw(v), 'must be a finite number');
  }
  return v;
}

/**
 * An instant field that MUST parse.
 *
 * This is shape (b)'s cure at the read boundary. `Date.parse` returning `NaN`
 * makes every subsequent comparison `false`, which reads as "not yet expired" /
 * "not yet due" — a silent, permanent suppression. `Number.isFinite` is the
 * check that cannot be satisfied by `NaN`.
 */
function requireInstant(doc: Record<string, unknown>, id: string, field: string): void {
  const v = doc[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new FindingDocumentShapeError(id, field, saw(v), 'must be a non-empty ISO-8601 string');
  }
  if (!Number.isFinite(Date.parse(v))) {
    throw new FindingDocumentShapeError(
      id,
      field,
      saw(v),
      'must be a PARSEABLE instant — Date.parse returned NaN, and every comparison against ' +
        'NaN is false, so an unparseable expiry reads as "not yet expired" forever',
    );
  }
}

/** The suppression sub-object, validated field by field. P-SUP + P-EXP. */
function requireSuppression(doc: Record<string, unknown>, id: string): void {
  const s = doc.suppression;
  if (!isRecordObject(s)) {
    throw new FindingDocumentShapeError(
      id,
      'suppression',
      saw(s),
      "must be an object — state 'accepted' without one makes reconcile() dereference " +
        'undefined and kill the whole run',
    );
  }
  for (const f of ['reason', 'owner'] as const) {
    const v = s[f];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new FindingDocumentShapeError(
        id,
        `suppression.${f}`,
        saw(v),
        'must be a non-empty string (P-SUP: a suppression with no reason or no owner is how ' +
          'a real finding gets buried)',
      );
    }
  }
  for (const f of ['acceptedAt', 'expiresAt'] as const) {
    requireInstant(s as Record<string, unknown>, id, f);
  }
}

/**
 * Validate one stored document and return it as a {@link FindingRecord}.
 *
 * Deliberately does NOT reject a record whose `schemaVersion` differs from the
 * current one: `reconcile()` reports those under `notEvaluated` and leaves them
 * UNTOUCHED, which is the correct handling and would be destroyed by rejecting
 * them here. Only a non-numeric `schemaVersion` is a shape error.
 */
export function validateFindingDocument(doc: unknown, documentId: string): FindingRecord {
  if (!isRecordObject(doc)) {
    throw new FindingDocumentShapeError(documentId, '<document>', saw(doc), 'must be an object');
  }

  const state = doc.state;
  if (typeof state !== 'string' || !(FINDING_STATES as readonly string[]).includes(state)) {
    throw new FindingDocumentShapeError(
      documentId,
      'state',
      saw(state),
      `must be one of ${FINDING_STATES.join(' | ')}`,
    );
  }

  requireFiniteNumber(doc, documentId, 'schemaVersion');
  requireNonEmptyString(doc, documentId, 'fingerprint');
  requireNonEmptyString(doc, documentId, 'estateId');
  requireNonEmptyString(doc, documentId, 'detector');
  requireNonEmptyString(doc, documentId, 'firstSeenRunId');
  requireNonEmptyString(doc, documentId, 'lastSeenRunId');
  requireInstant(doc, documentId, 'firstSeenAt');
  requireInstant(doc, documentId, 'lastSeenAt');

  const regressionCount = requireFiniteNumber(doc, documentId, 'regressionCount');
  if (regressionCount < 0 || !Number.isInteger(regressionCount)) {
    throw new FindingDocumentShapeError(
      documentId,
      'regressionCount',
      saw(regressionCount),
      'must be a non-negative integer',
    );
  }

  switch (state as FindingState) {
    case 'accepted':
      requireSuppression(doc, documentId);
      break;
    case 'fixed':
      requireInstant(doc, documentId, 'fixedAt');
      requireNonEmptyString(doc, documentId, 'fixedByRunId');
      break;
    case 'regressed':
      if (doc.priorState !== 'fixed') {
        throw new FindingDocumentShapeError(
          documentId,
          'priorState',
          saw(doc.priorState),
          "must be the literal 'fixed' (L2: a regression may only come from a fix)",
        );
      }
      requireInstant(doc, documentId, 'fixedAt');
      requireNonEmptyString(doc, documentId, 'fixedByRunId');
      requireInstant(doc, documentId, 'regressedAt');
      requireNonEmptyString(doc, documentId, 'regressedByRunId');
      break;
    case 'acknowledged':
      requireNonEmptyString(doc, documentId, 'acknowledgedBy');
      requireInstant(doc, documentId, 'acknowledgedAt');
      if (doc.resurfacedFromSuppressionAt !== undefined) {
        requireInstant(doc, documentId, 'resurfacedFromSuppressionAt');
      }
      break;
    case 'new':
      // L1: `new` pins `regressionCount: 0` as a literal and forbids a repair
      // history. A stored document claiming both is a laundered regression.
      if (regressionCount !== 0) {
        throw new FindingDocumentShapeError(
          documentId,
          'regressionCount',
          saw(regressionCount),
          "must be 0 when state is 'new' (L1: a record carrying a repair history is not a " +
            'new finding, and persisting one that way is a REGRESSION reported as new)',
        );
      }
      if (doc.fixedAt !== undefined || doc.priorState !== undefined) {
        throw new FindingDocumentShapeError(
          documentId,
          doc.fixedAt !== undefined ? 'fixedAt' : 'priorState',
          saw(doc.fixedAt !== undefined ? doc.fixedAt : doc.priorState),
          "must be absent when state is 'new' (L1)",
        );
      }
      break;
  }

  return doc as unknown as FindingRecord;
}
