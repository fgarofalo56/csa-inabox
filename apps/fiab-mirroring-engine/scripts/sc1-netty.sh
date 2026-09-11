#!/bin/sh
# CSA Loom -- loom-mirroring SC1 hardening (Trivy CRITICAL gate), Java layer. (#4429)
#
# CVE-2026-75595, CRITICAL, io.netty:netty-handler. quay.io/debezium/connect:
# 3.5.2.Final ships netty-handler 4.1.128.Final inside the Oracle connector
# plugin; upstream fixed it in 4.1.137.Final (4.1 line) and 4.2.17.Final (4.2
# line). This image takes 4.1.137.Final -- the MINIMAL version that clears the
# finding WITHOUT leaving the base's own netty 4.1 line. Moving to 4.2.x would
# be a netty MINOR bump under a connector runtime that was built against 4.1,
# which is a re-platform, not a CVE patch.
#
# WHY AN OVERLAY AND NOT A BASE BUMP -- MEASURED, not assumed (2026-09-11).
# Debezium HAS shipped newer lines (3.6.1.Final, 3.6.2.Final) since this base
# was pinned, so the obvious move was to bump. It does not work: the
# debezium-connector-oracle 3.6.2.Final plugin tarball on Maven Central still
# ships `netty-handler-4.1.128.Final.jar` --
#   curl -O https://repo1.maven.org/maven2/io/debezium/debezium-connector-oracle/\
#          3.6.2.Final/debezium-connector-oracle-3.6.2.Final-plugin.tar.gz
#   tar -tzf ... | grep netty-handler   ->   netty-handler-4.1.128.Final.jar
# so a 3.5 -> 3.6 bump would change the connector runtime (a real behavioural
# delta for every mirrored source) and NOT clear the CVE. Netty published
# 4.1.137.Final on 2026-08-06; no Debezium release carries it yet.
#
# ONE COPY, and that is verified rather than inferred from Trivy's table: a
# whole-filesystem `find / -name 'netty-handler-*.jar'` inside the pinned base
# returns exactly /kafka/connect/debezium-connector-oracle/netty-handler-
# 4.1.128.Final.jar. (Trivy de-duplicates per package+version and prints ONE
# representative path, so its table is not a copy count -- on loom-trino the
# same single row stood for fifteen physical jars.)
#
# ABI. Kafka Connect gives every connector plugin its own isolated classloader,
# so the blast radius is that one directory. Its netty set is 4.1.128 for the
# core modules and 4.1.119 for the DNS/epoll leaves -- i.e. upstream already
# ships a mixed 4.1.x set here. The method-level proof is recorded in the PR:
# scripts/ci/netty_link_check.py run three ways against the jars extracted from
# the pinned image --
#   forward  4.1.137 vs the plugin's 9 sibling netty jars: 15 unresolved classes,
#            IDENTICAL to the 4.1.128 CONTROL (all of them io.netty.internal.
#            tcnative, the optional native OpenSSL provider this plugin has never
#            shipped), and 0 unresolved MEMBERS
#   backward 4.1.128 -> 4.1.137: 1 removed class + 2 removed members, all
#            package-private io.netty.handler.ssl internals (OpenSslEngineMap,
#            ReferenceCountedOpenSslContext$DefaultOpenSslEngineMap) that no jar
#            outside netty-handler can legally name
#   callers  100 jars / 29,119 classes of the connector plugin: 0 broken refs
# NettyLinkCheck then re-proves the class-level half INSIDE the image, at build
# time, against the real plugin classpath and against a CONTROL run taken before
# the swap.
#
# The script lives in a FILE rather than an inline Dockerfile heredoc on purpose:
# ACR Tasks' classic builder cannot parse heredocs (they need BuildKit). A
# heredoc builds fine under a local `docker build` and then dies in CI after ~3s
# with `failed to run step ID: build: failed to scan dependencies: exit status 1`
# before any layer runs. Keep the Dockerfile BuildKit-feature-free.

set -eu

PLUGIN=/kafka/connect/debezium-connector-oracle
OLD_VERSION=4.1.128.Final
NEW_VERSION=4.1.137.Final
OLD_JAR="netty-handler-${OLD_VERSION}.jar"
NEW_JAR="netty-handler-${NEW_VERSION}.jar"
# Verified 2026-09-11 by downloading from Maven Central and hashing locally; the
# value matched the published .jar.sha256 sidecar. A tampered or truncated
# download fails the build instead of shipping.
NEW_SHA256=d0e4c6ee4779f59f6ab2fb5d388e4f57147c82270164b37945764bb9bda96a44
# The base image's OWN copy, so a re-pushed tag that changed the jar is caught
# rather than silently patched on top of something the analysis never saw.
OLD_SHA256=d9e3fd9b839cb207030ffd385d5b3c087dbf746a643056db544f16318573975f

WORK=/tmp/loom-sc1-netty
CLASSES=/opt/loom-sc1/classes

echo "== SC1 loom-mirroring netty-handler ${OLD_VERSION} -> ${NEW_VERSION} =="
if [ ! -d "$PLUGIN" ]; then
  echo "FATAL: ${PLUGIN} does not exist -- the base image layout changed. Re-derive the fix." >&2
  exit 1
fi
if [ ! -f "${PLUGIN}/${OLD_JAR}" ]; then
  echo "FATAL: ${PLUGIN}/${OLD_JAR} not found -- base image changed; re-derive the netty fix." >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK"

