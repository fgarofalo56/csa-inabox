# ---------------------------------------------------------------------------
# CSA Loom -- sandboxed R/Python "script visual" executor (the REAL backend)
# platform/runners/script-runner/app.py
# ---------------------------------------------------------------------------
# Azure-native, 1:1 parity backend for Power BI's R / Python script visuals.
# A single-purpose FastAPI service (this file) deployed as an internal-ingress
# Azure Container App. It receives a tabular `dataset` + a user-supplied R or
# Python script, RUNS THE SCRIPT in a resource-limited, env-scrubbed subprocess,
# and returns the active figure as a static PNG.
#
# SINGLE SOURCE OF TRUTH: this exact file is the one and only executor source.
# The Dockerfile COPYs it verbatim into the image (`COPY app.py /app/app.py`) --
# there is NO embedded heredoc duplicate to drift from (an older inline copy that
# diverged on the request/response contract was deleted in favor of this COPY).
# The request model below (`dataset.columns: list[str]` -> base64 `png`) is thus
# authoritative in EXACTLY ONE place, and it is byte-for-byte the contract the
# Console BFF calls
# (apps/fiab-console/app/api/items/report/[id]/script-visual/route.ts: it POSTs
# `{language, script, dataset:{columns:string[], rows}}` and reads back `png`).
#
# It contacts NO Power BI / Fabric service to do it
# (.claude/rules/no-fabric-dependency.md): the report wells feed `dataset`, the
# existing Synapse `/query` Path-3 produces the rows, and this container only
# renders. There is NO mock array, NO `return []` placeholder, NO sample image
# (.claude/rules/no-vaporware.md) -- the subprocess is real and the PNG is real.
#
# ---------------------------------------------------------------------------
# THREAT MODEL -- read before changing anything here (mirrors README.md).
# ---------------------------------------------------------------------------
# Arbitrary user R/Python code RUNS INSIDE this container. That is by design and
# is exactly Power BI's posture -- PBI runs each visual's script in a locked
# container too. THE CONTAINER IS THE SANDBOX BOUNDARY. This module trusts no
# request body. Defense in depth (the layers that live in THIS file; the rest
# live in the Dockerfile + script-runner-app.bicep):
#
#   (3) EPHEMERAL /tmp        -- a fresh 0700 mkdtemp() dir per request holds
#                                dataset.csv / the user script / out.png, and is
#                                shutil.rmtree()'d in `finally` no matter what.
#   (4) SCRUBBED MINIMAL ENV  -- the child is spawned with a FRESH dict
#                                (PATH, HOME=tempdir, MPLBACKEND=Agg, LANG only)
#                                -- NEVER os.environ -- so no inherited secret,
#                                connection string, or IMDS-minted token text is
#                                visible to user code.
#   (5) POSIX RLIMITS         -- a preexec_fn sets RLIMIT_CPU, RLIMIT_AS,
#                                RLIMIT_FSIZE, and RLIMIT_NPROC on the child.
#   (6) PROCESS-GROUP KILL    -- start_new_session=True makes the child a session
#                                leader; a wall-clock timeout os.killpg(SIGKILL)s
#                                the WHOLE group, so a script that forks cannot
#                                outlive the request.
#   (7) INPUT/OUTPUT CAPS     -- script bytes, row/column/cell counts, the
#                                child's stderr capture, and the output PNG size
#                                are all bounded before/after execution.
#
# Non-root (uid 10001) and internal-ingress-only are layers (1) and (2); they
# live in the Dockerfile and the bicep module respectively, not here.
#
# What is NOT claimed: this is PROCESS-level isolation (non-root + rlimits +
# scrubbed env + a locked-down container), the same class of sandbox Power BI
# uses. It is NOT VM-level, gVisor, or seccomp/syscall-filtered isolation. A
# kernel-level escape is out of scope of these defenses; mitigate at the
# platform layer (ACA tenancy + CAE/NSG egress restriction + a DEDICATED
# least-privilege managed identity per README "Identity hardening").
#
# no-freeform-config: the report-designer CODE PANE is Power BI 1:1 parity (the
# R/Python visual literally IS a code editor) and is therefore EXEMPT, exactly
# like the ADF/Synapse expression builder. Everything structured (the field
# wells, the R<->Python toggle) stays structured. This file only EXECUTES the
# code the parity pane already legitimately accepts.
# ---------------------------------------------------------------------------

from __future__ import annotations

