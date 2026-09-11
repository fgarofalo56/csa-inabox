#!/bin/sh
# CSA Loom -- loom-risingwave connector-node SC1 hardening (Trivy CRITICAL gate).
#
# Runs at image-build time as the sole owner of every Java-layer CVE fix in this
# image. Lives in a FILE, not an inline Dockerfile heredoc: ACR Tasks' classic
# builder cannot parse heredocs (they need BuildKit) -- one builds fine under a
# local `docker build` and then dies in CI after ~3s with
#   `failed to run step ID: build: failed to scan dependencies: exit status 1`
# before any layer runs, naming neither the heredoc nor the parser.
#
# The scan that produced this list (trivy 0.72.0, --severity CRITICAL
# --ignore-unfixed --scanners vuln --pkg-types os,library) reported 21 Java
# CRITICALs in risingwavelabs/risingwave:v2.1.3, all in
# /risingwave/bin/connector-node/libs:
#
#   19  htrace-core-3.2.0-incubating.jar  (shaded jackson-databind 2.4.0)
#    1  avro-1.11.3.jar                   (CVE-2024-47561)
#    1  parquet-avro-1.12.3.jar           (CVE-2025-30065)
#
# Disposition per finding is documented at each step below. The connector node
# builds its classpath with a WILDCARD (`java -classpath "${DIR}/libs/*"`, see
# start-service.sh), so replacing or removing a jar needs no classpath edit --
# but it also means a bad change fails only at runtime, which is why
# ConnectorLibsSmokeTest.java link-checks every affected class here, at BUILD
# time. (That test is not decoration: it is what caught the first attempt at the
# htrace fix -- repacking the jar without its shaded jackson left
# org.apache.htrace.impl.MilliSpan unable to run its static initialiser.)

set -eu

LIBS=/risingwave/bin/connector-node/libs
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

# Pinned replacement artifact + its checksum. The digest was verified by
# downloading from Maven Central on 2026-07-28 and hashing locally; a tampered or
# truncated download fails the build instead of shipping.
AVRO_OLD=avro-1.11.3.jar
AVRO_VERSION=1.11.4
AVRO_SHA256=eeba11b77070b9aa6337d886fdf778f6695f6c4c3dcfd2a02389925c885079fa

PARQUET_AVRO_OLD=parquet-avro-1.12.3.jar
HTRACE_JAR=htrace-core-3.2.0-incubating.jar

echo "== SC1 connector-node hardening =="
if [ ! -d "$LIBS" ]; then
  echo "FATAL: $LIBS does not exist -- the base image layout changed. Re-derive the fix." >&2
  exit 1
fi
cd "$LIBS"

# ---------------------------------------------------------------------------
# 1) avro 1.11.3 -> 1.11.4  (CVE-2024-47561, CRITICAL: Avro schema parsing can
#    reach arbitrary class instantiation -> RCE. Fixed upstream in 1.11.4.)
#
# UPGRADE, not removal: org.apache.avro is LIVE code here -- hadoop-common,
# hadoop-mapreduce-client-core, hive-serde, iceberg-core, iceberg-data and
# iceberg-parquet all link against it. 1.11.4 is a patch release inside the
# pinned 1.11.x line (1.12.x moves the ecosystem's compile baseline and is what
# risingwave v3.x carries; that belongs to a base-image bump, not a CVE patch).
# This is the same CVE, and the same disposition, the repo already recorded for
# loom-mirroring in .trivyignore's audit trail.
# ---------------------------------------------------------------------------
if [ ! -f "$AVRO_OLD" ]; then
  echo "FATAL: $AVRO_OLD not found in $LIBS -- base image changed; re-derive the avro fix." >&2
  exit 1
fi
curl -fsSL -o "avro-${AVRO_VERSION}.jar" \
  "https://repo1.maven.org/maven2/org/apache/avro/avro/${AVRO_VERSION}/avro-${AVRO_VERSION}.jar"
echo "${AVRO_SHA256}  avro-${AVRO_VERSION}.jar" | sha256sum -c -
rm -f "$AVRO_OLD"
echo "avro: ${AVRO_OLD} -> avro-${AVRO_VERSION}.jar"

