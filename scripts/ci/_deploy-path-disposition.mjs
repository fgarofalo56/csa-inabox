#!/usr/bin/env node
/**
 * _deploy-path-disposition.mjs — is a watched deploy path DELIBERATELY dormant?
 *
 * ── THE DEFECT THIS REMOVES (#4144) ─────────────────────────────────────────
 *
 * `deploy-staleness` reported eight stale/failing/never-run deploy paths on
 * every run. Two were tracked. SIX were not, and nothing in the repo recorded a
 * decision about any of them, so the check reported them daily into a void:
 *
 *   deploy-fiab-il5.yml            has NEVER run — the only lane that applies
 *                                  main.bicep to the DoD IL5 estate
 *   deploy-report-subscriptions.yml never run for real (one dry run ignored)
 *   deploy-loom-uat.yml            17d+ undeployed
 *   deploy-loom-verify.yml         17d+ undeployed
 *   deploy-loom-sharing.yml        15d+ undeployed
 *   gov-uc-purview-wire.yml        15d+ undeployed
 *
 * deploy-integrity.md R1 ("a broken deploy path is P0") and R3 ("a path that has
 * NEVER run is the loudest case, not a silent pass") both say that is not an
 * acceptable steady state. But the fix cannot be "make it green": a report that
 * is red forever for reasons nobody has decided about is a report nobody reads,
 * which is precisely how the 2026-08-05 two-week deploy blackout stayed
 * invisible while every dashboard was already red.
 *
 * SO THE MISSING FACT IS INTENT. "Stale because nobody looked" and "stale
 * because we decided to leave it dormant, for this measured reason, until this
 * date" are different facts with different fixes, and until this register
 * existed they rendered identically.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * It is NOT an allowlist that turns a lane green. An acknowledged row is printed
 * on EVERY run, with its owner, its reason, the condition it acknowledges and
 * its expiry — it is reported as ACKNOWLEDGED, never omitted, and never counted
 * as ok. The only thing a disposition changes is the EXIT CODE for that one row.
 *
 * And it can only reach two conditions. `drift` (undeployed code) and
 * `never-run` are states an operator can legitimately decide to hold. A FAILING
 * lane, a SWITCHED-OFF lane, an UNKNOWN workflow state and an UNREADABLE run
 * history are NEVER acknowledgeable — {@link ACKNOWLEDGEABLE} does not contain
 * them and {@link classifyDisposition} refuses any entry that names one, so no
 * amount of register editing can suppress the three signals that six weeks of
 * red full-app-deploy-commercial and seventeen red GCC-High runs needed.
 * check-deploy-staleness's own closing advice has said this in prose since it
 * was written ("A FAILING or DISABLED path is never signed off that way"); this
 * file makes it mechanical.
 *
 * ── WHY A CHECKED-IN FILE, AND WHY THIS EXACT SHAPE ─────────────────────────
 *
 * The same answer scripts/ci/workflow-lane-states-allowlist.json gives for
 * workflow disablement, and scripts/ci/_estate-pause-declaration.mjs gives for a
 * paused estate: a repo variable or a GitHub UI toggle is "one click, no commit,
 * no review, no record". This file IS the record. It is deliberately the same
 * vocabulary as those two — `owner`, a substantive `reason`, `declaredOn`, and
 * an EXPIRING `reviewBy` — so the repo has one idea of what a declared
 * exception looks like rather than three.
 *
 * ── THE TWO DIRECTIONS ARE NOT SYMMETRIC ────────────────────────────────────
 *
 * SUPPRESSING is the dangerous direction, so it takes POSITIVE evidence: a
 * well-formed, owned, unexpired entry naming this exact workflow AND this exact
 * condition. EVERY uncertain outcome — register missing, unparseable, wrong
 * shape, workflow absent, reason too thin, a date that cannot be true, an
 * expired review — resolves to `declared: false`, which means the row is judged
 * EXACTLY as it was before this file existed. "I could not tell" must never
 * become "somebody signed this off."
 *
 * Every rejection carries a `reason` the caller PRINTS. A declaration that is
 * silently ignored is worse than none: the operator believes the path is
 * acknowledged and cannot see why the report is still red (deploy-integrity.md
 * R7 — say only what was actually established).
 *
 * ── THE REGISTER MUST STAY TRUE, SO DRAINING HAS TEETH ──────────────────────
 *
 * {@link auditDispositionRegister} is the other half, and it is the half that
 * stops this becoming the thing it replaces. A register nobody drains stops
 * describing reality (`stale_audit_items_propagate`), so an entry that no longer
 * matches the world is a FINDING, not a shrug:
 *
 *   - an entry for a workflow that is not WATCHED at all (renamed, deleted,
 *     never registered) — it acknowledges nothing and hides that it does;
 *   - a `never-run` acknowledgment on a lane that HAS now run for real. That is
 *     good news and a ONE-WAY DOOR: a lane cannot become never-run again, so the
 *     row is permanently obsolete and must be drained;
 *   - the same workflow declared twice, where two reasons disagree in silence.
 *
 * A `drift` acknowledgment is deliberately NOT audited that way. Drift
 * oscillates — a lane that deploys today drifts again next week — so demanding a
 * drain the moment it clears would make the register churn; that entry expires
 * on its `reviewBy` instead, which is the teeth that matter.
 */

