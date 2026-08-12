"""Probe half of ``check_app_fresh_resolve.py`` -- runs INSIDE the freshly
created virtualenv, never in the caller's interpreter.

Reads a JSON spec on stdin, writes a JSON report on stdout:

  in : {"targets":  [{"file": str, "line": int, "module": str, "symbols": [str]}],
        "declared": [{"name": str, "spec": str}]}
  out: {"installed": {canonical_name: version},
        "failures":  [{... target ..., "kind": str, "error": str,
                       "providers": [{"dist": str, "version": str}]}]}

It reports only what it observed: the set of distributions the fresh resolve
actually installed, and the exception each import raised verbatim. It does not
infer WHY pip picked a version.
"""

from __future__ import annotations

import importlib
import json
import re
import sys
import traceback


def _canon(name: str) -> str:
    """PEP 503 normalized distribution name."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _installed() -> dict[str, str]:
    from importlib import metadata

    out: dict[str, str] = {}
    for dist in metadata.distributions():
        name = dist.metadata["Name"] if dist.metadata else None
        if not name:
            continue
        out[_canon(name)] = dist.version or "?"
    return out


def _providers(module: str) -> tuple[str, list[dict[str, str]]]:
    """Which installed distributions actually ship files under ``module``.

    Namespace packages (``azure``) are shared by many distributions, so naming
    every ``azure-*`` sibling would be noise. Instead walk each distribution's
    RECORD and match the deepest package path that any of them ships: for
    ``azure.mgmt.resource.resources.models`` that lands on ``azure-mgmt-resource``
    alone. Returns (matched_prefix, providers); an empty provider list means no
    installed distribution ships that path at all -- reported as such, not
    guessed at.
    """
    from importlib import metadata

    installed = _installed()
    dist_files: list[tuple[str, str, list[str]]] = []
    for dist in metadata.distributions():
        name = dist.metadata["Name"] if dist.metadata else None
        if not name:
            continue
        try:
            files = [str(f).replace("\\", "/") for f in (dist.files or [])]
        except Exception:  # pragma: no cover - defensive
            files = []
        dist_files.append((name, dist.version or "?", files))

    parts = module.split(".")
    for depth in range(len(parts), 0, -1):
        prefix = "/".join(parts[:depth])
        owners = sorted(
            {
                (name, ver)
                for name, ver, files in dist_files
                if any(f == f"{prefix}.py" or f.startswith(f"{prefix}/") for f in files)
            }
        )
        if owners:
            return prefix.replace("/", "."), [
                {"dist": n, "version": installed.get(_canon(n), v)} for n, v in owners
            ]
    return "", []


def main() -> int:
    spec = json.load(sys.stdin)
    installed = _installed()
    failures: list[dict[str, object]] = []

    for target in spec["targets"]:
        module = target["module"]
        entry = dict(target)
        try:
            mod = importlib.import_module(module)
        except BaseException:  # report anything the import raises, verbatim
            owned_path, providers = _providers(module)
            entry.update(
                kind="module-import-failed",
                error=traceback.format_exception_only(*sys.exc_info()[:2])[-1].strip(),
                providers=providers,
                owned_path=owned_path,
            )
            failures.append(entry)
            continue

        missing = [s for s in target["symbols"] if s != "*" and not hasattr(mod, s)]
        if missing:
            owned_path, providers = _providers(module)
            entry.update(
                kind="symbol-missing",
                error=(
                    f"module {module!r} imported, but does not define: "
                    + ", ".join(missing)
                ),
                providers=providers,
                owned_path=owned_path,
                missing=missing,
            )
            failures.append(entry)

    json.dump({"installed": installed, "failures": failures}, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
