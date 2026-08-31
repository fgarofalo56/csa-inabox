#!/usr/bin/env bash
# =============================================================================
# test-cosign-install-retry.sh — self-test for scripts/ci/cosign-install-retry.sh
# =============================================================================
#
# WHY THIS EXISTS (#4156). The installer had no retry at seven sites and a TCP
# reset on a binary download reverted a healthy image on a P0 roll. A retry that
# is added but never exercised is worth very little, so this suite measures the
# loop BEHAVIOURALLY — it counts how many times the script actually invokes
# `curl`, rather than grepping the source for `ATTEMPTS=4`. A grep-based
# assertion passes on a file where the literal is present but unreachable.
#
# It also constrains the set from ABOVE. Two things must NOT be retried, and both
# have a case here:
#   · a 404, because the pinned release genuinely does not publish that file;
#   · a CHECKSUM MISMATCH, because that is an integrity failure and re-fetching
#     it is the wrong response to the one thing this script exists to detect.
# Without those, widening "retry on failure" to cover them would keep this suite
# green while making a corrupted download take four attempts and a bad pin take
# four minutes.
#
# `curl` is stubbed via a PATH shim, so this runs anywhere — no network, no
# GitHub, no cosign. Every case uses --backoff 0 except the one that measures the
# default, which uses --attempts 1 (the loop never sleeps after its final
# attempt, so the default is observable for free).
#
# Usage: bash scripts/ci/test-cosign-install-retry.sh
# Exit:  0 all cases passed / 1 a case failed
# -----------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/cosign-install-retry.sh"
[ -f "$TARGET" ] || { echo "FAIL: $TARGET not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SHIM="$TMP/bin"
mkdir -p "$SHIM"

# The `curl` stub. Appends one line per invocation so the caller can count, then
# behaves according to the env the case sets. It writes a real payload and a
# checksums file whose hash it computes with the real sha256sum, so the happy
# path verifies for the right reason rather than because the check was skipped.
cat > "$SHIM/curl" <<'SHIMEOF'
#!/usr/bin/env bash
printf 'call\n' >> "$CURL_CALLS"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -sSL|-w) shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
[ -z "$out" ] && out=/dev/null
n=$(wc -l < "$CURL_CALLS" | tr -d ' ')

# Transient until the configured attempt, if the case asks for that.
if [ -n "${CURL_OK_ON:-}" ] && [ "$n" -lt "$CURL_OK_ON" ]; then
  echo "curl: (35) Recv failure: Connection reset by peer" >&2
  printf '000'
  exit 35
fi
if [ "${CURL_MODE:-ok}" = "reset" ]; then
  echo "curl: (35) Recv failure: Connection reset by peer" >&2
  printf '000'; exit 35
fi
if [ "${CURL_MODE:-ok}" = "notfound" ]; then
  printf '404'; exit 0
fi

case "$url" in
  *cosign_checksums.txt)
    if [ "${CURL_MODE:-ok}" = "badsum" ]; then
      printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "cosign-linux-${ARCH_UNDER_TEST}" > "$out"
    elif [ "${CURL_MODE:-ok}" = "nosum" ]; then
      printf '%s  %s\n' "deadbeef" "cosign-linux-somethingelse" > "$out"
    else
      printf '%s  %s\n' "$(sha256sum "$PAYLOAD" | awk '{print $1}')" "cosign-linux-${ARCH_UNDER_TEST}" > "$out"
    fi
    ;;
  *)
    cp "$PAYLOAD" "$out"
    ;;
esac
printf '200'
exit 0
SHIMEOF
chmod +x "$SHIM/curl"

# The "binary" the stub serves: a runnable script, so `cosign version` succeeds
# and the post-install execution check measures something real.
PAYLOAD="$TMP/payload"
cat > "$PAYLOAD" <<'PAYEOF'
#!/usr/bin/env bash
echo "GitVersion: 2.6.1"
PAYEOF

case "$(uname -m)" in
  x86_64|amd64) ARCH_UNDER_TEST=amd64 ;;
  aarch64|arm64) ARCH_UNDER_TEST=arm64 ;;
  *) ARCH_UNDER_TEST=amd64 ;;
