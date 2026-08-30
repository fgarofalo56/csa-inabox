#!/usr/bin/env node
/**
 * _estate-pause-declaration.mjs — is a boundary's estate DECLARED paused?
 *
 * ── THE DEFECT THIS REMOVES ─────────────────────────────────────────────────
 *
 * `deploy-fiab-gcch` ran red for 17 consecutive runs after its last success on
 * 2026-08-11 — a 15-day outage on a P0 sovereign deploy path. Every failure was
 * the same step and byte-identical output:
 *
 *   [adx-preflight] adx-csa-loom-fmezxj: state=Stopped -> start
 *   ERROR: (InsufficientResourcesForSubscription) [BadRequest] Currently there are
 *   no available resources to start the cluster with current SKU.
 *
 * The lane was working correctly at every step: it authenticated to Azure
 * Government, read the LIVE cluster state, tried the start the deploy needs, and
 * failed closed when Azure refused. What changed is the OPERATOR'S INTENT — the
 * estate pause/resume mandate says the sovereign estate stays stopped unless
 * something is actively being validated. So the daily schedule was failing on a
 * condition that is now deliberate.
 *
 * ── THE TRAP THIS FILE EXISTS TO NOT FALL INTO ──────────────────────────────
 *
 * The naive fix is `if (state === 'Stopped') skip`. That is a CONTROL THAT
 * CANNOT FAIL, and it is the single most-repeated defect in this repo. It would
 * mean a genuinely broken, should-be-running cluster reads as fine FOREVER, on a
 * P0 deploy path, in a sovereign boundary nobody watches closely — the exact
 * shape of `csa_loom_gates_that_cannot_fail`.
 *
 * INTENT IS NOT INFERABLE FROM STATE. "Stopped" and "deliberately stopped" are
 * different facts, and only one of them is a reason not to go red. So the
 * suppression keys to an EXPLICIT, CHECKED-IN DECLARATION and never to the
 * observed state alone. Observed state still decides WHAT to do; the declaration
 * decides only whether a stopped cluster is EXPECTED.
 *
 * ── WHY A CHECKED-IN FILE AND NOT A REPO VARIABLE ───────────────────────────
 *
 * A GitHub repository variable would have been fewer keystrokes. It is also
 * exactly the failure mode this repo already wrote a register to close.
 * scripts/ci/workflow-lane-states-allowlist.json says it in its own words, about
 * workflow disablement:
 *
 *   "Disabling happens in the GitHub UI: one click, no commit, no review, no
 *    record. This file IS the record."
 *
 * A repo variable that silences a P0 sovereign deploy lane has all the same
 * properties: invisible in a diff, unreviewable, untestable, and permanent by
 * default. This register is deliberately the same shape as that allowlist —
 * `owner`, a substantive `reason`, and an EXPIRING `reviewBy` — for the same
 * reasons, so the two read as one vocabulary rather than two mechanisms.
 *
 * ── THE TWO DIRECTIONS ARE NOT SYMMETRIC ────────────────────────────────────
 *
 * This is the same asymmetry #3980 established for the What-If lane, restated
 * for a register rather than a probe. SUPPRESSING is the dangerous direction, so
 * it requires POSITIVE evidence: a well-formed, owned, unexpired entry naming
 * this exact boundary. EVERY uncertain outcome — register missing, unparseable,
 * wrong shape, boundary absent, reason too thin, `reviewBy` malformed or in the
 * past — resolves to `declared: false`, which means the preflight behaves
 * EXACTLY as it does today and a stopped cluster still fails the lane.
 *
 * "I could not tell" must never become "it is paused, stand down."
 *
 * Every rejection carries a `reason` the caller PRINTS, because a declaration
 * that is silently ignored is worse than no declaration: the operator believes
 * the estate is declared paused and cannot see why the lane still went red
 * (deploy-integrity.md R7 — say what was actually established).
 *
 * ── `declaredOn` IS LOAD-BEARING, AND IT WAS DOCUMENTED NOWHERE (#4121) ─────
 *
 * A stood-down run SUCCEEDS having deployed nothing. Left alone, that would
 * flip `check-deploy-staleness` from `STALE … 17 consecutive FAILURE(s)` to
 * `ok` — a loud true red converted into a silent false green, which is the one
 * thing that file exists to prevent. `pickLastRealSuccess(rows, pausedSince)`
 * therefore DISCARDS successes dated at or after the declaration, and the date
 * it uses is this entry's `declaredOn`.
 *
 * So `declaredOn` is not metadata. It is the single field that decides whether
 * the drift monitor still works, and BOTH of these turn it off:
 *
 *   1. A FUTURE-DATED `declaredOn` (still earlier than `reviewBy`) makes the
 *      filter keep every run — including today's stood-down success — so
 *      driftDays goes to 0 and the check exits 0. This function now REFUSES a
 *      declaration dated later than the run reading it: a declaration cannot
 *      have been made in the future, and a date that cannot be true must not be
 *      allowed to disable a control.
 *
 *   2. RE-DATING ON RENEWAL does the same thing with no mistake at all. The
 *      expiry design says to re-date the declaration with a fresh read; moving
 *      `declaredOn` forward to today discards nothing and reports 0 days of
 *      drift over however long the lane has actually been dead. That is the
 *      instructions being followed, which is why it needs a field rather than a
 *      warning:
 *
 *        `declaredOn` is the date the pause BEGAN and is NEVER changed.
 *        Renewal extends `reviewBy` and records the fresh read in `renewedOn`.
 *
 *      `renewedOn` is optional, must be an ISO date, must not precede
 *      `declaredOn`, and must not be in the future. Nothing keys the staleness
 *      filter to it — that is the point: the field a renewal touches is
 *      deliberately not the field the filter reads.
 *
 * HONEST LIMIT: immutability of `declaredOn` across renewals is enforced by
 * this file's rules and by having somewhere else to write the renewal date. It
 * is NOT enforced against git history — a reviewer editing `declaredOn`
 * backwards or forwards within the allowed range still passes. The register is
 * a reviewed, checked-in file precisely so that edit is visible in a diff.
 */

