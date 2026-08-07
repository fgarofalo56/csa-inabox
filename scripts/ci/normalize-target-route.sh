#!/usr/bin/env bash
# normalize-target-route.sh — CI-side guard for loom-ui-verify's `target_route`.
#
# WHY (measured, run 31122589186, 2026-08-06)
#   loom-ui-verify receipts are dispatched from Git Bash on Windows:
#       gh workflow run loom-ui-verify.yml -f target_route=/admin/readiness
#   MSYS POSIX path conversion rewrites any argument that looks like an absolute
#   POSIX path into a Windows path by PREPENDING the MSYS installation root, so
#   the workflow input actually received was:
#       C:/Program Files/Git/admin/readiness
#   The receipt script then fed that to `new URL(route, baseUrl)`, which parsed
#   `C:` as a URL SCHEME, discarded the base URL, and asked Chromium to navigate
#   to `c:/Program%20Files/Git/admin/readiness`. Chromium aborted, and the error
#   handler blamed the P2S VPN, private-link and LOOM_URL — three causes the code
#   never established, all three false. That is a deploy-integrity.md R7
#   violation, and it is why loom-ui-verify read as broken from 2026-08-04,
#   blocking every V3 browser receipt in the FINISHLINE program.
#
# WHAT IT DOES
#   Repairs the ONE deterministic corruption (MSYS root prefix) and FAILS CLOSED
#   on anything else. It never invents a route: an unrecoverable input exits 1
#   with the exact dispatch-side fix, because a fabricated route would produce a
#   fabricated receipt (no-vaporware.md).
#
# CONTRACT
#   in : $RAW_ROUTE          the raw workflow input
#   out: $GITHUB_OUTPUT      route=<normalized>  repaired=true|false
#   rc : 0 usable · 1 unusable (with remediation printed)
#
# The equivalent logic for local/non-CI runs lives in
# scripts/csa-loom/e2e-receipt.mjs (normalizeRoute). Both are covered by
# scripts/ci/__tests__/normalize-target-route.test.mjs.
set -euo pipefail

RAW="${RAW_ROUTE:-}"
OUT="${GITHUB_OUTPUT:-/dev/null}"

emit() {
  printf 'route=%s\n' "$1" >> "$OUT"
  printf 'repaired=%s\n' "$2" >> "$OUT"
}

fail() {
  echo "::error::$1"
  cat <<EOF

[normalize-target-route] REJECTED: '$RAW'

  $1

  The console was NOT contacted. Nothing is known about its reachability —
  do not read this as an outage.

  Fix the DISPATCH, not the console. From Git Bash on Windows:

      MSYS_NO_PATHCONV=1 gh workflow run loom-ui-verify.yml --ref main \\
        -f target_route=/admin/readiness

  or double the leading slash so MSYS leaves it alone:

      gh workflow run loom-ui-verify.yml --ref main \\
        -f target_route=//admin/readiness
EOF
  exit 1
}

if [ -z "$RAW" ]; then
  fail "target_route was empty."
fi

# Same-origin absolute URL is legitimate.
case "$RAW" in
  http://*|https://*)
    echo "target_route is an absolute http(s) URL — passing through unchanged."
    emit "$RAW" false
    exit 0
    ;;
esac

# Windows drive-letter path => corrupt input (the MSYS signature). A console
# route is NEVER a Windows filesystem path.
if printf '%s' "$RAW" | grep -qiE '^[a-z]:[\\/]'; then
  unified="${RAW//\\//}"
  recovered=""
  # MSYS only ever PREPENDS its root, and every Git-for-Windows root ends in one
  # of these marker segments. Take the LAST occurrence and keep the remainder.
  for marker in /Git /usr /mingw64 /mingw32 /clang64; do
    lower_hay="$(printf '%s' "$unified" | tr '[:upper:]' '[:lower:]')"
    lower_mark="$(printf '%s' "$marker" | tr '[:upper:]' '[:lower:]')"
    # shellcheck disable=SC2295
    suffix="${lower_hay##*${lower_mark}/}"
    if [ "$suffix" != "$lower_hay" ]; then
      # Recompute against the ORIGINAL casing using the same tail length.
      tail_len=${#suffix}
      candidate="/${unified: -$tail_len}"
      # Prefer the LONGEST marker match (deepest root), i.e. the SHORTEST tail.
      if [ -z "$recovered" ] || [ ${#candidate} -lt ${#recovered} ]; then
        recovered="$candidate"
      fi
    fi
  done

  if [ -n "$recovered" ] && [ "$recovered" != "/" ]; then
    echo "::warning::target_route was mangled by MSYS/Git-Bash path conversion; repaired '$RAW' -> '$recovered'."
    echo "[normalize-target-route] REPAIRED"
    echo "  received : $RAW"
    echo "  using    : $recovered"
    echo "  cause    : MSYS POSIX path conversion on the dispatching shell."
    echo "  prevent  : MSYS_NO_PATHCONV=1 gh workflow run ..."
    emit "$recovered" true
    exit 0
  fi

  fail "target_route is a WINDOWS FILESYSTEM PATH, not a console route, and the MSYS root prefix could not be identified to repair it."
fi

# Site-relative path — the normal, correct case.
case "$RAW" in
  /*)
    echo "target_route OK: $RAW"
    emit "$RAW" false
    exit 0
    ;;
esac

# Bare `admin/readiness` — unambiguous, add the leading slash.
if printf '%s' "$RAW" | grep -qE '^[A-Za-z0-9]' && ! printf '%s' "$RAW" | grep -q ':'; then
  echo "[normalize-target-route] adding leading slash: '$RAW' -> '/$RAW'"
  emit "/$RAW" true
  exit 0
fi

fail "target_route must be a site-relative path (e.g. /admin/readiness) or a same-origin absolute http(s) URL."
