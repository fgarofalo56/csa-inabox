# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# CSA Loom — Loom Direct Lake columnar cache/scan service (HYP-5)
# ---------------------------------------------------------------------------
# Image: <acr-login-server>/loom-directlake:<tag>
# Built server-side with ACR Tasks (NO local Docker daemon required), same path
# as the loom-script-runner / gh-aca-runner images:
#   az acr build -r <acr> -t loom-directlake:<tag> apps/loom-directlake
#
# WHAT this carries: a single Rust/axum binary (loom-directlake) that FRAMES a
# Delta/Parquet source and TRANSCODES scanned columns to an Arrow IPC stream via
# Apache DataFusion — the Azure-native, OSS outcome-equivalent of Fabric Direct
# Lake. NO Power BI / Fabric / OneLake service is contacted
# (.claude/rules/no-fabric-dependency.md): the abfss:// Delta path reads the
# customer's OWN ADLS Gen2 via Managed Identity (object_store + delta-rs).
#
# The bundled fixtures/sales.parquet + the in-memory `fixture://sales` source
# make the /scan core path executable with ZERO Azure — no stub, no mock frame
# (.claude/rules/no-vaporware.md). When LOOM_DIRECTLAKE_STORAGE_ACCOUNT is unset,
# only the abfss:// path honest-gates (503); fixture:// and file:// still run.
#
# Internal ingress ONLY (external:false in the ACA module) — reached solely by
# the Console BFF over the Container Apps environment / VNet, never public.
# ---------------------------------------------------------------------------

# ---- Build stage: compile the release binary -------------------------------
# Pinned to a specific Rust toolchain tag (bookworm base) so the arrow 53 /
# datafusion 43 / deltalake 0.24 graph resolves reproducibly. Bump deliberately.
FROM rust:1.82-slim-bookworm AS build

# Transitive native deps: pkg-config + build-essential cover any *-sys crate that
# needs a C toolchain; ca-certificates lets cargo fetch over TLS. delta-rs/
# object_store use rustls (no OpenSSL), so libssl-dev is intentionally omitted to
# keep the build lean — add it only if a future feature pulls an openssl-sys dep.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        pkg-config \
        build-essential \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Cache the dependency graph: copy the manifest first and pre-build deps against
# a stub main, so app-source edits don't re-download/re-compile the whole tree.
COPY Cargo.toml ./
RUN mkdir -p src \
    && echo 'fn main() { println!("dep-cache stub"); }' > src/main.rs \
    && cargo build --release || true

# Now the real sources + the bundled fixture.
COPY src ./src
COPY fixtures ./fixtures
# Touch main.rs so the stub build above is invalidated and the real bin compiles.
RUN touch src/main.rs \
    && cargo build --release \
    && cp target/release/loom-directlake /usr/local/bin/loom-directlake

# ---- Runtime stage: minimal, non-root -------------------------------------
FROM debian:bookworm-slim AS runtime

# ca-certificates so the MI-authenticated HTTPS calls to ADLS / IMDS validate.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 runner

WORKDIR /app

# The compiled binary + the bundled fixture (the fixture backs `file://` scans
# and lets a from-scratch container prove the core path with no Azure).
COPY --from=build /usr/local/bin/loom-directlake /usr/local/bin/loom-directlake
COPY --from=build /build/fixtures /app/fixtures
RUN chown -R runner:runner /app

# Drop privileges — the service and every scan run as the unprivileged runner.
USER runner

# RUST_LOG default; PORT is read by main.rs (matches the ACA targetPort).
ENV RUST_LOG=loom_directlake=info \
    PORT=8080

EXPOSE 8080

# Exec-form so the binary is PID 1 and receives SIGTERM directly on ACA scale-in
# (the axum graceful-shutdown handler catches it).
CMD ["/usr/local/bin/loom-directlake"]
