# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# CSA Loom — sandboxed R/Python script-visual executor for Azure Container Apps
# ---------------------------------------------------------------------------
# Image: <acr-login-server>/loom-script-runner:<tag>
# Built server-side with ACR Tasks (NO local Docker daemon), same as the
# gh-aca-runner / loom-dbt-runner images:
#   az acr build -r <acr> -t loom-script-runner:<tag> platform/runners/script-runner
#
# WHAT this carries (single-purpose — it does ONE thing):
#   - A FastAPI/uvicorn service (app.py) exposing POST /run that executes a
#     user-supplied R or Python "script visual" against a tabular `dataset`
#     and returns a static PNG of the active figure. This is the Azure-native,
#     1:1 parity backend for Power BI's R/Python visuals — NO Power BI / Fabric
#     service is contacted (see .claude/rules/no-fabric-dependency.md). The
#     report-designer wells feed `dataset`; the /query Synapse path (Path-3)
#     produces the rows; this container only renders.
#   - Python 3.12 + matplotlib/pandas (pinned in requirements.txt)
#   - R (r-base-core) + ggplot2 pre-baked (r-cran-ggplot2) so R visuals import
#     fast and render text (fontconfig + freetype) on the headless Agg backend.
#
# ---------------------------------------------------------------------------
# THREAT MODEL — read this before changing anything in here.
# ---------------------------------------------------------------------------
# Arbitrary user code RUNS INSIDE this container. That is by design and is
# exactly Power BI's posture: PBI runs the visual's R/Python in a locked
# container too. The CONTAINER IS THE SANDBOX BOUNDARY. There is no in-process
# trust — app.py treats every request body as hostile. Defense in depth, the
# layers that live in THIS image (the rest live in app.py + the bicep module):
#
#   (1) NON-ROOT — the service runs as the unprivileged `runner` user (uid
#       10001, no shell login intent). This is the first sandbox layer baked
#       into the image; nothing below /app is owned by, or writable by, root
#       at runtime. See `USER runner` at the bottom.
#   (2) INTERNAL INGRESS ONLY — the ACA app is deployed with ingress
#       external:false (never public). Only the Console BFF, inside the same
#       Container Apps environment / VNet, can reach it. (Enforced in
#       platform/fiab/bicep/.../script-runner-app.bicep, NOT here.)
#   (3) EPHEMERAL /tmp — app.py mkdtemp()s a fresh 0700 dir per request and
#       shutil.rmtree()s it in `finally`. dataset.csv / out.png / the script
#       live only there for the life of one request.
#   (4) SCRUBBED ENV — app.py spawns the R/Rscript/python child with a FRESH
#       env dict (PATH, HOME=tempdir, MPLBACKEND=Agg, LANG only) — never
#       os.environ — so no inherited secret, connection string, or token is
#       visible to user code.
#   (5) POSIX RLIMITS (preexec_fn) — RLIMIT_CPU (~25s), RLIMIT_AS (~1.5 GB),
#       RLIMIT_FSIZE (~50 MB), RLIMIT_NPROC, plus start_new_session=True and a
#       wall-clock timeout (~30s) that os.killpg(SIGKILL)s the whole process
#       group. Mirrors PBI's 150k-row / 5-min(Desktop)/1-min(service) caps.
#   (6) INPUT CAPS — script size (200 KB), row/cell counts, and output PNG
#       size are all bounded before/after execution.
#
# NO SECRETS IN THIS IMAGE. It carries code + interpreters only. Nothing here
# reads a credential, and nothing should ever be COPY'd in that does.
#
# IDENTITY HARDENING (carried into the bicep module + README, flagged here so
# it is not forgotten): an ACA app exposes its assigned UAMI to in-container
# code via IMDS. Because user code runs in this container, the runner MUST be
# given a DEDICATED, LEAST-PRIVILEGE managed identity — `uami-loom-script-runner`
# with AcrPull and ZERO data-plane roles. Reusing the broadly-permissioned
# Console UAMI is a genuine sandbox hole (user code could mint tokens for
# Storage/Cosmos/etc. via IMDS). Interim Console-UAMI reuse, if any, is
# documented as a known weakness to tighten — never relied on silently.
#
# Pin every version: the pip pins live in requirements.txt; the R apt packages
# are EXACT-pinned (=version) below; the base is locked to the bookworm-slim tag
# so those apt pins stay resolvable. Bump any of them deliberately and rebuild.
# ---------------------------------------------------------------------------
# Locked to the bookworm-slim tag (NOT the bare python:3.12-slim default, which
# tracks the newest Debian and would silently move to trixie) so the EXACT apt
# version pins below stay resolvable against bookworm. Bump deliberately. For
# full byte-for-byte reproducibility, additionally pin by digest, e.g.:
#   FROM python:3.12-slim-bookworm@sha256:<digest-from-`docker buildx imagetools inspect`>
# Left as the suffixed tag to match the gh-aca-runner image's tag-pin convention.
FROM python:3.12-slim-bookworm

