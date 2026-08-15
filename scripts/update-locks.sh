#!/usr/bin/env bash
# =============================================================================
# CSA-0032 — Regenerate the dependency lock files.
#
# Reads pyproject.toml directly and emits fully-resolved, hash-pinned locks at
# `requirements/locks/<extra>/requirements.txt` via `pip-compile --extra=<name>`
# (pip-tools >=7 treats pyproject.toml as a first-class input, so no
# intermediate `.in` files are needed — the [project.optional-dependencies]
# tables are the single source of truth). The path is load-bearing; see the
# comment above the compile loop and #3485.
#
# THE TWO DEFECTS THIS SCRIPT CARRIES A FIX FOR  (refs #3491)
# ----------------------------------------------------------
#
# 1. IT COULD NOT PERFORM THE REMEDIATION IT IS DOCUMENTED FOR.
#
#    `requirements/README.md` and `docs/SUPPLY_CHAIN.md` §6.2 both tell a CVE
#    responder to raise a floor in pyproject.toml and then run this script.
#    Raising a floor is only HARD when a transitive dependency has to move with
#    it — and that was exactly the case this script could not do.
#
#    pip-compile reuses the existing output file as constraints. With no
#    `--upgrade`/`--upgrade-package` flag, every pin already in the lock is
#    handed back to the resolver as a hard requirement. So
#    `cryptography>=50.0.0` failed `ResolutionImpossible` against a lock
#    pinning `msal==1.36.0`, because msal 1.36.0 declares `cryptography<49`.
#    The give-away was in the error itself: every version it named — msal
#    1.36.0, azure-storage-blob 12.28.0, azure-identity 1.25.3 — was a version
#    read back out of the committed lock, not one the resolver chose.
#
#    A responder following the runbook hit `ResolutionImpossible` and could
#    reasonably conclude the bump was not possible. It was: the script had
#    forbidden the solution and then reported that none existed.
#
#    Fixed two ways: `--upgrade-package <name>` (repeatable) and `--upgrade`
#    are now first-class flags, and a `ResolutionImpossible` failure is
#    DIAGNOSED — the script cross-references the versions named in the resolver
#    error against the pins in the existing lock and, when they match, says so
#    and prints the exact re-run. Per deploy-integrity.md R7 it asserts only
#    what it established: when none of the named versions is a reused pin, it
#    says the conflict could not be attributed to reused constraints rather
#    than guessing.
#
# 2. THE OUTPUT DEPENDED ON WHO RAN IT.
#
#    The committed `requirements/portal.lock` had been compiled on WINDOWS. It
#    carried `colorama` (a win32-only marker) and omitted `uvloop`, the
#    non-Windows member of `uvicorn[standard]`. Every declared consumer of
#    these locks — the Docker image builds, CI, the SBOM, the Trivy fs scan —
#    is Linux, so the lock described a dependency set the images do not
#    install and omitted one they do.
#
#    pip-tools has no universal/cross-platform resolve mode (that is
#    `uv pip compile --universal`, a different tool), so a flag cannot fix
#    this. WHERE the compile runs is the fix. This script therefore compiles
#    inside a DIGEST-PINNED Linux container by default — the same
#    python:3.12-slim digest `portal/kubernetes/docker/backend/Dockerfile`
#    ships — with a pinned pip-tools version. Python, glibc, platform tags and
#    resolver are then properties of this file, not of the contributor's
#    laptop.
#
#    Measured: with this container path, `update-locks.sh portal` run from a
#    Windows host reproduces the committed portal.lock BYTE-IDENTICALLY.
#
#    `--native` opts out. It is REFUSED outright on a non-Linux host, because
#    that is the configuration that produced the defect above; on Linux it
#    warns that the result is only as reproducible as the local interpreter.
#
# WHAT THE LOCKS ACTUALLY FEED — stated precisely, because the previous version
# of this list was not true. It claimed "Docker image builds
# (portal/kubernetes/docker/{backend,frontend}/Dockerfile)". Measured over all
# 37 tracked Dockerfiles: NOT ONE references requirements/locks. The portal
# backend installs `portal/shared/requirements.txt` (a RANGE file) at
# portal/kubernetes/docker/backend/Dockerfile:19, and the only other `.lock`
# hits in any Dockerfile are Rust's Cargo.lock. Claiming an audience a file does
# not have is how a control comes to be trusted for something it never covered.
#
#   • SBOM generation      (.github/workflows/sbom.yml)
#   • Trivy filesystem CVE scans (.github/workflows/trivy.yml)
#
# NOT consumed by:
#   • Any Dockerfile. The shipped portal image resolves
#     portal/shared/requirements.txt, whose ranges are guarded separately by
#     scripts/ci/check-python-cve-floors.mjs.
#   • The Python test lane. `.github/workflows/test.yml` installs the EXTRAS
#     from pyproject.toml as floors and explicitly EXCLUDES requirements/locks/
#     from its per-domain loop (#3485) — 495 exact pins in one shared env would
#     decide what the suite measures, which is the #2615 defect.
#
# Wiring a Dockerfile to a lock would be a real improvement; until someone does,
# this comment says what is true.
#
# Usage:
#   scripts/update-locks.sh                        # regenerate every lock
#   scripts/update-locks.sh portal dev             # regenerate only those extras
#   scripts/update-locks.sh portal --upgrade-package cryptography
#   scripts/update-locks.sh portal --upgrade       # release every pin
#   scripts/update-locks.sh --print-plan portal    # show the commands, run none
#   scripts/update-locks.sh --native portal        # Linux hosts only; see above
#
# Environment:
#   LOCK_COMPILE_IMAGE      override the digest-pinned compile image
#   LOCK_PIP_TOOLS_VERSION  override the pinned pip-tools version
#   DOCKER                  override the docker executable
#   PYTHON                  interpreter for --native runs (default: python3)
#
# Requirements:
#   • Docker (default path), or --native with Python >= 3.10 + pip-tools >= 7
# =============================================================================
set -euo pipefail