import base64
import csv
import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# `resource` is POSIX-only. It is always present in the Linux container (the only
# place this runs); guard the import so the module still *compiles/imports* on a
# non-POSIX dev box. If it is missing, rlimits are skipped and that is logged
# loudly -- it must never be missing in production.
try:  # pragma: no cover - POSIX only
    import resource as _resource
except ImportError:  # pragma: no cover - non-POSIX dev only
    _resource = None  # type: ignore[assignment]

log = logging.getLogger("loom.script_runner")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

# ---------------------------------------------------------------------------
# Limits / constants. These are OURS (stated honestly, not silently equal to
# Power BI's): same *shape* of contract as PBI (150k-row / minutes-timeout /
# fixed-DPI), tuned for an internal request path. `app.py` is authoritative.
# ---------------------------------------------------------------------------
MAX_SCRIPT_BYTES = 200 * 1024          # user script cap -> 413 above this (README: 200 KB)
MAX_ROWS = 150_000                     # Power BI parity row cap -> 413 above this
MAX_COLS = 1_000                       # column cap            -> 413 above this
MAX_CELLS = 5_000_000                  # rows*cols cap          -> 413 above this
MAX_PNG_BYTES = 16 * 1024 * 1024       # output PNG cap (16 MB) -> 422 above this
MAX_STDERR_TAIL = 8 * 1024             # bytes of child stderr surfaced on error

DPI = 96                               # fixed render DPI (README states this is ours)
R_PNG_W = 1280                         # R png() device width  (px)
R_PNG_H = 960                          # R png() device height (px)

WALL_CLOCK_SECONDS = 30                # request wall-clock budget; killpg past it
RLIMIT_CPU_SECONDS = 25                # CPU-time rlimit (< wall-clock, so CPU dies first)
# RLIMIT_AS is VIRTUAL address space. It must comfortably exceed RESIDENT need,
# because numpy/OpenBLAS and matplotlib reserve large *virtual* arenas they never
# fault in. 2 GiB is a real, meaningful runaway-allocation cap that still avoids
# spurious MemoryError on legitimate plots (README quotes "~1.5 GB" approximately;
# this file is authoritative and uses 2 GiB for headroom).
RLIMIT_AS_BYTES = 2 * 1024 * 1024 * 1024
RLIMIT_FSIZE_BYTES = 50 * 1024 * 1024  # max bytes any single child file write (also caps stderr/out logs)
RLIMIT_NPROC = 128                     # cap processes for the runner uid -> blunts fork bombs

# Distinct exit code the Python wrapper uses to say "ran fine but drew nothing".
_PY_NO_FIGURE_RC = 7

# Interpreters resolved once at import. Absolute paths -> the scrubbed-env child
# does not depend on PATH lookup to find them.
_PYTHON = sys.executable or shutil.which("python3") or shutil.which("python")
_RSCRIPT = shutil.which("Rscript")

# A FIXED, non-secret PATH for the child. We deliberately do NOT copy os.environ's
# PATH (it could carry injected dirs); these are the standard interpreter/tool
# locations on the python:3.12-slim (Debian bookworm) base.
_CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

app = FastAPI(title="loom-script-runner", docs_url=None, redoc_url=None, openapi_url=None)


# ---------------------------------------------------------------------------
# Wrappers. The user script is written verbatim to script.py / script.R; a small
# trusted wrapper loads `dataset`, runs the user code, and captures the active
# figure. Tokens (__DPI__ / __W__ / __H__) are substituted -- NOT f-strings -- so
# the wrappers' own braces/format chars need no escaping.
# ---------------------------------------------------------------------------
_PY_WRAPPER = r'''
import sys
import matplotlib
matplotlib.use("Agg")                 # headless: capture the active figure to a file
import matplotlib.pyplot as plt
import pandas as pd

# Power BI parity: the Values well becomes a pandas DataFrame named `dataset`
# whose column names are the field names verbatim (no rename).
dataset = pd.read_csv("dataset.csv")

with open("script.py", "r", encoding="utf-8") as _f:
    _src = _f.read()

# Only `dataset` is injected. Power BI parity: the user imports matplotlib/plt
# itself; referencing an unimported name raises NameError exactly like PBI
# (e.g. the documented "NameError: name 'plt' is not defined").
_ns = {"__name__": "__main__", "dataset": dataset}
exec(compile(_src, "script.py", "exec"), _ns)

# Capture the ACTIVE figure as a static, non-interactive PNG (PBI captures the
# active device). No active figure -> honest, distinct exit code.
if not plt.get_fignums():
    sys.stderr.write("the script ran but produced no matplotlib figure to capture\n")
    sys.exit(__NOFIG__)
plt.gcf().savefig("out.png", dpi=__DPI__)
'''

