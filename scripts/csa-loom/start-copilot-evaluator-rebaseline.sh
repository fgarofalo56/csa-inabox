#!/usr/bin/env bash
# Start a corpus re-baseline execution of the `loom-copilot-evaluator` Container
# App Job, wait for it, and classify the outcome.
#
# EXTRACTED (#4586) from the `post-deploy-evals` job of
# `.github/workflows/full-app-deploy-commercial.yml`, where it was a 633-line
# inline `run:` block of 38,355 UTF-8 bytes. GitHub refused to LOAD the whole
# workflow because of that one step's size, which produced 12 consecutive
# 0-job `failure` runs on the canonical from-scratch app path from 2026-09-18
# onward — a P0 under `.claude/rules/deploy-integrity.md` R1. A file can also
# be linted and unit-tested; a 633-line inline block can be neither.
#
# NOTE for future editors: no comment line here may BEGIN with the word
# "shellcheck" after the `#`, because ShellCheck reads that as a directive and
# fails the file with SC1073. That is not hypothetical — the first draft of
# this header wrapped onto a line starting `# shellcheckable`, and `shellcheck
# -S warning` rejected it.
#
# ENV CONTRACT. Actions `${{ }}` expressions do NOT expand inside a called
# script, so the two values the inline block interpolated are now passed in by
# the step's `env:` block. Passing them is not optional plumbing — without them
# this script would build a malformed ARM resource id:
#
#   LOOM_EVAL_RG   <- ${{ needs.resolve.outputs.rg }}
#   LOOM_EVAL_SUB  <- ${{ inputs.subscription || secrets.AZURE_SUBSCRIPTION_ID }}
#
# Two deliberate, disclosed differences from the block this replaces — both
# strictly fail-closed, neither reachable on a well-formed run:
#
#   1. Each variable is REQUIRED and non-empty (`${VAR:?}`). The inline form
#      would have silently interpolated an empty string and then asked ARM for
#      `/subscriptions//resourceGroups//providers/...`, whose 4xx names the
#      wrong cause (`deploy-integrity.md` R7).
#   2. The values arrive through the environment rather than being pasted
#      inside single quotes, so a value containing a `'` can no longer
#      terminate the quoting and splice shell.
#
# Everything from `JOB=loom-copilot-evaluator` down is byte-identical to the
# `run:` block it replaced.
set -euo pipefail

: "${LOOM_EVAL_RG:?LOOM_EVAL_RG is required (resource group; the workflow maps needs.resolve.outputs.rg into it)}"
: "${LOOM_EVAL_SUB:?LOOM_EVAL_SUB is required (subscription id; the workflow maps inputs.subscription || secrets.AZURE_SUBSCRIPTION_ID into it)}"
RG="$LOOM_EVAL_RG"
SUB="$LOOM_EVAL_SUB"
JOB=loom-copilot-evaluator
JOB_ID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/jobs/$JOB"
API=2024-03-01