# ---------------------------------------------------------------------------
# 2) parquet-avro 1.12.3 -> DELETED  (CVE-2025-30065, CRITICAL: parquet-avro
#    schema parsing -> RCE. Fixed upstream in 1.15.1.)
#
# REMOVAL, not upgrade, because the jar is already inert: every parquet-avro
# >= 1.11 needs org.apache.parquet.schema.LogicalTypeAnnotation, and the only
# parquet core on this classpath is parquet-hadoop-bundle-1.10.0, which predates
# that class. Loading org.apache.parquet.avro.AvroSchemaConverter in the
# UNMODIFIED base image throws
#   NoClassDefFoundError: org/apache/parquet/schema/LogicalTypeAnnotation
# (measured, not assumed). Nothing can be calling it today, and swapping in
# 1.15.x would ship the same unloadable jar with a newer version string --
# version theatre, not a fix. Making it genuinely loadable would mean bumping the
# whole parquet family (bundle 1.10.0 -> 1.15.x, which is what risingwave v3.x
# does), a functional re-platform that does not belong in a CVE patch.
#
# Blast radius: iceberg-parquet-1.5.2 is the sole referrer and it hits the same
# NoClassDefFoundError today. ConnectorLibsSmokeTest asserts iceberg-parquet,
# parquet-hadoop and parquet-schema all still load afterwards.
# ---------------------------------------------------------------------------
if [ ! -f "$PARQUET_AVRO_OLD" ]; then
  echo "FATAL: $PARQUET_AVRO_OLD not found in $LIBS -- base image changed; re-derive the parquet fix." >&2
  exit 1
fi
rm -f "$PARQUET_AVRO_OLD"
echo "parquet-avro: ${PARQUET_AVRO_OLD} -> removed (unloadable on this classpath)"

# ---------------------------------------------------------------------------
# 3) htrace-core 3.2.0-incubating -> DELETED  (19 CRITICALs: the jar is a SHADED
#    uber-jar carrying a whole copy of jackson-core / jackson-databind /
#    jackson-annotations 2.4.0 relocated under org/apache/htrace/fasterxml/**,
#    which is the entire jackson-databind polymorphic-deserialization gadget
#    family -- CVE-2017-7525, -15095, -17485, CVE-2018-7489, -11307, -14718,
#    -14719, -19362, CVE-2019-14379, -14540, -16335, -16942, -16943, -17267,
#    -17531, -20330, CVE-2020-8840, -9547, -9548.)
#
# REMOVAL, because there is no upgrade and no safe repack:
#   * No upgrade path. Apache HTrace was retired to the Attic; 3.2.0-incubating
#     (2015) is the last 3.x release, and 4.x renamed the entire API surface to
#     org.apache.htrace.core.*, which the hbase 2.0.0-alpha4 jars here cannot
#     consume.
#   * No safe repack. Stripping just the shaded jackson was tried first and the
#     build-time smoke test rejected it: org.apache.htrace.impl.MilliSpan holds a
#     static ObjectMapper, so it can no longer run its static initialiser. And
#     re-shading a PATCHED jackson into org/apache/htrace/fasterxml/** is not a
#     byte-level rename (the source and target package names differ in length,
#     so every CONSTANT_Utf8 length prefix would have to be rewritten), i.e. it
#     needs a real bytecode shader -- far more machinery than the finding merits.
#
# WHY DELETING IT CANNOT REGRESS ANYTHING: htrace-core sits in a dead 15-jar
# island. Decompiling the constant pool of all 460 OTHER jars in this directory
# finds ZERO references to org/apache/htrace, org/apache/hadoop/hbase or
# co/cask/tephra, and there is no META-INF/services entry naming any of them.
# (The only textual mentions anywhere outside the island are inert: hadoop's
# application-classloader.properties filter list, and hive-metastore's own
# pom.xml.) htrace's referrers are hbase-client/hbase-common; theirs is
# tephra-hbase-compat; and nothing at all references tephra. RisingWave ships no
# HBase sink. ConnectorLibsSmokeTest asserts the classes are gone AND that
# hadoop-common, iceberg and the connector-node entrypoint still link.
#
# The 11 hbase-* / 3 tephra-* jars are deliberately LEFT IN PLACE: they carry no
# CRITICAL of their own, so removing them would be an extra claim to defend
# rather than part of this fix. They were already unreachable before this change.
# ---------------------------------------------------------------------------
if [ ! -f "$HTRACE_JAR" ]; then
  echo "FATAL: $HTRACE_JAR not found in $LIBS -- base image changed; re-derive the htrace fix." >&2
  exit 1