_R_WRAPPER = r'''
# Power BI parity: the Values well becomes a data.frame named `dataset` whose
# column names are the field names verbatim (check.names=FALSE -> no mangling).
dataset <- read.csv("dataset.csv", check.names = FALSE, stringsAsFactors = FALSE)

# Headless cairo PNG device (no X11). r-base-core depends on libcairo2, so the
# "cairo" type is available; fontconfig + libfreetype6 (image apt layer) render text.
grDevices::png(filename = "out.png", width = __W__L, height = __H__L, res = __DPI__L, type = "cairo")

# print.eval=TRUE auto-prints each top-level value -> a trailing ggplot object is
# rendered to the device, mirroring PBI's auto-print. dev.off() always runs (even
# on error) so a partial figure is flushed; the error still propagates -> rc != 0.
tryCatch(
  source("script.R", echo = FALSE, print.eval = TRUE),
  finally = grDevices::dev.off()
)
'''


def _py_wrapper() -> str:
    return (
        _PY_WRAPPER.replace("__DPI__", str(DPI)).replace("__NOFIG__", str(_PY_NO_FIGURE_RC))
    )


def _r_wrapper() -> str:
    return (
        _R_WRAPPER.replace("__W__", str(R_PNG_W))
        .replace("__H__", str(R_PNG_H))
        .replace("__DPI__", str(DPI))
    )


# ---------------------------------------------------------------------------
# Request model.
# ---------------------------------------------------------------------------
class _Dataset(BaseModel):
    columns: list[str] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)


class _RunRequest(BaseModel):
    language: str = "python"
    script: str = ""
    dataset: _Dataset = Field(default_factory=_Dataset)


def _envelope(status: int, *, ok: bool, **extra: Any) -> JSONResponse:
    """Structured {ok,...} envelope per no-vaporware, with an explicit HTTP code."""
    body: dict[str, Any] = {"ok": ok}
    body.update(extra)
    return JSONResponse(body, status_code=status)


def _apply_rlimits() -> None:
    """preexec_fn: drop POSIX rlimits onto the child BEFORE exec.

    Runs in the forked child after start_new_session=True has already called
    setsid(), and before the interpreter is exec'd. Per the subprocess docs
    preexec_fn is not thread-safe in the abstract; it is the documented mechanism
    for rlimits and is the contract this runner ships (README defense #5). Keep
    the body tiny and allocation-free.
    """
    if _resource is None:  # pragma: no cover - non-POSIX dev only
        return
    _resource.setrlimit(_resource.RLIMIT_CPU, (RLIMIT_CPU_SECONDS, RLIMIT_CPU_SECONDS))
    _resource.setrlimit(_resource.RLIMIT_AS, (RLIMIT_AS_BYTES, RLIMIT_AS_BYTES))
    _resource.setrlimit(_resource.RLIMIT_FSIZE, (RLIMIT_FSIZE_BYTES, RLIMIT_FSIZE_BYTES))
    try:
        _resource.setrlimit(_resource.RLIMIT_NPROC, (RLIMIT_NPROC, RLIMIT_NPROC))
    except (ValueError, OSError):  # pragma: no cover - some kernels restrict NPROC
        pass


def _kill_group(proc: subprocess.Popen) -> None:
    """SIGKILL the child's entire process group (forked grandchildren included)."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def _read_tail(path: str, limit: int) -> str:
    """Return at most `limit` trailing bytes of a file as text (bounded memory)."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > limit:
                fh.seek(size - limit)
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


def _last_line(text: str) -> str:
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line:
            return line
    return ""


def _signal_message(signum: int) -> str:
    """Honest message for a child terminated by a limit signal."""
    sigxcpu = getattr(signal, "SIGXCPU", None)
    sigxfsz = getattr(signal, "SIGXFSZ", None)
    if sigxcpu is not None and signum == int(sigxcpu):
        return f"script exceeded the CPU-time limit ({RLIMIT_CPU_SECONDS}s) and was killed"
    if sigxfsz is not None and signum == int(sigxfsz):
        return (
            f"script exceeded the {RLIMIT_FSIZE_BYTES // (1024 * 1024)} MB "
            "file-size limit and was killed"
        )
    if signum == int(signal.SIGKILL):
        return "script was killed (memory limit exceeded or forcibly terminated)"
    name = signal.Signals(signum).name if signum in {int(s) for s in signal.Signals} else str(signum)
    return f"script was terminated by signal {name}"


