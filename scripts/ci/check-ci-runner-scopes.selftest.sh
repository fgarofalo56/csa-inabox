#!/usr/bin/env bash
# check-ci-runner-scopes.selftest.sh — prove the guard can fail, arm by arm.
#
# assertion-design.md: "A test that has never failed has never been shown to
# work." This runs check-ci-runner-scopes.sh against a stubbed variables API in
# a scratch directory and asserts BOTH directions for every arm — the value that
# turns it red, and a neighbouring value that must stay green. Nothing in the
# tracked tree is modified; the checker and .github/actionlint.yaml are COPIED.
#
# The arm that matters most is the one the guard was added for:
#   CI_RUNNER = ["self-hosted","loom-aca"] on the il5-deploy environment
# That value is well-formed by every shape test, and until 2026-09-26 no
# revision of this guard could turn red on it, because the guard read
# repository scope only. It is arm 1 here.
#
# Run it yourself:  bash scripts/ci/check-ci-runner-scopes.selftest.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

WORK="$TMP/work"; FIX="$TMP/fixtures"; BIN="$TMP/bin"
mkdir -p "$WORK/.github" "$WORK/scripts/ci" "$FIX" "$BIN"
cp "$ROOT/scripts/ci/check-ci-runner-scopes.sh" "$WORK/scripts/ci/"
cp "$ROOT/.github/actionlint.yaml"              "$WORK/.github/"

# Stub `gh`, serving fixtures. GH_FAIL_MODE=403 makes every call a refusal.
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -u
[ "${1:-}" = "api" ] || { echo "stub: unexpected: $*" >&2; exit 64; }
path="${2:-}"
if [ "${GH_FAIL_MODE:-}" = "403" ]; then
  echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1
fi
case "$path" in
  *"/environments?"*) cat "$FIXTURE_DIR/environments.json" ;;
  *"/environments/"*"/variables?"*)
    name="${path#*/environments/}"; name="${name%%/variables*}"
    f="$FIXTURE_DIR/env-$name.json"
    if [ -f "$f" ]; then cat "$f"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;
  *) echo "stub: unhandled path: $path" >&2; exit 64 ;;
esac
STUB
chmod +x "$BIN/gh"
export PATH="$BIN:$PATH" FIXTURE_DIR="$FIX"

CHECK="scripts/ci/check-ci-runner-scopes.sh"
pass=0; fail=0

# $1 label, $2 expected exit, $3 expected substring (single LINE; "-" to skip),
# rest: NAME=VALUE assignments for the run.
arm() {
  local label="$1" want="$2" needle="$3"; shift 3
  local out got
  out="$(cd "$WORK" && env "$@" TARGET_REPO=o/r bash "$CHECK" 2>&1)"; got=$?
  if [ "$got" -ne "$want" ]; then
    printf 'FAIL  %-58s exit=%s want=%s\n' "$label" "$got" "$want"
    printf '%s\n' "$out" | sed 's/^/        | /' | head -14
    fail=$((fail+1)); return
  fi
  # grep -F on the FULL output, never the truncated display. The needle must sit
  # on ONE line: the guard's messages wrap, and an earlier draft of this file
  # searched for a phrase split across two `err` calls and reported a false FAIL.
  if [ "$needle" != "-" ] && ! printf '%s' "$out" | grep -qF -- "$needle"; then
    printf 'FAIL  %-58s exit ok but missing: %s\n' "$label" "$needle"
    printf '%s\n' "$out" | sed 's/^/        | /' | head -14
    fail=$((fail+1)); return
  fi
  printf 'ok    %-58s exit=%s\n' "$label" "$got"
  pass=$((pass+1))
}

# The nine environments that exist on this repository, measured 2026-09-26 via
# GET /repos/:r/environments?per_page=100 (total_count 9). Held literally rather
# than fetched so the selftest needs no token and no network.
ENVS='copilot-function-prod dev gcc-high-deploy github-pages gov-dev il5-deploy prod scratch staging'
mk_clean() {
  rm -f "$FIX"/env-*.json
  printf '{"total_count":9,"environments":[' > "$FIX/environments.json"
  local first=1
  for e in $ENVS; do
    [ $first -eq 1 ] || printf ',' >> "$FIX/environments.json"; first=0
    printf '{"name":"%s"}' "$e" >> "$FIX/environments.json"
    printf '{"total_count":0,"variables":[]}' > "$FIX/env-$e.json"
  done
  printf ']}' >> "$FIX/environments.json"
}
set_env_var() {
  printf '{"total_count":1,"variables":[{"name":"CI_RUNNER","value":%s}]}' \
    "$(printf '%s' "$2" | jq -Rs .)" > "$FIX/env-$1.json"
}

echo "=== THE CASE THE GUARD EXISTS FOR: a value at ENVIRONMENT scope ==="
mk_clean; set_env_var il5-deploy '["self-hosted","loom-aca"]'
arm 'RED  ["self-hosted","loom-aca"] on il5-deploy' 1 \
    "names 'self-hosted' at ENVIRONMENT scope" CI_RUNNER_REPO_RAW=
