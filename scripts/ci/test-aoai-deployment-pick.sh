#!/usr/bin/env bash
# Self-test for scripts/csa-loom/aoai-deployment-pick.sh — the AOAI deployment
# picker that byo-wizard.sh and discover-services.sh both source.
#
# WHY THIS EXISTS
# ---------------
# The matcher this replaced was a hard-coded model allowlist:
#     gpt-4o|gpt-4.1|gpt-4|gpt-35|gpt-3.5
# On 2026-08-05 that list matched NOTHING on a real account whose only chat slots
# were gpt-5.4-mini / gpt-5.4-nano / o3-deep-research. A reuse pick therefore
# emitted `chatDeployment: ''`, the deploy shipped a blank
# LOOM_AOAI_CHAT_DEPLOYMENT, and nothing anywhere said so. An allowlist ages into
# a SILENT failure the moment the platform ships a family it does not name, and
# it fails EMPTY — the worst direction, because an empty string reads downstream
# as "this account has no chat model" rather than "I did not recognise it".
#
# So the property under test is not "does it know today's model names". It is:
#
#   (A) a NEVER-SEEN family still resolves a non-empty chat deployment, and
#   (B) among names it DOES know, it picks the best one rather than the first.
#
# (A) is the age-out guard: it goes RED the moment someone reintroduces a pure
# allowlist, no matter which names are in it.
#
# FIXTURES ARE REAL CAPTURES, NOT INVENTIONS
# ------------------------------------------
# Every account block below is a byte-copy of real output from
#   az cognitiveservices account deployment list \
#     --query "[].{name:name,model:properties.model.name}" -o tsv
# captured 2026-08-06 against live Azure. That matters: a hand-written fixture
# models what the author THINKS the API returns, and this repo has already
# shipped a deploy-breaking bug past a guard whose fixture was invented. The
# `gpt-4o` row of dml-ai-eastus-sandbox is a good example of something nobody
# would have made up — the deployment is NAMED gpt-4o but SERVES gpt-5.1, which
# is why selection is on the MODEL and the returned value is the DEPLOYMENT NAME.
#
# Run: bash scripts/ci/test-aoai-deployment-pick.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=scripts/csa-loom/aoai-deployment-pick.sh
. "$REPO/scripts/csa-loom/aoai-deployment-pick.sh"

FAIL=0
PASS=0

expect() { # expect <label> <actual> <wanted>
  if [[ "$2" == "$3" ]]; then
    PASS=$((PASS + 1))
    printf '  ok    %-58s %s\n' "$1" "'$2'"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %-58s got=%s want=%s\n' "$1" "'$2'" "'$3'"
  fi
}

expect_nonempty() { # expect_nonempty <label> <actual>
  if [[ -n "$2" ]]; then
    PASS=$((PASS + 1))
    printf '  ok    %-58s %s\n' "$1" "'$2'"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %-58s got EMPTY — the matcher aged out and failed silently\n' "$1"
  fi
}

