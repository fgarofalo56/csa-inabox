export const meta = {
  name: 'loom-sprint',
  description: 'Agile sprint over the CSA Loom backlog: groom → plan → build (lane-isolated) → test → adversarial review → serial merge train → live receipts',
  whenToUse: 'The default way of working in this repo. Give it a goal or a list of issue numbers; it runs a full sprint and reports what is DEPLOYED vs merely merged.',
  phases: [
    { title: 'Groom', detail: 'BAs re-verify every premise, size it, assign an ownership lane' },
    { title: 'Plan', detail: 'architect sequences by lane + dependency; capacity is CI throughput, not agent count' },
    { title: 'Build', detail: 'one engineer per story, each in its OWN git worktree' },
    { title: 'Test', detail: 'testers verify independently — the author never grades their own work' },
    { title: 'Review', detail: 'adversarial reviewers try to REFUTE each story; majority kills it' },
    { title: 'Rework', detail: 'refused stories get the findings back and are RE-reviewed — one bounded cycle' },
    { title: 'Report', detail: 'ship list, merge order, and what still owes a live receipt' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SHAPE
//
// Measured on 2026-08-11, shipping five PRs solo in one session:
//
//   code generation        ~5 min/story
//   mutation-proof + guard ~10 min/story
//   CI per PR              ~12-15 min   (108 guardrail steps, vitest, next
//                                        build, python matrix, dbt)
//   merge                  SERIAL       (strict:true + 1 required review means
//                                        every merge is --admin, and --admin
//                                        makes MAIN's CI the gate)
//   live roll receipt      ~8 min
//
// So the throughput ceiling is NOT how many engineers write code at once. It is
// CI wall-clock and a merge train that cannot be parallelised. Fanning out 20
// implementers would produce 20 branches that queue behind the same train and
// collide on the same files.
//
// This workflow therefore parallelises GROOMING, BUILDING, TESTING and REVIEW —
// the parts that genuinely scale — and deliberately serialises the merge, which
// the orchestrator (me) drives afterwards. It optimises for stories that are
// CORRECT ON FIRST PASS, because a story that fails review costs a full CI cycle
// to redo.
//
// REPO-SPECIFIC RULES ENCODED BELOW (each learned the hard way):
//   * every agent gets its OWN worktree — parallel agents sharing a checkout
//     corrupt node_modules and `git stash` is REPO-GLOBAL across worktrees, so
//     one agent's stash silently steals another's work
//   * LANE partitioning — two stories touching the same file produce a merge
//     conflict the train cannot resolve unattended
//   * a guard must be MUTATION-PROVEN, and keyed to the MISMATCH rather than the
//     unsafe string (adopting a fix removes the token a naive rule matched, so
//     the rule goes quiet on exactly the files that were fixed)
//   * NOTHING is "done" on a merge — deploy-integrity R2. Merged-not-deployed is
//     reported in exactly those words
//   * Gov/GCC-High is verified ONLY through GitHub Actions, never local az
// ─────────────────────────────────────────────────────────────────────────────

const GOAL = typeof args === 'string' ? args : (args?.goal ?? args?.[0] ?? 'Drain the highest-value open issues.');
const ISSUES = Array.isArray(args?.issues) ? args.issues : (Array.isArray(args) ? args : []);
const CAPACITY = Number(args?.capacity ?? 6); // stories per sprint; sized to the merge train, not the agent pool

const RULES = `
REPO RULES — non-negotiable, they encode incidents this repo has already paid for:
* deploy-integrity R2: MERGED IS NOT DONE. Never report a merge as a fix. If it is
  not deployed and verified live, say "merged, not deployed" in exactly those words.
* deploy-integrity R1: a broken deploy path is P0 and preempts feature work.
* deploy-integrity R7: an error message must not assert a cause it did not
  establish. If the code does not know, the message says it does not know.
* cloud-parity: a capability that works in Commercial and not in Gov is INCOMPLETE.
  Gov is verified ONLY via a GitHub Actions run — never local az.
* no-vaporware: no mock arrays, no return [] placeholders, real backend calls.
* Every guard/check you add must FAIL when mutated. Prove it: show the baseline
  passing, then a mutation failing. A guard that cannot fail is not a guard.
* Key a guard to the MISMATCH, never to the unsafe string alone — adopting the
  safe fix removes that token, so the rule would go quiet on the fixed files.
* A guard must refuse to pass on an EMPTY population (zero files scanned, zero
  references found) — that means the matcher drifted, not that the repo is clean.
* NEVER git stash: the stash is repo-global across worktrees and parallel agents
  will steal each other's work. Make a WIP commit instead.
* Windows host, Git Bash: POSIX syntax, python not python3, temp files in ./temp/.
* Never read or echo secrets. Never touch security software.
`;

const GROOM_SCHEMA = {
  type: 'object',
  required: ['stories'],
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'title', 'premiseStillTrue', 'evidence', 'points', 'lane', 'recommendation'],
        properties: {
          ref: { type: 'string', description: 'issue number or a short slug' },
          title: { type: 'string' },
          premiseStillTrue: { type: 'boolean', description: 'Did you VERIFY the claim still holds against the current tree/runs?' },
          evidence: { type: 'string', description: 'the command you ran and what it returned — not a summary' },
          points: { type: 'number', enum: [1, 3, 5, 8, 13] },
          lane: { type: 'string', enum: ['ci', 'bicep', 'console', 'dataplane', 'docs'] },
          filesLikely: { type: 'array', items: { type: 'string' } },
          needsLiveReceipt: { type: 'boolean' },
          boundaries: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string', enum: ['do-now', 'defer', 'close-stale', 'split'] },
          why: { type: 'string' },
        },
      },
    },
  },
};

