#!/usr/bin/env bash
# =============================================================================
# cosign-install-retry.sh — install a PINNED cosign, with a bounded retry on the
#                           download, and a failure message that cannot be
#                           mistaken for a signature verdict
# =============================================================================
#
# USAGE
#   bash scripts/ci/cosign-install-retry.sh --version v2.6.1
#                                           [--attempts 4] [--backoff 10]
#                                           [--dest /usr/local/bin]
#
# EXIT
#   0  cosign is installed at the pinned version and runs
#   1  it is not — and NOTHING has been verified either way
#
# WHY THIS EXISTS (loom-roll-and-validate run 33138606218, 2026-08-28)
#
#   INFO: Downloading bootstrap version 'v3.0.6' of cosign to verify version …
#         https://github.com/sigstore/cosign/releases/download/v3.0.6/cosign-linux-amd64
#   curl: (35) Recv failure: Connection reset by peer
#   ##[error]Process completed with exit code 35.
#
# Grepping that entire run for `##[error]` returns exactly those two lines. The
# roll never reached a gate, and a HEALTHY image was reverted because a binary
# download from github.com got a TCP reset. `sigstore/cosign-installer` is a bare
# action invocation whose only failure mode is to fail the job; it was used at
# SEVEN sites across SIX workflows, three of them sovereign, with no retry at any
# of them (#4156).
#
# THE R7 POINT — THE TWO FAILURES ARE NOT THE SAME THING (deploy-integrity.md).
# When this fired, the auto-filed issue asked which gate had failed and listed
# "cosign signature verify" among the candidates. That sends the reader hunting a
# supply-chain problem that does not exist:
#
#   cosign VERIFY fails     an image signature did not validate — a trust finding
#   cosign INSTALL fails    the binary never arrived, so NOTHING was verified,
#                           and no claim about image trust can be made at all
#
# So the exhaustion message below states that second thing explicitly, and never
# uses the word "signature" to describe its own failure.
#
# FAILS CLOSED (deploy-integrity.md R6). There is no valve in here. If cosign
# cannot be installed the caller gets a non-zero exit and its gate refuses; the
# callers own their own `skip_supply_chain` valves and say so loudly when used.
#
# WHAT IS RETRIED, AND WHAT IS NOT. Only the network fetch. A pinned version that
# does not exist answers 404 and fails on attempt 1 — retrying a 404 buys nothing
# except a less accurate error. A checksum MISMATCH is never retried either: that
# is an integrity failure, not a transient, and re-downloading it would be the
# wrong response to the one thing this script exists to detect.
#
# INTEGRITY. The binary is verified against `cosign_checksums.txt` from the SAME
# pinned release before it is installed. This is not equivalent to the action's
# bootstrap-cosign verification and is not claimed to be: it establishes that the
# bytes are the bytes that release published, which is exactly the property a
# truncated or reset download violates. It does not establish that the release
# itself is trustworthy — pinning the version is what carries that.
#
# ONE HELPER, EVERY BOUNDARY (cloud-parity.md). The same bare invocation existed
# in the Commercial producer, full-app-deploy-commercial (twice),
# loom-roll-and-validate, AND all three sovereign workflows. Fixing only
# Commercial would have left the sovereign estates carrying the failure this
# removes — the identical mistake the cosign-SIGN retry work already found.
#
# NOTE: this script's header is `set -uo pipefail` — it never enables -e, and a
# bare `set -e` here would TURN IT ON rather than restore it
# (scripts/ci/check-set-e-restore.mjs).
# -----------------------------------------------------------------------------
set -uo pipefail

VERSION=""
ATTEMPTS=4
BACKOFF=10
DEST="/usr/local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --version)  VERSION="${2:-}"; shift 2 ;;
    --attempts) ATTEMPTS="${2:-4}"; shift 2 ;;
    --backoff)  BACKOFF="${2:-10}"; shift 2 ;;
    --dest)     DEST="${2:-/usr/local/bin}"; shift 2 ;;
    *) echo "::error::cosign-install-retry: unknown argument '$1'" >&2; exit 3 ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "::error::cosign-install-retry: --version is required and must be PINNED (e.g. v2.6.1). An unpinned cosign is a silent major-version upgrade of the tool that signs every image this repo ships." >&2
  exit 3
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "::error::cosign-install-retry: unsupported machine architecture '$(uname -m)'. cosign publishes linux-amd64 and linux-arm64; this runner is neither, so no install was attempted." >&2
    exit 1
    ;;
esac

