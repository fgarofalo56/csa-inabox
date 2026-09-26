#!/usr/bin/env bash
# check-ci-runner-scopes.sh — validate CI_RUNNER at EVERY scope a converted job
# can resolve it from, not just repository scope.
#
# WHY THIS EXISTS
# ---------------
# 102 workflows route through
#   runs-on: ${{ fromJSON(startsWith(vars.CI_RUNNER, '[') && vars.CI_RUNNER || '["ubuntu-latest"]') }}
#
# Until 2026-09-26 the guard that judged that variable read it as
# `${{ vars.CI_RUNNER }}` from a job declaring no `environment:`, which is
# REPOSITORY SCOPE ONLY. GitHub resolves `vars.*` with environment precedence
# inside a job that declares an environment, and converted jobs do. Measured at
# PR #4492's head efda6b114, by the PyYAML walk described below:
#
#   converted jobs (runs-on VALUE)                171
#   ... that declare an `environment:`             19  in 10 files
#         naming a LITERAL environment              5
#           copilot-function-prod  deploy-copilot-function.yml:deploy
#           dev                    bicep-whatif.yml:whatif
#           gcc-high-deploy        deploy-fiab-gcch.yml:deploy-validate
#           github-pages           docs.yml:deploy
#           il5-deploy             deploy-fiab-il5.yml:deploy-validate
#         naming an EXPRESSION                     14
#           deploy-gov.yml:deploy and :what-if are `${{ github.event.inputs.environment }}`
#
# So `CI_RUNNER` set on the `il5-deploy` environment routed an IL5 deploy into
# the Commercial hub VNet, under the Commercial identity uami-loom-ci, and the
# guard stayed green: no value at repository scope could turn it red, because
# the value was never at repository scope. That is the case this script exists
# to make loud, and it is the one cloud-parity.md cares about most.
#
# WHY EVERY ENVIRONMENT, NOT THE FIVE LITERALS
# --------------------------------------------
# 14 of the 19 name an EXPRESSION whose value is only known at run time, and two
# of those fourteen are `deploy-gov.yml`'s own jobs. A Gov deploy can therefore
# land on ANY environment name a dispatcher types. The set to audit is "every
# environment that exists", not a transcribed list of five.
#
# WHY THE API AND NOT `environment:` ON THE GUARD JOB
# ---------------------------------------------------
# Letting GitHub resolve the precedence for us would mean a matrix job declaring
# each environment. Measured the same day against the live repository:
#
#   gcc-high-deploy  protection=[required_reviewers]
#   il5-deploy       protection=[required_reviewers]
#   prod             protection=[branch_policy,required_reviewers]
#   dev/github-pages/staging  protection=[branch_policy]
#
# A job declaring an environment with `required_reviewers` QUEUES for manual
# approval instead of running, so the guard would be absent exactly on the two
# sovereign boundaries it exists for, and absent silently. The three
# `branch_policy` environments would refuse a job running on a PR head branch
# outright. The API read has neither failure mode.
#
# WHAT THIS SCRIPT CANNOT DO, AND WHAT IT DOES INSTEAD
# ----------------------------------------------------
# Reading another environment's variables needs a token carrying the
# repository "Variables: read" fine-grained permission. There is no `variables`
# key in a workflow `permissions:` block. If the read is refused this script
# exits NON-ZERO and says it could not read — it never reports an unread scope
# as clean. Per deploy-integrity.md R7, "I could not read il5-deploy" and
# "il5-deploy carries no CI_RUNNER" are different statements and only one of
# them is established by a 403.
#
# Inputs (all via environment):
#   CI_RUNNER_REPO_RAW  repository-scope value, passed as `${{ vars.CI_RUNNER }}`
#                       from a job declaring NO `environment:`. Unset/empty is a
#                       valid state (it is the rollback).
#   TARGET_REPO             owner/repo. Defaults to $GITHUB_REPOSITORY.
#   GH_TOKEN            token used by `gh api`.
#   ACTIONLINT_CONFIG   defaults to .github/actionlint.yaml.
#   SKIP_ENV_SCOPES     set to 1 ONLY by the sandbox harness's repo-scope arms,
#                       so a repo-scope class can be exercised without a stub
#                       API. Never set in CI; the workflow does not pass it.

set -u

REPO="${TARGET_REPO:-${GITHUB_REPOSITORY:-}}"
ACTIONLINT="${ACTIONLINT_CONFIG:-.github/actionlint.yaml}"
rc=0

