#!/usr/bin/env node
/**
 * resolve-program-budget-start-date.mjs — DISCOVER the start date the live
 * program budget already holds, and export it so the ARM apply names the value
 * the estate actually has instead of one computed at deploy time.
 *
 * ── THE DEFECT THIS REMOVES (#4253) ─────────────────────────────────────────
 *
 * `timePeriod.startDate` on `Microsoft.Consumption/budgets` is IMMUTABLE. ARM
 * refuses any PUT naming a start that differs from the one the budget was
 * created with, and because the budget is a leaf of the subscription-scope
 * deployment that refusal takes the WHOLE `az deployment sub create` with it:
 *
 *     400 on 'loom-program-budget' → "Start date of budgets cannot be updated.
 *     Please delete and create a new budget."
 *
 * program-budget.bicep defaulted the parameter to `utcNow('yyyy-MM-01')` — the
 * rotator shape (`csa_loom_bicep_newguid_is_a_rotator`, already documented on
 * cost-export.bicep:159). utcNow() re-evaluates on every deployment, so on the
 * 1st of each month the template began asking for a start the live budget could
 * never accept, and kept asking for the rest of that month and every month
 * after. A time bomb on a monthly fuse.
 *
 * MEASURED on deploy-fiab-commercial: the three scheduled runs immediately
 * before the break (2026-08-29/30/31) succeeded; every run from 09-01 onward
 * failed on this single leaf. The classifier called it `unknown` and failed
 * closed — correct under R7, but it named no cause, so a P0 deploy outage ran
 * for eight days with nothing in the run saying what broke.
 *
 * ── WHY NOT A CONSTANT ──────────────────────────────────────────────────────
 *
 * Pinning a literal was considered and rejected twice over:
 *
 *   1. Azure accepts only the first of the CURRENT month on a CREATE — Learn,
 *      BudgetProperties.timePeriod: "Past start date should be selected within
 *      the timegrain period." So a constant goes stale and breaks a genuinely
 *      fresh estate. cost-export.bicep:180 records the same trap for its own
 *      start window.
 *   2. Every boundary froze a DIFFERENT value, because each created its budget
 *      on its own date. No single literal is right for all of them, and pinning
 *      one per boundary in a .bicepparam only relocates the guess — precisely
 *      what #3754 established for the DNS resolver's immutable field.
 *
 * And bicep alone cannot tell a first create from a redeploy, so there is no
 * pure-template answer either. The value has to be READ.
 *
 * ── WHY `list` AND NOT `show` ───────────────────────────────────────────────
 *
 * `az consumption budget show` on a budget that does not exist FAILS, and the
 * error code it emits for that case is not established here — no such call has
 * been made against a live estate by this change. Guessing it wrong in the
 * absence direction refuses every greenfield deploy; guessing it wrong in the
 * other direction turns an RBAC denial into "greenfield" and creates a second
 * budget beside the customer's. `list` removes the question: on a subscription
 * that is readable it exits 0 and returns a well-formed array, and a budget
 * that is not in that array is DEFINITELY not there. Absence stops being an
 * error code to parse and becomes an observation.
 *
 * ── THE THREE OUTCOMES, AND WHY THE THIRD IS NOT THE SECOND ─────────────────
 *
 *   discovered  the budget exists → echo back the start it already holds, so
 *               the PUT proposes no change to the immutable field.
 *   greenfield  the read COMPLETED and the budget is not among the results →
 *               nothing is being converged on, so emit the first of the current
 *               month, the only start Azure accepts on a create.
 *   refuse      anything else — an RBAC denial, a throttle, a network failure,
 *               a non-JSON payload, or a budget whose entry carries no start.
 *               UNKNOWN IS NOT ABSENCE. Collapsing the two is the R7 defect
 *               ("I could not read it" rendered as "it does not exist"), and
 *               here it would propose a change to an immutable property on a
 *               guess — the exact failure being removed. Exits non-zero with
 *               the raw stderr attached.
 *
 * Usage:
 *   node scripts/ci/resolve-program-budget-start-date.mjs \
 *     --subscription <sub-id> [--budget-name loom-next-level-program]
 *
 * Tests: node --test scripts/ci/__tests__/program-budget-start-date.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { definiteAbsenceCode } from './_arm-absence.mjs';

/** The budget's resource name. Must equal the `budgetName` default in
 *  platform/fiab/bicep/modules/admin-plane/program-budget.bicep — reading a
 *  DIFFERENT name than the template deploys would report greenfield against a
 *  live budget and propose a start it cannot accept, silently reintroducing
 *  #4253. Asserted by scripts/ci/__tests__/program-budget-start-date.test.mjs. */
