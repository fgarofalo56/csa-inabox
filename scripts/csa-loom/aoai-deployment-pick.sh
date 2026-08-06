#!/usr/bin/env bash
# Shared AOAI deployment picker — sourced, never executed.
#
# WHY THIS IS SHARED AND NOT COPIED
# ---------------------------------
# Two scanners answer "which deployments does this Azure OpenAI account have":
# `byo-wizard.sh` (which emits the adopt bag the deploy consumes) and
# `discover-services.sh` (which prints the EXISTING_* exports an operator pastes).
# They each carried their OWN copy of the matcher, and both copies were the
# pre-2026 list `gpt-4o|gpt-4.1|gpt-4|gpt-35`. Measured 2026-08-05 against real
# accounts, that list resolves NOTHING on a modern estate — e.g. an account whose
# only chat slots are `gpt-5.4-mini`, `gpt-5.4-nano` and `o3-deep-research` — so a
# reuse pick emitted `chatDeployment: ''` and the deploy shipped a blank
# LOOM_AOAI_CHAT_DEPLOYMENT. Fixing one copy and leaving the other is the
# guard-adoption gap this repo keeps re-finding, so there is now one copy.
#
# Usage:
#   . "$(dirname "${BASH_SOURCE[0]}")/aoai-deployment-pick.sh"
#   deploys="$(az cognitiveservices account deployment list … \
#                --query "[].{name:name,model:properties.model.name}" -o tsv)"
#   chat="$(aoai_pick_chat   "$deploys")"
#   mini="$(aoai_pick_mini   "$deploys")"
#   strong="$(aoai_pick_strong "$deploys")"
#   embed="$(aoai_pick_embed "$deploys")"
#
# INPUT is TSV: `<deployment name>\t<model name>`. Selection is on the MODEL, and
# the returned value is the DEPLOYMENT NAME — an account may name a deployment
# `gpt-4o` while it actually serves `gpt-5.1`, and the Console must be handed the
# deployment name it can call.

# aoai_pick_by_rank <tsv> <model-regex>… -> the deployment NAME whose MODEL
# matches the EARLIEST-listed regex (case-insensitive), else empty.
#
# RANKED, not first-line-wins: an account's deployment order is arbitrary (a real
# account lists grok-3 and DeepSeek-R1 before gpt-5), so "first line matching
# /gpt/" is a coin flip, not a choice.
aoai_pick_by_rank() {
  local tsv="$1"; shift
  local re hit
  for re in "$@"; do
    hit="$(awk -F'\t' -v re="$re" 'NF>=2 && tolower($2) ~ re {print $1; exit}' <<<"$tsv")"
    if [[ -n "$hit" ]]; then printf '%s' "$hit"; return 0; fi
  done
  return 0
}

# Everything that is NOT a text-chat model. A chat tier must never resolve to an
# image, audio, video or embedding slot.
aoai_chat_pool() {
  awk -F'\t' 'NF>=2 && tolower($2) !~ /image|dall-e|sora|whisper|tts|embedding|flux|video|speech|moderation|rerank/ {print}' <<<"$1"
}

# The chat pool minus the deliberately-small models, so a mini/nano slot is only
# chosen as the default tier when it is the ONLY thing on the account.
aoai_chat_pool_main() {
  awk -F'\t' 'tolower($2) !~ /mini|nano/ {print}' <<<"$(aoai_chat_pool "$1")"
}

# Default / standard tier — newest general chat model first.
aoai_pick_chat() {
  local pool_main pool hit
  pool_main="$(aoai_chat_pool_main "$1")"
  pool="$(aoai_chat_pool "$1")"
  local rank=('gpt-5[.]6' 'gpt-5[.]5' 'gpt-5[.]4' 'gpt-5[.]3' 'gpt-5[.]2' 'gpt-5[.]1' 'gpt-5' \
              'gpt-chat-latest' 'gpt-4[.]1' 'gpt-4o' 'gpt-4' 'gpt-35|gpt-3[.]5' 'model-router' 'gpt-')
  hit="$(aoai_pick_by_rank "$pool_main" "${rank[@]}")"
  [[ -z "$hit" ]] && hit="$(aoai_pick_by_rank "$pool" "${rank[@]}")"
  printf '%s' "$hit"
}

# Mini tier — an explicitly small model. Empty is safe: admin-plane falls the
# tier back to the account's chat deployment rather than to ''.
aoai_pick_mini() {
  aoai_pick_by_rank "$(aoai_chat_pool "$1")" \
    'gpt-5[.]6-mini' 'gpt-5[.]4-mini' 'gpt-5-mini' 'gpt-4[.]1-mini' 'gpt-4o-mini' 'mini' 'nano' 'gpt-35-turbo'
}

# Strong tier — reasoning-capable. The o-series and the gpt-5 flagship outrank a
# generic *reasoning* substring, or a small Phi-4-reasoning slot beats o1 on an
# account that has both (measured).
aoai_pick_strong() {
  aoai_pick_by_rank "$(aoai_chat_pool_main "$1")" \
    '(^|[^a-z0-9])o3([^a-z0-9]|$)' '(^|[^a-z0-9])o1([^a-z0-9]|$)' '(^|[^a-z0-9])o4([^a-z0-9]|$)' \
    'gpt-5[.]6' 'gpt-5[.]5' 'gpt-5[.]4' 'gpt-5[.]2' 'gpt-5[.]1' 'gpt-5' \
    'deepseek-r1' 'reasoning' 'deep-research' 'gpt-4[.]1' 'gpt-4o'
}

# Embeddings — largest/newest first.
aoai_pick_embed() {
  aoai_pick_by_rank "$1" 'text-embedding-3-large' 'text-embedding-3-small' 'text-embedding-ada' 'embedding'
}
