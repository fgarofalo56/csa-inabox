#!/bin/sh
# CSA Loom -- loom-unity SC1 hardening (Trivy CRITICAL gate), netty layer. (#4429)
#
# CVE-2026-75595, CRITICAL, io.netty:netty-handler. unitycatalog/unitycatalog:
# v0.5.0 resolves netty-handler 4.1.112.Final onto the SERVER classpath;
# upstream fixed it in 4.1.137.Final (4.1 line) and 4.2.17.Final (4.2 line).
# This image takes 4.1.137.Final -- the MINIMAL version that clears the finding
# without leaving the netty 4.1 line the rest of the server's netty set is on.
#
# THIS IS ONE OF TWO netty CRITICALs on this image. The other -- a netty-handler
# 4.1.115.Final SHADED inside the 641 MB AWS SDK fat jar bundle-2.29.52.jar -- is
# handled in sc1-prune-cache.sh, because it is reachable only from the upstream
# examples CLI and the disposition there is removal, not upgrade. Trivy reports
# BOTH under the same CVE id and the same package name; a fix that cleared only
# this one would leave the gate red. (The Commercial job's table wrapped the
# second row onto a continuation line, which is how it was initially missed --
# `Total: 2 (CRITICAL: 2)` is the number that counts, not the row you can see.)
#
# WHY AN OVERLAY AND NOT A BASE BUMP. unitycatalog/unitycatalog:v0.6.0 does now
# exist on Docker Hub (published 2026-08-20), so a bump was checked first. It is
# NOT taken here, and deliberately so: the stage-2 base-drift assertion in this
# image's Dockerfile FAILS THE BUILD when the base tag moves, because the
# narrowed three-class #1603 overlay is derived against v0.5.0's exact class
# digests. Bumping the base means re-deriving that overlay against v0.6.0 and
# re-running the authz proof -- a deliberate, separately-validated upgrade, not
# a CVE patch. The Dockerfile says so in as many words. It is tracked
# separately; this change does not pre-empt it.
#
# ABI. The server's netty set is a mixed 4.1.111/4.1.112 (upstream's own
# resolution), and it DOES carry netty-tcnative-boringssl-static 2.0.65, so the
# native OpenSSL path is live here -- unlike loom-mirroring and loom-risingwave.
# The method-level proof is recorded in the PR: scripts/ci/netty_link_check.py
# against the 46 netty jars named by the real server classpath --
#   forward  4.1.137 vs the treated set: ZERO unresolved classes, ZERO
#            unresolved members (tcnative present, so even the OpenSSL family
#            links)
#   backward 4.1.112 -> 4.1.137: 7 removed classes + 17 removed members, and
#            EVERY removed type is package-private io.netty.handler.ssl /
#            io.netty.handler.ssl.util internals (OpenSslSession,
#            OpenSslEngineMap, BouncyCastle*, OpenJdkSelfSignedCertGenerator$*
#            -- access flags read off the class files, 0x0600 / 0x0030). A class
#            in another package cannot legally name them, so no caller can break
#   modules  the other 45 netty jars on the server classpath: 0 regressions
# NettyLinkCheck then re-proves the class-level half INSIDE the image, at build
# time, against the real server classpath and against a CONTROL run taken before
# the swap.
#
# Runs from a FILE, never an inline Dockerfile heredoc: ACR Tasks' classic
# builder cannot parse heredocs (they need BuildKit); one builds fine under local
# `docker build` and then dies in CI after ~3s with
#   `failed to run step ID: build: failed to scan dependencies: exit status 1`.

set -eu

UC_HOME="${UC_HOME:-/home/unitycatalog}"
CACHE="${UC_HOME}/.cache/coursier/https/maven-proxy.cloud.databricks.com/io/netty"
SERVER_CP="${UC_HOME}/server/target/classpath"
OLD_VERSION=4.1.112.Final
NEW_VERSION=4.1.137.Final
OLD_JAR="${CACHE}/netty-handler/${OLD_VERSION}/netty-handler-${OLD_VERSION}.jar"
NEW_DIR="${CACHE}/netty-handler/${NEW_VERSION}"
NEW_JAR="${NEW_DIR}/netty-handler-${NEW_VERSION}.jar"
# Verified 2026-09-11 by downloading from Maven Central and hashing locally; the
# value matched the published .jar.sha256 sidecar.
NEW_SHA256=d0e4c6ee4779f59f6ab2fb5d388e4f57147c82270164b37945764bb9bda96a44
# The base image's OWN cached copy. The cache is served through a Databricks
# Maven mirror, so this also proves the mirror handed us the stock artifact the
# authoring-time analysis was run against.
OLD_SHA256=ea4d6062a5fb10a6e2364d8bbdebc1cfa814f1fc9f910ef57e5caf02fb15c588