# ---------------------------------------------------------------------------
# 1) Population + drift guards. A second copy appearing elsewhere, or a
#    re-pushed base whose jar changed, must stop the build rather than be
#    silently half-patched.
# ---------------------------------------------------------------------------
find / -xdev -type f -name 'netty-handler-*.jar' 2>/dev/null | sort > "${WORK}/copies.txt"
COPIES="$(wc -l < "${WORK}/copies.txt" | tr -d ' ')"
if [ "$COPIES" -ne 1 ]; then
  echo "FATAL: expected exactly ONE netty-handler jar in this image, found ${COPIES}:" >&2
  cat "${WORK}/copies.txt" >&2
  echo "       The base moved. Re-run scripts/ci/netty_link_check.py for each copy." >&2
  exit 1
fi
GOT="$(sha256sum "${PLUGIN}/${OLD_JAR}" | cut -d' ' -f1)"
if [ "$GOT" != "$OLD_SHA256" ]; then
  echo "FATAL: base-image drift. ${PLUGIN}/${OLD_JAR} hashes ${GOT}, expected ${OLD_SHA256}." >&2
  echo "       Re-run scripts/ci/netty_link_check.py against the new jar set." >&2
  exit 1
fi
echo "one netty-handler copy, digest matches the analysed base"

# ---------------------------------------------------------------------------
# 2) CONTROL RUN, before anything is touched. NettyLinkCheck records which
#    io.netty classes named by the handler jar this classpath cannot load. A
#    netty-handler ALWAYS names some it never could (this plugin ships no
#    netty-tcnative, so the whole native-OpenSSL family is unresolvable and
#    always was). Judging the raw set would fail every build and a spelling
#    allowlist would just move the lie, so the verdict is the DIFFERENCE.
# ---------------------------------------------------------------------------
echo "== SC1 netty link check: CONTROL (before the swap) =="
java -cp "${CLASSES}:${PLUGIN}/*" NettyLinkCheck \
  --jar "${PLUGIN}/${OLD_JAR}" \
  --expect "io.netty:netty-handler=${OLD_VERSION}" \
  --unresolved-out "${WORK}/ctl.txt" \
  --control --skip-ssl-probe

# ---------------------------------------------------------------------------
# 3) Fetch + install, preserving the upstream ownership and mode.
# ---------------------------------------------------------------------------
curl -fsSL -o "${WORK}/${NEW_JAR}" \
  "https://repo1.maven.org/maven2/io/netty/netty-handler/${NEW_VERSION}/netty-handler-${NEW_VERSION}.jar"
echo "${NEW_SHA256}  ${WORK}/${NEW_JAR}" | sha256sum -c -

install -m 0644 "${WORK}/${NEW_JAR}" "${PLUGIN}/${NEW_JAR}"
chown --reference="${PLUGIN}/${OLD_JAR}" "${PLUGIN}/${NEW_JAR}"
rm -f "${PLUGIN}/${OLD_JAR}"
echo "netty-handler: ${OLD_JAR} -> ${NEW_JAR}"

# ---------------------------------------------------------------------------
# 4) Assertions. A `rm` of a name that moved, or a curl that wrote a 200-byte
#    error page, would otherwise ship silently.
# ---------------------------------------------------------------------------
echo "== SC1 assertions =="
test ! -e "${PLUGIN}/${OLD_JAR}" || { echo "FATAL: ${OLD_JAR} still present" >&2; exit 1; }
test -s "${PLUGIN}/${NEW_JAR}" || { echo "FATAL: ${NEW_JAR} missing or empty" >&2; exit 1; }
LEFT="$(find / -xdev -type f -name "netty-handler-${OLD_VERSION}.jar" 2>/dev/null | wc -l | tr -d ' ')"
[ "$LEFT" -eq 0 ] || { echo "FATAL: ${LEFT} copies of ${OLD_JAR} survived" >&2; exit 1; }
echo "assertions passed"

# ---------------------------------------------------------------------------
# 5) TREATMENT RUN + the verdict: any io.netty class that resolved BEFORE the
#    swap and does not resolve after it is a regression and fails the build.
#    The SSL probe runs here too -- SslContextBuilder -> SslHandler ->
#    EmbeddedChannel links handler -> common -> buffer -> transport for real,
#    which a class-loading check alone does not.
# ---------------------------------------------------------------------------
echo "== SC1 netty link check: TREATMENT (after the swap) =="
java -cp "${CLASSES}:${PLUGIN}/*" NettyLinkCheck \
  --jar "${PLUGIN}/${NEW_JAR}" \
  --expect "io.netty:netty-handler=${NEW_VERSION}" \
  --unresolved-out "${WORK}/trt.txt"
sort -o "${WORK}/ctl.txt" "${WORK}/ctl.txt"
sort -o "${WORK}/trt.txt" "${WORK}/trt.txt"
NEWLY="$(comm -13 "${WORK}/ctl.txt" "${WORK}/trt.txt")"
if [ -n "$NEWLY" ]; then
  echo "FATAL: netty-handler ${NEW_VERSION} names io.netty classes that resolved before" >&2
  echo "       the swap and do NOT resolve after it:" >&2
  echo "$NEWLY" | sed 's/^/         /' >&2
  echo "       A sibling netty module in ${PLUGIN} is too old. Lift it, or re-derive the" >&2
  echo "       swap with scripts/ci/netty_link_check.py." >&2
  exit 1
fi
echo "0 newly-unresolvable io.netty classes vs the control"

rm -rf "$WORK"
echo "== SC1 loom-mirroring netty hardening complete =="
