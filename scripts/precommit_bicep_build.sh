#!/usr/bin/env bash
# Pre-commit hook: compile every changed .bicep file.
# Args: list of .bicep file paths from pre-commit.
set -euo pipefail

if ! command -v bicep >/dev/null 2>&1; then
  echo "[bicep-build] 'bicep' CLI not found on PATH; skipping (CI will still run it)." >&2
  exit 0
fi

failed=0
for f in "$@"; do
  if [[ ! -f "$f" ]]; then continue; fi
  if ! out=$(bicep build --stdout "$f" 2>&1 >/dev/null); then
    echo "::error file=$f::bicep build failed"
    echo "$out"
    failed=$((failed+1))
  fi
done

if [[ $failed -gt 0 ]]; then
  echo "[bicep-build] $failed file(s) failed to compile" >&2
  exit 1
fi
