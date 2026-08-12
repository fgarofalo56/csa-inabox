#!/usr/bin/env python
"""FRESH-RESOLVE GUARD -- does what the app's Dockerfile does, then checks that
the code can actually import what it imports.

WHY THIS EXISTS (2026-08-10, story 3063)
----------------------------------------
``apps/fiab-setup-orchestrator/Dockerfile`` runs a bare ``pip install .`` with no
lockfile and no constraints file, so **every image build fresh-resolves** the
specifiers in that app's own ``pyproject.toml`` to whatever is newest on PyPI at
build time. ``azure-mgmt-resource`` was pinned ``>=23.2.0`` with no upper bound;
v25/v26 moved ``Deployment`` / ``DeploymentProperties`` / ``DeploymentMode`` /
``TemplateLink`` out of ``azure.mgmt.resource.resources.models`` and dropped
``ResourceManagementClient`` from ``azure.mgmt.resource`` entirely. Every image
built after that release shipped a Setup Wizard whose Deploy path raised
ImportError on first use. Nothing in CI noticed: the root ``pyproject.toml``
``testpaths`` do not include ``apps/**``, so the app's own tests were never
collected, and the only workflow references to the app are image builds.

WHAT THIS GUARD IS KEYED TO
---------------------------
The **mismatch** between (a) the import statements in the app's own source and
(b) what a clean venv resolving that same ``pyproject.toml`` actually provides.
It is deliberately NOT keyed to any version string or to the presence of an
upper bound: adopting the fix removes those tokens, and a rule keyed to them
would go quiet on exactly the files it just fixed. This one keeps checking every
import, forever, against whatever pip resolves today.

IT REFUSES TO PASS ON AN EMPTY POPULATION
-----------------------------------------
Hard failure -- not a skip -- when: the app directory or its pyproject is missing;
the source tree yields zero third-party imports; ``pip install`` resolves zero
distributions; a declared direct dependency is absent from the resolved
environment; or no workflow builds the app's Docker context.

WHAT IT DOES *NOT* ESTABLISH
----------------------------
It does not establish why pip chose a version -- it reports the specifier as
declared and the version resolved, side by side. It checks module + top-level
symbol imports only; it does not exercise operation groups, network calls, or
runtime behaviour. Those are the app's own tests, run separately in the same
venv by the CI leg.

CLOUD PARITY
------------
There is exactly ONE ``pyproject.toml`` and ONE ``Dockerfile`` per app, and every
image builder consumes that same context, so a pass here covers every boundary
that builds the image FROM THAT CONTEXT. The guard prints the builders it found
and FAILS on zero, so a boundary-specific fork of the build context cannot go
unnoticed. What it cannot tell you is whether a given boundary actually runs the
resulting container -- that is a bicep activation question, not a resolution one,
and the guard does not claim to answer it.

USAGE
-----
    python scripts/ci/check_app_fresh_resolve.py [APP_DIR ...]

Defaults to ``apps/fiab-setup-orchestrator``. Exit 0 = clean, 1 = mismatch or
empty population.
"""

from __future__ import annotations

import ast
import json
import os
import re
import shutil
import subprocess
import sys
import sysconfig
import tempfile
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - 3.10 fallback
    import tomli as tomllib  # type: ignore[no-redef]

# Windows consoles default to cp1252 and raise UnicodeEncodeError on anything a
# dependency name or an SDK exception message might legitimately contain.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

REPO_ROOT = Path(__file__).resolve().parents[2]
PROBE = Path(__file__).resolve().parent / "_fresh_resolve_probe.py"

DEFAULT_APPS = ["apps/fiab-setup-orchestrator"]

# A requirement specifier: name, optional [extras], then the version spec.
_REQ_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?")


class GuardFailureError(Exception):
    """A condition under which the guard must fail rather than pass or skip."""


def canon(name: str) -> str:
    """PEP 503 normalized distribution name."""
    return re.sub(r"[-_.]+", "-", name).lower()


def declared_dependencies(pyproject: Path) -> list[dict[str, str]]:
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    raw = data.get("project", {}).get("dependencies", [])
    out: list[dict[str, str]] = []
    for spec in raw:
        # Environment markers are not evaluated here; the name is all we key on.
        head = spec.split(";", 1)[0]
        m = _REQ_NAME.match(head)
        if not m:
            # An unparseable shape is a hard failure, never a silent skip.
            raise GuardFailureError(
                f"{pyproject}: cannot parse dependency specifier {spec!r}. "
                "Refusing to pass on a requirement this guard cannot read."
            )
        out.append({"name": m.group(1), "spec": spec.strip()})
    if not out:
        raise GuardFailureError(
            f"{pyproject}: [project].dependencies is empty or absent. "
            "Refusing to pass on an empty dependency population."
        )
    return out


def own_top_levels(src_dir: Path) -> set[str]:
    """Top-level package names the app itself ships (first-party, not resolved)."""
    return {
        p.name
        for p in src_dir.iterdir()
        if p.is_dir() and (p / "__init__.py").exists()
    }