fi
rm -f "$HTRACE_JAR"
echo "htrace: ${HTRACE_JAR} -> removed (dead island, shaded jackson-databind 2.4.0)"

# ---------------------------------------------------------------------------
# 4) Assert every change landed. A `rm` of a name that moved, or a curl that
#    wrote a 200-byte error page, would otherwise ship silently.
# ---------------------------------------------------------------------------
echo "== SC1 assertions =="
test ! -e "$AVRO_OLD" || { echo "FATAL: $AVRO_OLD still present" >&2; exit 1; }
test -s "avro-${AVRO_VERSION}.jar" || { echo "FATAL: avro-${AVRO_VERSION}.jar missing or empty" >&2; exit 1; }
test ! -e "$HTRACE_JAR" || { echo "FATAL: $HTRACE_JAR still present" >&2; exit 1; }
if ls parquet-avro-*.jar >/dev/null 2>&1; then
  echo "FATAL: a parquet-avro jar is still present in $LIBS" >&2
  exit 1
fi
if ls htrace-*.jar >/dev/null 2>&1; then
  echo "FATAL: an htrace jar is still present in $LIBS" >&2
  exit 1
fi
echo "assertions passed"

# ---------------------------------------------------------------------------
# 5) netty 4.1.77 -> 4.1.137 for the SIX CORE MODULES  (#4429, CVE-2026-75595,
#    CRITICAL: io.netty:netty-handler. Fixed upstream in 4.1.137.Final on the
#    4.1 line and 4.2.17.Final on the 4.2 line; 4.1.137 is the minimal version
#    that clears it without leaving this image's netty line.)
#
# WHY SIX MODULES AND NOT JUST netty-handler. This is the one image of the four
# where lifting the flagged jar ALONE is a real breakage, and it was measured
# rather than guessed. netty-handler 4.1.137's
#   io.netty.handler.ssl.util.LazyX509Certificate$CertFactoryHandle
# references io.netty.util.Recycler$EnhancedHandle, which netty-common 4.1.77
# does NOT contain (4.1.137 does). scripts/ci/netty_link_check.py, run forward
# against the jars extracted from the pinned base, shows exactly one NEW
# unresolved class versus the 4.1.77 CONTROL -- that one. A plain Class.forName
# would not have caught it either: the reference is a member reference, not a
# supertype, and HotSpot resolves those lazily.
#
# So the fix lifts the whole 4.1.77 CORE -- common, buffer, codec, resolver,
# transport, handler -- to 4.1.137, and leaves the 4.1.100 LEAF modules
# (codec-http, codec-dns, handler-proxy, transport-classes-epoll, the native
# .so jars, ...) alone. That direction is the safe one: a 4.1.100 leaf calling a
# 4.1.137 core uses API that existed at 4.1.100 and was not removed, whereas the
# reverse is what just broke. Measured, over the WHOLE directory:
#   * every one of the 35 netty jars re-checked against the lifted set:
#     0 newly-unresolved classes, 0 newly-unresolved members;
#   * it FIXES 182 references that were ALREADY unresolved in the unmodified
#     base -- upstream's 4.1.100 leaves were sitting on a 4.1.77 core, so
#     netty-codec-http, netty-codec-http2, transport-classes-epoll and
#     transport-classes-kqueue each had dangling references before this change;
#   * the other 439 jars on the connector-node classpath (157,656 classes):
#     0 unresolved io.netty references, before AND after.
# netty-all-4.1.100.Final.jar is deliberately untouched: measured, it contains
# ZERO class entries (it is the empty aggregator jar, not a 4.0-era uber-jar),
# so it cannot shadow anything.
#
# UPGRADE, not removal: netty is live code here -- the connector node's JDBC,
# Elasticsearch, Cassandra and Iceberg sinks all sit on it.
# ---------------------------------------------------------------------------
NETTY_OLD=4.1.77.Final
NETTY_NEW=4.1.137.Final
# Each digest verified 2026-09-11 by downloading from Maven Central and hashing
# locally; every value matched the published .jar.sha256 sidecar. The OLD digest
# is the base image's own copy, so a re-pushed base tag that changed a jar fails
# the build instead of being silently patched on top of something the link
# analysis never saw.
#   module|new sha256|old sha256
NETTY_MODULES="
netty-common|d31926b01adcc07af86f5e27b81b6d6c115df17d366e835d1fc3f5a1924e7e52|40dd9b5ef14878f050a1f7f4d5647d53473f134e349665b47243bde56de7a51f
netty-buffer|f474b14c7734f15e0540394cb6f39d67777b7581a42919e4ac89d253d4efd929|41b7ddc4dd124c7e75af33a13a426fda4e1ec87c387cd234971e7df4c0b51c26
netty-codec|9987b6a660b0a6b1f0d791485dae33180b3d1c63687c006fe6d3fd025e9e3798|84e4e01dd5b345311e971289b5bc08c0dfd6054a28d16853f0416943c9a3e458
netty-resolver|b4cf2aeedd9fc7c8c439bbfe574f63cfe5b83392e88bbc07ca0e8424b7cff955|0161cfe9544b3656ed0de67d8937828101859e94bcd0caaf58d21ac7011eabd4
netty-transport|6251adc2a2921572382732a2db188d4f4f2251fd6ebb49c5d44bbf33d6bfb1a7|034cdf7d81feaad9977c3d8b4fc05611952bc9861dfb9085b8962e2c1de582aa
netty-handler|d0e4c6ee4779f59f6ab2fb5d388e4f57147c82270164b37945764bb9bda96a44|7911becd4850ff3fc3d93b4be7c468a2f6444fb48c17eec03c807856faf11e0a
"

