"""#2653 (py/code-injection) — the UDF execution host's boundary must stay in place.

The host runs `exec()` on Python delivered in the `X-Udf-Source-B64` REQUEST
HEADER. That is the product working as designed — a User Data Function host runs
the author's Python — but it means whoever can open a connection to the host can
execute arbitrary code as that container.

The host cannot authenticate callers, and that is a deliberate decision recorded
in `admin-plane/main.bicep`: this host executes the item's own Python, so a shared
key in its environment could be read straight back out by that Python and
exfiltrated. Putting a credential here would move the secret INTO the blast
radius.

So the boundary is necessarily the NETWORK: internal-only ACA ingress plus an IP
allow-list pinning it to the Console's subnet. These tests hold that boundary in
place, and hold the host to admitting when it is missing.
"""
import importlib.util
import os
import pathlib
from types import ModuleType

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
UDF_DIR = REPO / "platform" / "fiab" / "bicep" / "modules" / "admin-plane" / "udf-runtime"
APP_PY = UDF_DIR / "app.py"
BICEP = REPO / "platform" / "fiab" / "bicep" / "modules" / "admin-plane" / "udf-runtime.bicep"
SCRIPT_RUNNER_PY = REPO / "platform" / "runners" / "script-runner" / "app.py"
SCRIPT_RUNNER_BICEP = (
    REPO / "platform" / "fiab" / "bicep" / "modules" / "admin-plane" / "script-runner-app.bicep"
)

# The ONLY files permitted to exec user-supplied code. Both execute user code as
# their product function, both hold no credential by design, and both are bounded
# by internal ingress + an IP allow-list. Adding to this set is a security
# decision: the host must be documented and its bicep must pin ingress.
#
# script-runner was found by the sweep below, NOT by CodeQL — alert #545 reported
# only udf-runtime. That is precisely why the unit of work for this class is a
# sweep rather than the one reported line.
SANCTIONED_EXEC_HOSTS = {APP_PY.resolve(), SCRIPT_RUNNER_PY.resolve()}


def _load_app_module() -> ModuleType:
    """Import app.py directly. Module scope only reads the bundled source file
    (returning {} when absent) and does NOT bind a socket, so this is safe."""
    spec = importlib.util.spec_from_file_location("loom_udf_app", APP_PY)
    # Explicit guard rather than a cast: if app.py ever moves, this must fail with
    # "cannot load <path>" instead of an opaque NoneType attribute error that
    # reads like a test bug rather than a missing security-relevant file.
    assert spec is not None, f"cannot load {APP_PY}"
    assert spec.loader is not None, f"no loader for {APP_PY}"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# The host must ADMIT when its only control is "reachable on the VNet".
# ---------------------------------------------------------------------------

def test_warns_when_ingress_has_no_ip_allowlist() -> None:
    app = _load_app_module()
    warn = app.ingress_warning(env={})
    assert warn is not None, "an unpinned deployment must not boot silently"
    # Name the mechanism, the header, and the remediation — a warning that does
    # not say what to do is not a remediation.
    assert "X-Udf-Source-B64" in warn
    assert "consoleAllowedCidrs" in warn
    assert "#2653" in warn


def test_silent_when_ingress_is_ip_restricted() -> None:
    app = _load_app_module()
    assert app.ingress_warning(env={"LOOM_UDF_INGRESS_IP_RESTRICTED": "1"}) is None


def test_empty_string_counts_as_unrestricted() -> None:
    # bicep emits '' (not an absent var) when consoleAllowedCidrs is empty, so a
    # truthiness check is required — `in env` would report a pinned host.
    app = _load_app_module()
    assert app.ingress_warning(env={"LOOM_UDF_INGRESS_IP_RESTRICTED": ""}) is not None


# ---------------------------------------------------------------------------
# The bicep must keep wiring the network control. Text-level assertions: these
# catch silent REMOVAL of the boundary, which is the regression that matters.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def bicep_src() -> str:
    return BICEP.read_text(encoding="utf-8")