WORK=/tmp/loom-sc1-netty
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

echo "== SC1 loom-unity netty-handler ${OLD_VERSION} -> ${NEW_VERSION} =="
if [ ! -f "$OLD_JAR" ]; then
  echo "FATAL: ${OLD_JAR} not found -- the upstream image's netty resolution changed." >&2
  echo "       Re-derive the swap (scripts/ci/netty_link_check.py) before editing this." >&2
  exit 1
fi
if [ ! -f "$SERVER_CP" ]; then
  echo "FATAL: ${SERVER_CP} not found -- bin/start-uc-server reads exactly this file." >&2
  exit 1
fi
GOT="$(sha256sum "$OLD_JAR" | cut -d' ' -f1)"
if [ "$GOT" != "$OLD_SHA256" ]; then
  echo "FATAL: base-image drift. ${OLD_JAR} hashes ${GOT}, expected ${OLD_SHA256}." >&2
  echo "       Re-run scripts/ci/netty_link_check.py against the new jar set." >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK"

# ---------------------------------------------------------------------------
# 1) CONTROL RUN on the UNMODIFIED server classpath. NettyLinkCheck records
#    which io.netty classes named by the handler jar cannot load; the verdict is
#    the DIFFERENCE against this, never the raw set (see NettyLinkCheck's
#    javadoc for why judging the raw set is not a real gate).
# ---------------------------------------------------------------------------
echo "== SC1 netty link check: CONTROL (before the swap) =="
javac -nowarn -d "$WORK" "${SCRIPTS}/NettyLinkCheck.java"
java -cp "${WORK}:$(cat "$SERVER_CP")" NettyLinkCheck \
  --jar "$OLD_JAR" \
  --expect "io.netty:netty-handler=${OLD_VERSION}" \
  --unresolved-out "${WORK}/ctl.txt" \
  --control --skip-ssl-probe

# ---------------------------------------------------------------------------
# 2) Install at the CANONICAL coursier path for the new version -- not on top of
#    the old filename. Overwriting 4.1.112's bytes with 4.1.137's would leave
#    every classpath file, every audit and every future scan reading a version
#    string that is a lie; the repo already rejected that shape once (the
#    parquet-avro "newer version string on the same unloadable jar" note in
#    apps/loom-risingwave/scripts/sc1-harden.sh).
# ---------------------------------------------------------------------------
#    Ownership and mode are copied from the jar being replaced. This base is
#    ALPINE, so the coreutils spelling `chown --reference=` is not available --
#    BusyBox chown rejects it outright (it failed the first local build here).
#    Read the values with `stat` and apply them explicitly instead.
mkdir -p "$NEW_DIR"
curl -fsSL -o "$NEW_JAR" \
  "https://repo1.maven.org/maven2/io/netty/netty-handler/${NEW_VERSION}/netty-handler-${NEW_VERSION}.jar"
echo "${NEW_SHA256}  ${NEW_JAR}" | sha256sum -c -
JAR_OWNER="$(stat -c '%u:%g' "$OLD_JAR")"
JAR_MODE="$(stat -c '%a' "$OLD_JAR")"
DIR_OWNER="$(stat -c '%u:%g' "$(dirname "$OLD_JAR")")"
DIR_MODE="$(stat -c '%a' "$(dirname "$OLD_JAR")")"
chown "$JAR_OWNER" "$NEW_JAR"
chmod "$JAR_MODE" "$NEW_JAR"
chown "$DIR_OWNER" "$NEW_DIR"
chmod "$DIR_MODE" "$NEW_DIR"