BASE="https://github.com/sigstore/cosign/releases/download/${VERSION}"
BIN="cosign-linux-${ARCH}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Already present at the pinned version? Then this is a no-op. Makes the script
# idempotent so a workflow that installs twice does not pay for it twice.
if command -v cosign >/dev/null 2>&1; then
  HAVE="$(cosign version 2>/dev/null | sed -n 's/.*GitVersion: *//p' | head -1)"
  if [ "$HAVE" = "${VERSION#v}" ] || [ "$HAVE" = "$VERSION" ]; then
    echo "cosign ${VERSION} already installed at $(command -v cosign) — nothing to do."
    exit 0
  fi
fi

# fetch <url> <out> — bounded retry, and it distinguishes "the server said no"
# from "we never reached the server". A 404 is terminal: the pinned release does
# not publish this file and no number of retries will change that.
fetch() {
  url="$1"; out="$2"
  i=1
  while [ "$i" -le "$ATTEMPTS" ]; do
    CODE="$(curl -sSL -w '%{http_code}' -o "$out" "$url" 2> "$TMP/curl.err")"
    RC=$?
    if [ $RC -eq 0 ] && [ "$CODE" = "200" ]; then
      [ "$i" -gt 1 ] && echo "::notice::cosign-install-retry: fetched $(basename "$url") on attempt ${i}/${ATTEMPTS}."
      return 0
    fi
    if [ "$CODE" = "404" ]; then
      echo "::error::cosign-install-retry: ${url} returned 404. The pinned release '${VERSION}' does not publish $(basename "$url"), so this is NOT transient and was not retried. Check the version pin." >&2
      return 2
    fi
    LASTERR="curl rc=${RC} http=${CODE} $(tr -d '\r\n' < "$TMP/curl.err" | cut -c1-200)"
    if [ "$i" -lt "$ATTEMPTS" ]; then
      echo "::warning::cosign-install-retry: attempt ${i}/${ATTEMPTS} to fetch $(basename "$url") did not complete (${LASTERR}); waiting ${BACKOFF}s. This is the class of failure that reverted a healthy roll on 2026-08-28."
      sleep "$BACKOFF"
    fi
    i=$((i + 1))
  done
  echo "::error::cosign-install-retry: could not fetch ${url} after ${ATTEMPTS} attempt(s). LAST: ${LASTERR:-none recorded}" >&2
  return 1
}

echo "Installing cosign ${VERSION} (linux-${ARCH}), up to ${ATTEMPTS} attempt(s) per file ..."

fetch "${BASE}/${BIN}" "$TMP/cosign" || exit 1
fetch "${BASE}/cosign_checksums.txt" "$TMP/sums" || exit 1

# INTEGRITY, BEFORE THE BINARY IS EVER MADE EXECUTABLE. A reset or truncated
# download is exactly what this catches, and it is the failure that started this.
WANT="$(awk -v f="$BIN" '$2 == f { print $1 }' "$TMP/sums" | head -1)"
if [ -z "$WANT" ]; then
  echo "::error::cosign-install-retry: cosign_checksums.txt for ${VERSION} lists no entry for '${BIN}'. Refusing to install an unverified binary." >&2
  exit 1
fi
GOT="$(sha256sum "$TMP/cosign" | awk '{print $1}')"
if [ "$GOT" != "$WANT" ]; then
  echo "::error::cosign-install-retry: CHECKSUM MISMATCH for ${BIN} at ${VERSION} — expected ${WANT}, got ${GOT}. NOT retried: this is an integrity failure, not a transient. Nothing was installed and nothing was verified." >&2
  exit 1
fi

chmod +x "$TMP/cosign"
if ! mv "$TMP/cosign" "${DEST}/cosign" 2>"$TMP/mv.err"; then
  if ! sudo mv "$TMP/cosign" "${DEST}/cosign" 2>>"$TMP/mv.err"; then
    echo "::error::cosign-install-retry: downloaded and verified cosign ${VERSION} but could not install it into '${DEST}': $(tr -d '\r\n' < "$TMP/mv.err" | cut -c1-200)" >&2
    exit 1
  fi
fi

# PROVE IT RUNS. An installed file that cannot execute is not an install, and
# reporting success here would be the unverified-outcome claim R6 forbids.
if ! "${DEST}/cosign" version > "$TMP/ver.out" 2>&1; then
  echo "::error::cosign-install-retry: installed ${DEST}/cosign but it does not run: $(tr -d '\r\n' < "$TMP/ver.out" | cut -c1-200)" >&2
  exit 1
fi

# Match the action's contract: put the install dir on PATH for later steps.
if [ -n "${GITHUB_PATH:-}" ]; then echo "$DEST" >> "$GITHUB_PATH"; fi

echo "cosign ${VERSION} installed at ${DEST}/cosign and verified against cosign_checksums.txt."
exit 0
