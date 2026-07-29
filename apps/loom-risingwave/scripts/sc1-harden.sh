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
# 5) Link-check the classpath for real. This is the step that catches what the
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