NETTY_WORK=/tmp/loom-sc1-netty
rm -rf "$NETTY_WORK"
mkdir -p "$NETTY_WORK"

echo "== SC1 netty core ${NETTY_OLD} -> ${NETTY_NEW} =="

# 5a) Drift guard: every module we are about to replace must be the exact jar
#     the link analysis was run against.
for ROW in $NETTY_MODULES; do
  M="${ROW%%|*}"; REST="${ROW#*|}"; OLD_SHA="${REST#*|}"
  OLDF="${M}-${NETTY_OLD}.jar"
  if [ ! -f "$OLDF" ]; then
    echo "FATAL: ${OLDF} not found in ${LIBS} -- base image changed; re-derive the netty fix." >&2
    exit 1
  fi
  GOT="$(sha256sum "$OLDF" | cut -d' ' -f1)"
  if [ "$GOT" != "$OLD_SHA" ]; then
    echo "FATAL: base-image drift. ${OLDF} hashes ${GOT}, expected ${OLD_SHA}." >&2
    echo "       Re-run scripts/ci/netty_link_check.py against the new jar set." >&2
    exit 1
  fi
done
echo "all six ${NETTY_OLD} modules match the analysed base"

# 5b) CONTROL RUN on the UNMODIFIED classpath. The verdict below is the
#     DIFFERENCE against this, never the raw unresolved set: a netty-handler
#     always names classes this image never carried (it ships no
#     netty-tcnative, so the whole native-OpenSSL family is unresolvable and
#     always was). See NettyLinkCheck's javadoc.
#
#     The control probes ALL SIX modules, not just the handler. Probing one and
#     comparing against six is not a control at all -- it flagged four
#     pre-existing absences on the first local run (the optional
#     netty-codec-marshalling family, referenced by netty-codec, and
#     io.netty.util.internal.Hidden$NettyBlockHoundIntegration, which needs
#     reactor-blockhound) purely because the control had never looked at
#     netty-codec or netty-common. Same subjects on both sides, or the
#     difference measures the method instead of the change.
echo "== SC1 netty link check: CONTROL (before the lift) =="
javac -nowarn -d "$NETTY_WORK" "${SCRIPTS}/NettyLinkCheck.java"
NETTY_CONTROL_ARGS=""
for ROW in $NETTY_MODULES; do
  M="${ROW%%|*}"
  NETTY_CONTROL_ARGS="${NETTY_CONTROL_ARGS} --jar ${LIBS}/${M}-${NETTY_OLD}.jar --expect io.netty:${M}=${NETTY_OLD}"
done
# shellcheck disable=SC2086  # one --jar/--expect pair per module, built above
java -cp "${NETTY_WORK}:${LIBS}/*" NettyLinkCheck \
  $NETTY_CONTROL_ARGS \
  --unresolved-out "${NETTY_WORK}/ctl.txt" \
  --control --skip-ssl-probe