/**
 * Where the register lives, relative to the repo root.
 *
 * Exported so the check and the tests cannot disagree about the path — a
 * register the code reads from one place and the suite asserts about in another
 * is a register that can rot untested.
 */
export const DISPOSITION_PATH = 'scripts/ci/deploy-path-dispositions.json';

/**
 * A `reason` shorter than this is not a reason. Same floor as the estate-pause
 * register and the workflow-lane-states allowlist, on purpose: the point is not
 * the character count, it is that "dormant" and "not needed" cannot pass, so the
 * entry has to say what was MEASURED and what has to be true to change it.
 */
export const MIN_REASON_CHARS = 60;

/** Placeholder prose that is not a decision. Same list as the sibling registers. */
const PLACEHOLDER = /\b(tbd|todo|fixme|xxx|wip|n\/?a|unknown|placeholder|see above)\b/i;

/** An ISO calendar date and nothing else. Lexical comparison is only valid on this shape. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The longest window a single disposition may cover, in days from `declaredOn`.
 *
 * Expiry is the ONLY thing separating this register from the allowlist it
 * replaces, and an expiry with no ceiling is advisory: `reviewBy: '2099-12-31'`
 * satisfied every other rule in this file and acknowledged for 73 years. An
 * allowlist you can hide in for 73 years is an allowlist.
 *
 * 120 is deliberately generous — a quarter plus a month of slack. The three
 * shipped entries sit 84-91 days out, so this costs nothing today, which is
 * exactly when a cap is cheap to add and honest to choose. Re-dating an entry
 * is one line; that re-dating is the review this register is named for.
 */
export const MAX_REVIEW_DAYS = 120;

/**
 * Whole days from `from` to `to` (both ISO calendar dates), or `null` if either
 * is not a date at all.
 *
 * A DELIBERATE DEPARTURE from this file's idiom. Every other date rule here is a
 * lexical string comparison, which is exact on the ISO shape and needs no
 * parsing — but a *span* cannot be computed lexically, so this one guard parses.
 * It fails closed on anything `Date` rejects, which also closes a hole the
 * lexical rules leave open: '2026-13-45' matches ISO_DATE and compares greater
 * than every real date in 2026, so it reads as a far-future expiry to every
 * check above and as NaN here. (`Date` does still roll '2026-02-30' forward into
 * March rather than rejecting it; that lands on a real instant a day or two off,
 * so the cap still applies to it. The point is the ceiling, not the calendar.)
 */
function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The conditions a disposition may acknowledge.
 *
 *   never-run  the lane has never executed for real. An operator can decide a
 *              boundary or a capability is not yet deployed — cloud-parity.md
 *              requires that be STATED, and this is where it is stated.
 *   drift      merged code the lane has not applied. Holding it is a deployment
 *              decision (the same one `maxDays` encodes), and it expires.
 *
 * Everything else is in {@link NEVER_ACKNOWLEDGEABLE}.
 */
export const ACKNOWLEDGEABLE = Object.freeze(['never-run', 'drift']);

/**
 * The conditions NO disposition may ever acknowledge, enumerated positively so
 * the refusal is a fact in the code rather than a sentence in a comment.
 *
 *   failing        a run-history failure streak. This is R1's P0 case; six weeks
 *                  of red full-app-deploy-commercial is what it exists for.
 *   disabled       the workflow is switched off. Different fact, different fix
 *                  (`gh workflow enable`), and it already has its own register.
 *   state-unknown  the workflow was not in the page we read — pagination, not
 *                  health. An unmeasured thing must not be signed off.
 *   query-failed   the run history could not be read at all. Same reason.
 */
