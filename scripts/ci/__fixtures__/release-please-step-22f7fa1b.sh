set -euo pipefail
REPO="${GITHUB_REPOSITORY}"
RUN_URL="${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}"

# Hand-maintained mirror of branch protection's required contexts,
# each paired with the workflow FILE whose job publishes it.
# See the header for WHY this cannot be derived with GITHUB_TOKEN.
# It has drifted twice; the post-verify at the end of the loop is the
# control that makes a third drift fail loudly instead of silently.
# Last reconciled against protection: 2026-08-13 (14 contexts).
#
# The producer was established by READING each workflow's job `name:`
# (a matrix job's check-run name is `<name> (<matrix values>)`; a job
# with no `name:` reports under its job id — that is why `guardrails`
# is spelled lowercase).
#
# An EMPTY producer means "no workflow in this repo publishes this
# context". Those — and ONLY those — still get a synthetic status, and
# each one is named in a ::warning:: so the residue cannot go quiet.
REQUIRED_CHECKS=(
  "PowerShell Lint|validate.yml"
  "Python Lint|validate.yml"
  "Python Tests (3.10)|test.yml"
  "Python Tests (3.11)|test.yml"
  "Python Tests (3.12)|test.yml"
  "Repo Hygiene|validate.yml"
  "Secret Scan|validate.yml"
  "dbt Compile (finance)|test.yml"
  "dbt Compile (inventory)|test.yml"
  "dbt Compile (sales)|test.yml"
  "dbt Compile (shared)|test.yml"
  "guardrails|loom-guardrails.yml"
  "next build (node 20)|fiab-console-ci.yml"
  "vitest (node 20)|fiab-console-ci.yml"
)

# Derive the unique producer set from the table above — one source of
# truth, so adding a context can never forget to dispatch its workflow.
# NOTE ON `set -e` IN THIS STEP: every early-exit below is written as an
# explicit `if`, never `[ … ] && break`. A failing `[ … ]` at the head
# of an && list is exempt from errexit, but that exemption is subtle
# enough that this repo has been bitten by the neighbouring case
# (a failure skipping later guards, which then read as passes).
PRODUCERS=()
for entry in "${REQUIRED_CHECKS[@]}"; do
  wf="${entry#*|}"
  if [ -z "$wf" ]; then continue; fi
  already=0
  for seen in ${PRODUCERS[@]+"${PRODUCERS[@]}"}; do
    if [ "$seen" = "$wf" ]; then already=1; break; fi
  done
  if [ "$already" -eq 0 ]; then PRODUCERS+=("$wf"); fi
done
echo "Producing workflows: ${PRODUCERS[*]}"

# Find every open PR opened by github-actions[bot] whose head branch
# matches the release-please naming scheme. Resolve each to its
# *current* head SHA at runtime — never a cached value.
mapfile -t RELEASE_PRS < <(
  gh pr list --repo "${REPO}" --state open --author 'app/github-actions' --json number,headRefName \
    | jq -r '.[] | select(.headRefName | startswith("release-please--")) | .number'
)

if [ "${#RELEASE_PRS[@]}" -eq 0 ]; then
  echo "No open release-please PRs found — nothing to do."
  exit 0
fi

# Paths of every workflow run already recorded against a SHA.
runs_for_sha() {
  gh api --paginate "repos/${REPO}/actions/runs?head_sha=$1&per_page=100" \
    --jq '.workflow_runs[].path'
}
# path <TAB> status <TAB> conclusion <TAB> url for every run on a SHA.
runs_tsv() {
  gh api --paginate "repos/${REPO}/actions/runs?head_sha=$1&per_page=100" \
    --jq '.workflow_runs[] | [.path, .status, (.conclusion // ""), .html_url] | @tsv'
}

# UNVERIFIED counts release PRs this run failed to render a full verdict
# for. It is checked AFTER the loop and turns the job red. On 2026-08-14
# run 31786503229 hit exactly this case and concluded `success` — a run
# that verified nothing, showing green in `gh run list`, which is the
# signal the operator actually reads.
UNVERIFIED=0