def test_bicep_accepts_and_applies_an_ip_allowlist(bicep_src: str) -> None:
    assert "param consoleAllowedCidrs array" in bicep_src
    assert "ipSecurityRestrictions" in bicep_src
    # The rules must be DERIVED from the param, not a hard-coded list.
    assert "for (cidr, i) in consoleAllowedCidrs" in bicep_src
    assert "action: 'Allow'" in bicep_src


def test_bicep_keeps_ingress_internal(bicep_src: str) -> None:
    # Public exposure of an arbitrary-code-execution host would turn a VNet-scoped
    # finding into an internet-facing one.
    assert "external: false" in bicep_src
    assert "external: true" not in bicep_src


def test_bicep_tells_the_host_whether_the_control_is_present(bicep_src: str) -> None:
    assert "LOOM_UDF_INGRESS_IP_RESTRICTED" in bicep_src
    # Must reflect the actual param, not be pinned to a constant that would make
    # the host claim it is protected when it is not.
    assert "empty(consoleAllowedCidrs) ? '' : '1'" in bicep_src


# ---------------------------------------------------------------------------
# Class sweep: no OTHER Python in the repo may exec/eval request-derived source.
# ---------------------------------------------------------------------------

def test_no_other_python_execs_caller_supplied_source() -> None:
    """The unit of work for this class is the sweep, not the one reported line.

    app.py is the single sanctioned `exec` of caller-supplied code and is
    documented as such. Any NEW exec/eval reached from request data is a fresh
    instance of the same class and must fail here.
    """
    offenders = []
    # PRUNE DURING THE WALK. A pathlib rglob still descends into node_modules and
    # only filters afterwards, which takes minutes in this repo; os.walk lets us
    # cut those subtrees before entering them.
    skip_dirs = {
        ".git", "node_modules", ".venv", "venv", "__pycache__", "temp",
        ".claude", "site-packages", "dist", ".next", "build", ".pytest_cache",
        ".mypy_cache", ".ruff_cache", "htmlcov", ".tox",
    }
    self_path = pathlib.Path(__file__).resolve()
    py_files = []
    for root, dirnames, filenames in os.walk(REPO):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs and not d.startswith(".")]
        for fn in filenames:
            if fn.endswith(".py"):
                py_files.append(pathlib.Path(root) / fn)

    for path in py_files:
        if path.resolve() in SANCTIONED_EXEC_HOSTS:
            continue  # documented + network-bounded; asserted separately below
        if path.resolve() == self_path:
            continue  # this file names exec/eval in prose and assertions
        try:
            src = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for lineno, line in enumerate(src.splitlines(), 1):
            stripped = line.lstrip()
            if stripped.startswith("#"):
                continue
            # Call form only — `exec(`/`eval(` — so words like "execute" and
            # attribute access such as `cursor.execute(` do not false-positive.
            for fn in ("exec(", "eval("):
                idx = stripped.find(fn)
                if idx == -1:
                    continue
                prev = stripped[idx - 1] if idx else " "
                if prev.isalnum() or prev in "._":
                    continue  # e.g. cursor.execute(, spec.loader.exec_module(
                # A DEFINITION named exec/eval is not a call. Caught live:
                # apps/copilot/surfaces/api/tests/test_auth.py has `async def eval(`.
                before = stripped[:idx]
                if before.rstrip().endswith("def"):
                    continue
                offenders.append(f"{path.relative_to(REPO)}:{lineno}: {stripped[:90]}")

    assert not offenders, (
        "new py/code-injection candidates — each must be bounded like app.py "
        "(documented + network-isolated) or removed:\n" + "\n".join(offenders)
    )


def test_script_runner_bicep_also_pins_ingress() -> None:
    """The sibling instance the sweep found. Same class, same required control.

    CodeQL alert #545 reported only udf-runtime; script-runner has the identical
    exposure — it executes user Python/R for the Power BI-parity script visual and
    also sat on internal-ingress-only with no IP allow-list. A class sweep that
    fixed one and left the other would be the exact failure mode this repo keeps
    hitting.
    """
    src = SCRIPT_RUNNER_BICEP.read_text(encoding="utf-8")
    assert "param consoleAllowedCidrs array" in src
    assert "ipSecurityRestrictions" in src
    assert "for (cidr, i) in consoleAllowedCidrs" in src
    assert "external: false" in src
    assert "external: true" not in src
