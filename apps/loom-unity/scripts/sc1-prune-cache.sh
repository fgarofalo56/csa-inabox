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
WORK=/tmp/loom-sc1
KEEP="${WORK}/keep.txt"
PRESENT="${WORK}/present.txt"
ALL="${WORK}/all.txt"
DROP="${WORK}/drop.txt"
CPFILES="${WORK}/cpfiles.txt"

echo "== SC1 loom-unity cache prune =="
if [ ! -d "$CACHE" ]; then
  echo "FATAL: ${CACHE} does not exist -- the upstream image layout changed. Re-derive the fix." >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK"

# 1) Every classpath file in the image (server, CLI, clients, sub-project targets).
find "$UC_HOME" -type f -name classpath | sort > "$CPFILES"
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
tr ':' '\n' < "${WORK}/cp.raw" | sed 's/[[:space:]]*$//' | grep -vE '^$' | sort -u > "${WORK}/entries.txt"
grep -E '\.jar$' "${WORK}/entries.txt" > "$KEEP" || true
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

# 3) Everything cached, and the difference.
find "$CACHE" -type f -name '*.jar' | sort -u > "$ALL"
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

# The specific CVE this prune exists to clear.
find "$CACHE" \( -name 'bcprov-*.jar' -o -name 'bcpg-*.jar' \) > "${WORK}/bc.txt"
if [ -s "${WORK}/bc.txt" ]; then
  echo "FATAL: a bouncycastle jar survived the prune -- CVE-2025-14813 would still be reported:" >&2
  cat "${WORK}/bc.txt" >&2
  exit 1
fi

echo "assertions passed ($(wc -l < "$PRESENT") classpath entries intact, $(wc -l < "$DROP") unreferenced jars removed)"
rm -rf "$WORK"
echo "== SC1 loom-unity cache prune complete =="
