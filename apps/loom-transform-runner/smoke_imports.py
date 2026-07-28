"""Import smoke test for the transform runner's pinned dependency set.

WHY THIS EXISTS
---------------
`apps/loom-transform-runner/requirements.txt` was unresolvable for a long time
(dbt-core 1.8.9 wants protobuf<6, dbt-databricks 1.8.7 wanted protobuf<5) and
nothing noticed, because the only thing that ever read the file was an image
build nobody ran. The gate `svc-transform-runner` was therefore never clearable.

A `pip install --dry-run` catches THAT class of failure. It does not catch the
next one: this app pins dbt-core 1.8.9, whose `dbt-adapters<2.0` floor lets the
resolver pick an adapters release built for a much newer dbt-core. That
resolves fine and then explodes at import. So CI runs this file after a REAL
install, and it fails loudly if any engine, adapter, or app entrypoint cannot
actually be imported.

Run: `python smoke_imports.py` from apps/loom-transform-runner (needs unixodbc
on the box, same as the image).
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


def main() -> int:
    print("=== runtime ===")
    check("python", lambda: sys.version.split()[0])
    check("fastapi", lambda: __import__("fastapi").__version__)
    check("pydantic", lambda: __import__("pydantic").VERSION)
    check("protobuf", lambda: __import__("google.protobuf", fromlist=["__version__"]).__version__)

    print("=== dbt engine ===")
    check("dbt-core", lambda: __import__("dbt.version", fromlist=["get_installed_version"])
          .get_installed_version().to_version_string())
    check("dbt-adapters", lambda: __import__("importlib.metadata", fromlist=["version"]).version("dbt-adapters"))
    # The real programmatic entrypoint dbt_engine.run_dbt() calls.
    check("dbt.cli.main.dbtRunner", lambda: __import__("dbt.cli.main", fromlist=["dbtRunner"]).dbtRunner.__name__)

    print("=== dbt adapters (every one /capabilities advertises) ===")
    from app.main import EXPECTED_DBT_ADAPTERS

    for name, module in EXPECTED_DBT_ADAPTERS.items():
        check(f"adapter {name}", lambda m=module: __import__(m, fromlist=["*"]).__name__)

    print("=== sqlmesh engine ===")
    check("sqlmesh", lambda: __import__("sqlmesh").__version__)
    check("sqlmesh.core.config", lambda: __import__("sqlmesh.core.config", fromlist=["*"]).__name__)
    # The [dbt] extra — one project, either engine (the N4 backend selector).
    check("sqlmesh.dbt.project", lambda: __import__("sqlmesh.dbt.project", fromlist=["*"]).__name__)

    print("=== security overrides (requirements-security.txt) ===")

    def security_overrides_applied():
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

    check("CVE-bearing transitive pins overridden", security_overrides_applied)

    print("=== app ===")
    check("app.main", lambda: __import__("app.main", fromlist=["app"]).app.title)

    def capabilities_is_honest():
        from app.main import capabilities

        payload = capabilities()
        dbt = payload["engines"]["dbt"]
        if not dbt.get("available"):
            raise RuntimeError(f"dbt engine unavailable: {dbt.get('error')}")
        if dbt.get("missingAdapters"):
            raise RuntimeError(f"missing adapters: {dbt['missingAdapters']}")
        if not payload["engines"]["sqlmesh"].get("available"):
            raise RuntimeError("sqlmesh engine unavailable")
        return f"dbt {dbt['version']} adapters={dbt['adapters']}, sqlmesh ok"

    check("GET /capabilities reports both engines + all adapters", capabilities_is_honest)

    print()
    if failures:
        print(f"SMOKE FAILED ({len(failures)}): {failures}")
        return 1
    print("SMOKE PASSED: both engines, every adapter, and the app import cleanly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