/**
 * Where the register lives, relative to the repo root.
 *
 * Exported so the tests and the preflight cannot disagree about the path — a
 * register the code reads from one place and the suite asserts about in another
 * is a register that can rot untested.
 */
export const PAUSE_DECLARATION_PATH = 'scripts/ci/estate-pause-declaration.json';

/**
 * A `reason` shorter than this is not a reason.
 *
 * Same floor as the workflow-lane-states allowlist, on purpose. The point is not
 * the character count — it is that "paused" or "cost" cannot pass, so the entry
 * has to say what was stopped, what was measured, and what has to be true to
 * turn it back on.
 */
export const MIN_REASON_CHARS = 60;

/** An ISO calendar date and nothing else. Lexical comparison is only valid on this shape. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * PURE. Is `boundary` declared paused, as of `today`?
 *
 * @param {object} p
 * @param {unknown} p.register parsed estate-pause-declaration.json, or null when
 *   it is absent/unreadable/unparseable. Null is NOT an error here — the common
 *   case is that no estate is paused and the file does not exist.
 * @param {string|null|undefined} p.boundary CSA_LOOM_BOUNDARY, e.g. 'GCC-High'.
 * @param {string} p.today ISO 'YYYY-MM-DD'.
 * @returns {{declared: boolean, reason: string, entry: object|null}}
 */