export const NEVER_ACKNOWLEDGEABLE = Object.freeze(['failing', 'disabled', 'state-unknown', 'query-failed']);

/**
 * The dispositions a lane may carry.
 *
 *   dispatch-only        the lane is deliberately manual. Something about it
 *                        genuinely cannot be automated — a required-reviewer
 *                        environment, an operator security acceptance, a
 *                        deliberately stopped estate — and the entry says which.
 *   retirement-proposed  the lane is believed dead and its removal is proposed,
 *                        not performed. Deleting a deploy path unilaterally is
 *                        how a capability quietly loses its only producer.
 *
 * There is deliberately NO value meaning "this runs automatically": a lane with
 * a working trigger needs no entry here, and inventing one would let a broken
 * trigger hide behind a word.
 */
export const DISPOSITIONS = Object.freeze(['dispatch-only', 'retirement-proposed']);

/**
 * PURE. Is `workflow` declared deliberately dormant, as of `today`?
 *
 * @param {object} p
 * @param {unknown} p.register parsed deploy-path-dispositions.json, or null when
 *   it is absent/unreadable/unparseable. Null is NOT an error — the common case
 *   is a repo where nothing is dormant and the file does not exist.
 * @param {string|null|undefined} p.workflow the watched workflow file name.
 * @param {string} p.today ISO 'YYYY-MM-DD'.
 * @returns {{declared: boolean, reason: string, entry: object|null, acknowledges: string[], hasEntry: boolean}}
 *
 * `hasEntry` distinguishes "nobody declared anything about this lane" from "an
 * entry exists and was REFUSED". Only the second is worth printing beside a red
 * row, and printing it is the point: a declaration that is silently ignored is
 * worse than no declaration, because the operator believes the path is signed
 * off and cannot see why the report is still red.
 */
