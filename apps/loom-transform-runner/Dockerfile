# CSA Loom — transform runner image (N4).
#
# ONE runtime, TWO transformation engines:
#   • dbt-core (+ dbt-synapse / dbt-databricks / dbt-duckdb / opt-in dbt-fabric)
#     — the ecosystem default, unchanged from the existing loom-dbt-runner.
#   • SQLMesh — virtual data environments, Terraform-style plan/apply, and
#     column-level model diffs.
#
# Microsoft ODBC Driver 18 for SQL Server is required by dbt-synapse /
# dbt-fabric and by SQLMesh's mssql engine adapter. Authentication to every
# backend is the container's USER-ASSIGNED MANAGED IDENTITY (AZURE_CLIENT_ID is
# injected by bicep) — no passwords, no storage keys, no secrets in app
# settings.
#
# SOVEREIGN MOAT: this is OSS Python running on Azure Container Apps inside the
# deployment's own VNet. It has no SaaS control plane (no dbt Cloud, no Tobiko
# Cloud), so the full plan/apply/diff capability runs DISCONNECTED in an IL5
# air-gapped enclave against in-boundary Synapse / Databricks / DuckDB-on-ADLS.
FROM python:3.11-slim

# Microsoft ODBC Driver 18 for SQL Server (dbt-synapse / dbt-fabric / SQLMesh mssql).
#
# The leading `dist-upgrade` is the repo-standard SC1 hardening (same as
# apps/fiab-mcp-bridge/Dockerfile): it pulls the distro's security patches
# AHEAD of the pinned base tag, which is how OS-layer CRITICALs get cleared here
# without waiting for a base rebuild.
#
# DO NOT REMOVE THIS LINE. It is LOAD-BEARING TODAY, whatever it was when it
# was written. An earlier revision said "the debian 13.6 layer of this image
# scans 0 CRITICAL today — this is prophylactic". A revision after THAT said the
# first one "inverts the causation" — which asserts a mistake that was never
# established, and is itself the R7 overshoot it was correcting.
#
# What git says: `git log -S` for BOTH "prophylactic" and "dist-upgrade" on this
# file returns the same INTRODUCING commit, 38f4ac6f6e9 (2026-07-28). (Each
# returns several commits today — later ones move the word; it is the earliest
# that matters, and it is shared.) The word and the line landed together, and
# the `perl-base` CRITICALs were not gate-visible here until at least
# 2026-09-15: the earliest RED build recorded for the sibling images is
# 2026-09-15 (apps/loom-migrate/Dockerfile:24, #4547 — an OBSERVATION WINDOW,
# not a database date; both gates run `ignore-unfixed: true`, so a CRITICAL only
# becomes gate-visible once Debian publishes its fix). So the
# original sentence was true of its date and went stale seven weeks later: a
# dated record that lost its date, not an inverted causation.
#
# An earlier revision of THIS paragraph said the CVEs "did not enter the Trivy
# database until 2026-09-15" and cited that same file for it. The file records
# no such thing, nothing in this repo measured Trivy's database, and the claim
# asserts an unestablished negative over the whole 2026-07-28 → 2026-09-14
# window. An R7 overshoot inside the paragraph correcting an R7 overshoot; the
# conclusion survives all readings, only the mechanism was invented.
#
# What IS established, measured 2026-09-17 (#4547): this image is
# `FROM python:3.11-slim`, which resolved that day to debian 13.6 carrying the
# vulnerable `perl-base`; it scans 0 CRITICAL with this line, while the two
# sibling images lacking it scanned three CRITICALs each off the same base. That
# is a claim about 2026-09-17, dated here so the next reader does not inherit it
# as timeless the way the last one did.
#
# WHERE TRIMMING IT IS CAUGHT — AND WHERE IT IS NOT. This matters more than the
# archaeology above.
#   Commercial: built by full-app-deploy-commercial.yml:435-436, the canonical
#   from-scratch app path in no-vaporware.md, under the SC1 Trivy CRITICAL gate.
#   Trimming this line reds that path.
#
#   GCC-High / IL5: this image is ALSO built by
#   gov-provision-runner-images.yml:264/:312 — and that lane has NO
#   supply-chain gate whatsoever. Measured 2026-09-18: zero matches for trivy,
#   cosign or "supply" in that workflow, against 9 / 36 / 31 in the Commercial
#   lane. On the sovereign boundaries, trimming this line reds nothing and ships
#   three CRITICALs silently.
#
# So the deterrent is inverted exactly where cloud-parity.md says the need is
# greatest. That gap belongs to the GOV LANE, not to this file, and is NOT fixed
# by this comment — it is issue #4584. Recorded here because a reader of this
# file would otherwise conclude the gate has them covered on every boundary.
RUN apt-get update && apt-get dist-upgrade -y \
    && apt-get install -y --no-install-recommends curl gnupg2 apt-transport-https ca-certificates unixodbc-dev gcc g++ git \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" > /etc/apt/sources.list.d/mssql-release.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-security.txt ./
COPY scripts ./scripts

# Two passes on purpose. requirements.txt is the resolvable pin set;
# requirements-security.txt then OVERRIDES transitive pins that would otherwise
# ship a CRITICAL CVE (today: deepdiff 7.0.1 / CVE-2025-58367, held back by
# dbt-common 1.27.1, which is itself held by dbt-core's protobuf<6 fence). See
# that file for the full justification and the removal plan.
#
# The override deliberately conflicts with a declared range, so pip emits a
# "dependency conflicts" advisory and still exits 0 — which means a typo would
# fail SILENTLY. scripts/assert_security_pins.py turns that back into a build
# failure.
#
# That assertion lives in a FILE, not an inline heredoc: ACR Tasks' classic
# builder does not support Dockerfile heredocs (they require BuildKit). A
# heredoc here builds fine under a local `docker build` and then dies in CI with
# `failed to run step ID: build: failed to scan dependencies: exit status 1`
# after ~3s, before any layer runs — an opaque message that names neither the
# heredoc nor the parser. Keep this Dockerfile BuildKit-feature-free.
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir -r requirements-security.txt \
    && python scripts/assert_security_pins.py

COPY app ./app

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