# RESPONSE-SOURCED TEXT NEVER BEGINS A LINE. The runner reads a
# workflow command off a line that begins with `::` AFTER LEADING
# WHITESPACE HAS BEEN TRIMMED, so a `\n` inside a value that came out
# of a RESPONSE BODY is an injection primitive (`::add-mask::`,
# `::stop-commands::`) and this repo is public.
#
# "AFTER TRIMMING" is a CORRECTION to what rounds 4 and 5 of this PR
# said, recorded rather than quietly swapped. Round 5 wrote the rule
# as "never reaches COLUMN 1" and mitigated two sites by INDENTING
# them. That mitigates nothing: actions/runner
# src/Runner.Common/ActionCommand.cs:62-64 is
#     message = message.TrimStart();
#     if (!message.StartsWith(_commandKey)) { return false; }
# which removes exactly the spaces an indent adds.
#
# Round 5 also declined to claim that the runner command-parses
# STDERR, on the grounds that it had only established public-log
# publication. It DOES command-parse stderr:
# src/Runner.Worker/Handlers/ScriptHandler.cs:332-336 gives stdout
# AND stderr an `OutputManager` each, both constructed with the SAME
# `ActionCommandManager`; OutputManager.cs:83 hands any line
# containing `::` (or `##[`) to ActionCommandManager.cs:70-71. So
# every `>&2` in this step is a command sink, not just a log sink.
# Lifted from actions/runner source rather than transcribed, and
# pinned by scripts/ci/__tests__/workflow-command-injection.test.mjs
# so a regression here goes red in `guardrails`.
#
# NOT gated by ACTIONS_ALLOW_UNSECURE_COMMANDS. Only `set-env` and
# `add-path` consult that flag (ActionCommandManager.cs:244 and :463,
# the only two reads). `add-mask`, `stop-commands`, `add-matcher` and
# `error` are live in a default runner — enough to suppress every
# later annotation, forge `::error::`, and mask arbitrary strings out
# of a public run log. `notice` is NOT in that list: it carries a
# second gate at ActionCommandManager.cs:75-79, which drops it unless
# the server sets `DistributedTask.EnhancedAnnotations`.
#
# `jq -r` DECODES `\n` in a JSON string and `$( )` strips only
# TRAILING newlines, so an embedded one survives into `echo` and
# begins a line of its own. Measured, not reasoned about — round 4
# shipped exactly that on the off-origin arm and on the `::notice::`
# that names the execution; both are in the round-5 receipt with the
# pre-fix output.
#
# The repo already holds this rule on the TypeScript side
# (`lib/util/log-safe.ts`, enforced by `scripts/ci/check-log-injection.mjs`),
# and that guard states its own scope honestly: `app/api` and
# `app/auth`. A workflow `run:` block is outside it, which is how
# this shipped. Tracked as #4576; the fix here is at the sites.
#
# THE FORM SPACE, enumerated — because rounds 5, 6 and 7 each fixed
# ONE CELL of it and shipped believing they had fixed the class. The
# runner has TWO command forms and a payload can reach either through
# several delivery shapes; a mitigation is only complete when it
# covers the whole cross-product.
#
#   Form A `::cmd::`  TryParseV2 — TrimStart() THEN StartsWith("::").
#                     Needs the payload at the START of a runner line.
#   Form B `##[cmd]`  TryParse   — unanchored IndexOf (cs:132).
#                     Needs NOTHING; anywhere in the line will do.
#
#   delivery shape        | Form A | Form B | closed by
#   ----------------------+--------+--------+---------------------------
#   anchored at column 1  | YES    | YES    | the `az> ` prefix  (round 5)
#   leading whitespace    | YES    | YES    | ditto — a NON-space marker,
#                         |        |        |   which TrimStart cannot eat
#   split by an LF        | YES    | YES    | prefix is per-sed-line, and
#                         |        |        |   sed DOES split on LF
#   split by a bare CR    | YES    | YES    | `s|\r|%0D|g`       (round 7)
#   unanchored, mid-line  | n/a    | YES    | `s|##\[|## [|g`    (round 8)
#
# Nine reachable cells; Form A cannot use the mid-line shape at all,
# because TryParseV2 tests StartsWith after trimming. ROUND 8 is the
# last column's last row: `##[` needs neither a line start nor a line
# break, so NEITHER the prefix NOR the CR rewrite touches it, and two
# site classes in this step were publishing response-derived text with
# no `##[` expression at all (arm_get's `$url` echoes, and jq's own
# stderr). Both are closed below.
#
# ONE rule, two shapes — and BOTH shapes now cover all nine cells.
# They differ only in what they preserve:
#   `flatten`     a value going INTO a line we compose. LF and CR to
#                 SPACES (so no split shape survives), `##[` broken,
#                 capped at 400 chars. The cap is deliberate: the
#                 value is attacker-chosen in LENGTH as well as in
#                 content, and an unbounded echo is a log flood.
#   `defuse_cmds` a whole STREAM that must keep its full shape for
#                 triage (az's own stderr, jq's own stderr). Truncates
#                 nothing; rather than MOVING a leading `::` it puts a
#                 NON-whitespace marker in front of it, which
#                 `TrimStart()` has nothing to do with.
# A value interpolated mid-line into text of ours that does not begin
# `::` cannot reach Form A at all — but `flatten` does not lean on
# that, because the coupling would break the first time someone moved
# the interpolation to the front of a line.
#
# A BARE CR IS A RUNNER LINE TERMINATOR, AND `sed` DOES NOT SPLIT ON
# ONE. That disagreement is why the CR expression comes FIRST and is
# load-bearing, not tidying. ProcessInvoker.cs:511 reads a step's
# output with `StreamReader.ReadLine()`, and TextReader defines a
# line as terminated by a carriage return (0x0D) as well as by LF,
# CRLF or EOF (dotnet-api-docs, xml/System.IO/TextReader.xml:1096).
# `sed` splits on LF only, so ONE 0x0D inside a sed line becomes TWO
# runner lines and `s|^|az> |` prefixes only the first of them:
#
#   in   : ERROR: bad<CR>::add-mask::AAAAAAAAAAAA
#   sed  : az> ERROR: bad<CR>::add-mask::AAAAAAAAAAAA   <- one prefix
#   runner ReadLine(): ["az> ERROR: bad",
#                       "::add-mask::AAAAAAAAAAAA"]     <- PARSED
#
# So the CR is rewritten to the literal text `%0D` BEFORE the anchor
# runs, which makes the runner's line count equal sed's and the `^`
# prefix reach every line the runner will actually see. Rewritten,
# not DELETED: deleting it would silently join two genuine az lines,
# which is the truncation this function exists to avoid. `%0D` is the
# runner's own escape for CR (ActionCommand.cs:12), so it reads
# correctly to anyone who knows the format. REVERSIBLE, not
# "lossless": the mapping is not injective, because an az diagnostic
# that genuinely contained the three characters `%0D` is now
# indistinguishable from one that contained a CR. That costs nothing
# in fact and the weaker word is the true one.
flatten() {       # stdin -> ONE line, <=400 chars, no command in ANY form
  tr '\n\r' '  ' | sed 's|##\[|## [|g' | cut -c1-400
}
defuse_cmds() {   # stdin -> same text, no line that can BE a command
  sed -e 's|\r|%0D|g' -e 's|^|az> |' -e 's|##\[|## [|g'
}
# jq's OWN stderr is response-derived and was being published raw at
# every call site in this step. Measured on jq 1.8.2: the
# `Cannot iterate over <type> (<value>)` family embeds the offending
# RESPONSE VALUE verbatim —
#     jq: error (at job.json:0): Cannot iterate over string ("##[stop-commands]x9f2a1")
# — which is Form B, mid-line, and reaches the parser through the
# unanchored IndexOf. The `Cannot index <type> with string ("key")`
# family embeds our own KEY and the `error("literal")` and parse-error
# families embed nothing, so TODAY only the override build below is
# demonstrably live. jq's message catalogue is not a pinned contract
# and this runner does not pin a jq version, so every call is wrapped
# rather than the one that was measured — closing this at the SITES
# and not at the LABEL (assertion-design.md).
#
# Deliberately NOT `2>/dev/null`: the three annotations below say
# "jq's own message is on stderr above" and that must stay TRUE.
# `jq_err.txt` is distinct from `arm_err.txt` so a jq failure cannot
# overwrite the ARM diagnostic an annotation is about to quote.
#
# jq's lines therefore come out carrying `defuse_cmds`' `az> ` marker.
# That marker means "output of a subprocess this step ran, and NOT a
# workflow command" — it is not a claim about which subprocess. Noted
# rather than given a second spelling: two markers means two seds, and
# the second one is the one that drifts.
jq_defused() {    # jq, with its own stderr routed through defuse_cmds
  local ok=0
  if jq "$@" 2> jq_err.txt; then ok=1; fi
  defuse_cmds < jq_err.txt >&2
  [ "$ok" = 1 ]
}