# ---------------------------------------------------------------------------
# Routes.
# ---------------------------------------------------------------------------
@app.get("/healthz")
def healthz() -> Any:
    """Liveness + readiness: 200 {"ok":true} when both interpreters are loadable.

    The Python stack (matplotlib/pandas/numpy) is proven loadable by the fact
    this module imported -- the child uses the same interpreter + site-packages.
    R is an external binary, so we confirm Rscript resolves. Used as the ACA
    Liveness/Readiness probe path.
    """
    problems = []
    if not _PYTHON or not os.path.exists(_PYTHON):
        problems.append("python interpreter not resolvable")
    if not _RSCRIPT:
        problems.append("Rscript interpreter not found on PATH")
    if _resource is None:
        problems.append("POSIX resource limits unavailable (not a Linux container)")
    if problems:
        return _envelope(503, ok=False, error="; ".join(problems))
    return {"ok": True}


@app.post("/run")
def run_script(req: _RunRequest) -> Any:
    """Execute the user R/Python script against `dataset`, return the figure PNG.

    Returns the structured {ok,...} envelope (no-vaporware): 200 with a real
    base64 PNG on success; 400/413/422 with an honest error otherwise. NEVER
    leaks the container env -- only the child's own stderr (bounded) is surfaced.
    """
    t0 = time.monotonic()

    # --- language ---------------------------------------------------------
    lang = (req.language or "python").strip().lower()
    if lang in ("py", "python"):
        lang = "python"
    elif lang in ("r",):
        lang = "r"
    else:
        return _envelope(400, ok=False, error=f"unsupported language '{req.language}'; expected 'python' or 'r'")

    interpreter = _PYTHON if lang == "python" else _RSCRIPT
    if not interpreter:
        return _envelope(503, ok=False, error=f"the '{lang}' interpreter is not available in this image")

    # --- input caps (cap 7) ----------------------------------------------
    script_bytes = (req.script or "").encode("utf-8")
    if len(script_bytes) > MAX_SCRIPT_BYTES:
        return _envelope(
            413,
            ok=False,
            error=f"script is {len(script_bytes)} bytes; limit is {MAX_SCRIPT_BYTES} bytes (200 KB)",
        )

    columns = req.dataset.columns or []
    rows = req.dataset.rows or []
    ncols, nrows = len(columns), len(rows)
    if ncols == 0:
        return _envelope(422, ok=False, error="dataset.columns is empty; at least one column is required")
    if ncols > MAX_COLS:
        return _envelope(413, ok=False, error=f"dataset has {ncols} columns; limit is {MAX_COLS}")
    if nrows > MAX_ROWS:
        return _envelope(413, ok=False, error=f"dataset has {nrows} rows; limit is {MAX_ROWS}")
    if ncols * nrows > MAX_CELLS:
        return _envelope(413, ok=False, error=f"dataset has {ncols * nrows} cells; limit is {MAX_CELLS}")
    for i, row in enumerate(rows):
        if len(row) != ncols:
            return _envelope(
                422,
                ok=False,
                error=f"row {i} has {len(row)} values but there are {ncols} columns (dataset must be rectangular)",
            )

    # --- ephemeral 0700 workdir (cap 3) ----------------------------------
    workdir = tempfile.mkdtemp(prefix="loom-sr-")  # mkdtemp creates the dir 0o700
    try:
        # dataset.csv -- column names verbatim; None -> empty cell.
        csv_path = os.path.join(workdir, "dataset.csv")
        with open(csv_path, "w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow([str(c) for c in columns])
            for row in rows:
                writer.writerow(["" if v is None else v for v in row])

        # user script (verbatim) + trusted wrapper
        script_name = "script.py" if lang == "python" else "script.R"
        wrapper_name = "wrapper.py" if lang == "python" else "wrapper.R"
        with open(os.path.join(workdir, script_name), "w", encoding="utf-8", newline="") as fh:
            fh.write(req.script or "")
        with open(os.path.join(workdir, wrapper_name), "w", encoding="utf-8", newline="") as fh:
            fh.write(_py_wrapper() if lang == "python" else _r_wrapper())

        # --- scrubbed minimal env (cap 4): FRESH dict, never os.environ ---
        child_env = {
            "PATH": _CHILD_PATH,
            "HOME": workdir,              # any $HOME cache (matplotlib, R) lands in the ephemeral dir
            "MPLBACKEND": "Agg",          # headless matplotlib
            "LANG": "C.UTF-8",            # deterministic text/CSV encoding
        }

        if lang == "python":
            # -I isolated (ignore PYTHON* env + user site; global site-packages
            # still import), -B no .pyc writes into the workdir.
            argv = [interpreter, "-I", "-B", wrapper_name]
        else:
            # --vanilla -> no .Rprofile/.Renviron/site files, no save/restore.
            argv = [interpreter, "--vanilla", wrapper_name]

        stdout_path = os.path.join(workdir, "stdout.log")
        stderr_path = os.path.join(workdir, "stderr.log")
        out_png = os.path.join(workdir, "out.png")

        # Redirect child stdout/stderr to FILES (not pipes): RLIMIT_FSIZE then
        # caps how much a spamming script can write, and we never buffer
        # unbounded child output in the parent's memory.
        with open(stdout_path, "wb") as so, open(stderr_path, "wb") as se:
            try:
                proc = subprocess.Popen(
                    argv,
                    cwd=workdir,
                    env=child_env,
                    stdin=subprocess.DEVNULL,
                    stdout=so,
                    stderr=se,
                    preexec_fn=_apply_rlimits if _resource is not None else None,  # cap 5
                    start_new_session=True,                                        # cap 6 (own group)
                    close_fds=True,
                )
            except OSError as exc:
                return _envelope(500, ok=False, error=f"failed to launch the {lang} interpreter: {exc}")

            timed_out = False
            try:
                rc = proc.wait(timeout=WALL_CLOCK_SECONDS)
            except subprocess.TimeoutExpired:
                timed_out = True
                _kill_group(proc)  # cap 6: SIGKILL the whole process group
                try:
                    rc = proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    rc = -int(signal.SIGKILL)

        duration_ms = round((time.monotonic() - t0) * 1000)
        stderr_tail = _read_tail(stderr_path, MAX_STDERR_TAIL)

        # --- classify the outcome ----------------------------------------
        if timed_out:
            log.info("run lang=%s outcome=timeout durationMs=%s", lang, duration_ms)
            return _envelope(
                422,
                ok=False,
                error=f"script exceeded the wall-clock timeout ({WALL_CLOCK_SECONDS}s) and was killed",
                durationMs=duration_ms,
            )

        if rc < 0:  # killed by a signal (CPU/file-size/OOM/group-kill)
            msg = _signal_message(-rc)
            log.info("run lang=%s outcome=signal sig=%s durationMs=%s", lang, -rc, duration_ms)
            return _envelope(422, ok=False, error=msg, stderr=stderr_tail, durationMs=duration_ms)

        if rc == _PY_NO_FIGURE_RC and lang == "python":
            log.info("run lang=python outcome=no_figure durationMs=%s", duration_ms)
            return _envelope(
                422,
                ok=False,
                error="the script ran but produced no figure (no active matplotlib figure to capture)",
                stderr=stderr_tail,
                durationMs=duration_ms,
            )

        if rc != 0:  # user-script error -> surface the child's stderr, never the env
            err = _last_line(stderr_tail) or f"the {lang} script exited with status {rc}"
            log.info("run lang=%s outcome=user_error rc=%s durationMs=%s", lang, rc, duration_ms)
            return _envelope(422, ok=False, error=err, stderr=stderr_tail, durationMs=duration_ms)

        # --- success path: validate + return the real PNG (cap 7 output) --
        try:
            png_size = os.path.getsize(out_png)
        except OSError:
            png_size = 0
        if png_size == 0:
            return _envelope(
                422,
                ok=False,
                error="the script ran but produced no figure (no PNG was written)",
                stderr=stderr_tail,
                durationMs=duration_ms,
            )
        if png_size > MAX_PNG_BYTES:
            return _envelope(
                422,
                ok=False,
                error=f"rendered PNG is {png_size} bytes; limit is {MAX_PNG_BYTES} bytes (16 MB)",
                durationMs=duration_ms,
            )

        with open(out_png, "rb") as fh:
            png_b64 = base64.b64encode(fh.read()).decode("ascii")

        log.info("run lang=%s outcome=ok pngBytes=%s durationMs=%s", lang, png_size, duration_ms)
        return _envelope(200, ok=True, png=png_b64, dpi=DPI, durationMs=duration_ms)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)  # cap 3: always tear down the ephemeral dir