export const BUDGET_NAME = 'loom-next-level-program';

/** The env var the deploy lanes read and pass through to
 *  observabilityConfig.programBudgetStartDate. */
export const OUTPUT_VAR = 'LOOM_PROGRAM_BUDGET_START_DATE';

/**
 * PURE. The first of `date`'s month, UTC, as YYYY-MM-01.
 *
 * This is the ONLY place a start date is computed rather than read, and it is
 * reached only when the budget genuinely does not exist yet.
 *
 * @param {Date} date
 * @returns {string}
 */
export function firstOfMonthUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * PURE. Reduce whatever ARM reports for a start date to the YYYY-MM-01 form the
 * bicep parameter takes, or null when it is not a first-of-month date.
 *
 * ARM renders the field as a full timestamp (`2026-08-01T00:00:00+00:00`), and
 * the template wants the date alone. The day is VERIFIED rather than discarded:
 * the budgets API only ever stores a first-of-month start, so a value with any
 * other day means this is not the field we think it is, and truncating it would
 * quietly propose a change to an immutable property.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeStartDate(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(raw.trim());
  if (!m) return null;
  const [, year, month, day] = m;
  if (day !== '01') return null;
  if (Number(month) < 1 || Number(month) > 12) return null;
  return `${year}-${month}-01`;
}

/**
 * PURE. Decide what an `az consumption budget list` attempt established.
 *
 * @param {{ok: boolean, stdout: string, stderr: string}} attempt
 * @param {{budgetName: string, now: Date}} ctx
 * @returns {{decision: 'discovered'|'greenfield'|'refuse', value: string|null, reason: string}}
 */
export function classifyBudgetStartDateRead(attempt, ctx) {
  const budgetName = ctx?.budgetName ?? BUDGET_NAME;
  const now = ctx?.now ?? new Date();
  const stderr = String(attempt?.stderr ?? '');

  if (!attempt?.ok) {
    // A subscription that is not there at all is a definite absence — but it is
    // NOT a greenfield budget, it is a deploy pointed at nothing, and the apply
    // that follows would fail anyway. Reported as a refusal with the code named,
    // rather than silently becoming "create a budget".
    const hit = definiteAbsenceCode(stderr);
    return {
      decision: 'refuse',
      value: null,
      reason: hit
        ? `az failed with ${hit}. That is a definite absence of the SCOPE, not of the budget — there is ` +
          'no subscription here to hold one, so nothing can be established about the budget itself.'
        : 'the read did NOT complete, so whether a budget exists — and what start date it holds — is ' +
          'UNKNOWN, not absent. Refusing rather than proposing a change to an immutable property on a guess.',
    };
  }

  let payload;
  try {
    payload = JSON.parse(attempt.stdout);
  } catch {
    return {
      decision: 'refuse',
      value: null,
      reason: 'az exited 0 but its output was not JSON, so nothing about the live budget was established.',
    };
  }

  if (!Array.isArray(payload)) {
    return {
      decision: 'refuse',
      value: null,
      reason:
        'az exited 0 but did not return a LIST of budgets, so "the budget is not in the results" cannot be ' +
        'read as absence. The shape of the response is not what this resolver knows how to interpret.',
    };
  }

  const match = payload.find((b) => b?.name === budgetName);
  if (!match) {
    const value = firstOfMonthUtc(now);
    return {
      decision: 'greenfield',
      value,
      reason:
        `the read completed and listed ${payload.length} budget(s), none named '${budgetName}'. There is ` +
        `nothing to converge on, so this deploy CREATES the budget starting ${value} — the first of the ` +
        'current month, which is the only start Azure accepts on a create.',
    };
  }

  const raw = match?.timePeriod?.startDate;
  const normalized = normalizeStartDate(raw);
  if (!normalized) {
    return {
      decision: 'refuse',
      value: null,
      reason:
        `budget '${budgetName}' EXISTS but its timePeriod.startDate could not be read as a first-of-month ` +
        `date (got ${JSON.stringify(raw)}). Sending anything else would propose a change to an IMMUTABLE ` +
        'property on a resource whose current value was never established.',
    };
  }

  return {
    decision: 'discovered',
    value: normalized,
    reason:
      `budget '${budgetName}' already exists and started ${normalized}. Echoing that back unchanged is what ` +
      'makes the PUT propose no change to the immutable start date.',
  };
}