# Bounded retry for a genuinely transient ARM answer (deploy-integrity
# R6). Fails CLOSED on exhaustion: this returns 1 and BOTH callers turn
# that into `::error::` + exit 1, never a warning. It is deliberately
# not used to decide absence — see the next block for why.
#
# ARM's own stderr is captured to a file and then re-emitted (NOT
# discarded — no `2>/dev/null` anywhere here), so the caller can put
# the real cause on the ANNOTATION rather than leaving a 429 and a 403
# reading identically. Classifying by that text instead would be the
# bare-substring misclassification this repo has been bitten by, so the
# STATUS is what routes and the TEXT is only reported. It goes through
# `defuse_cmds` rather than `cat`: it is response-derived, and it is
# re-emitted in FULL because a truncated az diagnostic is the thing
# this block exists to stop losing.
#
# `$url` IS RESPONSE-DERIVED AND IS DEFUSED BEFORE IT IS ECHOED. Round
# 5 stopped echoing the `nextLink` this step REJECTS; it went on
# echoing the one it ACCEPTS, raw, on both diagnostics below. The
# justification here used to be "the control-character arm has already
# rejected it, so it cannot carry a newline". That half is TRUE and
# still holds — and it is not the whole rule, because a mid-line `##[`
# needs no newline (see the form-space table at the top of this step).
# Measured: a `nextLink` of
#   https://management.azure.com/subscriptions/s/jobs?api-version=1##[stop-commands]x9f2a1
# passes BOTH the `[[:cntrl:]]` arm and the origin glob, with positive
# controls proving each of those guards bites.
#
# Closed in two places, on purpose. Here the value is `flatten`ed, so
# the sink is safe whatever reaches it; at the refusal `case` below a
# `nextLink` carrying `##[` is REFUSED outright, so the value never
# travels. Either alone would do; both means loosening one does not
# silently re-open the other. The 400-char cap is the cost, and it is
# accepted: a truncated URL still identifies the page, and the length
# of this value is attacker-chosen too.
arm_get() {   # arm_get <url> <outfile>  ->  0 = read it, 1 = did not
  local url="$1" out="$2" n=0 safe_url
  # Assigned on its own line, not in the `local` list: `local x=$(…)`
  # takes `local`'s exit status and would swallow a failure here.
  safe_url="$(printf '%s' "$url" | flatten)"
  : > arm_err.txt
  while :; do
    n=$((n + 1))
    if az rest --method get --url "$url" > "$out" 2> arm_err.txt; then
      return 0
    fi
    defuse_cmds < arm_err.txt >&2
    if [ "$n" -ge 3 ]; then
      echo "ARM GET failed on all $n attempts: $safe_url" >&2
      return 1
    fi
    echo "ARM GET failed (attempt $n/3), retrying in $((n * 10))s: $safe_url" >&2
    sleep $((n * 10))
  done
}
arm_err() {   # the last ARM error, flattened for an annotation
  local e
  # GUARDED, so this function needs no exclusion from the bare-
  # assignment audit next door. It WAS bare, and was excluded along
  # with the other wrapper bodies -- but unlike `arm_get`, whose
  # exclusion is made sound by an assertion pinning that every call
  # site sits in an `if` condition, this one was excluded with
  # nothing pinning why it held. The exclusion happened to be true
  # (all three call sites are `echo "... $(arm_err) ..."`, argument
  # position, where the status never reaches errexit) and nothing
  # would have noticed if a caller moved. Guarding the assignment
  # removes the exclusion instead of documenting it, so the audit
  # now covers this body like any other line.
  if ! e="$(flatten < arm_err.txt)"; then e=""; fi
  echo "${e:-<az produced no stderr>}"
}

