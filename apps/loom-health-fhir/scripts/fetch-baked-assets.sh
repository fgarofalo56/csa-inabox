#!/bin/sh
# Build-time fetch of the validator CLI and the US Core package closure.
# Every artifact is checked against a sha256 pinned in this repo; a mismatch or a
# failed download aborts the build (set -e, no `|| true`). The RUNTIME image never
# downloads anything: this script only runs in a build stage.
#
#   fetch-baked-assets.sh <lock-dir> <out-dir>
set -eu
LOCK_DIR="$1"
OUT="$2"
mkdir -p "$OUT/packages" "$OUT/validator"

verify() { # <file> <expected-sha256> <label>
  actual=$(sha256sum "$1" | cut -d' ' -f1)
  if [ "$actual" != "$2" ]; then
    echo "ERROR: sha256 mismatch for $3: expected $2, got $actual" >&2
    exit 1
  fi
  echo "ok  $3  $actual"
}

# validator.lock: key=value lines (version, url, sha256)
VER=$(sed -n 's/^version=//p' "$LOCK_DIR/validator.lock" | tr -d '[:cntrl:]')
URL=$(sed -n 's/^url=//p' "$LOCK_DIR/validator.lock" | tr -d '[:cntrl:]')
SHA=$(sed -n 's/^sha256=//p' "$LOCK_DIR/validator.lock" | tr -d '[:cntrl:]')
if [ -z "$VER" ] || [ -z "$URL" ] || [ -z "$SHA" ]; then
  echo "ERROR: validator.lock is missing version/url/sha256" >&2
  exit 1
fi
curl -fsSL --retry 3 -o "$OUT/validator/validator_cli.jar" "$URL"
verify "$OUT/validator/validator_cli.jar" "$SHA" "validator_cli.jar $VER"
echo "$VER" > "$OUT/validator/VERSION"

# otel-agent.lock: patched OpenTelemetry Java agent that replaces the one shipped in the
# base image (CVE-2026-33701, fixed in 2.26.1). Same key=value shape as validator.lock.
mkdir -p "$OUT/agent"
OVER=$(sed -n 's/^version=//p' "$LOCK_DIR/otel-agent.lock" | tr -d '[:cntrl:]')
OURL=$(sed -n 's/^url=//p' "$LOCK_DIR/otel-agent.lock" | tr -d '[:cntrl:]')
OSHA=$(sed -n 's/^sha256=//p' "$LOCK_DIR/otel-agent.lock" | tr -d '[:cntrl:]')
if [ -z "$OVER" ] || [ -z "$OURL" ] || [ -z "$OSHA" ]; then
  echo "ERROR: otel-agent.lock is missing version/url/sha256" >&2
  exit 1
fi
curl -fsSL --retry 3 -o "$OUT/agent/opentelemetry-javaagent.jar" "$OURL"
verify "$OUT/agent/opentelemetry-javaagent.jar" "$OSHA" "opentelemetry-javaagent $OVER"

# jdbc-auth.lock.tsv: the Entra (passwordless) JDBC auth plugin and its runtime closure, minus
# what the pinned HAPI main.war already ships (jackson, reactor-core, slf4j, pgjdbc, nimbus,
# jspecify...) and minus non-linux-x86_64 natives. Columns: group, artifact, version, file,
# sha256, url. Baked into /app/extra-classes so PropertiesLauncher puts it on the class path.
mkdir -p "$OUT/jdbc-auth"
sed 's/[[:cntrl:]]*$//' "$LOCK_DIR/jdbc-auth.lock.tsv" > "$OUT/jdbc-auth.lock.lf"
JCOUNT=0
while IFS="$(printf '\t')" read -r _G _A _V FILE SUM URL; do
  [ -z "$FILE" ] && continue
  case "$URL" in https://repo1.maven.org/maven2/*) ;; *) echo "ERROR: jdbc-auth url not Maven Central: $URL" >&2; exit 1 ;; esac
  curl -fsSL --retry 3 -o "$OUT/jdbc-auth/$FILE" "$URL"
  verify "$OUT/jdbc-auth/$FILE" "$SUM" "$FILE"
  JCOUNT=$((JCOUNT + 1))
done < "$OUT/jdbc-auth.lock.lf"
[ "$JCOUNT" -ge 10 ] || { echo "ERROR: jdbc-auth.lock.tsv listed only $JCOUNT jars" >&2; exit 1; }
echo "baked $JCOUNT JDBC auth jars"

# packages.lock.tsv: name <TAB> version <TAB> sha256
COUNT=0
sed 's/[[:cntrl:]]*$//' "$LOCK_DIR/packages.lock.tsv" > "$OUT/packages.lock.lf"
while IFS="$(printf '\t')" read -r NAME VERSION SUM; do
  [ -z "$NAME" ] && continue
  F="$OUT/packages/$NAME-$VERSION.tgz"
  curl -fsSL --retry 3 -o "$F" "https://packages.fhir.org/$NAME/$VERSION"
  verify "$F" "$SUM" "$NAME#$VERSION"
  # Seed the validator's package cache from the VERIFIED tarball (layout:
  # <home>/.fhir/packages/<name>#<version>/package/...), so the validator never
  # resolves a package over the network.
  CACHE="$OUT/home/.fhir/packages/$NAME#$VERSION"
  mkdir -p "$CACHE"
  tar -xzf "$F" -C "$CACHE"
  COUNT=$((COUNT + 1))
done < "$OUT/packages.lock.lf"
printf '[cache]\nversion = 4\n' > "$OUT/home/.fhir/packages/packages.ini"
echo "baked $COUNT FHIR packages + validator $VER"