# 5c) Fetch, verify, install, remove.
NETTY_LINKCHECK_ARGS=""
for ROW in $NETTY_MODULES; do
  M="${ROW%%|*}"; REST="${ROW#*|}"; NEW_SHA="${REST%%|*}"
  OLDF="${M}-${NETTY_OLD}.jar"
  NEWF="${M}-${NETTY_NEW}.jar"
  curl -fsSL -o "$NEWF" \
    "https://repo1.maven.org/maven2/io/netty/${M}/${NETTY_NEW}/${NEWF}"
  echo "${NEW_SHA}  ${NEWF}" | sha256sum -c -
  rm -f "$OLDF"
  echo "netty: ${OLDF} -> ${NEWF}"
  NETTY_LINKCHECK_ARGS="${NETTY_LINKCHECK_ARGS} --jar ${LIBS}/${NEWF} --expect io.netty:${M}=${NETTY_NEW}"
done

# 5d) Assertions -- a curl that wrote an error page, or an rm of a name that
#     moved, would otherwise ship silently.
echo "== SC1 netty assertions =="
for ROW in $NETTY_MODULES; do
  M="${ROW%%|*}"
  test ! -e "${M}-${NETTY_OLD}.jar" || { echo "FATAL: ${M}-${NETTY_OLD}.jar still present" >&2; exit 1; }
  test -s "${M}-${NETTY_NEW}.jar" || { echo "FATAL: ${M}-${NETTY_NEW}.jar missing or empty" >&2; exit 1; }
done
if ls netty-*-"${NETTY_OLD}".jar >/dev/null 2>&1; then
  echo "FATAL: a ${NETTY_OLD} netty jar is still present in ${LIBS}" >&2
  ls netty-*-"${NETTY_OLD}".jar >&2
  exit 1
fi
echo "netty assertions passed (6 modules lifted, 0 ${NETTY_OLD} jars left)"

# 5e) TREATMENT RUN + the verdict. The SSL probe runs here too: SslContextBuilder
#     -> SslHandler -> EmbeddedChannel links handler -> common -> buffer ->
#     transport for real, which a class-loading check alone does not.
echo "== SC1 netty link check: TREATMENT (after the lift) =="
# shellcheck disable=SC2086  # the args are built above, one --jar/--expect pair per module
java -cp "${NETTY_WORK}:${LIBS}/*" NettyLinkCheck \
  $NETTY_LINKCHECK_ARGS \
  --unresolved-out "${NETTY_WORK}/trt.txt"
sort -o "${NETTY_WORK}/ctl.txt" "${NETTY_WORK}/ctl.txt"
sort -o "${NETTY_WORK}/trt.txt" "${NETTY_WORK}/trt.txt"
NETTY_NEWLY="$(comm -13 "${NETTY_WORK}/ctl.txt" "${NETTY_WORK}/trt.txt")"
if [ -n "$NETTY_NEWLY" ]; then
  echo "FATAL: the lifted netty core names io.netty classes that resolved before the" >&2
  echo "       lift and do NOT resolve after it:" >&2
  echo "$NETTY_NEWLY" | sed 's/^/         /' >&2
  echo "       Re-derive the module set with scripts/ci/netty_link_check.py." >&2
  exit 1
fi
echo "0 newly-unresolvable io.netty classes vs the control"
rm -rf "$NETTY_WORK"

# ---------------------------------------------------------------------------
# 6) Link-check the classpath for real. This is the step that catches what the
#    file assertions cannot: a class that no longer resolves its neighbours.
# ---------------------------------------------------------------------------
echo "== SC1 classpath smoke test =="
SMOKE_DIR=/tmp/loom-sc1-smoke
rm -rf "$SMOKE_DIR"
mkdir -p "$SMOKE_DIR"
cp "${SCRIPTS}/ConnectorLibsSmokeTest.java" "$SMOKE_DIR/"
javac -nowarn -d "$SMOKE_DIR" "${SMOKE_DIR}/ConnectorLibsSmokeTest.java"
java -cp "${SMOKE_DIR}:${LIBS}/*" ConnectorLibsSmokeTest
rm -rf "$SMOKE_DIR"

echo "== SC1 connector-node hardening complete =="