err() { printf '::error::%s\n' "$*"; }

# Windows-built jq opens stdout in TEXT mode and emits CRLF. A stray \r turns an
# environment name into a 404 and an integer comparison into a parse error, so
# every jq result CAPTURED into a shell variable is stripped. Never applied to
# the `jq -e` pipelines, where a trailing `tr` would mask the exit status that
# IS the verdict. Caught by the sandbox harness, which 404'd on all nine
# environments until this existed.
nocr() { tr -d '\r'; }

# The declared fleet labels, LIFTED from the config at run time rather than
# transcribed, so a typo here cannot make this guard disagree with the config it
# enforces. WHAT VALUE WOULD MAKE THE GUARD BELOW FAIL: an actionlint.yaml whose
# `self-hosted-runner.labels` list is empty or absent -> the narrowing check has
# nothing to check against and this exits 1 rather than passing the value.
read_declared_labels() {
  awk '
    /^self-hosted-runner:/            { in_sh = 1; next }
    /^[^[:space:]#]/                  { in_sh = 0 }
    in_sh && /^[[:space:]]+labels:/   { in_l = 1; next }
    in_sh && in_l && /^[[:space:]]+-[[:space:]]*/ {
      sub(/^[[:space:]]+-[[:space:]]*/, ""); sub(/[[:space:]]+$/, ""); print; next }
    in_sh && in_l && /^[[:space:]]+[A-Za-z_]+:/ { in_l = 0 }
  ' "$ACTIONLINT" | jq -R . | jq -s -c . | nocr
}

# Shape validation, applied IDENTICALLY to every scope. Returns 0 pass, 1 fail.
# $1 = human scope label, $2 = raw value.
validate_shape() {
  local scope="$1" raw="$2" declared

  if [ -z "$raw" ]; then
    echo "[$scope] CI_RUNNER is unset — jobs at this scope fall back to ubuntu-latest."
    echo "[$scope] That is a valid state (it is the rollback), so this passes."
    return 0
  fi
  echo "[$scope] CI_RUNNER = $raw"

  # THE SAME PREDICATE THE `runs-on` EXPRESSION USES, asserted here so the two
  # cannot diverge. The expression tests startsWith(…, '[') on the RAW text; a
  # value that parses as an array but does not start with '[' (leading
  # whitespace) would be accepted by every jq check below and SILENTLY
  # downgraded to ubuntu-latest at routing time.
  # WHAT VALUE WOULD MAKE THIS FAIL: ' ["self-hosted","loom-aca"]', 'self-hosted'.
  case "$raw" in
    '['*) : ;;
    *)
      err "[$scope] CI_RUNNER does not START with '['. The runs-on expression tests"
      err "[$scope] startsWith(vars.CI_RUNNER, '[') on the raw text, so this value would"
      err "[$scope] NOT be parsed as a label set — every job would silently fall back to"
      err "[$scope] ubuntu-latest while appearing to be configured for the fleet."
      err "[$scope] Remove any leading whitespace/quoting: [\"self-hosted\",\"loom-aca\"]"
      return 1
      ;;
  esac

  # jq -e exits non-zero when the filter yields false/null.
  # WHAT VALUE WOULD MAKE THIS FAIL: '[oops' (starts with '[', is not JSON).
  if ! printf '%s' "$raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    err "[$scope] CI_RUNNER is not a JSON ARRAY. A scalar makes fromJSON return a"
    err "[$scope] string, runs-on accepts it, and the job routes to ANY self-hosted"
    err "[$scope] runner with no label narrowing. Set it to e.g. [\"self-hosted\",\"loom-aca\"]"
    return 1
  fi
  # WHAT VALUE WOULD MAKE THIS FAIL: '[]'.
  if ! printf '%s' "$raw" | jq -e 'length > 0' >/dev/null 2>&1; then
    err "[$scope] CI_RUNNER is an EMPTY array — no runner can satisfy it and every"
    err "[$scope] job will queue forever. Unset it instead to fall back to ubuntu-latest."
    return 1
  fi
  # WHAT VALUE WOULD MAKE THIS FAIL: '[1,2]', '["self-hosted",7]'.
  if ! printf '%s' "$raw" | jq -e 'all(type == "string")' >/dev/null 2>&1; then
    err "[$scope] CI_RUNNER contains a non-string element; labels must be strings."
    return 1
  fi

  if printf '%s' "$raw" | jq -e 'index("self-hosted")' >/dev/null 2>&1; then
    declared="$(read_declared_labels)"
    if [ "$(printf '%s' "$declared" | jq -r 'length' | nocr)" -eq 0 ]; then
      err "[$scope] Could not read any self-hosted label from $ACTIONLINT."
      err "[$scope] Not treating that as 'the value is fine': the narrowing check has no"
      err "[$scope] list to check against, so it cannot establish anything (R7)."
      return 1
    fi
    echo "[$scope] declared fleet labels: $(printf '%s' "$declared" | jq -c . | nocr)"
    # A self-hosted set must NARROW, and `length > 1` is NOT enough to establish
    # that: ["self-hosted",""] and ["self-hosted","x64"] are two elements and
    # still route to ANY self-hosted runner, or to none at all.
    # WHAT VALUE WOULD MAKE THIS FAIL: ["self-hosted"], ["self-hosted",""],
    # ["self-hosted","x64"].
    if ! printf '%s' "$raw" | jq -e --argjson d "$declared" \
         'map(select(. != "self-hosted" and (. | length) > 0)) | any(. as $l | $d | index($l))' \
         >/dev/null 2>&1; then
      err "[$scope] CI_RUNNER names 'self-hosted' but no DECLARED fleet label. Length alone"
      err "[$scope] is not narrowing: [\"self-hosted\",\"\"] and [\"self-hosted\",\"x64\"] are two"
      err "[$scope] elements and still route to ANY self-hosted runner, or to none at all."
      err "[$scope] Use a label declared in $ACTIONLINT, e.g. [\"self-hosted\",\"loom-aca\"]."
      return 1
    fi
  fi
  echo "[$scope] ok — non-empty JSON array of strings$(printf '%s' "$raw" | jq -r 'if index("self-hosted") then " naming a narrowed self-hosted fleet" else "" end' | nocr)."
  return 0
}