# Resolve repo root so the script works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------------------------------------------------------------------------
# The pinned compile environment.
#
# The image digest is deliberately the SAME one
# portal/kubernetes/docker/backend/Dockerfile ships. The lock is a description
# of what that image will install; resolving it under a different Python,
# glibc or set of platform tags describes a different install. Bump both
# together, and re-run every lock when you do.
# ---------------------------------------------------------------------------
COMPILE_IMAGE="${LOCK_COMPILE_IMAGE:-python:3.12-slim@sha256:46cb7cc2877e60fbd5e21a9ae6115c30ace7a077b9f8772da879e4590c18c2e3}"
PIP_TOOLS_VERSION="${LOCK_PIP_TOOLS_VERSION:-7.6.1}"
DOCKER_BIN="${DOCKER:-docker}"

# Locks to regenerate (default: all extras declared in pyproject.toml that have
# a committed lock, plus a `base` pseudo-extra for the bare package).
KNOWN_EXTRAS=(
    base
    dev
    governance
    functions
    platform
    portal
    bff
    postgres
    copilot
    streaming
)

usage() {
    cat <<'USAGE'
scripts/update-locks.sh [flags] [extra ...]

Flags:
  --upgrade-package NAME   Release NAME (and only NAME) from the pins the
                           existing lock would otherwise impose. Repeatable.
                           This is the flag to reach for when raising a floor
                           fails with ResolutionImpossible.
  --upgrade                Release EVERY pin. Produces a large diff; prefer
                           --upgrade-package when responding to a CVE so the
                           review surface stays the packages you meant to move.
  --native                 Compile with the local interpreter instead of the
                           digest-pinned Linux container. REFUSED on non-Linux
                           hosts — see the header, a Windows-compiled lock is
                           the defect this default exists to prevent.
  --print-plan             Print the exact command for each extra and exit
                           without running anything.
  -h, --help               This text.

Extras (default: all): base dev governance functions platform portal bff
                       postgres copilot streaming
USAGE
}

MODE="container"
PRINT_PLAN=0
UPGRADE_ALL=0
UPGRADE_PACKAGES=()
EXTRAS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --upgrade-package)
            if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
                echo "ERROR: --upgrade-package requires a package name (got: ${2-<nothing>})." >&2
                exit 2
            fi
            UPGRADE_PACKAGES+=("$2")
            shift 2
            ;;
        --upgrade-package=*)
            _pkg="${1#*=}"
            if [[ -z "${_pkg}" ]]; then
                echo "ERROR: --upgrade-package= requires a package name." >&2
                exit 2
            fi
            UPGRADE_PACKAGES+=("${_pkg}")
            shift
            ;;
        --upgrade)
            UPGRADE_ALL=1
            shift
            ;;
        --native)
            MODE="native"
            shift
            ;;
        --print-plan)
            PRINT_PLAN=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            echo "ERROR: unknown flag '$1'." >&2
            usage >&2
            exit 2
            ;;
        *)
            EXTRAS+=("$1")
            shift
            ;;
    esac