// ── I/O shell ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith('--')) out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

/**
 * List the subscription's budgets. `az` is invoked WITHOUT a shell and its
 * stderr is CAPTURED, never discarded — the classifier needs it to tell a
 * failed read from an empty one. Note `az consumption` prints a preview-feature
 * WARNING to stderr even on success; that is why the decision is keyed on the
 * exit status and the payload, never on stderr being non-empty.
 */
function listBudgets(subscription) {
  const args = ['consumption', 'budget', 'list', '-o', 'json'];
  if (subscription) args.push('--subscription', subscription);
  try {
    const stdout = execFileSync('az', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e?.stdout ?? ''),
      stderr: String(e?.stderr ?? e?.message ?? e),
    };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.subscription) {
    console.log(
      '::error::resolve-program-budget-start-date: missing required argument --subscription. Without it the ' +
        'budgets of the WRONG subscription could be read, and the start date is only meaningful against the ' +
        'subscription the deploy targets.',
    );
    process.exit(1);
  }
  const budgetName = args['budget-name'] || BUDGET_NAME;

  const attempt = listBudgets(args.subscription);
  const verdict = classifyBudgetStartDateRead(attempt, { budgetName, now: new Date() });

  if (verdict.decision === 'refuse') {
    console.log(
      `::error::Could not establish the program budget's start date — ${verdict.reason} ` +
        'timePeriod.startDate on Microsoft.Consumption/budgets is IMMUTABLE, so deploying on a guess fails ' +
        'the WHOLE subscription deployment on a single leaf (#4253). ' +
        `REMEDIATION: confirm the deploy service principal can read budgets on subscription ` +
        `${args.subscription} (Cost Management Reader or broader), then re-run. To override deliberately, ` +
        `set observabilityConfig.programBudgetStartDate to the value of ` +
        `\`az consumption budget show --budget-name ${budgetName} --query timePeriod.startDate -o tsv\`; ` +
        'to stop managing the budget entirely, set observabilityConfig.programBudgetEnabled=false.',
    );
    if (attempt.stderr) {
      console.log('--- raw az stderr (first 20 lines) ---');
      console.log(attempt.stderr.split('\n').slice(0, 20).join('\n'));
    }
    process.exit(1);
  }

  console.log(
    `[program-budget-start] ${verdict.decision}: ${verdict.reason} → ${OUTPUT_VAR}='${verdict.value}'`,
  );

  const envFile = process.env.GITHUB_ENV;
  if (envFile) appendFileSync(envFile, `${OUTPUT_VAR}=${verdict.value}\n`);
  else console.log(`${OUTPUT_VAR}=${verdict.value}`);
}

// Only run when executed directly, so the pure functions above can be imported
// by the unit tests without touching az.
if (process.argv[1] && process.argv[1].endsWith('resolve-program-budget-start-date.mjs')) main();