# THE BOUNDARY ARM. Shape is not enough at environment scope: a PERFECTLY
# well-formed ["self-hosted","loom-aca"] set on `il5-deploy` is precisely the
# sovereign misroute, and every check above passes it. Every declared fleet
# label is Commercial (`.github/actionlint.yaml` declares exactly one,
# `loom-aca`, in the Commercial DMLZ subscription's cae-csa-loom-centralus
# under uami-loom-ci), so no environment-scoped self-hosted value can be
# correct for a boundary — and because `deploy-gov.yml`'s converted jobs take
# their environment from `${{ github.event.inputs.environment }}`, a Gov deploy
# can land on any environment name at all. The rule is therefore flat: at
# environment scope, `self-hosted` is red.
# WHAT VALUE WOULD MAKE THIS FAIL: CI_RUNNER=["self-hosted","loom-aca"] on the
# il5-deploy environment — green under every earlier revision of this guard.
# WHAT VALUE LEAVES IT GREEN: ["ubuntu-latest"], or no environment-scoped
# CI_RUNNER at all (the state measured on all 9 environments at efda6b114).
validate_env_boundary() {
  local envname="$1" raw="$2" sovereign=""
  case "$envname" in
    *gcc*|*GCC*|*il5*|*IL5*|*gov*|*Gov*|*GOV*|*dod*|*DoD*|*DOD*) sovereign=" (its NAME also carries a sovereign token)" ;;
  esac
  if printf '%s' "$raw" | jq -e 'try index("self-hosted") catch false' >/dev/null 2>&1; then
    err "[environment '$envname'] CI_RUNNER names 'self-hosted' at ENVIRONMENT scope$sovereign."
    err "[environment '$envname'] GitHub resolves vars.* with environment precedence, so this value"
    err "[environment '$envname'] SHADOWS repository scope for every converted job that declares this"
    err "[environment '$envname'] environment — and routes it onto the Commercial fleet."
    err "[environment '$envname'] Every label in $ACTIONLINT is Commercial (there is no sovereign"
    err "[environment '$envname'] fleet), and deploy-gov.yml's converted jobs take their environment"
    err "[environment '$envname'] from \${{ github.event.inputs.environment }}, so ANY environment can"
    err "[environment '$envname'] host a Gov deploy. Remove the environment-scoped CI_RUNNER; set the"
    err "[environment '$envname'] fleet at repository scope only, or use [\"ubuntu-latest\"] here."
    return 1
  fi
  return 0
}