done

if [[ ${#EXTRAS[@]} -eq 0 ]]; then
    EXTRAS=("${KNOWN_EXTRAS[@]}")
else
    # A typo'd extra used to compile silently against no extra at all and
    # overwrite a real lock with the base dependency set. Refuse instead.
    for extra in "${EXTRAS[@]}"; do
        _found=0
        for known in "${KNOWN_EXTRAS[@]}"; do
            [[ "${extra}" == "${known}" ]] && _found=1
        done
        if [[ ${_found} -eq 0 ]]; then
            echo "ERROR: '${extra}' is not an extra with a committed lock." >&2
            echo "       Known: ${KNOWN_EXTRAS[*]}" >&2
            echo "       Adding a new extra? Add it to KNOWN_EXTRAS in this script first." >&2
            exit 2
        fi
    done
fi

HOST_OS="$(uname -s)"

# ---------------------------------------------------------------------------
# Preflight for the chosen compile mode. Both branches fail CLOSED: a mode we
# cannot run is an error, never a quiet fallback to the other one. A silent
# fallback to the local interpreter is precisely how a Windows-compiled lock
# reached main in the first place.
# ---------------------------------------------------------------------------
if [[ "${MODE}" == "native" ]]; then
    if [[ "${HOST_OS}" != "Linux" ]]; then
        cat >&2 <<EOF
ERROR: --native is refused on ${HOST_OS}.

  Every consumer of these locks is Linux: the portal Docker images, CI,
  the SBOM and the Trivy filesystem scan. A lock compiled on ${HOST_OS} resolves
  a different dependency set — the committed portal.lock was compiled on Windows
  and therefore pinned the win32-only \`colorama\` while omitting \`uvloop\`,
  which \`uvicorn[standard]\` uses on Linux (#3491).

  Drop --native to compile inside the pinned Linux container instead:
      ${COMPILE_IMAGE}
EOF
        exit 2
    fi
    PYTHON="${PYTHON:-python3}"
    if ! command -v "${PYTHON}" >/dev/null 2>&1; then
        PYTHON="python"
    fi
    if ! command -v "${PYTHON}" >/dev/null 2>&1; then
        echo "ERROR: --native was requested but no '${PYTHON}' interpreter is on PATH." >&2
        exit 1
    fi
    if ! "${PYTHON}" -c "import piptools" >/dev/null 2>&1; then
        echo "ERROR: --native was requested but pip-tools is not installed for ${PYTHON}." >&2
        echo "Install it with:  ${PYTHON} -m pip install --upgrade 'pip-tools==${PIP_TOOLS_VERSION}'" >&2
        exit 1
    fi
    echo "WARNING: --native — this lock is only as reproducible as ${PYTHON} and this host." >&2
    echo "         The container path pins Python, glibc, platform tags and pip-tools." >&2
elif [[ ${PRINT_PLAN} -eq 0 ]] && ! command -v "${DOCKER_BIN}" >/dev/null 2>&1; then
    cat >&2 <<EOF
ERROR: '${DOCKER_BIN}' is not on PATH.

  This script compiles the locks inside a digest-pinned Linux container so the
  output does not depend on who runs it (#3491). Options:

    • Install/start Docker, or point DOCKER= at the executable.
    • On a Linux host, pass --native to use the local interpreter. The result
      is NOT guaranteed to match what CI and the images resolve.
EOF
    exit 1
fi

# Host path in a form the Docker daemon understands. Under Git Bash \$PWD is a
# /e/... MSYS path the Windows daemon cannot mount; `pwd -W` yields E:/...
host_mount_path() {
    case "${HOST_OS}" in
        MINGW*|MSYS*|CYGWIN*) (cd "$1" && pwd -W) ;;
        *) printf '%s\n' "$1" ;;
    esac
}

# Files a root-owned container writes into a bind mount come back root-owned on
# a Linux host. Hand the container the caller's ids so it can hand them back.
# Windows/macOS Docker Desktop maps ownership at the mount, so this is empty
# there and no chown is attempted.
CHOWN_TO=""
if [[ "${HOST_OS}" == "Linux" ]]; then
    CHOWN_TO="$(id -u):$(id -g)"
fi

# Shared pip-compile flags.  Kept as an array so the expansion is safe.
#
#   --generate-hashes       — emit sha256 hashes for every resolved artifact
#                             (hash-checking mode; failed hash = install error).
#   --resolver=backtracking — pip's backtracking resolver (pip-tools default
#                             since 7.0 but passed explicitly for clarity).
#   --strip-extras          — drop the `[extra]` suffix from wheel URLs so
#                             the lock remains stable across pip-tools versions.
#   --quiet                 — suppress the pip-tools banner; errors still print.
#   --allow-unsafe          — include pip/setuptools/pkg_resources themselves
#                             (needed for `pip install -r lock` to succeed in
#                             hash-checking mode on modern pip).
#   --no-emit-index-url     — do not embed private index URLs in the lock
#                             (keeps the file reproducible across networks).
#
# `--upgrade` / `--upgrade-package` are appended per run and are deliberately
# NOT recorded in the lock's autogenerated header by pip-tools, so the
# canonical command line in the file stays byte-identical and a later plain
# run of this script remains consistent with it.
PIP_COMPILE_FLAGS=(
    --generate-hashes
    --resolver=backtracking
    --strip-extras
    --allow-unsafe
    --no-emit-index-url
    --quiet
)

cd "${REPO_ROOT}"
mkdir -p requirements

# The inner script the container runs. Written once, here, so the plan printed
# by --print-plan is the same text that executes.
#
# The single quotes are load-bearing and SC2016 is disabled deliberately: `$1`,
# `$@`, `${CHOWN_TO}` and `${OUT_FILE}` must reach the CONTAINER's shell, not be
# expanded by this one. Expanding them here would hard-code the host's values
# into the string and silently drop the per-extra arguments.
# shellcheck disable=SC2016
CONTAINER_SCRIPT='set -e
pip install --quiet --disable-pip-version-check --root-user-action=ignore "pip-tools==$1"
shift
python -m piptools compile "$@"
if [ -n "${CHOWN_TO:-}" ]; then chown "${CHOWN_TO}" "${OUT_FILE}"; fi'

# ---------------------------------------------------------------------------
# ResolutionImpossible is the failure this script exists to stop mis-reporting.
#
# pip-compile hands the existing lock back to the resolver as constraints, so
# "no solution exists" and "I forbade the solution" produce the same message.
# This distinguishes them by FACT: it collects every `name` + `version` the
# resolver named and asks whether each is a pin in the lock we just fed it.
# Pairs that are get named as reused constraints. When none are, that is said
# plainly rather than guessed at (deploy-integrity.md R7).
#
# THE VERSION IS NAMED IN FOUR DIFFERENT SHAPES and the first draft of this
# only read one of them. Against the REAL failure (bff, 2026-08-15) pip-tools
# raised the ResolutionImpossible from inside resolvelib, so the blocker
# appeared only as a wheel URL:
#
#     LinkCandidate('https://…/msal-1.36.0-py3-none-any.whl …')
#
# `msal 1.36.0` never appears with a space, so the extractor found nothing and
# the script printed "NONE of the versions the resolver named is a pin" over a
# lock that pins `msal==1.36.0` on line 289. Honest, and useless — a guard
# keyed to the shape the defect does not take. All four shapes are read now.
# ---------------------------------------------------------------------------
normalize_pkg() {
    printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]' | tr '._' '--'
}

# grep that tolerates "matched nothing" (exit 1) but still fails on a real
# grep error (exit >1). A blanket `|| true` would swallow the second.
grep_ok() {
    local rc=0
    grep "$@" || rc=$?
    [[ ${rc} -le 1 ]] || return "${rc}"
}

# Every `name version` the resolver named, one pair per line, from all four
# shapes pip/pip-tools use.
extract_named_versions() {
    local log="$1"
    # `msal 1.36.0 depends on …` — pip's human-readable conflict block.
    grep_ok -oE "[A-Za-z0-9][A-Za-z0-9._-]* [0-9][0-9A-Za-z.*+!-]*" "${log}"
    # `Cannot install msal==1.36.0 and …`
    grep_ok -oE "[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][0-9A-Za-z.*+!]*" "${log}" | sed 's/==/ /'
    # `…/msal-1.36.0-py3-none-any.whl` — the shape the real failure took.
    grep_ok -oE "[A-Za-z0-9][A-Za-z0-9._]*-[0-9][0-9A-Za-z.!+]*-[A-Za-z0-9._]+-[A-Za-z0-9._]+-[A-Za-z0-9._]+\.whl" "${log}" \
        | sed -E 's/^([A-Za-z0-9][A-Za-z0-9._]*)-([0-9][0-9A-Za-z.!+]*)-.*$/\1 \2/'
    # `…/msal-1.36.0.tar.gz` — the sdist equivalent.
    grep_ok -oE "[A-Za-z0-9][A-Za-z0-9._-]*-[0-9][0-9A-Za-z.!+]*\.(tar\.gz|zip)" "${log}" \
        | sed -E 's/^(.*)-([0-9][0-9A-Za-z.!+]*)\.(tar\.gz|zip)$/\1 \2/'
}

diagnose_failure() {
    local extra="$1" lock="$2" log="$3" rc="$4"
    {
        echo ""
        echo "ERROR: pip-compile exited ${rc} while regenerating ${lock} (extra: ${extra})."
        echo ""
        sed 's/^/    | /' "${log}"
        echo ""
    } >&2

    if ! grep -qE "ResolutionImpossible|The conflict is caused by" "${log}"; then
        echo "  This script does not recognise that failure and will not guess at a cause." >&2
        return
    fi

    if [[ ! -f "${lock}" ]]; then
        cat >&2 <<EOF
  The resolver reported a conflict and ${lock} does not exist yet, so no
  previous pins were fed back to it. The conflict is between the declared
  requirements themselves — widen or correct pyproject.toml.
EOF
        return
    fi

    local blockers=()
    local name version norm
    while read -r name version; do
        [[ -z "${name}" || -z "${version}" ]] && continue
        norm="$(normalize_pkg "${name}")"
        # Is that exact version a pin in the lock we handed back as constraints?
        if grep -qiE "^${norm//-/[-_.]}==${version//./\\.}([[:space:]\\\\]|$)" "${lock}"; then
            local seen=0 b
            for b in ${blockers[@]+"${blockers[@]}"}; do
                [[ "${b}" == "${norm}" ]] && seen=1
            done
            [[ ${seen} -eq 0 ]] && blockers+=("${norm}")
        fi
    done < <(extract_named_versions "${log}")

    if [[ ${#blockers[@]} -eq 0 ]]; then
        cat >&2 <<EOF
  ResolutionImpossible, and NONE of the versions the resolver named is a pin in
  ${lock}. This script therefore cannot attribute the conflict to constraints it
  reused, and will not claim it did. Read the explanation above: the conflict is
  most likely between the declared requirements in pyproject.toml.
EOF
        return
    fi

    local rerun="  scripts/update-locks.sh ${extra}"
    local b
    for b in "${blockers[@]}"; do
        rerun+=" --upgrade-package ${b}"
    done

    cat >&2 <<EOF
  These versions named in the resolver's explanation are ALREADY PINNED in
  ${lock}: ${blockers[*]}

  pip-compile reuses that lock as constraints, so those pins were handed to the
  resolver as hard requirements. If one of them caps the package whose floor you
  just raised, no solution exists WITH THEM HELD — which is not the same as no
  solution existing. Release exactly those and re-run:

${rerun}

  See docs/SUPPLY_CHAIN.md §6.2.
EOF
}

# ---------------------------------------------------------------------------
# Use repo-relative paths for --output-file so the autogenerated header line
# that pip-compile embeds in each lock is identical across machines (otherwise
# Windows absolute paths like E:/... would leak in and churn diffs for every
# contributor).
#
# THE LAYOUT IS `requirements/locks/<extra>/requirements.txt`, NOT `<extra>.lock`,
# AND EVERY PART OF THAT PATH IS LOAD-BEARING (#3485). Trivy's pip analyzer and
# Syft's python cataloger both key on the FILENAME. Measured 2026-08-15 against
# one directory holding all three spellings of the same file:
#
#     requirements/bff.lock               Trivy num=0   Syft 0 components
#     requirements/bff.requirements.txt   Trivy num=0   Syft 13 components
#     requirements/bff/requirements.txt   Trivy SEES it Syft 13 components
#
# So `.lock` was invisible to BOTH, the obvious rename fixes only Syft, and only
# a file literally named `requirements.txt` is recognised by both with no
# scanner configuration at all — which is the point: a `--file-patterns` config
# can silently regress when a tool changes its defaults, and a filename cannot.
#
# The extra `locks/` level is not decoration either. Trivy's default skip list
# is ROOT-ANCHORED, and `dev` is on it: with the scan rooted at `requirements/`,
# a `requirements/dev/requirements.txt` is silently dropped while every sibling
# is scanned. Measured on a probe directory — `dev/` and `proc/` skipped,
# `nested/dev/`, `devx/`, `tmp/` and `portal/` all scanned. One level of nesting
# moves every extra off the anchor. `scripts/ci/check-lock-scan-coverage.mjs` is
# what caught this, and is what will catch the next one.
# ---------------------------------------------------------------------------
LOG_DIR="$(mktemp -d)"
trap 'rm -rf "${LOG_DIR}"' EXIT

FAILED=()

for extra in "${EXTRAS[@]}"; do
    LOCK_FILE_REL="requirements/locks/${extra}/requirements.txt"
    mkdir -p "requirements/locks/${extra}"

    COMPILE_ARGS=("${PIP_COMPILE_FLAGS[@]}")
    [[ ${UPGRADE_ALL} -eq 1 ]] && COMPILE_ARGS+=(--upgrade)
    for pkg in ${UPGRADE_PACKAGES[@]+"${UPGRADE_PACKAGES[@]}"}; do
        COMPILE_ARGS+=(--upgrade-package "${pkg}")
    done
    if [[ "${extra}" != "base" ]]; then
        COMPILE_ARGS+=(--extra "${extra}")
    fi
    COMPILE_ARGS+=(--output-file "${LOCK_FILE_REL}" pyproject.toml)

    if [[ ${PRINT_PLAN} -eq 1 ]]; then
        if [[ "${MODE}" == "native" ]]; then
            echo "PLAN ${extra}: ${PYTHON:-python3} -m piptools compile ${COMPILE_ARGS[*]}"
        else
            echo "PLAN ${extra}: ${DOCKER_BIN} run --rm --volume <repo>:/repo --workdir /repo ${COMPILE_IMAGE} sh -c '<install pip-tools==${PIP_TOOLS_VERSION}>' sh ${PIP_TOOLS_VERSION} python -m piptools compile ${COMPILE_ARGS[*]}"
        fi
        continue
    fi

    if [[ "${extra}" == "base" ]]; then
        echo "→ Regenerating ${LOCK_FILE_REL}  (base — no extra)"
    else
        echo "→ Regenerating ${LOCK_FILE_REL}  (extra: ${extra})"
    fi

    LOG="${LOG_DIR}/${extra}.log"
    RC=0
    if [[ "${MODE}" == "native" ]]; then
        "${PYTHON}" -m piptools compile "${COMPILE_ARGS[@]}" >"${LOG}" 2>&1 || RC=$?
    else
        MSYS_NO_PATHCONV=1 "${DOCKER_BIN}" run --rm \
            --volume "$(host_mount_path "${REPO_ROOT}"):/repo" \
            --workdir /repo \
            --env HOME=/tmp \
            --env PIP_CACHE_DIR=/tmp/pip-cache \
            --env "CHOWN_TO=${CHOWN_TO}" \
            --env "OUT_FILE=${LOCK_FILE_REL}" \
            "${COMPILE_IMAGE}" \
            sh -c "${CONTAINER_SCRIPT}" sh "${PIP_TOOLS_VERSION}" "${COMPILE_ARGS[@]}" \
            >"${LOG}" 2>&1 || RC=$?
    fi

    if [[ ${RC} -ne 0 ]]; then
        diagnose_failure "${extra}" "${LOCK_FILE_REL}" "${LOG}" "${RC}"
        FAILED+=("${extra}")
        continue
    fi

    # A pip-compile that exits 0 having written nothing is the "gate that
    # measures nothing" shape; refuse to report a regeneration that did not
    # happen.
    if [[ ! -s "${LOCK_FILE_REL}" ]]; then
        echo "ERROR: pip-compile exited 0 but ${LOCK_FILE_REL} is missing or empty." >&2
        FAILED+=("${extra}")
    fi
done

if [[ ${PRINT_PLAN} -eq 1 ]]; then
    exit 0
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo "" >&2
    echo "FAILED to regenerate: ${FAILED[*]}" >&2
    exit 1
fi

echo ""
echo "Done. Review the diff and commit the lock files:"
echo "   git add requirements/ && git status"
