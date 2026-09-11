#!/bin/sh
# CSA Loom -- loom-trino SC1 hardening (Trivy CRITICAL gate), Java layer. (#4429)
#
# CVE-2026-75595, CRITICAL, io.netty:netty-handler. trinodb/trino:483 ships
# netty-handler 4.2.16.Final; upstream fixed it in 4.2.17.Final (4.2 line) and
# 4.1.137.Final (4.1 line). This image takes 4.2.17.Final -- the MINIMAL version
# that clears the finding inside the pinned base's own netty minor. 4.2.18.Final
# exists (published 2026-09-09) and is deliberately NOT taken: the repo patches
# to the lowest version that clears the CVE (the same call recorded for
# loom-vscode / vitest 4.1.11 over 5.0.0 in #4446).
#
# WHY AN OVERLAY AND NOT A BASE BUMP. Measured 2026-09-11, not assumed:
# `trinodb/trino:483` IS `:latest` -- the Docker Hub tags API returns 404 for
# every tag 484..495 and 483's digest
# (sha256:db58cc93e593a2706553745f276bb119c9810e69918be56ecde088ba7ccb0534) is
# byte-identical to the one :latest points at. There is nothing newer to bump
# to, and 483 was published 2026-07-18 -- BEFORE netty 4.2.17.Final existed
# (2026-08-04), so no Trino release could have carried the fix yet.
#
# WHY ALL FIFTEEN COPIES. Trivy's table reported ONE row, naming
# plugin/cassandra -- because it de-duplicates a finding per (package, version)
# and prints one representative path. The image actually carries FIFTEEN
# byte-identical copies of io.netty_netty-handler-4.2.16.Final.jar, one per
# plugin (cassandra, delta-lake, elasticsearch, exchange-filesystem,
# exchange-hdfs, hive, hudi, iceberg, lakehouse, opensearch, pinot, ranger,
# redshift, spooling-filesystem, thrift) -- Trino gives every plugin its own
# isolated classloader and its own jar set. Patching only the path Trivy
# happened to print would leave 14 vulnerable copies and a still-red gate, so
# the loop below treats every directory and ASSERTS the count.
#
# ABI. Every netty module in every one of those plugin directories is 4.2.16.Final
# (the only other netty coordinate present is tcnative 2.0.80.Final), so lifting
# netty-handler alone to 4.2.17 is a patch-level move inside a uniform set. The
# method-level proof is recorded in the PR: scripts/ci/netty_link_check.py run
# three ways against the real jars extracted from trinodb/trino:483 --
#   forward  4.2.17 vs the cassandra sibling set (the SMALLEST, i.e. hardest):
#            identical unresolved set to the 4.2.16 CONTROL, 0 unresolved members
#   backward 4.2.16 -> 4.2.17: 0 removed classes, 0 removed public/protected members
#   callers  311 jars / 96,864 classes of the delta-lake plugin: 0 broken refs
# NettyLinkCheck then re-proves the class-level half INSIDE the image, against
# the real classpath, at build time.
#
# The script lives in a FILE rather than an inline Dockerfile heredoc on purpose:
# ACR Tasks' classic builder cannot parse heredocs (they need BuildKit). A
# heredoc builds fine under a local `docker build` and then dies in CI after ~3s
# with `failed to run step ID: build: failed to scan dependencies: exit status 1`
# before any layer runs. Keep the Dockerfile BuildKit-feature-free.

set -eu

PLUGINS=/usr/lib/trino/plugin
OLD_VERSION=4.2.16.Final
NEW_VERSION=4.2.17.Final
OLD_JAR="io.netty_netty-handler-${OLD_VERSION}.jar"
NEW_JAR="io.netty_netty-handler-${NEW_VERSION}.jar"
# Verified 2026-09-11 by downloading from Maven Central and hashing locally; the
# value matched the published .jar.sha256 sidecar. A tampered or truncated
# download fails the build instead of shipping.
NEW_SHA256=4df11c7520b556c5e2c84b939182699d48fcbb09e97a6bb5e1c0b6835227d126
EXPECTED_COPIES=15
# The base image's OWN copy, so a re-pushed :483 that changed the jar is caught
# rather than silently patched on top of something else.
OLD_SHA256=a259ca496da05ac1981f95cd856211f894a328056a6129e9cd70dbbd5df401f7

WORK=/tmp/loom-sc1-netty
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