export function classifyPauseDeclaration({ register, boundary, today }) {
  const no = (reason) => ({ declared: false, reason, entry: null });

  if (!boundary || typeof boundary !== 'string' || boundary.trim() === '') {
    // The CALLER did not say which estate it is asking about. Guessing would
    // make one boundary's declaration silence another's deploy.
    return no('no boundary was supplied, so no declaration can apply — the estate is treated as NOT declared paused');
  }
  if (!ISO_DATE.test(String(today ?? ''))) {
    // Without a trustworthy today, `reviewBy` cannot expire — and an expiry that
    // cannot fire is the "budget that cannot be exceeded" shape this repo has
    // already been bitten by. Refuse to suppress rather than suppress forever.
    return no(`today was not an ISO date ('${today}'), so a reviewBy expiry could not be evaluated — NOT suppressing`);
  }
  if (register === null || register === undefined) {
    return no(`no ${PAUSE_DECLARATION_PATH} was readable, so no estate is declared paused`);
  }
  if (typeof register !== 'object' || Array.isArray(register)) {
    return no(`${PAUSE_DECLARATION_PATH} is not a JSON object, so nothing was established — NOT suppressing`);
  }

  const paused = register.paused;
  if (!Array.isArray(paused)) {
    return no(`${PAUSE_DECLARATION_PATH} has no \`paused\` array, so nothing was established — NOT suppressing`);
  }

  const entry = paused.find((e) => e && typeof e === 'object' && e.boundary === boundary);
  if (!entry) {
    const named = paused.map((e) => e?.boundary ?? '<unnamed>').join(', ') || '<none>';
    return no(`'${boundary}' is not declared paused in ${PAUSE_DECLARATION_PATH} (it declares: ${named})`);
  }

  // ── An entry EXISTS. It still has to be a real one. ───────────────────────
  // These are the allowlist's rules, applied here. An entry that fails any of
  // them does not suppress, and says which rule it failed — a half-filled entry
  // must not be able to silence a sovereign deploy lane by accident.
  if (typeof entry.owner !== 'string' || entry.owner.trim() === '') {
    return no(`the '${boundary}' entry names no \`owner\`, so nobody owns the pause — NOT suppressing`);
  }
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
  if (reason.length < MIN_REASON_CHARS) {
    return no(
      `the '${boundary}' entry's \`reason\` is ${reason.length} characters (minimum ${MIN_REASON_CHARS}) — ` +
        'NOT suppressing. State what was stopped, what was measured, and what must be true to resume.',
    );
  }
  if (/\b(TODO|TBD|WIP)\b/i.test(reason)) {
    return no(`the '${boundary}' entry's \`reason\` is a placeholder (TODO/TBD/WIP) — NOT suppressing`);
  }
  // ── `declaredOn` (#4121) ──────────────────────────────────────────────────
  // The field check-deploy-staleness keys its stood-down filter to. Absent or
  // malformed, the filter silently does nothing and stood-down successes count
  // as deploys; future-dated, it keeps everything and reports zero drift. Both
  // resolve to NOT-suppressing, same asymmetry as every other rule here.
  if (!ISO_DATE.test(String(entry.declaredOn ?? ''))) {
    return no(
      `the '${boundary}' entry's \`declaredOn\` is not an ISO date ('${entry.declaredOn}') — NOT suppressing. ` +
        'It is the date check-deploy-staleness discards stood-down successes from; without it the drift ' +
        'monitor counts a run that deployed nothing as a deploy.',
    );
  }
  if (String(entry.declaredOn) > today) {
    return no(
      `the '${boundary}' entry's \`declaredOn\` is ${entry.declaredOn}, which is LATER than today (${today}) — ` +
        'NOT suppressing. A declaration cannot have been made in the future, and a future date makes the ' +
        'staleness filter keep every stood-down success, reporting 0 days of drift on a dead lane.',
    );
  }
  if (entry.renewedOn !== undefined && entry.renewedOn !== null) {
    // Optional, and deliberately NOT what the staleness filter reads: renewal
    // must have somewhere to record its fresh read that is not the field
    // holding the drift window open.
    if (!ISO_DATE.test(String(entry.renewedOn))) {
      return no(`the '${boundary}' entry's \`renewedOn\` is not an ISO date ('${entry.renewedOn}') — NOT suppressing`);
    }
    if (String(entry.renewedOn) < String(entry.declaredOn)) {
      return no(
        `the '${boundary}' entry was renewed on ${entry.renewedOn}, BEFORE it was declared on ${entry.declaredOn} ` +
          '— NOT suppressing. `declaredOn` is when the pause began and is never moved; a renewal that ' +
          'predates it means the two have been swapped.',
      );
    }
    if (String(entry.renewedOn) > today) {
      return no(`the '${boundary}' entry's \`renewedOn\` (${entry.renewedOn}) is in the future — NOT suppressing`);
    }
  }
  if (!ISO_DATE.test(String(entry.reviewBy ?? ''))) {
    return no(
      `the '${boundary}' entry's \`reviewBy\` is not an ISO date ('${entry.reviewBy}') — NOT suppressing. ` +
        'Without a parseable expiry the declaration would be permanent by default.',
    );
  }
  if (String(entry.reviewBy) <= String(entry.declaredOn)) {
    // Born expired. `reviewBy < today` below only catches this from the day
    // AFTER declaration; on the declaration day itself a reviewBy equal to
    // declaredOn would suppress for one run and then lapse, which is a
    // declaration nobody meant to make.
    return no(
      `the '${boundary}' entry's \`reviewBy\` (${entry.reviewBy}) is not after its \`declaredOn\` ` +
        `(${entry.declaredOn}) — NOT suppressing. A pause that expires on the day it starts is not a pause.`,
    );
  }
  if (String(entry.reviewBy) < today) {
    // EXPIRY IS THE TEETH. A pause declaration that never lapses is how a lane
    // stays dark for months while every dashboard reads green — the precise
    // failure deploy-integrity.md R3 is about. Past its date the estate reads as
    // NOT declared paused, the preflight resumes trying to start the cluster,
    // and the lane goes red until someone re-declares with a fresh read or
    // resumes the estate.
    return no(
      `the '${boundary}' pause declaration EXPIRED on ${entry.reviewBy} (today is ${today}) — NOT suppressing. ` +
        'Re-date it with a fresh read of the estate, or resume the estate.',
    );
  }

  return {
    declared: true,
    reason:
      `'${boundary}' is DECLARED paused in ${PAUSE_DECLARATION_PATH} by ${entry.owner}, declaredOn ` +
      `${entry.declaredOn}${entry.renewedOn ? ` (renewed ${entry.renewedOn})` : ''}, reviewBy ${entry.reviewBy}. ` +
      `Successful runs from ${entry.declaredOn} onward are stood-down runs and are NOT counted as deploys by ` +
      `check-deploy-staleness. Declared reason: ${reason}`,
    entry,
  };
}