for num in "${RELEASE_PRS[@]}"; do
  sha=$(gh api "repos/${REPO}/pulls/${num}" --jq '.head.sha')
  branch=$(gh api "repos/${REPO}/pulls/${num}" --jq '.head.ref')
  echo ""
  echo "=== Release PR #${num} (${branch}) head SHA ${sha} ==="

  # Sanity-check: release PRs must only touch version-metadata files.
  # If they touch anything else, abort — we don't want to drive this
  # release path for a PR that actually changes code. The allowlist is
  # UNCHANGED and deliberately NOT widened (#3393 requirement).
  #
  # Written as an explicit loop rather than `grep -Ev … || true`: the
  # `|| true` was there only because `grep -v` exits 1 when it filters
  # everything out (the GOOD case), but a `|| true` in a gate is the
  # shape this repo has been burned by, so it is gone.
  files="$(gh api "repos/${REPO}/pulls/${num}/files" --jq '.[].filename' | sort -u)"
  if [ -z "$files" ]; then
    echo "::error::Release PR #${num} reported ZERO changed files. That is an"
    echo "::error::UNREADABLE signal, not a green one — refusing to proceed rather"
    echo "::error::than treating 'I could not see any' as 'there are none'."
    exit 1
  fi
  mapfile -t file_list <<< "$files"
  echo "Files changed:"
  printf '  %s\n' "${file_list[@]}"
  allowed_re='^(CHANGELOG\.md|pyproject\.toml|\.release-please-manifest\.json|apps/fiab-console/package\.json)$'
  unexpected=""
  for f in "${file_list[@]}"; do
    if ! printf '%s' "$f" | grep -Eq "$allowed_re"; then
      unexpected="${unexpected}${f} "
    fi
  done
  if [ -n "$unexpected" ]; then
    echo "::error::Release PR #${num} touches non-metadata files; refusing to auto-pass required checks:"
    echo "  ${unexpected}"
    exit 1
  fi

  # ---------------------------------------------------------------
  # 1. DISPATCH the producing workflows against the release branch.
  #    Idempotent: skip any workflow that already has a run on this SHA.
  # ---------------------------------------------------------------
  existing_paths="$(runs_for_sha "${sha}")"
  dispatched=()
  for wf in "${PRODUCERS[@]}"; do
    if printf '%s\n' "${existing_paths}" | grep -qxF ".github/workflows/${wf}"; then
      echo "  = ${wf}: a run already exists on ${sha} — not re-dispatching."
      continue
    fi
    echo "  > dispatching ${wf} against ${branch}"
    # stderr is CAPTURED, never discarded: a dispatch that fails must
    # say why (deploy-integrity R7), and must stop the job.
    if ! dispatch_err="$(gh workflow run "${wf}" --repo "${REPO}" --ref "${branch}" 2>&1)"; then
      echo "::error::Dispatching ${wf} against ${branch} FAILED: ${dispatch_err}"
      echo "::error::This is fatal — without it the required contexts that ${wf}"
      echo "::error::publishes would have no real result, and posting a synthetic one"
      echo "::error::in their place is the exact defect #3393 records."
      echo "::error::If the message mentions a missing workflow_dispatch trigger, the"
      echo "::error::release branch was cut from a main commit that predates the"
      echo "::error::trigger being added: close PR #${num} and let release-please"
      echo "::error::recreate it from current main."
      exit 1
    fi
    dispatched+=("${wf}")
  done

  # ---------------------------------------------------------------
  # 2. CONFIRM each dispatch actually produced a run on this SHA.
  #    A dispatch that creates nothing is a FAILURE, not a pass.
  # ---------------------------------------------------------------
  if [ "${#dispatched[@]}" -gt 0 ]; then
    missing=("${dispatched[@]}")
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      sleep 15
      existing_paths="$(runs_for_sha "${sha}")"
      still=()
      for wf in "${missing[@]}"; do
        if ! printf '%s\n' "${existing_paths}" | grep -qxF ".github/workflows/${wf}"; then
          still+=("${wf}")
        fi
      done
      missing=(${still[@]+"${still[@]}"})
      if [ "${#missing[@]}" -eq 0 ]; then break; fi
    done
    if [ "${#missing[@]}" -gt 0 ]; then
      echo "::error::Dispatched ${missing[*]} against ${branch}, but NO workflow run"
      echo "::error::appeared on ${sha} within 3 minutes. An absent result is NOT a"
      echo "::error::green one, so this run fails rather than falling back to a"
      echo "::error::synthetic status (#3393)."
      exit 1
    fi
    echo "  all ${#dispatched[@]} dispatched workflow(s) produced a run on ${sha}."
  fi

  # ---------------------------------------------------------------
  # 3. WAIT for every producing run on this SHA to CONCLUDE.
  #    Nothing is posted until there is a real result to post.
  # ---------------------------------------------------------------
  unfinished="pending"
  for _ in $(seq 1 180); do
    runs="$(runs_tsv "${sha}")"
    unfinished=""
    for wf in "${PRODUCERS[@]}"; do
      # A workflow counts as finished only when EVERY run of it on this
      # SHA is `completed`. Picking "the latest run" would need an
      # ordering assumption about the API's response, and a re-dispatch
      # or a re-run leaves more than one — so this waits for all of
      # them instead, which cannot mistake an in-flight run for a done
      # one.
      counts="$(printf '%s\n' "${runs}" | awk -F'\t' -v p=".github/workflows/${wf}" \
        '$1==p {t++; if ($2!="completed") n++} END {printf "%d %d", t+0, n+0}')"
      tot="${counts% *}"; nf="${counts#* }"
      if [ "${tot}" -eq 0 ]; then
        unfinished="${unfinished}${wf}(no-run) "
      elif [ "${nf}" -gt 0 ]; then
        unfinished="${unfinished}${wf}(${nf}/${tot}-unfinished) "
      fi
    done
    if [ -z "${unfinished}" ]; then break; fi
    sleep 15
  done

  if [ -n "${unfinished}" ]; then
    # The runs are real and still going, so nothing is posted: an
    # unfinished run is not a green one and the PR stays blocked, which
    # is correct. What is NOT correct is this job then reporting
    # success, which is what it did on run 31786503229 — it gave up 78
    # seconds before fiab-console-ci.yml concluded, bridged nothing, and
    # went green. So this counts as UNVERIFIED and the job fails below.
    #
    # Distinguish the two causes rather than blaming the slower one
    # (R7). `strict: true` means release-please rewrites the PR — and
    # its head SHA — on every push to main, which throws away every run
    # this step was waiting on. That is a different problem from CI
    # being slow, and it has a different answer.
    now_sha=$(gh api "repos/${REPO}/pulls/${num}" --jq '.head.sha')
    if [ "${now_sha}" != "${sha}" ]; then
      echo "::error::PR #${num}: head SHA moved from ${sha} to ${now_sha} WHILE this"
      echo "::error::step was waiting. Every run it was waiting on belongs to a commit"
      echo "::error::that is no longer the PR head, so none of them can be bridged."
      echo "::error::Cause is SHA churn, not slow CI: branch protection has strict=true,"
      echo "::error::so release-please rebuilds this PR on every push to main. A release"
      echo "::error::needs a quiet window on main long enough for one CI cycle (~35 min)."
    else
      echo "::error::PR #${num}: real runs on ${sha} had NOT concluded after 45 min:"
      echo "::error::${unfinished}"
      echo "::error::No status was posted for ANY required context — an unfinished run is"
      echo "::error::not a green one. Re-run this workflow once they finish and their"
      echo "::error::results will be bridged onto ${sha}."
    fi
    echo "::error::This run verified NOTHING for PR #${num}, so it fails rather than"
    echo "::error::reporting green (#3393)."
    UNVERIFIED=$((UNVERIFIED + 1))
    continue
  fi
  echo "  every producing run on ${sha} has concluded."

  # ---------------------------------------------------------------
  # 4. BRIDGE each REAL result onto the head SHA as a commit status.
  #
  #    WHY A BRIDGE IS STILL NEEDED — measured 2026-08-13, see header:
  #    a workflow_dispatch check run lands on the commit and its check
  #    suite is even associated with the PR, but it does NOT appear in
  #    the PR's statusCheckRollup, so branch protection does not count
  #    it. So the dispatched run supplies the RESULT and this step
  #    carries that result across, naming the run that produced it.
  #    This is NOT the old auto-pass: nothing is posted for a context
  #    whose real check run did not conclude `success`.
  # ---------------------------------------------------------------
  cr_tsv="$(gh api --paginate "repos/${REPO}/commits/${sha}/check-runs?per_page=100" \
    --jq '.check_runs[] | [.name, .status, (.conclusion // ""), .html_url] | @tsv')"
  declare -A CR_CONCL=() CR_URL=()
  while IFS=$'\t' read -r cr_name cr_status cr_concl cr_url; do
    if [ -z "${cr_name}" ]; then continue; fi
    CR_CONCL["${cr_name}"]="${cr_status}/${cr_concl}"
    CR_URL["${cr_name}"]="${cr_url}"
  done <<< "${cr_tsv}"

  bridged=(); broken=(); producerless=()
  for entry in "${REQUIRED_CHECKS[@]}"; do
    ctx="${entry%%|*}"; wf="${entry#*|}"
    if [ -z "${wf}" ]; then producerless+=("${ctx}"); continue; fi
    verdict="${CR_CONCL[${ctx}]:-ABSENT}"
    if [ "${verdict}" != "completed/success" ]; then
      echo "    NOT-GREEN ${ctx} -> ${verdict}"
      # Post an explicit FAILURE rather than merely withholding a
      # success. Withholding alone would leave any status a PREVIOUS
      # run of this workflow bridged for the same SHA standing — so a
      # job that was green and is now red (a re-run, a flake) could
      # still be sitting green on the commit. Overwrite it.
      gh api -X POST "repos/${REPO}/statuses/${sha}" \
        -f state=failure \
        -f context="${ctx}" \
        -f description="Real run on this commit did not conclude success (${verdict})" \
        -f target_url="${CR_URL[${ctx}]:-${RUN_URL}}" >/dev/null
      broken+=("${ctx}=${verdict}")
      continue
    fi
    echo "    GREEN     ${ctx} -> ${CR_URL[${ctx}]}"
    gh api -X POST "repos/${REPO}/statuses/${sha}" \
      -f state=success \
      -f context="${ctx}" \
      -f description="Real run on this exact commit concluded success — see target URL" \
      -f target_url="${CR_URL[${ctx}]}" >/dev/null
    bridged+=("${ctx}")
  done

  if [ "${#broken[@]}" -gt 0 ]; then
    echo "::error::PR #${num}: ${#broken[@]} required context(s) did NOT conclude success"
    echo "::error::on ${sha}: ${broken[*]}"
    echo "::error::'ABSENT' means the producing workflow ran but published no check run"
    echo "::error::under that exact name — a REQUIRED_CHECKS mapping defect, not a pass."
    echo "::error::Anything else is a genuine red result. Each of these was posted as a"
    echo "::error::FAILURE status on ${sha}, so the release is blocked, which is the point."
    exit 1
  fi
  echo "  bridged ${#bridged[@]} real result(s) onto ${sha}."

  # ---------------------------------------------------------------
  # 5. A REQUIRED CONTEXT WITH NO PRODUCER IS A HARD FAILURE.
  #
  #    This used to post a SYNTHETIC `success` for such a context and
  #    shout about it in a ::warning::. A warning does not stop a merge;
  #    a green status is a green status however loudly it is annotated,
  #    and #3393 is on file precisely because release PRs merged on
  #    statuses no test produced. The synthetic path is GONE.
  #
  #    The population is zero today — all 14 required contexts, read
  #    from live branch protection on 2026-08-14, have a producer — so
  #    deleting it removes no working behaviour. If protection later
  #    adds a context this file has no producer for, the release stops
  #    dead with a red status and a named remediation. Fail closed.
  # ---------------------------------------------------------------
  if [ "${#producerless[@]}" -gt 0 ]; then
    for ctx in "${producerless[@]}"; do
      echo "::error::PR #${num}: required context '${ctx}' has NO producing workflow."
      gh api -X POST "repos/${REPO}/statuses/${sha}" \
        -f state=failure \
        -f context="${ctx}" \
        -f description="No workflow in this repo publishes this context — nothing can verify it" \
        -f target_url="${RUN_URL}" >/dev/null
    done
    echo "::error::${#producerless[@]} required context(s) cannot be verified by any run:"
    echo "::error::${producerless[*]}"
    echo "::error::This workflow will NOT invent a success for them. Either add the"
    echo "::error::workflow that publishes each one and map it in REQUIRED_CHECKS, or"
    echo "::error::remove the context from branch protection. Until then the release is"
    echo "::error::blocked, which is the correct state for something nothing tests."
    exit 1
  fi
  echo "::notice::0 synthetic statuses posted for PR #${num} — all ${#bridged[@]} required contexts were bridged from real runs that concluded success on ${sha}."

  # DRIFT / DIAGNOSIS CONTROL. Distinguish, without guessing, between
  # (a) a real failing check, (b) real checks still running, (c) the
  # permanent human-approval gate, and (d) REQUIRED_CHECKS drift.
  state=""
  for _ in 1 2 3 4; do
    sleep 15
    state=$(gh pr view "${num}" --repo "${REPO}" --json mergeStateStatus --jq '.mergeStateStatus')
    if [ "$state" != "UNKNOWN" ] && [ "$state" != "BLOCKED" ]; then break; fi
  done
  echo "  post-verify: mergeStateStatus=${state}"
  if [ "$state" = "BLOCKED" ]; then
    # Scope the diagnosis to the REQUIRED contexts. A non-required job
    # going red must not be reported as "BLOCKED with failing required
    # checks" — that would assert a cause this code did not establish.
    req_json="$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | cut -d'|' -f1 \
      | jq -R -s -c 'split("\n") | map(select(length > 0))')"
    rollup=$(gh pr view "${num}" --repo "${REPO}" --json statusCheckRollup --jq '.statusCheckRollup')
    failing=$(printf '%s' "$rollup" | jq -r --argjson req "$req_json" \
      '[.[]? | select((.name // .context) as $n | ($req | index($n)) != null)
             | select(((.conclusion // .state) == "FAILURE") or ((.conclusion // .state) == "ERROR") or ((.conclusion // .state) == "CANCELLED") or ((.conclusion // .state) == "TIMED_OUT"))
             | .name // .context] | unique | join(", ")')
    inflight=$(printf '%s' "$rollup" | jq -r --argjson req "$req_json" \
      '[.[]? | select((.name // .context) as $n | ($req | index($n)) != null)
             | select(((.status // "") == "QUEUED") or ((.status // "") == "IN_PROGRESS") or ((.state // "") == "PENDING"))
             | .name // .context] | unique | join(", ")')
    # The most common BLOCKED cause: branch protection requires an
    # approving review (required_approving_review_count=1 as of
    # 2026-08-13). GITHUB_TOKEN cannot read branch protection, but
    # reviewDecision lives on the PULL REQUEST object and IS readable
    # here — so this case is distinguished, not guessed at. Blaming
    # REQUIRED_CHECKS drift for a missing approval would be exactly the
    # R7 violation this post-verify exists to prevent.
    review=$(gh pr view "${num}" --repo "${REPO}" --json reviewDecision --jq '.reviewDecision // ""')
    if [ -n "$failing" ]; then
      echo "::error::Release PR #${num} is BLOCKED with FAILING required contexts: ${failing}."
      echo "::error::Every status this workflow posts is bridged from a real run that"
      echo "::error::concluded success on this exact commit, so a red one here is a"
      echo "::error::genuine result — the release is broken and must not merge."
      exit 1
    elif [ -n "$inflight" ]; then
      echo "::notice::Release PR #${num} is BLOCKED because required contexts are still pending: ${inflight}. Nothing was bridged for them, which is correct — they will be picked up by the next run of this workflow once their real runs conclude."
    elif [ "$review" = "REVIEW_REQUIRED" ]; then
      echo "::notice::Release PR #${num} is BLOCKED solely because branch protection requires an approving review, and no check is failing. This is the expected steady state — GITHUB_TOKEN cannot approve a PR. A human (or a PAT-backed reviewer) must approve #${num} to release. NOT context drift."
    else
      echo "::error::Release PR #${num} is still BLOCKED. No required context is"
      echo "::error::failing, none is pending, and reviewDecision is '${review}' so a"
      echo "::error::missing approval is NOT the cause either. The known cause of THIS"
      echo "::error::narrowed signal is REQUIRED_CHECKS having gone stale (it has drifted"
      echo "::error::twice: PR #815, and 2026-08-13) — protection requires a context this"
      echo "::error::file does not know about, so nothing was ever posted for it. Compare"
      echo "::error::'gh api repos/${REPO}/branches/main/protection/required_status_checks'"
      echo "::error::against the table in this file and add what is missing."
      echo "::error::This workflow cannot read branch protection to confirm that, so it"
      echo "::error::names the known cause without asserting it is the only one."
      exit 1
    fi
  fi
done

# THE VERDICT OF THIS RUN. A release PR that could not be fully graded
# leaves this job RED. It used to leave it green: run 31786503229 timed
# out 78 seconds early on 2026-08-14, bridged nothing for any of the 14
# required contexts, and reported success — and the release then merged
# on an admin bypass carrying zero statuses. A run that verified nothing
# must not look like a run that verified everything (#3393).
if [ "${UNVERIFIED}" -ne 0 ]; then
  echo "::error::${UNVERIFIED} release PR(s) were NOT fully verified by this run."
  echo "::error::No required context was bridged for them, so they cannot merge on"
  echo "::error::anything this workflow produced — and this run fails so that fact is"
  echo "::error::visible in the run list instead of showing as a green release lane."
  exit 1
fi