echo "== SC1 loom-trino netty-handler ${OLD_VERSION} -> ${NEW_VERSION} =="
if [ ! -d "$PLUGINS" ]; then
  echo "FATAL: ${PLUGINS} does not exist -- the base image layout changed. Re-derive the fix." >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK"

# ---------------------------------------------------------------------------
# 1) Enumerate every plugin directory that carries the vulnerable jar, and FAIL
#    if the population is not the one this fix was derived against. A base tag
#    that grew or lost a plugin changes the blast radius, and a silent patch of
#    a different set is exactly the drift this repo makes loud.
# ---------------------------------------------------------------------------
find "$PLUGINS" -type f -name "$OLD_JAR" | sort > "${WORK}/targets.txt"
FOUND="$(wc -l < "${WORK}/targets.txt" | tr -d ' ')"
echo "plugin directories carrying ${OLD_JAR}: ${FOUND}"
if [ "$FOUND" -ne "$EXPECTED_COPIES" ]; then
  echo "FATAL: expected ${EXPECTED_COPIES} copies of ${OLD_JAR}, found ${FOUND}." >&2
  echo "       The pinned base moved. Re-run scripts/ci/netty_link_check.py against the" >&2
  echo "       new image and update EXPECTED_COPIES before letting this build through." >&2
  cat "${WORK}/targets.txt" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2) Assert the PREMISE of the authoring-time link analysis: in every directory
#    we are about to touch, every other netty module is ${OLD_VERSION}. If a
#    plugin ever ships a mixed set, the "patch-level move inside a uniform set"
#    argument no longer holds and the analysis must be re-run.
# ---------------------------------------------------------------------------
SKEW=0
while IFS= read -r jar; do
  dir="$(dirname "$jar")"
  # Two shapes have to be accepted, not one: plain artifacts end
  # `-4.2.16.Final.jar`, but the native ones carry a CLASSIFIER after the
  # version (`-4.2.16.Final-linux-x86_64.jar`). Matching only the first shape
  # flagged 9 of the 15 directories as skewed on the first local build -- the
  # guard firing on its own pattern bug rather than on real drift.
  # tcnative is a separately-versioned artifact (2.0.x) and is not part of the
  # 4.2.x module set; exclude it rather than pretend it should match.
  bad="$(find "$dir" -maxdepth 1 -name 'io.netty_netty-*.jar' \
          ! -name 'io.netty_netty-tcnative-*' \
          ! -name "*-${OLD_VERSION}.jar" \
          ! -name "*-${OLD_VERSION}-*.jar" -print | sort)"
  if [ -n "$bad" ]; then
    echo "FATAL: ${dir} carries netty modules that are NOT ${OLD_VERSION}:" >&2
    echo "$bad" >&2
    SKEW=$((SKEW + 1))
  fi
done < "${WORK}/targets.txt"
if [ "$SKEW" -ne 0 ]; then
  echo "FATAL: ${SKEW} plugin director(ies) have a skewed netty set. Re-derive the swap." >&2
  exit 1
fi
echo "sibling netty set is uniformly ${OLD_VERSION} in all ${FOUND} directories"

# ---------------------------------------------------------------------------
# 3) Fetch the replacement ONCE, digest-pinned, and prove the jar we are
#    replacing is the one the analysis was run against.
# ---------------------------------------------------------------------------
curl -fsSL -o "${WORK}/${NEW_JAR}" \
  "https://repo1.maven.org/maven2/io/netty/netty-handler/${NEW_VERSION}/netty-handler-${NEW_VERSION}.jar"
echo "${NEW_SHA256}  ${WORK}/${NEW_JAR}" | sha256sum -c -

FIRST="$(head -n 1 "${WORK}/targets.txt")"
GOT="$(sha256sum "$FIRST" | cut -d' ' -f1)"
if [ "$GOT" != "$OLD_SHA256" ]; then
  echo "FATAL: base-image drift. ${FIRST} hashes ${GOT}, expected ${OLD_SHA256}." >&2
  echo "       trinodb/trino:483 is a MUTABLE tag and its netty-handler changed." >&2
  echo "       Re-run scripts/ci/netty_link_check.py against the new jar set." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4) CONTROL RUN, before anything is touched. NettyLinkCheck records which
