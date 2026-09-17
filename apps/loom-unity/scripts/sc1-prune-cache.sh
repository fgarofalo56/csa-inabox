#!/bin/sh
# CSA Loom -- loom-unity SC1 hardening (Trivy CRITICAL gate), Java layer.
#
# Prunes the sbt/coursier dependency cache the upstream unitycatalog image ships
# down to the jars its own classpath files actually reference.
#
# WHY
# ---
# unitycatalog/unitycatalog:v0.5.0 bakes the FULL sbt build cache into the
# runtime image: 864 jars, 1.3 GB, under
#   /home/unitycatalog/.cache/coursier/https/maven-proxy.cloud.databricks.com/**
# Only 310 of those are named by the image's eight `classpath` files (the server,
# the CLI, the java/python clients and the sbt sub-project targets) -- the launch
# scripts run `java -cp "$(cat <classpath-file>)"`, so a jar absent from every
# classpath file can never be loaded. The other 554 are build- and TEST-scope
# leftovers (junit, assertj, s3mock, mockito, old bouncycastle, ...) that ship to
# production for no reason.
#
# The SC1 gate found one CRITICAL among them:
#   CVE-2025-14813  org.bouncycastle:bcprov-jdk18on 1.80  (GOSTCTR block handling)
#     at .../org/bouncycastle/bcprov-jdk18on/1.80/bcprov-jdk18on-1.80.jar
# `bcprov` appears in NO classpath file -- neither 1.80 nor the 1.60 pair beside
# it -- so it is dead weight, not a dependency. Upgrading it would be theatre:
# nothing loads it. The fix is removal, matching the disposition the repo already
# uses for unused artifacts (npm in the console image, see .trivyignore).
#
# Pruning the whole unreferenced set rather than just that one jar is deliberate:
# this is a SECURITY-CRITICAL service (it is the Unity-Catalog-compatible
# metastore, and the svc-loom-unity-authz gate exists because the catalog must
# never be reachable anonymously). Shipping 554 unloadable test jars is pure
# latent attack surface and a standing source of future gate failures.
#
# WHY IT IS SAFE BY CONSTRUCTION
# ------------------------------
# The keep-set is not a hand-written list: it is DERIVED at build time from the
# image's own classpath files, so anything the image can load is kept by
# definition. The script then re-reads every classpath file and asserts each
# entry still exists on disk; a single missing entry fails the build.
#
# Nothing about the service's auth or network posture is touched -- no config, no
# entrypoint, no port, no user. Only unreferenced jars are deleted.
#
# Runs from a FILE, never an inline Dockerfile heredoc: ACR Tasks' classic
# builder cannot parse heredocs (they need BuildKit); one builds fine under local
# `docker build` and then dies in CI after ~3s with
#   `failed to run step ID: build: failed to scan dependencies: exit status 1`.

set -eu