export function classifyDisposition({ register, workflow, today }) {
  // Flipped the moment an entry for this workflow is found, so every refusal
  // BELOW that point reports `hasEntry: true` without each call site having to
  // remember to say so. A refusal that forgot would render as "nobody declared
  // anything", which is the one thing this flag exists to distinguish.
  let entryFound = false;
  const no = (reason) => ({ declared: false, reason, entry: null, acknowledges: [], hasEntry: entryFound });

  if (!workflow || typeof workflow !== 'string' || workflow.trim() === '') {
    // The CALLER did not say which lane it is asking about. Guessing would let
    // one lane's disposition silence another's.
    return no('no workflow was supplied, so no disposition can apply — the path is judged as undeclared');
  }
  if (!ISO_DATE.test(String(today ?? ''))) {
    // Without a trustworthy today, `reviewBy` cannot expire — and an expiry that
    // cannot fire is the "budget that cannot be exceeded" shape. Refuse to
    // suppress rather than suppress forever.
    return no(`today was not an ISO date ('${today}'), so a reviewBy expiry could not be evaluated — NOT acknowledging`);
  }
  if (register === null || register === undefined) {
    return no(`no ${DISPOSITION_PATH} was readable, so no deploy path is declared dormant`);
  }
  if (typeof register !== 'object' || Array.isArray(register)) {
    return no(`${DISPOSITION_PATH} is not a JSON object, so nothing was established — NOT acknowledging`);
  }
  const declaredList = register.dispositions;
  if (!Array.isArray(declaredList)) {
    return no(`${DISPOSITION_PATH} has no \`dispositions\` array, so nothing was established — NOT acknowledging`);
  }

  const matches = declaredList.filter((e) => e && typeof e === 'object' && e.workflow === workflow);
  if (matches.length === 0) {
    return no(`'${workflow}' is not declared dormant in ${DISPOSITION_PATH}`);
  }
  entryFound = true;
  if (matches.length > 1) {
    // Two entries, two reasons, and no way to tell which one an operator meant.
    // auditDispositionRegister reports this as a finding too; refusing here as
    // well means an ambiguous register cannot suppress anything in the meantime.
    return no(
      `'${workflow}' is declared ${matches.length} times in ${DISPOSITION_PATH} — NOT acknowledging. ` +
        'One lane, one entry, one reason: duplicates disagree silently.',
    );
  }
  const entry = matches[0];

  // ── An entry EXISTS. It still has to be a real one. ───────────────────────
  if (!DISPOSITIONS.includes(String(entry.disposition ?? ''))) {
    return no(
      `the '${workflow}' entry's \`disposition\` is '${entry.disposition}', which is not one of ` +
        `${DISPOSITIONS.join(' / ')} — NOT acknowledging. There is deliberately no value meaning ` +
        '"this runs automatically": a lane with a working trigger needs no entry here.',
    );
  }
  if (typeof entry.owner !== 'string' || entry.owner.trim() === '') {
    return no(`the '${workflow}' entry names no \`owner\`, so nobody owns the decision — NOT acknowledging`);
  }
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
  if (reason.length < MIN_REASON_CHARS) {
    return no(
      `the '${workflow}' entry's \`reason\` is ${reason.length} characters (minimum ${MIN_REASON_CHARS}) — ` +
        'NOT acknowledging. State what was MEASURED and what must be true to change the disposition.',
    );
  }
  if (PLACEHOLDER.test(reason)) {
    return no(`the '${workflow}' entry's \`reason\` reads as a placeholder (TODO/TBD/WIP/…) — NOT acknowledging`);
  }
  if (!ISO_DATE.test(String(entry.declaredOn ?? ''))) {
    return no(`the '${workflow}' entry's \`declaredOn\` is not an ISO date ('${entry.declaredOn}') — NOT acknowledging`);
  }
  if (String(entry.declaredOn) > today) {
    return no(
      `the '${workflow}' entry's \`declaredOn\` is ${entry.declaredOn}, which is LATER than today (${today}) — ` +
        'NOT acknowledging. A decision cannot have been made in the future.',
    );
  }
  if (!ISO_DATE.test(String(entry.reviewBy ?? ''))) {
    return no(
      `the '${workflow}' entry's \`reviewBy\` is not an ISO date ('${entry.reviewBy}') — NOT acknowledging. ` +
        'Without a parseable expiry a disposition would be permanent by default, which is how a deploy path ' +
        'stays dark for months while the report reads acknowledged.',
    );
  }
  if (String(entry.reviewBy) <= String(entry.declaredOn)) {
    // Born expired. The `reviewBy < today` rule below only bites from the day
    // AFTER declaration, so on the declaration day itself an entry whose review
    // is due immediately would acknowledge once and then lapse.
    return no(
      `the '${workflow}' entry's \`reviewBy\` (${entry.reviewBy}) is not after its \`declaredOn\` ` +
        `(${entry.declaredOn}) — NOT acknowledging. A decision that expires the day it is made is not a decision.`,
    );
  }
  if (String(entry.reviewBy) < today) {
    // EXPIRY IS THE TEETH. A disposition that never lapses is how a dormant
    // deploy path becomes a permanent one with nobody deciding to make it so.
    return no(
      `the '${workflow}' disposition EXPIRED on ${entry.reviewBy} (today is ${today}) — NOT acknowledging. ` +
        'Re-date it with a fresh read of the lane, dispatch it, or retire it — but decide.',
    );
  }
  // ...and teeth need a jaw. The rule above only fires once the date has passed,
  // so without a ceiling on how far out it may be set, `reviewBy: '2099-12-31'`
  // passes every rule in this function and acknowledges for 73 years.
  //
  // Measured from `declaredOn`, not from `today`, on purpose: the span is then a
  // property of the entry itself, reproducible from its own two fields by anyone
  // reading the file, and it cannot drift into compliance as the calendar moves.
  const span = daysBetween(String(entry.declaredOn), String(entry.reviewBy));
  if (span === null) {
    return no(
      `the '${workflow}' entry's dates are ISO-SHAPED but not real dates ` +
        `(declaredOn '${entry.declaredOn}', reviewBy '${entry.reviewBy}') — NOT acknowledging. ` +
        'Every other date rule here compares strings, so an impossible month reads as a far-future expiry.',
    );
  }
  if (span > MAX_REVIEW_DAYS) {
    return no(
      `the '${workflow}' disposition runs ${span} days from ${entry.declaredOn} to ${entry.reviewBy}, ` +
        `over the ${MAX_REVIEW_DAYS}-day cap — NOT acknowledging. A disposition is a decision to revisit, ` +
        'not a permanent exemption; shorten `reviewBy` and re-date it when you next read the lane.',
    );
  }

  const acknowledges = entry.acknowledges;
  if (!Array.isArray(acknowledges) || acknowledges.length === 0) {
    return no(
      `the '${workflow}' entry declares no \`acknowledges\` conditions — NOT acknowledging. ` +
        `An entry has to name WHAT it signs off (${ACKNOWLEDGEABLE.join(' / ')}); a blanket exemption is ` +
        'exactly the allowlist this register refuses to be.',
    );
  }
  const forbidden = acknowledges.filter((c) => NEVER_ACKNOWLEDGEABLE.includes(String(c)));
  if (forbidden.length > 0) {
    return no(
      `the '${workflow}' entry tries to acknowledge ${forbidden.join(', ')} — NOT acknowledging ANYTHING. ` +
        `${NEVER_ACKNOWLEDGEABLE.join(' / ')} can never be signed off in this register: a FAILING lane is ` +
        'deploy-integrity R1, a DISABLED one has its own register, and the other two are unmeasured rather ' +
        'than decided. The whole entry is refused so a forbidden condition cannot ride along beside a legal one.',
    );
  }
  const unknown = acknowledges.filter((c) => !ACKNOWLEDGEABLE.includes(String(c)));
  if (unknown.length > 0) {
    return no(
      `the '${workflow}' entry names unrecognised condition(s) ${unknown.join(', ')} — NOT acknowledging. ` +
        `Only ${ACKNOWLEDGEABLE.join(' / ')} exist; a typo must not silently widen what is signed off.`,
    );
  }

  return {
    declared: true,
    hasEntry: true,
    entry,
    acknowledges: acknowledges.map(String),
    reason:
      `'${workflow}' is DECLARED ${entry.disposition} in ${DISPOSITION_PATH} by ${entry.owner}, declaredOn ` +
      `${entry.declaredOn}, reviewBy ${entry.reviewBy}, acknowledging: ${acknowledges.join(', ')}. ` +
      `Declared reason: ${reason}`,
  };
}