#    io.netty classes named by the handler jar this classpath cannot load; a
#    netty-handler ALWAYS names some it never could (the optional native OpenSSL
#    provider, the optional Conscrypt engine, netty-pkitesting). Judging the raw
#    set would fail every build and an allowlist of names would just move the
#    lie, so the verdict is the DIFFERENCE against this baseline.
#
#    Two plugin classpaths are measured: cassandra has the SMALLEST netty set
#    (7 jars -- the hardest case for a swapped module) and delta-lake the
#    largest (49). Trino isolates plugins, so each is its own classpath and
#    proving the extremes covers the middle.
# ---------------------------------------------------------------------------
echo "== SC1 netty link check: CONTROL (before the swap) =="
javac -nowarn -d "$WORK" "${SCRIPTS}/NettyLinkCheck.java"
for p in cassandra delta-lake; do
  java -cp "${WORK}:${PLUGINS}/${p}/*" NettyLinkCheck \
    --jar "${PLUGINS}/${p}/${OLD_JAR}" \
    --expect "io.netty:netty-handler=${OLD_VERSION}" \
    --unresolved-out "${WORK}/ctl-${p}.txt" \
    --control --skip-ssl-probe
done

# ---------------------------------------------------------------------------
# 5) Install + remove, per directory, preserving the upstream ownership/mode.
# ---------------------------------------------------------------------------
while IFS= read -r jar; do
  dir="$(dirname "$jar")"
  install -m 0644 "${WORK}/${NEW_JAR}" "${dir}/${NEW_JAR}"
  chown --reference="$jar" "${dir}/${NEW_JAR}"
  rm -f "$jar"
  echo "  ${dir##*/}: ${OLD_JAR} -> ${NEW_JAR}"
done < "${WORK}/targets.txt"

# ---------------------------------------------------------------------------
# 6) Assertions. A `rm` of a name that moved, or a curl that wrote an error
#    page, would otherwise ship silently.
# ---------------------------------------------------------------------------
echo "== SC1 assertions =="
LEFT="$(find "$PLUGINS" -type f -name "$OLD_JAR" | wc -l | tr -d ' ')"
if [ "$LEFT" -ne 0 ]; then
  echo "FATAL: ${LEFT} copies of ${OLD_JAR} survived the swap." >&2
  exit 1
fi
NEWC="$(find "$PLUGINS" -type f -name "$NEW_JAR" | wc -l | tr -d ' ')"
if [ "$NEWC" -ne "$EXPECTED_COPIES" ]; then
  echo "FATAL: expected ${EXPECTED_COPIES} copies of ${NEW_JAR}, found ${NEWC}." >&2
  exit 1
fi
echo "assertions passed (${NEWC} plugin directories patched, 0 ${OLD_VERSION} handlers left)"

# ---------------------------------------------------------------------------
# 7) TREATMENT RUN + the verdict: any io.netty class that resolved BEFORE the
#    swap and does not resolve after it is a regression and fails the build.
#    The SSL probe runs here too -- SslContextBuilder -> SslHandler ->
#    EmbeddedChannel links handler -> common -> buffer -> transport for real,
#    which a class-loading check alone does not.
# ---------------------------------------------------------------------------
echo "== SC1 netty link check: TREATMENT (after the swap) =="
REG=0
for p in cassandra delta-lake; do
  echo "-- plugin/${p}"
  java -cp "${WORK}:${PLUGINS}/${p}/*" NettyLinkCheck \
    --jar "${PLUGINS}/${p}/${NEW_JAR}" \
    --expect "io.netty:netty-handler=${NEW_VERSION}" \
    --unresolved-out "${WORK}/trt-${p}.txt"
  sort -o "${WORK}/ctl-${p}.txt" "${WORK}/ctl-${p}.txt"
  sort -o "${WORK}/trt-${p}.txt" "${WORK}/trt-${p}.txt"
  NEWLY="$(comm -13 "${WORK}/ctl-${p}.txt" "${WORK}/trt-${p}.txt")"
  if [ -n "$NEWLY" ]; then
    echo "FATAL: plugin/${p} — netty-handler ${NEW_VERSION} names io.netty classes that" >&2
    echo "       resolved before the swap and do NOT resolve after it:" >&2
    echo "$NEWLY" | sed 's/^/         /' >&2
    echo "       A sibling netty module in that plugin is too old. Lift it, or re-derive" >&2
    echo "       the swap with scripts/ci/netty_link_check.py." >&2
    REG=$((REG + 1))
  else
    echo "   plugin/${p}: 0 newly-unresolvable io.netty classes vs the control"
  fi
done
[ "$REG" -eq 0 ] || exit 1

rm -rf "$WORK"
echo "== SC1 loom-trino netty hardening complete =="