def collect_imports(src_dir: Path, own: set[str]) -> list[dict[str, object]]:
    """Every third-party import statement in the app's source, with file:line.

    Relative imports and ``from __future__`` are first-party/compiler concerns.
    Standard-library modules are excluded via ``sys.stdlib_module_names`` so the
    probe only asserts on what the fresh resolve is responsible for providing.
    """
    stdlib = set(sys.stdlib_module_names)
    targets: list[dict[str, object]] = []
    files = sorted(src_dir.rglob("*.py"))
    if not files:
        raise GuardFailureError(
            f"{src_dir}: contains no .py files. Refusing to pass on an empty "
            "source population -- the layout changed or the matcher drifted."
        )
    for path in files:
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                if node.level or not node.module:
                    continue  # relative import -> first-party
                module = node.module
                symbols = [a.name for a in node.names]
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    top = alias.name.split(".")[0]
                    if top in stdlib or top in own:
                        continue
                    targets.append(
                        {
                            "file": str(path.relative_to(REPO_ROOT).as_posix()),
                            "line": node.lineno,
                            "module": alias.name,
                            "symbols": [],
                            "text": f"import {alias.name}",
                        }
                    )
                continue
            else:
                continue

            top = module.split(".")[0]
            if top in stdlib or top in own or top == "__future__":
                continue
            targets.append(
                {
                    "file": str(path.relative_to(REPO_ROOT).as_posix()),
                    "line": node.lineno,
                    "module": module,
                    "symbols": symbols,
                    "text": f"from {module} import {', '.join(symbols)}",
                }
            )
    if not targets:
        raise GuardFailureError(
            f"{src_dir}: found zero third-party imports across {len(files)} file(s). "
            "That means the AST matcher drifted, not that the app has no "
            "dependencies. Refusing to pass on an empty import population."
        )
    return targets


def dockerfile_install_lines(app_dir: Path) -> list[str]:
    """The Dockerfile lines that install this app's Python dependencies.

    Reported verbatim as context; this guard does not judge them. If there is no
    Dockerfile the guard's premise (image builds fresh-resolve this pyproject)
    is not established, so it fails rather than assuming.
    """
    dockerfile = app_dir / "Dockerfile"
    if not dockerfile.exists():
        raise GuardFailureError(
            f"{app_dir}: no Dockerfile. This guard's premise is that the image "
            "build resolves this pyproject; with no Dockerfile that premise is "
            "not established, so it fails rather than assuming either way."
        )
    lines = [
        ln.rstrip()
        for ln in dockerfile.read_text(encoding="utf-8").splitlines()
        if "pip install" in ln
    ]
    if not lines:
        raise GuardFailureError(
            f"{dockerfile}: contains no 'pip install' line. Refusing to pass -- "
            "this guard could not establish that the image installs from "
            "pyproject.toml at all."
        )
    return lines


def image_builders(app_dir: Path) -> list[str]:
    """Workflows whose build matrix references this app's Docker context.

    Cloud parity: every boundary's image builder consumes this same context, so
    zero hits means the context moved (or a boundary forked it) and this guard
    is no longer covering what it claims to.
    """
    rel = app_dir.relative_to(REPO_ROOT).as_posix()
    hits: list[str] = []
    wf_dir = REPO_ROOT / ".github" / "workflows"
    for wf in sorted(wf_dir.glob("*.yml")):
        if rel in wf.read_text(encoding="utf-8", errors="replace"):
            hits.append(wf.name)
    if not hits:
        raise GuardFailureError(
            f"no workflow under .github/workflows references the context {rel!r}. "
            "Refusing to pass on an empty builder population -- either the app is "
            "built from a path this guard does not know about, or it is not built "
            "at all."
        )
    return hits


def venv_python(venv: Path) -> Path:
    if os.name == "nt":
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True, **kw)


