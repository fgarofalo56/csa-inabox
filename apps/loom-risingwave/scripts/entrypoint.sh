#!/bin/sh
# CSA Loom — loom-risingwave FAIL-CLOSED authentication bootstrap.
#
# WHY THIS EXISTS (2026-07-29, operator finding on the live Commercial estate).
# `risingwavelabs/risingwave` ships a `root` superuser with NO password. The
# frontend's `UserAuthenticator` is `None` for a user whose `AuthInfo` is unset,
# so ANY Postgres-wire client that can open a TCP connection is root. The image
# was deployed to the live estate with env `[LOOM_LAKE_ACCOUNT]` and zero
# secrets, on `cae-csa-loom-centralus` — the SAME Container Apps environment as
# `loom-script-runner` and `loom-udf-runtime`, two services whose entire purpose
# is executing user-supplied code. That is an unauthenticated database one hop
# away from arbitrary user code. The app was removed from the estate.
#
# Neither of the network-shaped fixes actually closes it:
#   * ACA ingress IP rules (`ipSecurityRestrictions`) can only name CIDRs, and
#     EVERY app in a Container Apps environment draws its pod IP from the SAME
#     infrastructure subnet. An allow-list that admits the Console necessarily
#     admits loom-script-runner and loom-udf-runtime.
#   * A dedicated Container Apps environment has the same problem one level up:
#     its infrastructure subnet is reachable from the peer subnets in the VNet,
#     and an NSG keyed on the Console's subnet again admits the code-execution
#     apps, because they share it.
# Only a CREDENTIAL separates the Console from its neighbours. That is what this
# script installs, and it installs it BEFORE the wire port is ever bound to a
# routable address.
#
# THE CONTRACT
#   1. LOOM_RW_ROOT_PASSWORD must be present and non-empty. It arrives as a
#      Container Apps SECRET REFERENCE (Key-Vault-backed; see
#      platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep), never
#      as a plain env literal. If it is missing the container REFUSES TO START.
#      There is no "unauthenticated fallback" branch anywhere below — that is
#      the property that makes "loom-risingwave is never unauthenticated"
#      checkable rather than aspirational.
#   2. Phase 1 (SEALED) starts the engine with the frontend bound to
#      127.0.0.1 only. Upstream `single_node` forwards `--listen-addr` straight
#      to `FrontendOpts.listen_addr`
#      (src/cmd_all/src/single_node.rs, v2.1.3), so during bootstrap the wire
#      port exists ONLY inside this container's network namespace. Nothing in
#      the CAE, the VNet or the pod's own subnet can reach it — there is no
#      race window, not even a pod-IP one.
#   3. Still in phase 1, `ALTER USER root PASSWORD '<secret>'` is applied and
#      then VERIFIED: a password-less connection must be REJECTED. If it is
#      still accepted the script kills the engine and exits non-zero, so the
#      revision fails to become healthy instead of serving an open database.
#   4. Phase 2 (SERVING) re-execs the engine against the SAME store directory
#      (the SQLite meta store that now holds root's md5 credential) bound to
#      0.0.0.0. From the first instant the port is routable, root requires the
#      password.
#
# Rotation is free: the ALTER is re-applied on every boot, so a new Key Vault
# secret value simply takes effect on the next revision/restart.
#
# POSIX sh only (`set -eu`) — this image has no bash guarantee.

set -eu

# Upstream's image sets ENTRYPOINT ["/risingwave/bin/risingwave"] and does NOT
# put the binary on PATH (docker/Dockerfile, v2.1.3). This entrypoint replaces
# that ENTRYPOINT, so resolve the binary explicitly instead of assuming PATH.
if [ -n "${LOOM_RW_BIN:-}" ]; then
  RW_BIN="$LOOM_RW_BIN"
elif [ -x /risingwave/bin/risingwave ]; then
  RW_BIN=/risingwave/bin/risingwave
elif command -v risingwave >/dev/null 2>&1; then
  RW_BIN=risingwave
else
  echo "[loom-risingwave] FATAL: the risingwave binary was not found (looked at /risingwave/bin/risingwave and \$PATH)." >&2
  exit 1
fi
FRONTEND_PORT="${LOOM_RW_FRONTEND_PORT:-4566}"
STORE_DIR="${LOOM_RW_STORE_DIRECTORY:-/root/.risingwave}"
BOOTSTRAP_DB="${LOOM_RW_BOOTSTRAP_DATABASE:-dev}"
BOOTSTRAP_TIMEOUT="${LOOM_RW_BOOTSTRAP_TIMEOUT_SECS:-180}"

log() { echo "[loom-risingwave] $*" >&2; }

# ── 1. FAIL CLOSED ────────────────────────────────────────────────────────────
# No password => no database. Exiting 1 here is the whole security property:
# an operator cannot accidentally (or deliberately) run this image open.
if [ -z "${LOOM_RW_ROOT_PASSWORD:-}" ]; then
  log "FATAL: LOOM_RW_ROOT_PASSWORD is empty or unset."
  log "FATAL: RisingWave's built-in 'root' user has NO password, so starting"
  log "FATAL: without one would publish an unauthenticated Postgres-wire"
  log "FATAL: database to every workload in this Container Apps environment"
  log "FATAL: (including loom-script-runner / loom-udf-runtime, which execute"
  log "FATAL: user-supplied code). Refusing to start."
  log "FATAL: Deploy via platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep"
  log "FATAL: with risingwaveConfig.rootPasswordSecretUri (Key Vault secret URI,"
  log "FATAL: resolved by the app's managed identity) or the @secure()"
  log "FATAL: risingwaveRootPassword parameter. Both render a Container Apps"
  log "FATAL: SECRET and bind it as secretRef — never a plain env literal."
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  log "FATAL: psql is not on PATH. The authentication bootstrap cannot run, and"
  log "FATAL: this image must never start without it. Rebuild apps/loom-risingwave"
  log "FATAL: (its Dockerfile installs postgresql-client for exactly this step)."
  exit 1