# ---------------------------------------------------------------------------
# 3) Repoint EVERY classpath file that names the old jar, then delete it.
#
#    "Every", not "the server's": the upstream image carries EIGHT classpath
#    files and this image has already been bitten once by patching the wrong one
#    (the finishline D2 incident recorded in the Dockerfile -- find's traversal
#    order returned server/target/controlmodels/target/classpath and every
#    assertion passed against a file the server never reads). The rewrite is
#    written through `cat >` so the file's ownership and mode survive, and the
#    content is taken from a command substitution so no trailing newline is
#    introduced -- a newline inside the -cp argument word-splits the java
#    command and breaks the boot.
# ---------------------------------------------------------------------------
TOUCHED=0
for CP_FILE in $(find "$UC_HOME" -type f -name classpath); do
  if grep -q "netty-handler-${OLD_VERSION}.jar" "$CP_FILE"; then
    sed "s|${OLD_JAR}|${NEW_JAR}|g" "$CP_FILE" > "${WORK}/cp.new"
    printf '%s' "$(cat "${WORK}/cp.new")" > "${WORK}/cp.final"
    cat "${WORK}/cp.final" > "$CP_FILE"
    rm -f "${WORK}/cp.new" "${WORK}/cp.final"
    TOUCHED=$((TOUCHED + 1))
    echo "  repointed ${CP_FILE}"
  fi
done
if [ "$TOUCHED" -eq 0 ]; then
  echo "FATAL: no classpath file named netty-handler-${OLD_VERSION}.jar -- refusing to" >&2
  echo "       ship a swap that nothing loads (a green gate over an unchanged runtime)." >&2
  exit 1
fi
rm -f "$OLD_JAR" "${OLD_JAR}.sha1"
rmdir "$(dirname "$OLD_JAR")" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4) Assertions.
# ---------------------------------------------------------------------------
echo "== SC1 assertions =="
test ! -e "$OLD_JAR" || { echo "FATAL: ${OLD_JAR} still present" >&2; exit 1; }
test -s "$NEW_JAR" || { echo "FATAL: ${NEW_JAR} missing or empty" >&2; exit 1; }
grep -q "netty-handler-${NEW_VERSION}.jar" "$SERVER_CP" \
  || { echo "FATAL: ${SERVER_CP} does not name the patched jar -- the server would boot without it" >&2; exit 1; }
if grep -q "netty-handler-${OLD_VERSION}.jar" "$SERVER_CP"; then
  echo "FATAL: ${SERVER_CP} still names ${OLD_VERSION}" >&2
  exit 1
fi
LEFT="$(find "$UC_HOME" -type f -name "netty-handler-${OLD_VERSION}.jar" | wc -l | tr -d ' ')"
[ "$LEFT" -eq 0 ] || { echo "FATAL: ${LEFT} copies of the old jar survived" >&2; exit 1; }
# Every entry the server classpath names must still exist -- a repoint that
# landed on a path we never created would only surface at boot.
MISSING=0
for e in $(tr ':' '\n' < "$SERVER_CP"); do
  [ -e "$e" ] || { echo "FATAL: server classpath entry missing: $e" >&2; MISSING=$((MISSING + 1)); }
done
[ "$MISSING" -eq 0 ] || exit 1
echo "assertions passed (${TOUCHED} classpath file(s) repointed, server classpath intact)"

# ---------------------------------------------------------------------------
# 5) TREATMENT RUN + the verdict. The SSL probe runs here too: SslContextBuilder
#    -> SslHandler -> EmbeddedChannel links handler -> common -> buffer ->
#    transport for real, which a class-loading check alone does not.
# ---------------------------------------------------------------------------
echo "== SC1 netty link check: TREATMENT (after the swap) =="
java -cp "${WORK}:$(cat "$SERVER_CP")" NettyLinkCheck \
  --jar "$NEW_JAR" \
  --expect "io.netty:netty-handler=${NEW_VERSION}" \
  --unresolved-out "${WORK}/trt.txt"
sort -o "${WORK}/ctl.txt" "${WORK}/ctl.txt"
sort -o "${WORK}/trt.txt" "${WORK}/trt.txt"
NEWLY="$(comm -13 "${WORK}/ctl.txt" "${WORK}/trt.txt")"
if [ -n "$NEWLY" ]; then
  echo "FATAL: netty-handler ${NEW_VERSION} names io.netty classes that resolved before" >&2
  echo "       the swap and do NOT resolve after it:" >&2
  echo "$NEWLY" | sed 's/^/         /' >&2
  echo "       A sibling netty module is too old. Lift it, or re-derive the swap with" >&2
  echo "       scripts/ci/netty_link_check.py." >&2
  exit 1
fi
echo "0 newly-unresolvable io.netty classes vs the control"

rm -rf "$WORK"
echo "== SC1 loom-unity netty hardening complete =="
