#!/usr/bin/env bash
# =============================================================================
# cosign-sign-retry.sh — keyless cosign signing with a retry that RE-MINTS the
#                        OIDC token, and that can fail
# =============================================================================
#
# USAGE
#   bash scripts/ci/cosign-sign-retry.sh --ref <registry>/<repo>@sha256:<digest>
#                                        [--attempts 3] [--backoff 20]
#
# EXIT
#   0  signed
#   1  not signed after the budget — the caller must treat the image as UNSIGNED
#
# WHY THIS EXISTS (run 31496454872, Commercial image producer)
#
#   13:36:32  error fetching GitHub OIDC token (will retry):
#             … net/http: TLS handshake timeout
#   13:41:35  Error: signing …: getting key from Fulcio: retrieving cert:
#             error obtaining token: expired_token
#
# cosign's OWN internal retry is what turned a transient into a failure. It
# retried for five minutes against a token with a short lifetime, so the
# terminal error class MUTATED — a TLS handshake timeout surfaced as
# `expired_token`, which reads like a credential fault and is not one. That
# mutation is the dangerous part: it sends the reader to the wrong place.
#
# A fresh `cosign sign` invocation re-requests a NEW token from
# ACTIONS_ID_TOKEN_REQUEST_URL. cosign's internal retry cannot, because it is
# still holding the old one. So the retry has to live at THIS level to work at
# all — wrapping is not merely tidier, it is the only shape that helps.
#
# FAILS CLOSED (deploy-integrity.md R6). An image that cannot be signed stays
# unsigned and the roll gates reject it. There is no valve in here; the callers
# own their own `skip_supply_chain` valves and say so loudly when used.
#
# ONE HELPER, EVERY BOUNDARY (cloud-parity.md). The identical shape existed in
# four workflows — the Commercial producer, full-app-deploy-commercial, and BOTH
# Gov producers. Fixing only Commercial would have left the sovereign estates
# with the failure mode this removes.
# -----------------------------------------------------------------------------
set -uo pipefail

REF=""
ATTEMPTS=3
BACKOFF=20

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)      REF="${2:-}"; shift 2 ;;
    --attempts) ATTEMPTS="${2:-3}"; shift 2 ;;
    --backoff)  BACKOFF="${2:-20}"; shift 2 ;;
    *) echo "::error::cosign-sign-retry: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$REF" ]; then
  echo "::error::cosign-sign-retry: --ref is required (a digest reference, e.g. myacr.azurecr.io/app@sha256:…)." >&2
  exit 1
fi

# A DIGEST reference, never a tag. Signing a tag signs whatever the tag pointed
# at when cosign resolved it, which is not necessarily what was just built, and
# the roll gates verify by digest.
case "$REF" in
  *@sha256:*) : ;;
  *)
    echo "::error::cosign-sign-retry: --ref must be a DIGEST reference (…@sha256:…), got '${REF}'. Signing a tag does not prove which image was signed." >&2
    exit 1
    ;;
esac

echo "Signing $REF keylessly (GitHub Actions OIDC → Fulcio/Rekor), up to ${ATTEMPTS} attempt(s) ..."

i=1
while [ "$i" -le "$ATTEMPTS" ]; do
  if cosign sign --yes "$REF"; then
    if [ "$i" -gt 1 ]; then
      echo "::notice::cosign-sign-retry: signed $REF on attempt ${i}/${ATTEMPTS}."
    fi
    exit 0
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "::warning::cosign-sign-retry: attempt ${i}/${ATTEMPTS} failed for ${REF}. Re-invoking so a FRESH OIDC token is minted — an 'expired_token' here is a symptom of a retry outliving its token, NOT a credential fault. Waiting ${BACKOFF}s."
    sleep "$BACKOFF"
  fi
  i=$((i + 1))
done

echo "::error::cosign-sign-retry: signing FAILED for ${REF} after ${ATTEMPTS} attempt(s). The image is BUILT but UNSIGNED — the roll gates will reject it. Re-run this workflow (transient Sigstore/OIDC outage), or (emergency only) re-dispatch with skip_supply_chain=true AND use the roll workflow's skip valve." >&2
exit 1