# --- scope 1: repository -----------------------------------------------------
# Read as `${{ vars.CI_RUNNER }}` from a job with no `environment:` — the same
# mechanism, at the same scope, the routed jobs use when they declare none.
validate_shape "repository scope" "${CI_RUNNER_REPO_RAW:-}" || rc=1

if [ "${SKIP_ENV_SCOPES:-0}" = "1" ]; then
  echo "SKIP_ENV_SCOPES=1 — environment scopes NOT audited. This is the sandbox"
  echo "harness's repo-scope-only mode and is never set in CI."
  exit "$rc"
fi

# --- scopes 2..N: every environment -----------------------------------------
if [ -z "$REPO" ]; then
  err "Neither TARGET_REPO nor GITHUB_REPOSITORY is set, so the environment scopes"
  err "cannot be enumerated. Failing closed: an unread scope is not a clean scope."
  exit 1
fi

envs_raw="$(gh api "repos/$REPO/environments?per_page=100" 2>&1)"
if [ $? -ne 0 ] || ! printf '%s' "$envs_raw" | jq -e 'type == "object"' >/dev/null 2>&1; then
  err "Could not LIST the environments of $REPO. Nothing about environment-scoped"
  err "CI_RUNNER was established — this is not 'no environment carries one' (R7)."
  err "The API said: $(printf '%s' "$envs_raw" | head -c 400)"
  err "If this is a permissions refusal, add a CI_RUNNER_AUDIT_TOKEN secret: a"
  err "fine-grained PAT on this repository with 'Environments: read' and"
  err "'Variables: read'. GITHUB_TOKEN has no 'variables' permission key."
  exit 1
fi

env_total="$(printf '%s' "$envs_raw" | jq -r '.total_count // 0' | nocr)"
mapfile -t env_names < <(printf '%s' "$envs_raw" | jq -r '.environments[]?.name' | nocr)
# GET /environments defaults to per_page=10 and TRUNCATES SILENTLY; the repo's
# own variables endpoint returned 10 of total_count 11 on 2026-09-26. Comparing
# the returned length to total_count is what makes a truncated read loud.
# WHAT VALUE WOULD MAKE THIS FAIL: a repository with more environments than one
# page returns.
if [ "${#env_names[@]}" -ne "$env_total" ]; then
  err "Environment listing is TRUNCATED: got ${#env_names[@]} of total_count $env_total."
  err "The unlisted environments were not audited. Failing closed rather than"
  err "reporting green over a scope this run never looked at."
  exit 1
fi
echo "environments to audit ($env_total): ${env_names[*]}"

for e in "${env_names[@]}"; do
  enc="$(jq -rn --arg s "$e" '$s|@uri' | nocr)"
  vars_raw="$(gh api "repos/$REPO/environments/$enc/variables?per_page=100" 2>&1)"
  if [ $? -ne 0 ] || ! printf '%s' "$vars_raw" | jq -e 'type == "object"' >/dev/null 2>&1; then
    err "Could not READ the variables of environment '$e'. Nothing about its"
    err "CI_RUNNER was established — a refused read is not an absent variable (R7)."
    err "The API said: $(printf '%s' "$vars_raw" | head -c 400)"
    rc=1
    continue
  fi
  v_total="$(printf '%s' "$vars_raw" | jq -r '.total_count // 0' | nocr)"
  v_got="$(printf '%s' "$vars_raw" | jq -r '.variables | length' | nocr)"
  if [ "$v_got" -ne "$v_total" ]; then
    err "Variable listing for environment '$e' is TRUNCATED: got $v_got of"
    err "total_count $v_total. CI_RUNNER may be among the ones not returned."
    rc=1
    continue
  fi
  value="$(printf '%s' "$vars_raw" | jq -r '.variables[]? | select(.name == "CI_RUNNER") | .value' | nocr)"
  if [ -z "$value" ]; then
    echo "[environment '$e'] no CI_RUNNER among its $v_total variable(s) — nothing shadows repository scope here."
    continue
  fi
  validate_shape "environment '$e'" "$value" || rc=1
  validate_env_boundary "$e" "$value" || rc=1
done

if [ "$rc" -eq 0 ]; then
  echo "ok — CI_RUNNER is well-formed at repository scope and at all $env_total environment scopes."
fi
exit "$rc"