# Use bash with pipefail for every RUN so a failure mid-pipe aborts the build.
# python:3.12-slim (Debian bookworm-slim) ships /bin/bash; CMD stays exec-form
# (a JSON array), so it does not go through this shell.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# --- OS deps: R + ggplot2 (pre-baked) + matplotlib text rendering ----------
# r-cran-ggplot2 is pulled as an apt package so ggplot2 is install-free and
# import-fast at runtime (no per-request CRAN compile). r-base-core also pulls
# libcairo2 + libpango, so R's png(type="cairo") renders headless (no X11);
# fontconfig + libfreetype6 give both matplotlib (Agg) and R's PNG device real
# text/glyphs. ca-certificates is standard hygiene. --no-install-recommends +
# cleaning the apt lists keeps the image lean (smaller sandbox attack surface).
# The two R packages are EXACT-pinned to their Debian bookworm versions (the pip
# side is pinned in requirements.txt; this stops the apt R layer from floating).
# Bump these in lockstep with the bookworm base above and re-run the smoke test.
# The security-sensitive transitive OS libs (ca-certificates / freetype) are left
# to receive bookworm security updates on purpose — pinning a CA bundle or a
# freetype CVE fix to a stale version would be the wrong kind of "reproducible".
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        r-base-core=4.2.2.20221110-2 \
        r-cran-ggplot2=3.4.1+dfsg-1 \
        ca-certificates \
        fontconfig \
        libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

# --- runtime env -----------------------------------------------------------
# MPLBACKEND=Agg  -> headless, file-only matplotlib (no display, captures the
#                    active figure to PNG — mirrors PBI's default-device capture).
# MPLCONFIGDIR    -> writable cache dir under /tmp so the non-root runner can
#                    build matplotlib's font cache without touching $HOME/root.
# PYTHONUNBUFFERED-> logs stream immediately to ACA's stdout.
# PIP_NO_CACHE_DIR-> no wheel cache layer baked into the image.
ENV MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/mpl \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# --- Python deps (PINNED in requirements.txt) ------------------------------
# Copied before app.py so dependency layers cache across app.py edits.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# --- non-root runner user (first sandbox layer) ----------------------------
RUN useradd --create-home --uid 10001 runner

# --- service code ----------------------------------------------------------
# app.py is COPY'd from the build context (platform/runners/script-runner/app.py).
# That file is the SINGLE SOURCE OF TRUTH for the executor and the artifact the
# Console BFF's contract is matched against
# (apps/fiab-console/app/api/items/report/[id]/script-visual/route.ts).
#
# This step used to MATERIALIZE app.py from an inline BuildKit heredoc
# (`COPY <<'PYEOF' /app/app.py`). That was a real, shipped contract break: the
# heredoc body had drifted STALE against the BFF. It read a TOP-LEVEL
# body.get("columns")/("rows") and returned {ok, image, mime} — but the BFF sends
# a NESTED `dataset:{columns:string[], rows}` (route.ts:510) and reads `json.png`
# (route.ts:555). So against the ACTUALLY-BUILT image, every real call 400'd
# ("columns is required"), and even a success returned `image`, not the `png` the
# BFF consumes — the feature was broken end-to-end as deployed. The real
# standalone app.py on disk implements the nested `dataset` request model and
# returns `png`; copying it makes the correct executor the build artifact.
#
# Copying the one on-disk file (instead of a second inlined copy) is also what
# REMOVES the drift class entirely: there is now exactly ONE executor definition,
# so the Dockerfile and the BFF can no longer diverge. requirements.txt is COPY'd
# the same way above, so the build context — `az acr build ... <this dir>` —
# already carries app.py; there is no second source to go missing.
COPY app.py /app/app.py
RUN chown -R runner:runner /app

# Drop privileges: everything from here (including the executed user scripts)
# runs as the unprivileged runner user.
USER runner

EXPOSE 8080

# Exec-form so uvicorn is PID 1 and receives SIGTERM directly on ACA scale-in.
# uvicorn itself is pinned via requirements.txt.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