mk_clean; set_env_var gcc-high-deploy '["self-hosted","loom-aca"]'
arm 'RED  same value on gcc-high-deploy' 1 "sovereign token" CI_RUNNER_REPO_RAW=
mk_clean; set_env_var gov-dev '["self-hosted","loom-aca"]'
arm 'RED  same value on gov-dev' 1 "sovereign token" CI_RUNNER_REPO_RAW=
mk_clean; set_env_var dev '["self-hosted","loom-aca"]'
# `dev` carries no sovereign token, and is red anyway: deploy-gov.yml's converted
# jobs take their environment from an expression, so any environment can host a
# Gov deploy.
arm 'RED  same value on dev (expression-reachable)' 1 \
    "so ANY environment can" CI_RUNNER_REPO_RAW=
mk_clean; set_env_var il5-deploy '["self-hosted","x64"]'
arm 'RED  malformed AND environment-scoped' 1 "no DECLARED fleet label" CI_RUNNER_REPO_RAW=

echo
echo "=== NEGATIVE CONTROLS: correct values at every scope stay green ==="
mk_clean
arm 'green  nothing set anywhere (the live state)' 0 \
    "all 9 environment scopes" CI_RUNNER_REPO_RAW=
arm 'green  repo-scope ["self-hosted","loom-aca"]' 0 \
    "all 9 environment scopes" 'CI_RUNNER_REPO_RAW=["self-hosted","loom-aca"]'
arm 'green  repo-scope ["ubuntu-latest"]' 0 \
    "all 9 environment scopes" 'CI_RUNNER_REPO_RAW=["ubuntu-latest"]'
mk_clean; set_env_var il5-deploy '["ubuntu-latest"]'
arm 'green  env-scoped ["ubuntu-latest"] on il5-deploy' 0 \
    "all 9 environment scopes" CI_RUNNER_REPO_RAW=

echo
echo "=== REGRESSION: the repository-scope value classes ==="
mk_clean
rep() { arm "$1" "$2" "$3" "CI_RUNNER_REPO_RAW=$4"; }
rep 'class  1  unset / empty              -> pass' 0 'CI_RUNNER is unset' ''
rep 'class  2  self-hosted  (bare scalar) -> RED'  1 "does not START with '['" 'self-hosted'
rep 'class  3  "self-hosted" (quoted)     -> RED'  1 "does not START with '['" '"self-hosted"'
rep 'class  4  leading space + array      -> RED'  1 "does not START with '['" ' ["self-hosted","loom-aca"]'
rep 'class  5  [oops        (not JSON)    -> RED'  1 'is not a JSON ARRAY'     '[oops'
rep 'class  6  []           (empty array) -> RED'  1 'is an EMPTY array'       '[]'
rep 'class  7  [1,2]        (non-string)  -> RED'  1 'non-string element'      '[1,2]'
rep 'class  8  ["self-hosted",7]          -> RED'  1 'non-string element'      '["self-hosted",7]'
rep 'class  9  ["self-hosted"]            -> RED'  1 'no DECLARED fleet label' '["self-hosted"]'
rep 'class 10  ["self-hosted",""]         -> RED'  1 'no DECLARED fleet label' '["self-hosted",""]'
rep 'class 11  ["self-hosted","x64"]      -> RED'  1 'no DECLARED fleet label' '["self-hosted","x64"]'
rep 'class 12  ["self-hosted","loom-aca"] -> pass' 0 'narrowed self-hosted fleet' '["self-hosted","loom-aca"]'
rep 'class 13  ["ubuntu-latest"]          -> pass' 0 'non-empty JSON array'    '["ubuntu-latest"]'

echo
echo "=== READ INTEGRITY: an unread scope is never reported as clean ==="
mk_clean
arm 'RED  the environments list is refused' 1 \
    'Could not LIST the environments' CI_RUNNER_REPO_RAW= GH_FAIL_MODE=403
mk_clean; rm -f "$FIX/env-il5-deploy.json"
arm 'RED  one environment read is refused' 1 \
    "Could not READ the variables of environment 'il5-deploy'" CI_RUNNER_REPO_RAW=
mk_clean
jq '.total_count = 40' "$FIX/environments.json" > "$FIX/.t" && mv "$FIX/.t" "$FIX/environments.json"
arm 'RED  environment listing truncated (9 of 40)' 1 \
    'listing is TRUNCATED' CI_RUNNER_REPO_RAW=
mk_clean
printf '{"total_count":11,"variables":[{"name":"X","value":"y"}]}' > "$FIX/env-il5-deploy.json"
arm 'RED  a variable page is truncated (1 of 11)' 1 'is TRUNCATED' CI_RUNNER_REPO_RAW=
mk_clean
printf '# every self-hosted label removed for this arm\n' > "$WORK/.github/actionlint.yaml"
arm 'RED  actionlint.yaml declares no fleet label' 1 \
    'Could not read any self-hosted label' 'CI_RUNNER_REPO_RAW=["self-hosted","loom-aca"]'
cp "$ROOT/.github/actionlint.yaml" "$WORK/.github/"
# ... and the same value is green again once the list is back, so the arm above
# pins the missing list and not something incidental about the value.
arm 'green  ...and green again with the list restored' 0 \
    'narrowed self-hosted fleet' 'CI_RUNNER_REPO_RAW=["self-hosted","loom-aca"]'

echo
printf 'ARMS: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