esac
export ARCH_UNDER_TEST PAYLOAD

PASS=0
FAIL=0

run_case() {
  # run_case <name> <mode> <ok_on|""> <expect_rc> <expect_curl_calls> [extra args...]
  local name="$1" mode="$2" ok_on="$3" want_rc="$4" want_calls="$5"
  shift 5
  local calls="$TMP/calls.$$" dest="$TMP/dest.$$"
  : > "$calls"; rm -rf "$dest"; mkdir -p "$dest"
  local out rc got
  out="$(CURL_CALLS="$calls" CURL_MODE="$mode" CURL_OK_ON="$ok_on" GITHUB_PATH="" \
        PATH="$SHIM:$PATH" bash "$TARGET" --version v2.6.1 --dest "$dest" "$@" 2>&1)"
  rc=$?
  got="$(wc -l < "$calls" | tr -d ' ')"
  if [ "$rc" = "$want_rc" ] && [ "$got" = "$want_calls" ]; then
    echo "  ok   $name (rc=$rc, curl calls=$got)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected rc=$want_rc curl=$want_calls, got rc=$rc curl=$got"
    printf '%s\n' "$out" | sed 's/^/         | /'
    FAIL=$((FAIL + 1))
  fi
  LAST_OUT="$out"
}

echo "== cosign-install-retry self-test"

# --- behaviour --------------------------------------------------------------
# Happy path is TWO curl calls: the binary, then the checksums file.
run_case "installs on first attempt"              ok       ""  0 2 --attempts 4 --backoff 0
run_case "retries a reset, then installs"         ok       3  0 4 --attempts 4 --backoff 0
run_case "exhausts the budget and fails CLOSED"   reset    ""  1 4 --attempts 4 --backoff 0

# --- the classification set, not just the mechanics -------------------------
# A 404 means the pinned release does not publish the file. Retrying it buys a
# slower, less accurate error. Broadening the retry to "any non-200" turns this
# red: curl calls go 1 -> 4.
run_case "a 404 is TERMINAL, not retried"         notfound ""  1 1 --attempts 4 --backoff 0

# A corrupted download is the failure this script exists to catch. Re-fetching is
# the wrong response, so the mismatch must exit after the SAME two fetches the
# happy path makes — not four. Retrying on mismatch turns this red.
run_case "checksum MISMATCH is not retried"       badsum   ""  1 2 --attempts 4 --backoff 0

# A checksums file with no line for our artifact must refuse rather than install
# an unverified binary or silently treat "no entry" as "no mismatch".
run_case "no checksum entry refuses to install"   nosum    ""  1 2 --attempts 4 --backoff 0

# --- the failure text must not read as a signature verdict (R7) --------------
if printf '%s' "$LAST_OUT" | grep -qi "signature"; then
  echo "  FAIL exhaustion text says 'signature' — an install failure verified NOTHING and must not read as a trust finding"
  FAIL=$((FAIL + 1))
else
  echo "  ok   failure text does not claim a signature verdict (R7)"
  PASS=$((PASS + 1))
fi

# --- the defaults, measured through the loop --------------------------------
run_case "DEFAULT attempts is 4"                  reset    ""  1 4 --backoff 0

# --- usage -------------------------------------------------------------------
PATH="$SHIM:$PATH" bash "$TARGET" >/dev/null 2>&1
if [ $? -eq 3 ]; then
  echo "  ok   missing --version exits 3"
  PASS=$((PASS + 1))
else
  echo "  FAIL missing --version did not exit 3"
  FAIL=$((FAIL + 1))
fi

# --- CONTROL: the harness itself must be able to fail ------------------------
# Without this, a broken shim (never invoked) would make every case above pass
# vacuously — the same control the acr-login-retry suite carries.
if [ "$(PATH="$SHIM:$PATH" command -v curl)" = "$SHIM/curl" ]; then
  echo "  ok   CONTROL: curl resolves to the stub, so the cases above measured it"
  PASS=$((PASS + 1))
else
  echo "  FAIL CONTROL: curl did not resolve to the stub — every case above is meaningless"
  FAIL=$((FAIL + 1))
fi

echo "== $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