# ABSENCE IS NOT UNREADABILITY -- the same distinction OP-19 (a) exists
# to make in scripts/csa-loom/check-retired-function-timers.sh, applied
# here because this step used to break it. An earlier revision GET the
# job directly and collapsed EVERY failure into one warning + exit 0:
# measured against a stubbed `az rest`, a 404 (genuinely absent), a 429
# (ARM throttling) and a 403 (deploy identity lost read) produced the
# SAME green warning. A 403 therefore meant the re-baseline silently
# never ran, deploy after deploy -- the deploy-integrity R3 invisibility
# shape, committed one file away from the fix that removes it.
#
# So resolve absence against a LISTING, never against a failed GET. A
# list that fails is unreadability (error, exit 1); a list that
# succeeds WITHOUT the job is genuine absence (warning, exit 0). The
# listing is the discriminator precisely because it answers with an
# empty COLLECTION when the job is gone and non-zero when ARM is
# unreachable. A COLLECTION, not a page — see the pagination block
# below, which is the second half of that sentence and was missing.
#
# This is the same rule scripts/ci/_arm-absence.mjs holds for the
# sovereign estate preflights, and deliberately NOT a third inline copy
# of its error-code classifier: that helper is a Node module and this is
# a `run:` block, so instead of re-deriving "which az error means
# absent" this step never asks. It gates on the STATUS and lets a
# SUCCESSFUL listing answer the absence question, which sidesteps the
# trap that helper documents — `az` emitting a well-formed empty `[]` on
# stdout alongside a non-zero exit and a ResourceGroupNotFound. Arm 7 of
# the receipt is exactly that case and it exits 1, not 0.
# A PAGE IS NOT A LISTING. `az rest --method get` is a raw HTTP
# passthrough: it hands back exactly the page ARM returned and does
# NOT follow `nextLink`, so `.value` is ONE page. A 200 carrying a
# `nextLink` answers with a PARTIAL array while the job is present,
# and a page-1-only reader cannot tell that from "gone" — it is green,
# it is false, and the re-baseline silently never runs. That is the
# SAME deploy-integrity R3 invisibility this block removes from the
# failed-GET path, arriving through the pagination door instead of the
# error door. What makes it fail: a `nextLink` key on page 1.
#
# Not a hypothetical wire shape — measured live on ARM in this repo and
# recorded at scripts/ci/check-file-size.mjs:255 (#4432): Cognitive
# Services `Accounts_List` is RBAC-filtered PER PAGE, and page 1 came
# back HTTP 200 with `value: []` and a `nextLink` while the
# subscription held three accounts, so every model picker rendered
# empty with no error because nothing had failed.
#
# The remedy is the one already in the tree: `armListAll()` at
# apps/fiab-console/lib/azure/foundry-cs-client.ts — a BOUNDED walk
# (page cap, deadline, cycle guard, origin check before the token
# travels). It is TypeScript inside the console, behind `@/` path
# aliases and the console's own `armFetch`/`token()`, so a `run:`
# block cannot call it. This is therefore a SECOND implementation of
# that rule and says so rather than being a silent one; the two bounds
# below are its MAX_ARM_PAGES and MAX_ARM_PAGING_MS.
#
# Where it DIVERGES it diverges STRICTLY, and deliberately.
# `armListAll()` `break`s out of the walk on a cap, deadline, cycle or
# off-origin hop and returns what it has, because its consumer is a
# picker that degrades. THIS consumer asserts ABSENCE, and a partial
# collection cannot support that claim — so each of those is
# `::error::` + exit 1 here, never a shorter list and never an
# absence.
#
# That claim was FALSE as written in round 4, at one site, and is
# recorded rather than quietly corrected. The off-origin annotation
# echoed the rejected `nextLink` verbatim — LOOSER than
# `same-origin-url.ts`, which refuses to reflect it, and looser on
# exactly the property that module exists to hold. It is not echoed
# now; see the never-begins-a-line rule at the top of this step.
#
# ORIGIN CHECK. `nextLink` is attacker-shaped: an absolute URL read
# out of a RESPONSE BODY, to which `az rest` would attach a
# management-plane bearer token. lib/util/same-origin-url.ts explains
# why `startsWith(base)` is NOT a host check — both
# `https://management.azure.com.evil.test/x` and
# `https://management.azure.com@evil.test/x` pass a bare prefix test.
# The `case` glob below demands the character AFTER the literal base
# be `/`, which is the authority TERMINATOR: `.` and `@` are not `/`,
# and neither are `:` (port), `?`, `#` or `\`. So the authority is
# exactly $ARM_BASE's for any parser that ends the authority at one of
# those. $ARM_BASE is also the literal $LIST_URL is built from, so the
# endpoint has one spelling in this step rather than two that can
# drift.
#
# The glob is also CASE-SENSITIVE and ABSOLUTE-ONLY, which the
# enumeration above does not imply: `https://MANAGEMENT.AZURE.COM/x`
# and a relative `/subscriptions/…` `nextLink` are both refused. ARM
# emits neither, and refusing is the closed direction, so that is
# stated for completeness rather than defended.
#
# UNCOVERED, stated rather than asserted away: the glob checks the
# URL this step ASKS FOR, not the host `az rest` ENDS AT. The CLI
# follows redirects, and whether its transport strips `Authorization`
# across a host change was not established here — so this check
# bounds the first hop only, and does not claim more.
ARM_BASE=https://management.azure.com
MAX_PAGES=50            # armListAll() MAX_ARM_PAGES
MAX_PAGING_SECONDS=60   # armListAll() MAX_ARM_PAGING_MS
LIST_URL="$ARM_BASE/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/jobs?api-version=$API"
PAGE_URL="$LIST_URL"
SEEN_LINKS="|$LIST_URL|"
PAGING_STARTED=$SECONDS
PAGES=0
TOTAL=0
MATCH=0
while : ; do
  PAGES=$((PAGES + 1))
  if ! arm_get "$PAGE_URL" jobs.json; then
    echo "::error::Could not LIST Container App Jobs in $RG (page $PAGES) after 3 attempts, so this run established NOTHING about whether $JOB exists and it is NOT reported as absent. ARM said: $(arm_err) — a 429/5xx is transient (it was already retried), a 403 means the deploy identity lost Reader on $RG, a 404 means the resource group itself is gone. Post-deploy eval re-baseline NOT started."
    exit 1
  fi

  # A parse that yields nothing is also not an absence. Require the
  # collection SHAPE before concluding anything from its contents —
  # and count the matches in the SAME guarded jq. The previous
  # revision counted in a bare `MATCH=$(jq …)`: on a `.value` of
  # non-objects that died at rc=5 with no annotation, and its
  # `MATCH=${MATCH:-0}` default was unreachable (a `length` filter
  # always emits a number, and errexit killed the bare assignment
  # before any default could apply).
  #
  # The element-type arm is why this is an `elif` and not a typed
  # `select(...)`: a `select` that SKIPS non-objects turns
  # `{"value":[1,2]}` into "two jobs, neither matching" — a false
  # ABSENCE, which is fail-OPEN and strictly worse than the rc=5 it
  # replaced. Measured on arm P7 while writing this. An array of
  # non-objects is not a job collection, so it errors like any other
  # unparseable listing. An EMPTY array still passes (`any` over
  # nothing is false), because an empty page is legitimate.
  # `$n` below is a JQ variable bound by `--arg n`, not a shell one,
  # so the single quotes are REQUIRED. shellcheck recognises `jq` and
  # knows its argument is a program; it does not recognise
  # `jq_defused`, so the wrapper costs one SC2016 directive at each
  # call site. That is the whole cost of routing jq's own stderr
  # through defuse_cmds, and it is paid at the SITE rather than by
  # widening the actionlint ratchet baseline.
  # shellcheck disable=SC2016
  if ! PAGE_COUNTS=$(jq_defused -er --arg n "$JOB" '
         if (.value | type) != "array" then error("no .value array")
         elif (.value | map(type) | any(. != "object")) then error("not a job collection")
         else "\(.value | length) \([.value[] | select(.name == $n)] | length)" end' jobs.json); then
    echo "::error::The job listing for $RG returned 200 on page $PAGES but is not a job collection (.value is not an array, or not an array of objects), so absence cannot be concluded from it. jq's own message is on stderr above. Post-deploy eval re-baseline NOT started."
    exit 1
  fi
  TOTAL=$((TOTAL + ${PAGE_COUNTS%% *}))
  MATCH=$((MATCH + ${PAGE_COUNTS##* }))

  if ! NEXT=$(jq_defused -r '.nextLink // "" | tostring' jobs.json); then
    echo "::error::The job listing for $RG returned 200 on page $PAGES but its nextLink could not be read, so the collection was not fully walked and absence cannot be concluded from it. Post-deploy eval re-baseline NOT started."
    exit 1
  fi
  [ -n "$NEXT" ] || break

  # Past this line the collection is INCOMPLETE, so every exit below
  # is an error and none of them is an absence: a walk that stopped
  # early cannot tell "not in the collection" from "not in the part
  # that was read".
  #
  # That reason is about ABSENCE, and it stops applying once
  # MATCH > 0 — at which point a late page failure costs a
  # re-baseline that could have run. Kept fail-closed on purpose:
  # continuing past a read failure would mean starting the job from
  # a collection this step cannot describe, and the cost is one
  # re-dispatch. Named here so the next reader does not have to
  # re-derive that it was a choice.
  #
  # A URL cannot contain a control character, and a shell `*` DOES
  # match a newline — so without this first arm a `nextLink` carrying
  # the right prefix passes the origin glob below, reaches
  # `az rest --url`, and its embedded `\n::add-mask::…` BEGINS a line
  # of its own in arm_get's diagnostics. Measured.
  #
  # The SECOND arm is round 8's, and it is the other command form: a
  # `##[` token needs no line break at all, so the control-character
  # arm does not see it and a mid-line `##[stop-commands]…` rode an
  # ACCEPTED nextLink into arm_get's echoes. An ARM `nextLink` never
  # contains one, and refusing is the closed direction. Kept as a
  # separate `case` from the control-character arm so the two
  # annotations can name different causes — an operator reading
  # "control character" when the value carried `##[` is the
  # bare-substring misclassification this repo has been bitten by.
  #
  # `::` is deliberately NOT refused here: the sinks compose it into
  # text of theirs that does not begin `::`, so Form A is unreachable
  # for it, and a skip token containing `::` would be a legitimate
  # value to refuse wrongly. The sink-side `flatten` is what makes
  # that safe to leave alone.
  case "$NEXT" in
    *[[:cntrl:]]*)
      echo "::error::The job listing for $RG handed back a nextLink containing a control character at page $PAGES, which is not a URL. Refusing to fetch it, and refusing to conclude absence from the $TOTAL job(s) read so far. The value is NOT echoed — it is attacker-chosen. Post-deploy eval re-baseline NOT started."
      exit 1 ;;
  esac
  case "$NEXT" in
    *'##['*)
      echo "::error::The job listing for $RG handed back a nextLink containing the sequence '##[' at page $PAGES. That is not a URL ARM emits, and it is the runner's unanchored workflow-command prefix (ActionCommand.cs:132), so it is refused rather than carried into a diagnostic. Refusing to conclude absence from the $TOTAL job(s) read so far. The value is NOT echoed — it is attacker-chosen. Post-deploy eval re-baseline NOT started."
      exit 1 ;;
  esac
  case "$NEXT" in
    "$ARM_BASE"/*) ;;
    *)
      echo "::error::The job listing for $RG handed back a nextLink that is not on $ARM_BASE at page $PAGES. Refusing to carry a management-plane token off-origin, and refusing to conclude absence from the $TOTAL job(s) read so far. The rejected value is NOT echoed: it is attacker-chosen, and lib/util/same-origin-url.ts declines to reflect one for exactly that reason. Post-deploy eval re-baseline NOT started."
      exit 1 ;;
  esac
  case "$SEEN_LINKS" in
    *"|$NEXT|"*)
      echo "::error::The job listing for $RG repeated a nextLink at page $PAGES — that is a cycle, not progress, so the collection was not fully walked and absence cannot be concluded from the $TOTAL job(s) read so far. Post-deploy eval re-baseline NOT started."
      exit 1 ;;
  esac
  SEEN_LINKS="$SEEN_LINKS|$NEXT|"
  if [ "$PAGES" -ge "$MAX_PAGES" ]; then
    echo "::error::The job listing for $RG is still paginating after $MAX_PAGES page(s) ($TOTAL job(s) read). The collection was not fully walked, so absence cannot be concluded from it. Post-deploy eval re-baseline NOT started."
    exit 1
  fi
  # WALL-CLOCK, and that deliberately INCLUDES arm_get's backoff: a
  # single transient page can burn 10s (one retry) or 30s (two)
  # before this line is next consulted, so one 429 on a genuinely
  # multi-page RG can spend half the budget without turning a page.
  # It is a bound on how long this step may take, not on how long
  # paging may take, and it fails closed either way — but it means a
  # "passed 60s" red is a plausible transient outcome and not proof
  # of an unbounded listing.
  if [ "$((SECONDS - PAGING_STARTED))" -ge "$MAX_PAGING_SECONDS" ]; then
    echo "::error::Walking the job listing for $RG passed ${MAX_PAGING_SECONDS}s at page $PAGES ($TOTAL job(s) read). The collection was not fully walked, so absence cannot be concluded from it. Post-deploy eval re-baseline NOT started."
    exit 1
  fi
  PAGE_URL="$NEXT"
done

# Only now can absence be asserted, and the cause list is narrower than
# it used to be BECAUSE it can be: every read-failure cause was just
# routed to the error path above, so the causes that survive here are
# exactly the configuration ones. The job is deployed only when ALL
# THREE conjuncts of `copilotEvaluatorActive` hold
# (admin-plane/main.bicep:8735):
#   copilotEvaluatorEnabled && containerPlatform == 'containerApps'
#                           && deployAppsEnabled
# so absence here is a legitimate configuration state and NOT a deploy
# failure -- but it is reported as absence, never as a skipped success.
# R7: name every cause that can actually hold, and do not assert which
# one does.
if [ "$MATCH" -eq 0 ]; then
  echo "::warning::Container App Job $JOB is absent from a successful listing of $RG — the WHOLE collection was walked ($TOTAL job(s) across $PAGES page(s), with no nextLink left unfollowed), which is what makes this an absence rather than a truncated page. This run did not establish WHICH cause applies; any of these will produce it — functionAppsConfig.copilotEvaluatorEnabled=false (opt-out), containerPlatform != 'containerApps' (the job is Container-Apps-only), or deployAppsEnabled=false. Post-deploy eval re-baseline NOT started. Each of those causes means the job does not exist, so there is no nightly schedule for this step to have affected; if the job is later deployed, its schedule comes from bicep and nothing here changed it."
  exit 0
fi

# The job IS in the listing. From here a failed GET can only be
# unreadability -- absence has already been excluded by the line above,
# which is the whole point of doing it in that order. The one residual
# is a TOCTOU the run genuinely cannot close: a job listed at T0 and
# DELETED before this GET answers 404, and this step calls that
# unreadable. The window is milliseconds and the direction is closed
# (error, never a silent absence), so the sentence names the
# possibility rather than asserting a cause it did not establish.
if ! arm_get "https://management.azure.com${JOB_ID}?api-version=$API" job.json; then
  echo "::error::$JOB IS present in the $RG listing but its own GET failed after 3 attempts — that is unreadable, not absent (or, in the millisecond window between the two calls, deleted; this run cannot tell those apart and does not claim to). ARM said: $(arm_err). Post-deploy eval re-baseline NOT started."
  exit 1
fi

# A start REPLACES the execution template, so build the override FROM
# the job's current containers. An empty container list means the image
# has never been built — that is a real gap, not a quiet no-op.
#
# FIVE call sites use `jq_defused`; this was the only unguarded one.
# The other four wrap it as `if ! X=$(...)`, which puts the call in an
# `if` CONDITION and so suppresses errexit. This one was a BARE
# assignment, so under `set -euo pipefail` a malformed `job.json` made
# jq exit non-zero and killed the step AT THE ASSIGNMENT — the
# `::error::` below never printed and the log carried only
# `az> jq: parse error: ...`. Measured side by side: the empty-body arm
# reached the annotation (`COUNT=[0]`); the malformed arm did not.
#
# Worse, the annotation itself asserted "an empty or malformed body
# reads the same way here", which was false for precisely the half that
# produced no message at all — R6 (a failure whose only output is a
# parse error) and R7 (a message claiming what the code did not
# establish), in the same three lines. Four of five sites closed is the
# exact pattern this step's own header audit exists to prevent.
#
# The two are now genuinely distinguished, because they are different
# failures and the operator needs different things from each.
if ! COUNT=$(jq_defused '(.properties.template.containers // []) | length' job.json); then
  echo "::error::Could not PARSE the job GET for $JOB — the JSON parse of job.json failed, so the container list was never read. That is a malformed or truncated response body, NOT an empty container list; this run DID establish which, and it is the former. Retry the step; if it repeats, the ARM response itself is bad. No execution was started."
  exit 1
fi
# Still load-bearing after the guard above: on a 200-with-EMPTY body jq
# exits 0 having emitted nothing, so COUNT is empty and `[ "" -eq 0 ]`
# would raise "integer expected". That error sits in an `if` CONDITION,
# where errexit is suppressed and it reads as FALSE — so the guard this
# comment calls a real gap would be SKIPPED and the step would exit 0
# with a notice. Same shape as the EXEC default below.
COUNT=${COUNT:-0}
if [ "$COUNT" -eq 0 ]; then
  echo "::error::No container template could be read for $JOB from its GET. The body PARSED and its container list is empty — so if the job is deployed, its image has not been built/pushed and no execution can start. Build it with scripts/csa-loom/deploy-copilot-evaluator-job.sh. No execution was started."
  exit 1
fi

# The same four knobs the Console's "Run now" sets
# (lib/azure/copilot-evaluator-client.ts mergeRunEnv). Empty SURFACES =
# every surface, which is what the retired per-surface loop covered.
#
# The strip list is DERIVED from the override list ($ovn), exactly as
# mergeRunEnv derives it (`!overrides.some((o) => o.name === e.name)`),
# so THE STRIP LIST CANNOT DRIFT FROM THE OVERRIDE LIST. An earlier
# revision stripped every `COPILOT_EVAL_*` by prefix, which is NOT what
# mergeRunEnv does: a fifth COPILOT_EVAL_* added to
# copilot-evaluator-job.bicep would have been dropped here while "Run
# now" kept it — the two start paths diverging exactly where this
# comment promises they cannot. Benign at the time (the live job
# carries exactly two, MODE and TRIGGER, both in the four), which is
# why only the contract, not a symptom, catches it.
#
# What that claim does NOT cover, stated so the comment is not
# overread: this `$ov` and the TS `overrides` are two independent
# literals in two languages, and nothing in CI compares them. Adding a
# fifth override KNOB to mergeRunEnv does not reach this jq. That
# residual is #4566, not this block.
# GUARDED, for the reason the LISTING body already is. Round 4
# shape-checked the listing and left its sibling one guard
# downstream: a job body whose `containers` are not objects (measured
# with `containers:["c"]`) died at rc=5 carrying only jq's stack
# trace and ZERO annotations — a start that did not happen and said
# nothing, which deploy-integrity R6 forbids in those words. Closing
# a finding at the LABEL and not at every SITE is the specific error;
# this is the site.
# `$ov`/`$ovn` below are JQ variables bound by `as $ov` / `as $ovn`,
# not shell ones — same reason as the listing jq above.
# shellcheck disable=SC2016
if ! jq_defused -c '[{name:"COPILOT_EVAL_MODE",value:"copilot"},
        {name:"COPILOT_EVAL_TRIGGER",value:"corpus"},
        {name:"COPILOT_EVAL_SURFACES",value:""},
        {name:"COPILOT_EVAL_DOMAINS",value:""}] as $ov
       | ($ov | map(.name)) as $ovn
       | {containers: [.properties.template.containers[]
         | .env = ((.env // []) | map(select(.name | IN($ovn[]) | not))) + $ov]}' \
       job.json > override.json; then
  echo "::error::$JOB IS present, but the execution override could not be built from its GET body — .properties.template.containers is not a list of container objects, so this run cannot describe what it would start. jq's own message is on stderr above. NO execution was started and the re-baseline did NOT run."
  exit 1
fi

# The one WRITE in this step, and the only `az` here that mutates
# anything. GUARDED for the same reason the script's `--apply` write
# is (check-retired-function-timers.sh): a bare `az rest --method
# post` under errexit exits non-zero carrying ONLY az's own text, and
# deploy-integrity R6 requires a permission failure to name the exact
# action and scope. The step header promises a start that did not
# happen "exits non-zero AND SAYS WHY"; without this wrapper the 403
# arm said only what az said.
#
# The role names are from Microsoft Learn (azure/container-apps/jobs
# §Permissions), not from memory: `Microsoft.App/jobs/start/action` is
# carried by the built-in **Container Apps Jobs Operator** and
# **Container Apps Jobs Contributor**.
if ! az rest --method post --url "https://management.azure.com${JOB_ID}/start?api-version=$API" \
     --headers "Content-Type=application/json" --body @override.json > start.json 2> arm_err.txt; then
  defuse_cmds < arm_err.txt >&2
  echo "::error::Could not START $JOB — no execution was created and the re-baseline did NOT run. ARM said: $(arm_err). A 403 here means the deploy identity lacks Microsoft.App/jobs/start/action on ${JOB_ID}; grant it Container Apps Jobs Operator (read/start/stop) or Container Apps Jobs Contributor at that scope. A 429/5xx is transient and this run can simply be re-dispatched; a 404 means the job vanished between the GET above and this POST."
  exit 1
fi
# GUARDED, and deliberately NOT fatal. A bare `EXEC=$(jq …)` exits
# rc=5 under errexit with ZERO annotations (measured with a body of
# `not json at all`), so the operator reads a red step and concludes
# the re-baseline did not run — a claim this run did not establish
# and the opposite of what it did. The MESSAGE is what carries that,
# not the exit code: `exit 1` under this same text would also have
# been truthful, and `continue-on-error: true` on the job (:1274)
# means the only difference is a red step versus a yellow annotation.
# The discriminator is NOT "a non-zero status asserts it did not
# run" — the step header uses the opposite framing eight lines up to
# justify failing closed everywhere else, and both cannot be the
# general rule. It is that this is the ONE arm where the
# deploy-relevant outcome ALREADY SUCCEEDED, so a red step buys
# triage attention for nothing. Say "started, name unreadable", hand
# over a runnable next step, and keep exit 0.
if ! EXEC=$(jq_defused -r '.name // .id // "unknown"' start.json); then
  echo "::warning::$JOB WAS started — the start POST returned success, so an execution IS running — but its 200 body is not readable JSON and this run cannot name the execution. jq's own message is on stderr above. Nothing downstream depends on the name; find the execution with: az containerapp job execution list -n $JOB -g $RG."
  EXEC=unknown
fi
# `.name` comes out of a RESPONSE BODY, so it is subject to the
# never-begins-a-line rule at the top of this step: round 4 emitted
# it raw and a `.name` of "exec-1\n::add-mask::…" started a line with
# an injected command on the SUCCESS path, where nothing looks wrong.
# Flatten before it reaches either the annotation or the job summary.
# Guarded for the same reason as the COUNT read above: a bare
# `VAR="$(cmd | cmd)"` under `set -euo pipefail` dies AT THE
# ASSIGNMENT, so any message below it never prints. Review found this
# one still bare after the COUNT site was fixed — four of five closed,
# again, at a different address.
if ! EXEC="$(printf '%s' "$EXEC" | flatten)"; then
  echo "::error::Could not flatten the execution name for $JOB before emitting it. The start call itself SUCCEEDED — an execution may well be running — but its name could not be made safe to print, so it is deliberately not echoed. Check the job's executions in the portal rather than trusting this step's output."
  exit 1
fi
# `// "unknown"` covers a MISSING key, not an EMPTY body: on an empty
# start.json jq emits nothing and exits 0, leaving EXEC="" and a notice
# reading "execution  started". ACA start answers 200 or 202, and a
# 202-with-no-body is the realistic path — precisely the case the
# default was written for. Empty-but-present is a distinct state from
# absent, so close it here rather than in the jq.
EXEC=${EXEC:-unknown}
echo "::notice::copilot-evaluator execution $EXEC started (mode=copilot trigger=corpus, all surfaces) — scores land in Cosmos loom-copilot-evals; copilot-quality-evals.yml + /admin/copilot-quality read them."
echo "copilot-evaluator re-baseline execution: \`$EXEC\`" >> "$GITHUB_STEP_SUMMARY"