UC_HOME="${UC_HOME:-/home/unitycatalog}"
CACHE="${UC_HOME}/.cache/coursier"
# The scratch root. Inside the image build this is one process, one run, and
# /tmp/loom-sc1 is fine. On a HOST harness that spawns the script repeatedly the
# fixed path is a defect: the `rm -rf` below plus the immediately-following
# `mkdir -p` race, and the loser proceeds against a half-deleted directory. That
# produced a RED that read `examples/ was removed despite a live reference` --
# a false failure whose text is the very defect under fix. So the PARENT is
# overridable and the leaf is always appended by this script, which keeps the
# `rm -rf` target a name the script itself chose rather than one it was handed.
case "${SC1_WORK_PARENT:-/tmp}" in
  /*) : ;;
  *)  echo "FATAL: SC1_WORK_PARENT must be an absolute path." >&2; exit 1 ;;
esac
WORK="${SC1_WORK_PARENT:-/tmp}/loom-sc1"
KEEP="${WORK}/keep.txt"
PRESENT="${WORK}/present.txt"
ALL="${WORK}/all.txt"
DROP="${WORK}/drop.txt"
CPFILES="${WORK}/cpfiles.txt"
OTHERS="${WORK}/others.txt"
CPOTHERS="${WORK}/cp-outside-examples.txt"

echo "== SC1 loom-unity cache prune =="
if [ ! -d "$CACHE" ]; then
  echo "FATAL: ${CACHE} does not exist -- the upstream image layout changed. Re-derive the fix." >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK"

# PROBE DISCIPLINE (#4471; deploy-integrity.md R7)
# ------------------------------------------------
# Every probe in this script authorises a deletion, so a probe whose ERROR is
# indistinguishable from its EMPTY RESULT authorises that deletion on a fact it
# never established. That is the exact shape R7 records: a `2>/dev/null` turned a
# permission denial into an empty string, and the empty string into the false
# claim "the tag does not exist".
#
# The original examples guard had all three collapsing layers at once:
#   OTHERS="$(find ... -print0 | xargs -0 grep -l "${EXAMPLES}/" 2>/dev/null || true)"
#   * `grep -l` exits 1 on no-match and >1 on error -- two different facts;
#   * `xargs` maps BOTH onto 123, because it reports 123 for any child exiting
#     1..125, so the distinction is already gone before the shell sees it;
#   * `$?` after a pipeline is the LAST stage's, so find's status was never read;
#   * `2>/dev/null` discarded the only remaining evidence;
#   * `|| true` erased what was left.
# "nothing else references this" and "the probe blew up" were the same
# observation, and `rm -rf "$EXAMPLES"` ran on either.
#
# So, below: no probe runs inside a pipeline whose status belongs to another
# command, no probe discards stderr, and every probe's status is read on its own
# line with `cmd > out 2> err || rc=$?` -- the only form in which `$?` provably
# belongs to the command being judged. Anything that is not an unambiguous
# "completed, and here is the answer" ABORTS. Fail closed; never delete on an
# unestablished fact.
#
# SCOPE OF THAT CLAIM, stated precisely because an earlier revision of this very
# comment overstated it and a reviewer measured the gap. It covers every command
# that INTERROGATES THE FILESYSTEM -- `find` and `grep` -- at every site in this
# file. It does NOT claim the file is pipeline-free: `wc -c < file | tr -d ' '`
# below is a pipeline, and deliberately so. `wc` reading a regular file this
# script just wrote is not a probe of the world; it cannot report "no match" and
# it has no empty-versus-error ambiguity to collapse. Where a local transform
# COULD truncate silently (`tr`, `sed`, the blank filter), a status read is not
# sufficient on its own and each carries an exact arithmetic invariant instead --
# see the keep-set derivation. The distinction that matters is not "pipeline or
# not"; it is whether a failure can masquerade as an answer.

# Abort naming the probe that did not finish, and SHOW its stderr. Deliberately
# worded so it can never be misread as "nothing matched".
probe_failed() { # $1=what  $2=exit status  $3=stderr file
  echo "FATAL: ${1} could not be COMPLETED (exit ${2})." >&2
  echo "       This is NOT 'nothing matched' -- the probe did not finish, so its" >&2
  echo "       empty result establishes nothing and must not authorise a delete." >&2
  if [ -s "$3" ]; then
    echo "       probe stderr:" >&2
    sed 's/^/         /' "$3" >&2
  else
    echo "       probe stderr: (empty -- the probe failed without writing one)" >&2
  fi
  exit 1
}

# Run `find`, reading FIND's own status instead of a pipeline's, surfacing its
# stderr, and writing a newline-delimited list to $1.
#   probe_find <outfile> <description> <find args...>
probe_find() {
  _p_out="$1"
  _p_what="$2"
  shift 2
  _p_rc=0
  find "$@" -print0 > "${WORK}/.probe.z" 2> "${WORK}/.probe.err" || _p_rc=$?
  if [ "$_p_rc" -ne 0 ]; then
    probe_failed "$_p_what" "$_p_rc" "${WORK}/.probe.err"
  fi
  if [ -s "${WORK}/.probe.err" ]; then
    # Completed, but not silently. Surfaced rather than discarded: a warning here
    # is how a half-readable tree becomes visible instead of becoming an answer.
    echo "WARN: ${_p_what} completed (exit 0) but wrote to stderr:" >&2
    sed 's/^/        /' "${WORK}/.probe.err" >&2
  fi
  # A path containing a newline would make the one-per-line form under-report,
  # and a SHORT keep-set deletes MORE. Refuse rather than guess. `find -print0`
  # is kept for exactly this: it makes the ambiguity detectable instead of silent.
  tr -cd '\n' < "${WORK}/.probe.z" > "${WORK}/.probe.nl"
  _p_nl="$(wc -c < "${WORK}/.probe.nl" | tr -d ' ')"
  if [ "$_p_nl" -ne 0 ]; then
    echo "FATAL: ${_p_what} returned a path containing a newline. The line-oriented" >&2
    echo "       keep-set cannot represent it, and a short keep-set deletes MORE." >&2
    exit 1
  fi
  tr '\0' '\n' < "${WORK}/.probe.z" > "$_p_out"
}

# 0) REMOVE THE UPSTREAM EXAMPLES TREE FIRST (#4429).
#
# CVE-2026-75595 (CRITICAL) is reported TWICE on this image. One copy is the
# netty-handler on the server classpath -- upgraded in place by sc1-netty.sh,
# which runs before this script. The other is a netty-handler 4.1.115.Final
# SHADED inside `software/amazon/awssdk/bundle/2.29.52/bundle-2.29.52.jar`, a
# 641 MB AWS SDK fat jar. Measured, against the pinned base:
#   * of the image's EIGHT classpath files, exactly ONE names that jar --
#     examples/cli/target/classpath, the upstream demo CLI launched by bin/uc;
#   * the SERVER classpath does not name it, and neither does any other. The
#     server reaches S3 through the MODULAR awssdk jars (s3, sdk-core,
#     netty-nio-client, ... at 2.24.0/2.27.12), not the bundle;
#   * no surviving classpath file names anything under $UC_HOME/examples at all.
# So the ONLY thing keeping a 641 MB jar with a CRITICAL in the image is a demo
# CLI that the Loom runtime never invokes: the ENTRYPOINT is
# bin/loom-entrypoint.sh -> bin/start-uc-server, and `bin/uc` appears nowhere in
# apps/loom-unity.
#
# REMOVAL, not upgrade, and the precedent is exact. .trivyignore's audit trail
# records npm + npx being DELETED from loom-console / loom-copilot-maf /
# loom-onelake / lineage-extractor for the same reason -- "the runtime never
# invokes a package manager" -- while loom-mcp-bridge, which DOES spawn npx, got
# an in-place upgrade instead. Same shape here: upgrading the bundle would mean
# jumping AWS SDK 2.29.52 -> 2.54.x (the first line whose netty.version is
# 4.1.137.Final, read off the aws-sdk-java-pom parent POMs) and re-downloading
# 641 MB on every build, to keep a demo tool this image does not ship a use for.
#
# bin/uc goes with it. Leaving a launcher that now fails would be worse than
# removing it: the tool is gone, and the image says so.
#
# This is deliberately done BEFORE the keep-set is derived, so the bundle jar
# falls out of the existing, already-justified mechanism as an unreferenced jar
# rather than through a second hand-written deletion path. The assertions below
# then cover it for free.
EXAMPLES="${UC_HOME}/examples"
BUNDLE_GLOB='bundle-*.jar'
if [ -d "$EXAMPLES" ]; then
  # Fail closed if a classpath OTHER than the examples CLI's has started naming
  # the examples tree -- that would make this removal a real regression.
  #
  # #4471: this is the probe that authorises the `rm -rf` below, so it is split
  # into two steps that each own their status. `find` enumerates; then each
  # classpath file is searched on its own so grep's 1 (no match) stays distinct
  # from its >1 (error) instead of being flattened by `xargs` into 123. Only an
  # unambiguous 0 or 1 is accepted as an answer.
  probe_find "$CPOTHERS" "the classpath enumeration OUTSIDE ${EXAMPLES}" \
    "$UC_HOME" -type f -name classpath ! -path "${EXAMPLES}/*"
  # An EMPTY population is not evidence of absence either. A successful walk
  # that found nothing to search would otherwise print "0 classpath file(s)
  # searched, 0 reference ..." and delete on it -- the same absence-over-an-
  # empty-population shape, one step earlier. Step 1 already carries this guard;
  # step 0 lacked it.
  if [ ! -s "$CPOTHERS" ]; then
    echo "FATAL: no classpath file found outside ${EXAMPLES}, so there was nothing to" >&2
    echo "       search. An empty population does not establish that nothing references" >&2
    echo "       the examples tree. Re-derive the disposition." >&2
    exit 1
  fi
  : > "$OTHERS"
  while IFS= read -r _cpf; do
    [ -n "$_cpf" ] || continue
    _g_rc=0
    # -F: the needle is a literal path, never a pattern. -e/--: a path or needle
    # starting with `-` must not become an option. The loop reads from a FILE,
    # not a pipe, so this is not a subshell and `probe_failed`'s exit is the
    # script's exit.
    grep -l -F -e "${EXAMPLES}/" -- "$_cpf" >> "$OTHERS" 2> "${WORK}/.grep.err" || _g_rc=$?
    if [ "$_g_rc" -gt 1 ]; then
      probe_failed "the examples-reference check of ${_cpf}" "$_g_rc" "${WORK}/.grep.err"
    fi
    if [ -s "${WORK}/.grep.err" ]; then
      echo "WARN: examples-reference check of ${_cpf} wrote to stderr (exit ${_g_rc}):" >&2
      sed 's/^/        /' "${WORK}/.grep.err" >&2
    fi
  done < "$CPOTHERS"
  if [ -s "$OTHERS" ]; then
    echo "FATAL: a classpath outside ${EXAMPLES} now references it -- removing the" >&2
    echo "       examples tree would break a live path. Re-derive the disposition." >&2
    cat "$OTHERS" >&2
    exit 1
  fi
  echo "examples-reference check: $(wc -l < "$CPOTHERS") classpath file(s) searched, 0 reference ${EXAMPLES}/"
  rm -rf "$EXAMPLES"
  echo "removed ${EXAMPLES} (upstream demo CLI; carries the 641 MB awssdk bundle)"
else
  echo "FATAL: ${EXAMPLES} does not exist -- the upstream image layout changed, so the" >&2
  echo "       awssdk-bundle disposition no longer matches reality. Re-scan and re-derive" >&2
  echo "       rather than shipping a silent no-op." >&2
  exit 1
fi
rm -f "${UC_HOME}/bin/uc"

# 1) Every classpath file in the image (server, CLI, clients, sub-project targets).
#    #4471: `find ... | sort > "$CPFILES"` read SORT's status, not find's, so a
#    partially-failed walk produced a SHORT classpath list -> a short keep-set ->
#    MORE jars deleted. The `! -s` check below only ever caught the total-failure
#    case; truncation sailed through it.
probe_find "${WORK}/cpfiles.raw" "the classpath enumeration under ${UC_HOME}" \
  "$UC_HOME" -type f -name classpath
sort "${WORK}/cpfiles.raw" > "$CPFILES"
if [ ! -s "$CPFILES" ]; then
  echo "FATAL: no classpath file found under ${UC_HOME} -- cannot derive the keep-set." >&2
  exit 1
fi
echo "classpath files: $(wc -l < "$CPFILES")"

# 2) Keep-set = every .jar named by any of them. The files are written by sbt as a
#    single colon-separated line with NO trailing newline, so append an explicit
#    separator between files or the last entry of one would fuse with the first of
#    the next.
: > "${WORK}/cp.raw"
while IFS= read -r f; do
  cat "$f" >> "${WORK}/cp.raw"
  printf ':\n' >> "${WORK}/cp.raw"
done < "$CPFILES"
tr ':' '\n' < "${WORK}/cp.raw" > "${WORK}/fields.raw"
# #4471 (round 2): this was a FOUR-STAGE pipeline --
#   tr ':' '\n' < cp.raw | sed <trim> | grep -vE '^$' | sort -u > entries.txt
# whose status belonged to `sort -u`. `entries.txt` is the sole input to BOTH
# $KEEP (what survives the delete) and $PRESENT (the assertion that would catch
# a bad delete), so a truncation shrinks the protection and its control IN
# LOCKSTEP. Measured by a reviewer with a `sed` shim that truncates and exits 2:
# a jar NAMED BY THE SERVER CLASSPATH was deleted, exit 0, stderr empty,
# "assertions passed" printed. Status reads alone are not enough here, because a
# stage can also truncate at rc=0, so each stage additionally carries an EXACT
# arithmetic invariant:
#   * `tr` is a pure byte substitution -- same byte count in and out;
#   * `sed` is per-line -- same line count in and out;
#   * after `sort -u` every blank field has collapsed to AT MOST ONE line, so
#     the blank filter may remove at most 1 line. More than that is truncation.
_tr_in="$(wc -c < "${WORK}/cp.raw" | tr -d ' ')"
_tr_out="$(wc -c < "${WORK}/fields.raw" | tr -d ' ')"
if [ "$_tr_in" -ne "$_tr_out" ]; then
  echo "FATAL: the colon split lost bytes (${_tr_in} in, ${_tr_out} out). A truncated" >&2
  echo "       field list yields a SHORT keep-set, which deletes MORE." >&2
  exit 1
fi
sed 's/[[:space:]]*$//' "${WORK}/fields.raw" > "${WORK}/fields.trimmed"
_sed_in="$(wc -l < "${WORK}/fields.raw" | tr -d ' ')"
_sed_out="$(wc -l < "${WORK}/fields.trimmed" | tr -d ' ')"
if [ "$_sed_in" -ne "$_sed_out" ]; then
  echo "FATAL: the trailing-space trim lost lines (${_sed_in} in, ${_sed_out} out). A" >&2
  echo "       truncated field list yields a SHORT keep-set, which deletes MORE." >&2
  exit 1
fi
sort -u "${WORK}/fields.trimmed" > "${WORK}/fields.sorted"
_srt="$(wc -l < "${WORK}/fields.sorted" | tr -d ' ')"
_b_rc=0
grep -vE -e '^$' -- "${WORK}/fields.sorted" > "${WORK}/entries.txt" 2> "${WORK}/.grep.err" || _b_rc=$?
if [ "$_b_rc" -gt 1 ]; then
  probe_failed "the blank-field filter over the classpath entries" "$_b_rc" "${WORK}/.grep.err"
fi
_ent="$(wc -l < "${WORK}/entries.txt" | tr -d ' ')"
if [ "$(( _srt - _ent ))" -gt 1 ]; then
  echo "FATAL: the blank-field filter removed $(( _srt - _ent )) of ${_srt} lines, but after" >&2
  echo "       'sort -u' at most ONE can be blank -- so it truncated. A short keep-set" >&2
  echo "       deletes MORE." >&2
  exit 1
fi
# #4471: `grep ... > "$KEEP" || true` had the same collapse as the examples
# guard -- a grep that ERRORED partway through writes a TRUNCATED keep-set, and
# `|| true` made that indistinguishable from "no entry ends in .jar". A short
# keep-set deletes MORE, and the `! -s` check below only catches the empty case.
_g_rc=0
grep -E -e '\.jar$' -- "${WORK}/entries.txt" > "$KEEP" 2> "${WORK}/.grep.err" || _g_rc=$?
if [ "$_g_rc" -gt 1 ]; then
  probe_failed "the .jar filter over the classpath entries" "$_g_rc" "${WORK}/.grep.err"
fi
if [ ! -s "$KEEP" ]; then
  echo "FATAL: derived an EMPTY keep-set -- refusing to delete anything." >&2
  exit 1
fi
echo "jars referenced by a classpath: $(wc -l < "$KEEP")"

# Snapshot which classpath entries EXIST right now. The upstream image already
# ships a classpath naming paths that were never built (e.g.
# clients/python/target/classes), so "must exist afterwards" is only a valid
# assertion for entries that existed beforehand.
: > "$PRESENT"
while IFS= read -r entry; do
  if [ -e "$entry" ]; then
    printf '%s\n' "$entry" >> "$PRESENT"
  fi
done < "${WORK}/entries.txt"
echo "classpath entries present pre-prune: $(wc -l < "$PRESENT") of $(wc -l < "${WORK}/entries.txt")"

# 3) Everything cached, and the difference. Same treatment: a truncated cache
#    scan under-reports what is there, which under-deletes rather than
#    over-deletes -- but it would ALSO hide a surviving bcprov from the counts,
#    so it is not allowed to pass unnoticed either.
probe_find "${WORK}/all.raw" "the coursier cache scan under ${CACHE}" \
  "$CACHE" -type f -name '*.jar'
sort -u "${WORK}/all.raw" > "$ALL"
echo "jars in the coursier cache:    $(wc -l < "$ALL")"
comm -23 "$ALL" "$KEEP" > "$DROP"
echo "unreferenced jars to remove:   $(wc -l < "$DROP")"
if [ ! -s "$DROP" ]; then
  echo "FATAL: nothing to prune -- the upstream image no longer matches the analysis this script encodes. Re-scan and re-derive rather than shipping a no-op." >&2
  exit 1
fi

# 4) Prune. Remove the jar and its sibling checksum; leave .pom metadata alone
#    (Trivy's jar analyzer only reads archives, and poms cost nothing).
while IFS= read -r jar; do
  rm -f "$jar" "${jar}.sha1"
done < "$DROP"

# 5) Assertions. The build must fail rather than ship a catalog whose classpath
#    has a hole in it. Every entry that existed before the prune must still exist
#    -- jars and non-jar roots (server/target/classes) alike.
echo "== SC1 assertions =="
missing=0
while IFS= read -r entry; do
  if [ ! -e "$entry" ]; then
    echo "FATAL: classpath entry destroyed by the prune: $entry" >&2
    missing=$((missing + 1))
  fi
done < "$PRESENT"
if [ "$missing" -ne 0 ]; then
  echo "FATAL: ${missing} classpath entrie(s) missing after prune." >&2
  exit 1
fi

# The specific CVEs this prune exists to clear. These are ABSENCE claims, so
# they get the same treatment (#4471): a scan that died would otherwise write an
# empty file and be read as "no bouncycastle survived". They are paired with the
# positive control above -- the surviving-classpath-entry assertion -- so neither
# a dead scan nor a deleted prune can make the pair pass.
probe_find "${WORK}/bc.txt" "the bouncycastle survivor scan under ${CACHE}" \
  "$CACHE" '(' -name 'bcprov-*.jar' -o -name 'bcpg-*.jar' ')'
if [ -s "${WORK}/bc.txt" ]; then
  echo "FATAL: a bouncycastle jar survived the prune -- CVE-2025-14813 would still be reported:" >&2
  cat "${WORK}/bc.txt" >&2
  exit 1
fi

# #4429: the awssdk fat jar that shades netty-handler 4.1.115.Final. Asserted by
# NAME rather than by version so a future base that caches a different bundle
# release is caught too -- the finding is "this image ships the AWS SDK uber-jar
# for a demo CLI it does not run", not "it ships exactly 2.29.52".
probe_find "${WORK}/bundle.txt" "the awssdk-bundle survivor scan under ${CACHE}" \
  "$CACHE" -name "$BUNDLE_GLOB" -path '*/awssdk/bundle/*'
if [ -s "${WORK}/bundle.txt" ]; then
  echo "FATAL: an awssdk bundle fat jar survived the prune -- the shaded netty-handler" >&2
  echo "       CVE-2026-75595 would still be reported:" >&2
  cat "${WORK}/bundle.txt" >&2
  exit 1
fi
if [ -e "${UC_HOME}/bin/uc" ] || [ -e "${UC_HOME}/examples" ]; then
  echo "FATAL: the examples CLI survived -- bin/uc or examples/ is still present." >&2
  exit 1
fi

echo "assertions passed ($(wc -l < "$PRESENT") classpath entries intact, $(wc -l < "$DROP") unreferenced jars removed)"
rm -rf "$WORK"
echo "== SC1 loom-unity cache prune complete =="
