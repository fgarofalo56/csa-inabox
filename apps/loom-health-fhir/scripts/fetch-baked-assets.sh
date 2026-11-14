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
