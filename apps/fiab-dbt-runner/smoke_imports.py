"""Import smoke test for the dbt runner's pinned dependency set.

WHY THIS EXISTS
---------------
`apps/fiab-dbt-runner/requirements-security.txt` overrides a transitive pin
(deepdiff, held at 7.0.1 by dbt-common 1.27.1) to clear CVE-2025-58367, which
the SC1 Trivy CRITICAL gate blocks on. That override deliberately violates a
declared range, so pip prints a "dependency conflicts" advisory and STILL
EXITS 0 — a silent failure mode. `scripts/assert_security_pins.py` catches a
pin that did not land; this file catches the other half: a pin that landed and
BROKE something.

The only consumer of deepdiff in this tree is dbt-common's record/replay
harness (`dbt_common.record.Diff`), which constructs `DeepDiff` with
`ignore_order` / `verbose_level` / `exclude_paths`. Those four symbols are the
entire compatibility surface of the 7.x -> 8.x move, so this file exercises
them directly rather than asserting a version number and hoping.

Run: `python smoke_imports.py` from apps/fiab-dbt-runner (needs unixodbc on the
box, same as the image).
"""
from __future__ import annotations

import sys
import traceback

failures: list[str] = []


def check(label, fn):
    try:
        print(f"  ok   {label}: {fn()}")
    except Exception as exc:  # noqa: BLE001
        print(f"  FAIL {label}: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        failures.append(label)


def security_overrides_applied():
    """Every `name==version` in requirements-security.txt is what is installed."""
    import re
    from importlib.metadata import version
    from pathlib import Path

    req = Path(__file__).with_name("requirements-security.txt")
    pins = dict(
        re.findall(r"^\s*([A-Za-z0-9._-]+)==([^\s#]+)", req.read_text(), re.M)
    )
    if not pins:
        raise RuntimeError(f"{req.name} declares no pins — the override is a no-op")
    wrong = {n: (want, version(n)) for n, want in pins.items() if version(n) != want}
    if wrong:
        raise RuntimeError(
            "override NOT applied (did the second `pip install -r "
            f"requirements-security.txt` pass run?): {wrong}"
        )
    return ", ".join(f"{n}=={v}" for n, v in sorted(pins.items()))


def deepdiff_api_still_matches_dbt_common():
    """The exact DeepDiff call shape dbt_common.record.Diff uses.

    If deepdiff 8.x had renamed or dropped any of these kwargs, dbt's
    record/replay harness would raise at runtime instead of at build time.
    """
    import dbt_common.record  # noqa: F401  (proves the module still imports)
    from deepdiff import DeepDiff

    diff = DeepDiff(
        {"a": [1, 2, 3], "skip": 1},
        {"a": [3, 2, 1], "skip": 2},
        ignore_order=True,
        verbose_level=2,
        exclude_paths=["root['skip']"],
    )
    if diff:
        raise RuntimeError(
            f"ignore_order/exclude_paths no longer behave as dbt_common expects: {diff}"
        )
    changed = DeepDiff({"a": 1}, {"a": 2}, ignore_order=True, verbose_level=2)
    if "values_changed" not in changed:
        raise RuntimeError(f"DeepDiff stopped reporting values_changed: {changed}")
    return "DeepDiff(ignore_order, verbose_level, exclude_paths) behaves as dbt_common expects"


def main() -> int:
    print("=== runtime ===")
    check("python", lambda: sys.version.split()[0])
    check("fastapi", lambda: __import__("fastapi").__version__)
    check("pydantic", lambda: __import__("pydantic").VERSION)

    print("=== dbt engine ===")
    check(
        "dbt-core",
        lambda: __import__("dbt.version", fromlist=["get_installed_version"])
        .get_installed_version()
        .to_version_string(),
    )
    check(
        "dbt-common",
        lambda: __import__("importlib.metadata", fromlist=["version"]).version("dbt-common"),
    )
    check(
        "dbt.cli.main.dbtRunner",
        lambda: __import__("dbt.cli.main", fromlist=["dbtRunner"]).dbtRunner.__name__,
    )

    print("=== dbt adapters ===")
    for name, module in {
        "synapse": "dbt.adapters.synapse",
        "fabric": "dbt.adapters.fabric",
    }.items():
        check(f"adapter {name}", lambda m=module: __import__(m, fromlist=["*"]).__name__)

    print("=== security overrides (requirements-security.txt) ===")
    check("CVE-bearing transitive pins overridden", security_overrides_applied)
    check("deepdiff 8.x API still matches dbt_common", deepdiff_api_still_matches_dbt_common)

    print("=== app ===")
    check("app.main", lambda: __import__("app.main", fromlist=["app"]).app.title)

    print()
    if failures:
        print(f"SMOKE FAILED ({len(failures)}): {failures}")
        return 1
    print("SMOKE PASSED: dbt engine, both adapters, the security override, and the app import cleanly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