/**
 * PURE. Reconcile what the OBSERVED cluster state asks for against what the
 * estate is DECLARED to be.
 *
 * Deliberately a SEPARATE function that post-processes `classifyClusterState`'s
 * verdict rather than a new branch inside it. Two reasons, both about keeping
 * the blast radius of this change small on a P0 path:
 *
 *   1. `classifyClusterState` stays a pure function of the STATE ALONE, so every
 *      test already pinning it keeps its meaning and a reader can still answer
 *      "what does Stopped mean?" without knowing about declarations.
 *   2. The declaration's influence is confined to ONE table, which is what makes
 *      both mutation directions cheap to prove.
 *
 * WHAT A DECLARATION DOES AND DOES NOT EXCUSE:
 *
 *   start  + declared -> `paused`. THE DELIBERATE CASE. Do not start the cluster
 *          (starting it would defeat the pause mandate and bill the operator
 *          from an unattended 10:00 UTC cron), and do not fail.
 *   none   + declared -> `none`, INCONSISTENCY noted. The estate is declared
 *          paused but this cluster is Running. That is a real finding worth
 *          surfacing — something resumed it, or the declaration is stale — but
 *          it is NOT a deploy blocker: a Running cluster is exactly what the
 *          apply needs. Warn, proceed.
 *   wait   + declared -> `wait`, INCONSISTENCY noted. Starting/Creating/Updating
 *          against a declared-paused estate means a control-plane operation is
 *          in flight that the declaration does not explain. Say so, then poll as
 *          normal.
 *   refuse + declared -> `refuse`, UNCHANGED. A declaration of pause says the
 *          engine is deliberately DOWN. It says nothing about a cluster in
 *          Unavailable, Deleting, Deleted, or an unrecognised state — those are
 *          real defects and must stay red. This is the same lesson as #3980's
 *          PAUSE_STATES allowlist: folding every non-Running state into "paused"
 *          converts a genuine defect into a silent skip.
 *
 * @param {object} p
 * @param {'none'|'start'|'wait'|'refuse'} p.action from classifyClusterState
 * @param {string|null} p.state the observed state, for the message
 * @param {boolean} p.declared from classifyPauseDeclaration
 * @returns {{action: 'none'|'start'|'wait'|'refuse'|'paused', note: string|null}}
 */
export function reconcileWithDeclaredPause({ action, state, declared }) {
  if (!declared) return { action, note: null };

  if (action === 'start') {
    return {
      action: 'paused',
      note:
        `the estate is DECLARED paused and this cluster is '${state}' — that is the expected state, not a defect. ` +
        'NOT starting it (a start would defeat the pause mandate and bill the operator from an unattended run), ' +
        'and NOT failing the lane.',
    };
  }
  if (action === 'none' || action === 'wait') {
    return {
      action,
      note:
        `INCONSISTENCY: the estate is DECLARED paused, but this cluster is '${state}'. The declaration says the ` +
        'engine should be down. Either something resumed the estate or the declaration is stale. This is reported, ' +
        'not failed — a live cluster is what the apply needs.',
    };
  }
  // `refuse` falls through unchanged, on purpose. See the table above.
  return { action, note: null };
}
