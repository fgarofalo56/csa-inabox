#!/usr/bin/env python3
"""Pre-commit hook: validate data contracts.

Mirrors the two checks the Validate Data Contracts CI workflow runs
(.github/workflows/validate-contracts.yml) so developers catch the same
errors locally before they reach CI.

1. examples/*/contracts/*.yaml must have the canonical top-level keys
   (apiVersion, kind, metadata, schema, sla, quality_rules) and the
   metadata block must have name/domain/owner/version/description.
   schema.columns[*] must have name + type.

2. csa_platform.governance.contracts.contract_validator --ci must pass
   for the domains/ tree (the live runtime validator).

Exits non-zero on any failure with a clear message; otherwise silent so
fast hooks stay fast.
"""
from __future__ import annotations

import glob
import subprocess
import sys
from pathlib import Path

REQUIRED_FIELDS = ["apiVersion", "kind", "metadata", "schema", "sla", "quality_rules"]
REQUIRED_METADATA = ["name", "domain", "owner", "version", "description"]


def check_example_contracts() -> list[str]:
    """Validate examples/*/contracts/*.yaml against the canonical schema."""
    try:
        import yaml  # local import: keep --help fast
    except ImportError:
        return ["pyyaml not installed; run `pip install pyyaml` or `pip install -e .`"]

    errors: list[str] = []
    contracts = sorted(glob.glob("examples/*/contracts/*.yaml"))

    for path in contracts:
        try:
            with open(path, encoding="utf-8") as f:
                doc = yaml.safe_load(f)
        except yaml.YAMLError as exc:
            errors.append(f"{path}: YAML parse error: {exc}")
            continue
        if not isinstance(doc, dict):
            errors.append(f"{path}: top-level YAML must be a mapping")
            continue

        for field in REQUIRED_FIELDS:
            if field not in doc:
                errors.append(f"{path}: missing required field '{field}'")

        meta = doc.get("metadata") or {}
        if isinstance(meta, dict):
            for field in REQUIRED_METADATA:
                if field not in meta:
                    errors.append(f"{path}: metadata missing '{field}'")

        schema = doc.get("schema") or {}
        if isinstance(schema, dict):
            cols = schema.get("columns") or []
            for i, col in enumerate(cols):
                if not isinstance(col, dict):
                    errors.append(f"{path}: schema.columns[{i}] is not a mapping")
                    continue
                if "name" not in col or "type" not in col:
                    errors.append(
                        f"{path}: schema.columns[{i}] missing 'name' or 'type'"
                    )

    return errors


def check_platform_contracts() -> list[str]:
    """Run the runtime validator that enforces domains/ contracts."""
    if not Path("csa_platform/governance/contracts/contract_validator.py").exists():
        return []  # repo layout changed; skip silently
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "csa_platform.governance.contracts.contract_validator",
            "--ci",
            "--repo-root",
            ".",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        # Show only the last few lines; the validator emits one log line per
        # contract which is noisy for a precommit hook.
        tail = "\n".join(
            (proc.stdout + proc.stderr).strip().splitlines()[-10:]
        )
        return [f"csa_platform contract_validator failed:\n{tail}"]
    return []


def main() -> int:
    errors = check_example_contracts() + check_platform_contracts()
    if errors:
        print("Data contract validation failed:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        print(
            "\nFix the contracts above or run "
            "`python scripts/precommit_validate_contracts.py` to re-check.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