# ── real capture: alz-ai-services-westus (2026-08-06) ────────────────────────
# The account that broke the old matcher: no gpt-4-family model at all.
ALZ=$(printf 'MAI-Image-2e\tMAI-Image-2e
MAI-Image-2\tMAI-Image-2
gpt-5.4-mini\tgpt-5.4-mini
gpt-5.4-nano\tgpt-5.4-nano
o3-deep-research\to3-deep-research')

echo "alz-ai-services-westus (real capture — the account the old allowlist missed)"
expect_nonempty "chat resolves at all"                 "$(aoai_pick_chat "$ALZ")"
expect          "chat"          "$(aoai_pick_chat   "$ALZ")" 'gpt-5.4-mini'
expect          "mini"          "$(aoai_pick_mini   "$ALZ")" 'gpt-5.4-mini'
expect          "strong"        "$(aoai_pick_strong "$ALZ")" 'o3-deep-research'
expect          "embed (none)"  "$(aoai_pick_embed  "$ALZ")" ''

# ── real capture: aoai-csa-loom-centralus (2026-08-06) ───────────────────────
# Has a mini AND a flagship; the old matcher picked the MINI as the chat tier
# because gpt-4o-mini contains 'gpt-4o' and came first in the list.
AOAI=$(printf 'gpt-4o-mini\tgpt-4o-mini
gpt-5.6-sol\tgpt-5.6-sol
gpt-5.6-luna\tgpt-5.6-luna
gpt-5.6-terra\tgpt-5.6-terra')

echo
echo "aoai-csa-loom-centralus (real capture — mini must NOT win the chat tier)"
expect "chat"   "$(aoai_pick_chat   "$AOAI")" 'gpt-5.6-sol'
expect "mini"   "$(aoai_pick_mini   "$AOAI")" 'gpt-4o-mini'
expect "strong" "$(aoai_pick_strong "$AOAI")" 'gpt-5.6-sol'

# ── real capture: azopenai-dev-eastus2 (2026-08-06) ──────────────────────────
# A deployment NAMED gpt-5.2-chat that SERVES gpt-chat-latest, alongside a video
# model. Proves selection is on the model and modality filtering works.
DEV=$(printf 'model-router\tmodel-router
sora-2\tsora-2
gpt-5.2-chat\tgpt-chat-latest')

echo
echo "azopenai-dev-eastus2 (real capture — model-based selection, sora excluded)"
expect "chat" "$(aoai_pick_chat "$DEV")" 'gpt-5.2-chat'

# ── real capture: dml-ai-eastus-sandbox (2026-08-06) ─────────────────────────
# 25 deployments across five vendors, arbitrary order. `gpt-4o` SERVES gpt-5.1 —
# selecting on the model is what makes it the right chat pick; selecting on the
# name would have graded it as a 2024 model.
RICH=$(printf 'text-embedding-ada-002\ttext-embedding-ada-002
gpt-4.1\tgpt-4.1
text-embedding-3-small\ttext-embedding-3-small
text-embedding-3-large\ttext-embedding-3-large
DeepSeek-R1-0528\tDeepSeek-R1-0528
grok-3-mini\tgrok-3-mini
grok-3\tgrok-3
gpt-4o\tgpt-5.1
gpt-4o-mini\tgpt-4.1-mini
o1\to1
gpt-35-turbo\tgpt-4.1-mini
gpt-5-mini\tgpt-5-mini
o4-mini\to4-mini
gpt-4.1-nano\tgpt-4.1-nano
gpt-5\tgpt-5
Phi-4\tPhi-4
Phi-4-reasoning\tPhi-4-reasoning
Kimi-K2-Thinking\tKimi-K2.5
MAI-Image-2e\tMAI-Image-2e
gpt-5.4-mini\tgpt-5.4-mini
FLUX.2-pro\tFLUX.2-pro
MAI-Image-2.5\tMAI-Image-2.5')

echo
echo "dml-ai-eastus-sandbox (real capture — 22 deployments, arbitrary order)"
expect "chat (the gpt-5.1-backed slot, not the first gpt-* line)" \
       "$(aoai_pick_chat "$RICH")" 'gpt-4o'
expect "mini"   "$(aoai_pick_mini   "$RICH")" 'gpt-5.4-mini'
expect "strong (o-series beats a small *reasoning* slot)" \
       "$(aoai_pick_strong "$RICH")" 'o1'
expect "embed (3-large beats 3-small and ada)" \
       "$(aoai_pick_embed  "$RICH")" 'text-embedding-3-large'

# ── THE AGE-OUT GUARD ────────────────────────────────────────────────────────
# Synthetic ON PURPOSE, and the only synthetic case here: its whole point is that
# these names are ones the picker has never heard of. If someone replaces the
# ranked preference order with an allowlist — of ANY vintage — this goes red.
echo
echo "AGE-OUT GUARD — an account of entirely unrecognised families"
FUTURE=$(printf 'o5-preview\to5-preview
some-new-family-1\tsome-new-family-1
mystery-chat\tmystery-chat')
expect_nonempty "chat still resolves on an unknown family" "$(aoai_pick_chat "$FUTURE")"

# …and the fallback must still respect modality: an image-only account has no
# chat model, and saying so is correct, not a failure to recognise.
echo
echo "the fallback is not a free-for-all — an image-only account has no chat"
IMAGES=$(printf 'MAI-Image-2e\tMAI-Image-2e
FLUX.2-pro\tFLUX.2-pro
sora-2\tsora-2')
expect "chat on an image-only account" "$(aoai_pick_chat "$IMAGES")" ''

# ── empty input ──────────────────────────────────────────────────────────────
echo
echo "empty input (account unreadable, or genuinely has no deployments)"
expect "chat"   "$(aoai_pick_chat   "")" ''
expect "mini"   "$(aoai_pick_mini   "")" ''
expect "strong" "$(aoai_pick_strong "")" ''
expect "embed"  "$(aoai_pick_embed  "")" ''

echo
if [[ "$FAIL" -gt 0 ]]; then
  echo "[aoai-deployment-pick] FAIL — $FAIL of $((PASS + FAIL)) assertions failed."
  echo "  If the age-out assertion is the one that failed, the picker has been"
  echo "  turned back into an allowlist and will silently bind an empty chat"
  echo "  deployment on any account using a family it does not name."
  exit 1
fi
echo "[aoai-deployment-pick] OK — $PASS assertions, 4 real accounts + the age-out guard."