def check_app(app_rel: str, keep: bool = False) -> list[str]:
    """Returns a list of human-readable problems; empty list == clean."""
    app_dir = (REPO_ROOT / app_rel).resolve()
    pyproject = app_dir / "pyproject.toml"
    src_dir = app_dir / "src"

    if not app_dir.is_dir():
        raise GuardFailureError(
            f"{app_rel}: app directory not found under {REPO_ROOT}. Refusing to "
            "skip -- a missing target is an unknown, not a pass."
        )
    if not pyproject.is_file():
        raise GuardFailureError(f"{pyproject}: not found. Refusing to skip.")
    if not src_dir.is_dir():
        raise GuardFailureError(f"{src_dir}: not found. Refusing to skip.")
    if not PROBE.is_file():
        raise GuardFailureError(f"{PROBE}: probe script missing.")

    declared = declared_dependencies(pyproject)
    own = own_top_levels(src_dir)
    targets = collect_imports(src_dir, own)
    install_lines = dockerfile_install_lines(app_dir)
    builders = image_builders(app_dir)

    print(f"-- {app_rel}")
    print(f"   Dockerfile install: {'; '.join(ln.strip() for ln in install_lines)}")
    print(f"   built by          : {', '.join(builders)}")
    print(f"   declared deps     : {len(declared)}")
    print(
        f"   third-party imports: {len(targets)} across "
        f"{len({t['file'] for t in targets})} file(s)"
    )

    tmp = Path(tempfile.mkdtemp(prefix="loom-fresh-resolve-"))
    try:
        venv = tmp / "venv"
        print(f"   creating clean venv ... ({venv})")
        cp = run([sys.executable, "-m", "venv", str(venv)])
        if cp.returncode != 0:
            raise GuardFailureError(f"venv creation failed:\n{cp.stdout}\n{cp.stderr}")
        vpy = venv_python(venv)
        if not vpy.exists():
            raise GuardFailureError(f"venv python not found at {vpy}")

        print("   pip install <app>  (fresh resolve, no lockfile -- as the Dockerfile does) ...")
        cp = run([str(vpy), "-m", "pip", "install", "--disable-pip-version-check", "-q", str(app_dir)])
        if cp.returncode != 0:
            raise GuardFailureError(
                "pip install of the app failed; the guard cannot establish "
                f"anything about imports.\nSTDOUT:\n{cp.stdout}\nSTDERR:\n{cp.stderr}"
            )

        spec = {"targets": targets, "declared": declared}
        cp = run([str(vpy), str(PROBE)], input=json.dumps(spec))
        if cp.returncode != 0 or not cp.stdout.strip():
            raise GuardFailureError(
                f"probe did not produce a report (exit {cp.returncode}).\n"
                f"STDOUT:\n{cp.stdout}\nSTDERR:\n{cp.stderr}"
            )
        report = json.loads(cp.stdout)
    finally:
        if not keep:
            shutil.rmtree(tmp, ignore_errors=True)

    installed: dict[str, str] = report["installed"]
    if not installed:
        raise GuardFailureError(
            "the fresh resolve reported ZERO installed distributions. That is a "
            "broken measurement, not a clean tree."
        )

    problems: list[str] = []

    missing_declared = [d for d in declared if canon(d["name"]) not in installed]
    if missing_declared:
        for d in missing_declared:
            problems.append(
                f"DECLARED-BUT-UNRESOLVED  {app_rel}/pyproject.toml\n"
                f"    declared : {d['spec']}\n"
                f"    resolved : (absent from the fresh environment)"
            )

    for f in report["failures"]:
        prov = f.get("providers") or []
        owned = f.get("owned_path") or ""
        if prov:
            prov_txt = (
                ", ".join(f"{p['dist']}=={p['version']}" for p in prov)
                + f"   (deepest package path any installed distribution ships: {owned})"
            )
        else:
            prov_txt = (
                "(NO installed distribution ships any part of this module path -- "
                "nothing in the resolved environment provides it)"
            )
        prov_names = {canon(p["dist"]) for p in prov}
        decl = [d for d in declared if canon(d["name"]) in prov_names]
        decl_txt = "; ".join(d["spec"] for d in decl) or (
            "(no declared direct dependency of this app ships that path)"
        )
        problems.append(
            f"IMPORT-MISMATCH  {f['file']}:{f['line']}\n"
            f"    source imports : {f['text']}\n"
            f"    declared as    : {decl_txt}\n"
            f"    fresh resolve  : {prov_txt}\n"
            f"    observed       : {f['error']}"
        )

    if not problems:
        print(f"   OK -- all {len(targets)} third-party imports resolve; "
              f"{len(declared)}/{len(declared)} declared deps present "
              f"({len(installed)} distributions installed).")
    return problems


def main(argv: list[str]) -> int:
    apps = argv[1:] or DEFAULT_APPS
    print("Fresh-resolve guard -- resolving each app's own pyproject.toml in a clean")
    print("venv (exactly as its Dockerfile does) and importing what its source imports.")
    print(f"host python: {sys.version.split()[0]}  ({sysconfig.get_platform()})")
    print()

    all_problems: list[str] = []
    try:
        for app in apps:
            all_problems.extend(check_app(app))
    except GuardFailureError as exc:
        print()
        print("GUARD FAILURE -- this guard refuses to pass when it cannot measure:")
        print(f"  {exc}")
        return 1

    print()
    if all_problems:
        print(f"FAIL -- {len(all_problems)} mismatch(es) between the app source and what a")
        print("fresh resolve of its own pyproject.toml provides. Every image build of")
        print("this app ships this break, in every cloud boundary.")
        print()
        for p in all_problems:
            print(p)
            print()
        print("The guard reports the declared specifier and the resolved version side by")
        print("side; it does not claim to know why pip chose that version.")
        return 1

    print(f"PASS -- {len(apps)} app(s) fresh-resolve cleanly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