/**
 * PURE. Does the register still describe reality?
 *
 * Called with the rows the staleness check has ALREADY measured, so this asks
 * only about entries — never about lanes. A lane with no entry is not a finding
 * here; it is simply judged on its own conditions, as it always was.
 *
 * @param {object} p
 * @param {unknown} p.register parsed register, or null.
 * @param {{workflow:string, conditions:string[]}[]} p.rows measured rows.
 * @returns {{kind:string, subject:string, why:string}[]} findings, [] when clean
 */
export function auditDispositionRegister({ register, rows }) {
  const findings = [];
  const push = (kind, subject, why) => findings.push({ kind, subject, why });

  if (register === null || register === undefined) return findings; // nothing declared, nothing to drain
  if (typeof register !== 'object' || Array.isArray(register) || !Array.isArray(register.dispositions)) {
    push(
      'register-malformed',
      DISPOSITION_PATH,
      'the register exists but is not an object carrying a `dispositions` array. It acknowledges nothing, ' +
        'and a file that looks like a decision record while recording nothing is worse than its absence.',
    );
    return findings;
  }

  const measured = new Map((rows || []).map((r) => [r.workflow, r.conditions || []]));
  const seen = new Set();

  for (const entry of register.dispositions) {
    const wf = String(entry?.workflow ?? '');
    if (!wf) {
      push('entry-malformed', '(entry with no workflow)', 'every disposition entry needs a `workflow`.');
      continue;
    }
    if (seen.has(wf)) {
      push(
        'duplicate-entry',
        wf,
        'declared more than once. One lane, one entry, one reason — two entries disagree in silence, and ' +
          'classifyDisposition refuses to honour either of them while both exist.',
      );
      continue;
    }
    seen.add(wf);

    if (!measured.has(wf)) {
      push(
        'not-watched',
        wf,
        `is declared dormant but is not a WATCHED deploy path, so this entry acknowledges NOTHING while ` +
          'reading as a decision. Renamed, deleted, or never registered: add it to WATCHED in ' +
          `check-deploy-staleness.mjs, or drain the row from ${DISPOSITION_PATH}.`,
      );
      continue;
    }

    const conditions = measured.get(wf);
    const acks = Array.isArray(entry?.acknowledges) ? entry.acknowledges.map(String) : [];
    if (acks.includes('never-run') && !conditions.includes('never-run')) {
      push(
        'never-run-drained',
        wf,
        'acknowledges `never-run`, but this lane HAS now run for real. That is good news and a one-way ' +
          'door — a lane cannot become never-run again — so the acknowledgment is permanently obsolete. ' +
          `Drain it from ${DISPOSITION_PATH} (or narrow it to \`drift\` if the lane is now merely behind).`,
      );
    }
  }

  return findings;
}