fi

mkdir -p "$STORE_DIR"

# Upstream's CMD was `["single_node"]` (an ARGUMENT to its `risingwave`
# ENTRYPOINT). This entrypoint supplies the subcommand itself, so a stale
# `--command single_node` override from an older deployment template would land
# as a spurious positional and clap would reject it. Drop it defensively.
if [ "${1:-}" = "single_node" ]; then
  shift
fi

# psql inherits the password from the environment; it is never passed on a
# command line (argv is world-readable via /proc on a shared kernel).
PSQL_SEALED="psql --host=127.0.0.1 --port=${FRONTEND_PORT} --username=root --dbname=${BOOTSTRAP_DB} --no-password --quiet --tuples-only --no-align"

# ── 2. PHASE 1 — SEALED BOOT (loopback-only frontend) ─────────────────────────
log "phase 1/2: starting the engine SEALED (frontend bound to 127.0.0.1:${FRONTEND_PORT} only)"
"$RW_BIN" single_node --listen-addr "127.0.0.1:${FRONTEND_PORT}" --store-directory "$STORE_DIR" &
BOOTSTRAP_PID=$!

fail() {
  log "FATAL: $*"
  kill "$BOOTSTRAP_PID" 2>/dev/null || true
  wait "$BOOTSTRAP_PID" 2>/dev/null || true
  exit 1
}

# Wait for the sealed frontend to answer SQL. `root` still has no password at
# this point, which is exactly why the listener is on loopback.
READY=0
WAITED=0
while [ "$WAITED" -lt "$BOOTSTRAP_TIMEOUT" ]; do
  if ! kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
    fail "the engine exited during the sealed bootstrap (see the lines above)."
  fi
  if PGPASSWORD='' $PSQL_SEALED --command 'SELECT 1' >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done
[ "$READY" = "1" ] || fail "the sealed frontend did not accept SQL within ${BOOTSTRAP_TIMEOUT}s."

# ── 3. SET THE CREDENTIAL ─────────────────────────────────────────────────────
# Fed on stdin so the secret never appears in argv or in `ps`. RisingWave stores
# it md5(password + username)-hashed (src/frontend/src/user/user_authentication.rs),
# and the wire handshake is then a salted md5 challenge — the cleartext secret
# never crosses the connection even though ACA TCP ingress does not offer TLS.
#
# SQL-literal safety: a single quote in an operator-supplied password would end
# the literal early, so quotes are doubled the way every SQL dialect expects.
ESCAPED_PASSWORD=$(printf '%s' "$LOOM_RW_ROOT_PASSWORD" | sed "s/'/''/g")

log "applying the root credential (ALTER USER root PASSWORD)"
apply_password() {
  # Two spellings because the grammar accepts the optional WITH and the
  # published example omits it; if the pinned engine ever tightens either way
  # the other still lands. A silent no-op is impossible: step 4 verifies.
  printf "ALTER USER root PASSWORD '%s';\n" "$ESCAPED_PASSWORD" \
    | PGPASSWORD='' $PSQL_SEALED --set=ON_ERROR_STOP=1 --file=- >/dev/null 2>&1 && return 0
  printf "ALTER USER root WITH PASSWORD '%s';\n" "$ESCAPED_PASSWORD" \
    | PGPASSWORD='' $PSQL_SEALED --set=ON_ERROR_STOP=1 --file=- >/dev/null 2>&1 && return 0
  return 1
}
apply_password || fail "ALTER USER root PASSWORD failed."

# ── 4. VERIFY IT ACTUALLY TOOK ────────────────────────────────────────────────
# Assert the negative: an anonymous connection must now be REFUSED. If this
# still succeeds the engine is open, and the correct response is to die rather
# than to bind a routable port. `--no-password` makes psql fail instead of
# prompting, so a rejected auth is a non-zero exit, not a hang.
if PGPASSWORD='' $PSQL_SEALED --command 'SELECT 1' >/dev/null 2>&1; then
  fail "root STILL accepts a password-less connection after ALTER USER. Refusing to expose the wire port."
fi
# ...and the credential we just set must work.
PGPASSWORD="$LOOM_RW_ROOT_PASSWORD" $PSQL_SEALED --command 'SELECT 1' >/dev/null 2>&1 \
  || fail "root does not accept the configured password after ALTER USER."
log "verified: anonymous connect REJECTED, credentialed connect ACCEPTED"

# ── 5. PHASE 2 — SERVING BOOT (routable frontend) ─────────────────────────────
# Stop the sealed instance and hand the process over to a normally-bound engine.
# The SQLite meta store under $STORE_DIR carries root's credential across the
# restart, so the port is authenticated from the first packet it ever answers.
log "phase 1 complete — stopping the sealed engine"
kill "$BOOTSTRAP_PID" 2>/dev/null || true
wait "$BOOTSTRAP_PID" 2>/dev/null || true

log "phase 2/2: starting the engine SERVING on 0.0.0.0:${FRONTEND_PORT} (root now requires a password)"
exec "$RW_BIN" single_node --listen-addr "0.0.0.0:${FRONTEND_PORT}" --store-directory "$STORE_DIR" "$@"