const BUILD_SCHEMA = {
  type: 'object',
  required: ['ref', 'status', 'summary', 'filesChanged', 'proof'],
  properties: {
    ref: { type: 'string' },
    status: { type: 'string', enum: ['implemented', 'blocked', 'not-needed'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    proof: { type: 'string', description: 'commands run and their ACTUAL output — baseline pass AND mutation fail where a guard was added' },
    mutationProven: { type: 'boolean' },
    branch: { type: 'string' },
    blockedBy: { type: 'string' },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['ref', 'verdict', 'reasoning'],
  properties: {
    ref: { type: 'string' },
    verdict: { type: 'string', enum: ['SHIP', 'REWORK', 'REJECT'] },
    reasoning: { type: 'string' },
    defectsFound: { type: 'array', items: { type: 'string' } },
    checkedIndependently: { type: 'boolean', description: 'Did you RUN the code, or only read it?' },
  },
};

log(`Sprint goal: ${GOAL}`);
log(`Capacity ${CAPACITY} stories — sized to the MERGE TRAIN (serial, --admin, ~12-15 min CI each), not to the agent pool.`);

// ── PHASE 1: GROOM ───────────────────────────────────────────────────────────
// Business analysts, in parallel, each on a slice of the backlog. Their ONE job
// is to re-verify the premise. This repo has repeatedly found that audit items
// go stale: the issue describes a defect that a later merge already fixed, and
// acting on it wastes a whole story. Grooming is cheap; a wasted merge cycle is
// not.
phase('Groom');
const SLICES = ISSUES.length
  ? chunk(ISSUES, Math.max(1, Math.ceil(ISSUES.length / 4)))
  : [['triage-1'], ['triage-2'], ['triage-3'], ['triage-4']];

const groomed = (await parallel(SLICES.map((slice, i) => () =>
  agent(
    `You are a senior business analyst on the CSA Loom team. Sprint goal: ${GOAL}

${ISSUES.length
  ? `Groom EXACTLY these GitHub issues: ${slice.join(', ')}. Use \`gh issue view <n>\`.`
  : `Find candidate work yourself with \`gh issue list --state open\`. You are analyst ${i + 1} of 4 — take the slice of issues where (number %% 4) == ${i} so the four of you do not overlap.`}

YOUR ONE JOB IS TO VERIFY THE PREMISE STILL HOLDS. Do not trust the issue text.
This repo has been burned repeatedly by stale audit items: the issue describes a
defect a later merge already fixed, and acting on it burns a full merge cycle.

For each issue:
  1. Read it.
  2. Re-derive its central claim against the CURRENT tree and CURRENT run history
     — grep the code, run the guard, check \`gh run list\` for the named workflow.
     Record the exact command and its ACTUAL output as evidence.
  3. If the premise is already false, recommend close-stale and say what the
     evidence was.
  4. Size it: 1 trivial / 3 one-file+guard / 5 multi-file+live receipt /
     8 deploy-path or cross-boundary / 13 = TOO BIG, recommend split.
  5. Assign an ownership LANE from the files it will touch — ci, bicep, console,
     dataplane, docs. Two stories in the same lane touching the same file will
     collide in the merge train, so be precise about filesLikely.
  6. Say whether it needs a LIVE receipt (a deploy/roll), and which boundaries.

${RULES}

Return the structured object. Evidence must be real command output, never a
paraphrase — an unverified premise is the single most expensive thing you can
hand downstream.`,
    { label: `groom:${i + 1}`, phase: 'Groom', schema: GROOM_SCHEMA, isolation: 'worktree' },
  )))).filter(Boolean).flatMap((r) => r.stories || []);

log(`Groomed ${groomed.length} candidate stories.`);

const stale = groomed.filter((s) => s.recommendation === 'close-stale');
const splits = groomed.filter((s) => s.recommendation === 'split' || s.points >= 13);
const ready = groomed
  .filter((s) => s.recommendation === 'do-now' && s.premiseStillTrue && s.points < 13)
  .sort((a, b) => a.points - b.points);

log(`${ready.length} ready, ${stale.length} already-fixed (close on evidence), ${splits.length} too big to start.`);

// ── PHASE 2: PLAN ────────────────────────────────────────────────────────────
// One story per LANE-FILE set. Two stories that touch the same file cannot both
// be built in parallel — the second one's merge conflicts and the train stalls.
phase('Plan');
const claimed = new Set();
const sprint = [];
for (const s of ready) {
  const files = (s.filesLikely || []).map((f) => f.toLowerCase());
  if (files.some((f) => claimed.has(f))) {
    log(`  deferred (file collision): ${s.ref} — ${s.title}`);
    continue;
  }
  files.forEach((f) => claimed.add(f));
  sprint.push(s);
  if (sprint.length >= CAPACITY) break;
}
log(`Sprint committed: ${sprint.length} stories, ${sprint.reduce((a, s) => a + s.points, 0)} points.`);
sprint.forEach((s) => log(`  [${s.points}sp ${s.lane}] ${s.ref} — ${s.title}`));

if (sprint.length === 0) {
  return { goal: GOAL, sprint: [], stale, splits, note: 'Nothing passed grooming — every candidate was stale, too big, or collided.' };
}

// ── PHASES 3-5: BUILD → TEST → REVIEW, as a PIPELINE ─────────────────────────
// Deliberately NOT a barrier. A 1-point story should reach review while an
// 8-pointer is still building; making the fast ones wait for the slow one wastes
// the only resource that matters here.
const results = await pipeline(
  sprint,

  // BUILD — one engineer per story, each in its own worktree.
  (story) => agent(
    `You are a staff engineer (20 years, Azure + TypeScript + CI) on CSA Loom.

STORY ${story.ref}: ${story.title}
Lane: ${story.lane} | ${story.points} points | files likely: ${(story.filesLikely || []).join(', ') || 'discover them'}
Why: ${story.why || ''}
Grooming evidence: ${story.evidence}

Implement it COMPLETELY on a new branch \`sprint/${String(story.ref).replace(/[^a-zA-Z0-9-]/g, '-')}\`.
Commit your work (never stash — the stash is repo-global and will steal a
sibling agent's work). Do NOT push and do NOT open a PR; the orchestrator drives
the merge train.

STAY IN YOUR LANE. Touch only files in the ${story.lane} lane and only those this
story needs. Another engineer is working in parallel; a stray edit outside your
lane becomes a merge conflict that stalls the train.

THE REVIEWERS' CHECKLIST, HANDED TO YOU UP FRONT (sprint 1 calibration).
Sprint 1 approved ZERO of 16 points — not because the work was lazy, but because
these were discovered at review, which is the expensive place to find them. Every
one is a real defect the reviewers found:

  * R7 — DOES YOUR MESSAGE ASSERT WHAT THE CODE ESTABLISHED? A guard failed on
    \`AZURE_LOCATION: "\${{ inputs.region }}"\` — a YAML no-op quoting of the SAFE
    value — reporting 'seeds the deploy region with the bare text """"'. It had
    stripped the expression and was looking at the quote characters. It would
    have blocked every PR in the repo while stating a cause that did not exist.
    Unwrap quoting before you judge a scalar. Never print a regex source as prose.
  * MUTATE ADDITIVELY, NOT ONLY BY REPLACEMENT. Every blind spot found in sprint 1
    came from ADDING a bad entry ALONGSIDE the good one. Replacing the only entry
    trips your floor and reads as proven. A job-level \`env: { X: bad }\` flow
    mapping overrode the workflow-level seed at runtime and still gave
    found=1 / violations=0 / exit 0 / 60 tests green.
  * A DISCOVERY FLOOR IS NOT A COMPLETENESS CHECK. \`found >= 1\` is satisfied by
    the good entry while the bad one stays invisible. If you cannot parse a shape
    (flow mappings, folded >-, literal |, next-line scalars, quoted keys), FAIL on
    encountering it rather than skipping it.
  * EMPTY VALUE IS UNKNOWN, NOT SAFE. \`X:\` with the value on the next line
    parsed as '' and was skipped as harmless — while being the line carrying the
    defect.
  * CLOUD PARITY. If your check reads deploy-fiab-commercial.yml, say what
    happens for gcch / il5 / gcc. Commercial-only is declared, never implied.

DEFINITION OF DONE:
  * the change is complete and real — no placeholder, no TODO, no mock
  * if you added or changed a guard/check, MUTATION-PROVE it: run it clean
    (must pass), then break the thing it watches (must fail, and must name the
    file), then restore. Paste both outputs into \`proof\`.
  * run the relevant existing tests and paste the ACTUAL output
  * if it cannot be done, say so with status=blocked and name the blocker
    precisely — a blocked story reported honestly is worth more than a
    plausible-looking one that fails review

${RULES}

Report what you ACTUALLY ran and what it ACTUALLY returned. Do not describe
intended behaviour as if it were observed.`,
    { label: `build:${story.ref}`, phase: 'Build', schema: BUILD_SCHEMA, isolation: 'worktree' },
  ),

  // TEST — an independent tester. The author never grades their own work.
  (built, story) => {
    if (!built || built.status !== 'implemented') return { story, built, tests: null };
    return agent(
      `You are a senior QA engineer on CSA Loom. An engineer says they finished this story. Verify it INDEPENDENTLY.

STORY ${story.ref}: ${story.title}
They claim: ${built.summary}
Files: ${(built.filesChanged || []).join(', ')}
Their branch: ${built.branch || `sprint/${story.ref}`}
Their proof: ${built.proof}

Check out their branch and RUN things. Reading the diff is not testing.
  1. Do their claimed commands actually produce the output they pasted? Re-run them.
  2. If they added a guard, mutate the code yourself in a DIFFERENT way than they
     did and confirm it still fires. A guard proven by exactly one mutation is
     often keyed to that mutation.
  3. Does the guard refuse to pass on an EMPTY population?
  4. Run the repo's own checks over the changed area (node --test on the relevant
     __tests__ file, the guard scripts under scripts/ci, tsc if console code).
  5. Look for the failure modes this repo keeps hitting: a result discarded with
     \`|| true\` / \`2>/dev/null\` / continue-on-error; an UNKNOWN rendered as a
     negative; a check that measures nothing; CRLF on a .sh file.

${RULES}

verdict SHIP only if you RAN it and it held. checkedIndependently must be true
only if you actually executed things.`,
      { label: `test:${story.ref}`, phase: 'Test', schema: VERDICT_SCHEMA, isolation: 'worktree' },
    ).then((tests) => ({ story, built, tests }));
  },

  // REVIEW — adversarial, three lenses, majority rules.
  async (bundle) => {
    if (!bundle?.built || bundle.built.status !== 'implemented') return bundle;
    const LENSES = [
      ['correctness', 'Try to REFUTE that this works. Find the input, state, or ordering where it breaks. Default to REWORK if you are unsure.'],
      ['blast-radius', 'This repo runs live estates in Commercial AND GCC-High. Could this break a deploy path, a roll, or a sovereign boundary? Does it hold on both clouds, or is it silently Commercial-only?'],
      ['honesty', 'Does anything here CLAIM more than it established? An error string asserting an unverified cause, a gate that cannot fail, a check that passes on an empty population, a "fixed" that is only "merged".'],
    ];
    const votes = (await parallel(LENSES.map(([lens, brief]) => () =>
      agent(
        `You are a principal engineer reviewing a CSA Loom story through the ${lens} lens.

${brief}

STORY ${bundle.story.ref}: ${bundle.story.title}
Change: ${bundle.built.summary}
Files: ${(bundle.built.filesChanged || []).join(', ')}
Branch: ${bundle.built.branch || `sprint/${bundle.story.ref}`}
Engineer's proof: ${bundle.built.proof}
QA verdict: ${bundle.tests?.verdict ?? 'not tested'} — ${bundle.tests?.reasoning ?? ''}

Read the actual diff (\`git diff main...<branch>\`) and run whatever you need.

${RULES}

Be adversarial. A plausible-looking change that ships broken costs far more than
one more review round.`,
        { label: `review:${lens}:${bundle.story.ref}`, phase: 'Review', schema: VERDICT_SCHEMA, isolation: 'worktree' },
      )))).filter(Boolean);

    const ship = votes.filter((v) => v.verdict === 'SHIP').length;
    return { ...bundle, votes, shipVotes: ship, approved: ship >= 2 && bundle.tests?.verdict === 'SHIP' };
  },
);

// ── PHASE 5b: REWORK ─────────────────────────────────────────────────────────
//
// WHY THIS EXISTS. Sprint 1 approved 0 of 16 points; Sprint 3 approved 0 of 16
// again — after the Sprint-1 calibration (smaller stories, reviewer checklist
// handed over up front) had already been applied. The reviews were not wrong
// either time: they found real, SPECIFIC, and mostly SMALL defects — an R7 false
// assertion on one code path, a test whose NAME claimed coverage it did not have,
// an UNKNOWN rendered as a negative.
//
// The defect was in the PIPELINE, not the engineers. A story that earned REWORK
// died there, because Review handed straight to Report. No real team works that
// way: the reviewer's defects go back to the author, get fixed, and get
// re-reviewed inside the same sprint. Two sprints produced 32 points of work and
// shipped none of it, while the fixes were often a handful of lines.
//
// Bounded to ONE cycle on purpose. If a second adversarial pass still refuses it,
// the story is genuinely not ready and belongs in the next sprint with what was
// learned — an unbounded loop would just relitigate a real rejection.
let results2 = results;
const firstPassRework = results.filter(
  (r) => r?.built?.status === 'implemented' && !r.approved,
);

if (firstPassRework.length > 0) {
  phase('Rework');
  log(`${firstPassRework.length} story(ies) earned REWORK on the first pass — feeding the defects back rather than dropping them.`);

  const reworked = await parallel(firstPassRework.map((bundle) => async () => {
    const defects = [
      bundle.tests?.verdict === 'SHIP' ? null : `QA: ${bundle.tests?.reasoning ?? 'no QA reasoning recorded'}`,
      ...(bundle.votes || [])
        .filter((v) => v.verdict !== 'SHIP')
        .map((v) => `${v.verdict}: ${v.reasoning}`),
    ].filter(Boolean).join('\n\n');

    const fixed = await agent(
      `You are the engineer who wrote CSA Loom story ${bundle.story.ref}, addressing review.

STORY: ${bundle.story.title}
BRANCH: ${bundle.built.branch || `sprint/${bundle.story.ref}`}
Your change: ${bundle.built.summary}

The QA pass and the adversarial reviewers REFUSED it. Their findings, verbatim:

${defects}

These are not opinions to argue with — they were measured. Fix every one on the
SAME branch. Most are small; the review is specific about what and where.

Rules that apply to the fix as much as the original:
 - Fix the CAUSE, not the symptom. If a message asserted something the code never
   established, make the message true — do not delete the check.
 - If a test's NAME claimed coverage it did not have, make the test cover it.
   Renaming it to match the gap is not a fix.
 - UNKNOWN is never reported as NEGATIVE. If the code could not determine
   something, it must say it could not determine it.
 - Re-run the proof after fixing, and MUTATION-PROVE anything guard-shaped:
   break the fix, confirm by \`git diff\` that the mutation actually applied,
   watch the guard fail, restore, watch it pass.

${RULES}

Report what you changed and the evidence it now holds. If a finding is genuinely
WRONG, say so and show the measurement that refutes it — do not silently ignore it.`,
      { label: `rework:${bundle.story.ref}`, phase: 'Rework', schema: BUILD_SCHEMA, isolation: 'worktree' },
    );

    if (!fixed || fixed.status !== 'implemented') return { ...bundle, reworkFailed: true };

    // RE-REVIEW. The same adversarial bar — a rework pass that graded itself
    // would be exactly the "author grades their own work" failure this pipeline
    // exists to prevent.
    const reVotes = (await parallel([
      ['correctness', 'The previous round was REFUSED. Verify EVERY original finding is genuinely fixed — not renamed, not deleted, not argued away. Then try to refute the fix itself.'],
      ['honesty', 'Does the fix CLAIM more than it established? Re-check the exact findings that were raised: false assertions, tests whose names overstate coverage, UNKNOWN rendered as negative, guards that cannot fail.'],
    ].map(([lens, brief]) => () =>
      agent(
        `You are a principal engineer RE-REVIEWING CSA Loom story ${bundle.story.ref} after rework, through the ${lens} lens.

${brief}

ORIGINAL FINDINGS THAT MUST NOW BE FIXED:
${defects}

The engineer says: ${fixed.summary}
Proof offered: ${fixed.proof}
Branch: ${fixed.branch || bundle.built.branch}

Read the diff and RUN things. ${RULES}

SHIP only if every original finding is actually resolved and you verified it
yourself. If any remains, REWORK and say which.`,
        { label: `re-review:${lens}:${bundle.story.ref}`, phase: 'Rework', schema: VERDICT_SCHEMA, isolation: 'worktree' },
      )))).filter(Boolean);

    const reShip = reVotes.filter((v) => v.verdict === 'SHIP').length;
    return {
      ...bundle,
      built: fixed,
      votes: reVotes,
      shipVotes: reShip,
      reworked: true,
      approved: reShip >= 2,
    };
  }));

  const byRef = new Map(reworked.filter(Boolean).map((r) => [r.story.ref, r]));
  results2 = results.map((r) => (r && byRef.has(r.story?.ref) ? byRef.get(r.story.ref) : r));
  const rescued = reworked.filter((r) => r?.approved).length;
  log(`Rework cycle: ${rescued}/${firstPassRework.length} rescued to SHIP.`);
}

// ── PHASE 6: REPORT ──────────────────────────────────────────────────────────
phase('Report');
const done = results2.filter(Boolean);
const approved = done.filter((r) => r.approved);
const rework = done.filter((r) => r?.built?.status === 'implemented' && !r.approved);
const blocked = done.filter((r) => r?.built && r.built.status !== 'implemented');

log(`APPROVED ${approved.length} | REWORK ${rework.length} | BLOCKED ${blocked.length}`);

return {
  goal: GOAL,
  committedPoints: sprint.reduce((a, s) => a + s.points, 0),
  approved: approved.map((r) => ({
    ref: r.story.ref, title: r.story.title, lane: r.story.lane, points: r.story.points,
    branch: r.built.branch, summary: r.built.summary, files: r.built.filesChanged,
    needsLiveReceipt: r.story.needsLiveReceipt, boundaries: r.story.boundaries,
    shipVotes: r.shipVotes, proof: r.built.proof,
  })),
  rework: rework.map((r) => ({
    ref: r.story.ref, title: r.story.title, branch: r.built?.branch,
    qa: r.tests?.verdict, defects: [
      ...(r.tests?.defectsFound || []),
      ...(r.votes || []).flatMap((v) => v.defectsFound || []),
    ],
  })),
  blocked: blocked.map((r) => ({ ref: r.story.ref, title: r.story.title, blockedBy: r.built?.blockedBy })),
  closeAsStale: stale.map((s) => ({ ref: s.ref, title: s.title, evidence: s.evidence })),
  needsSplitting: splits.map((s) => ({ ref: s.ref, title: s.title, points: s.points })),
  mergeTrainNote:
    'Branches are committed locally in each agent worktree and NOT pushed. The orchestrator ' +
    'pushes, opens PRs and merges SERIALLY — strict:true + a required review make every merge ' +
    '--admin, which makes MAIN\'s CI the gate, so the train must be watched rather than fired. ' +
    'Nothing here is "done": every item is merged-not-deployed until its live receipt exists.',
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
