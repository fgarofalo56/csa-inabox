#!/bin/sh
# CSA Loom — loom-risingwave FAIL-CLOSED bootstrap: ONE routable port, and that
# one requires a credential.
#
# ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
#
# (1) 2026-07-29, operator finding on the live Commercial estate.
# `risingwavelabs/risingwave` ships a `root` superuser with NO password. The
# frontend's `UserAuthenticator` is `None` for a user whose `AuthInfo` is unset,
# so ANY Postgres-wire client that can open a TCP connection is root. The image
# was deployed with env `[LOOM_LAKE_ACCOUNT]` and zero secrets on
# `cae-csa-loom-centralus` — the SAME Container Apps environment as
# `loom-script-runner` and `loom-udf-runtime`, two services whose entire purpose
# is executing user-supplied code. The app was removed from the estate.
#
# (2) 2026-07-30 round-4 review: THE CREDENTIAL ALONE WAS NOT ENOUGH. It guards
# the Postgres wire on 4566 and nothing else. `single_node` binds FIVE routable
# ports, four of which have no authentication of any kind. Measured on the pinned
# image (`/proc/net/tcp`, stock `risingwave single_node`, v2.1.3):
#
#     0.0.0.0:4566   Postgres-wire frontend          <- the credential covers ONLY this
#     0.0.0.0:5688   compute-node gRPC               <- NO AUTH (Exchange/Task/Config/Monitor)
#     0.0.0.0:5690   meta-node gRPC                  <- NO AUTH (Cluster/Ddl/HummockManager)
#     0.0.0.0:5691   meta dashboard HTTP + REST API  <- NO AUTH
#     0.0.0.0:6660   compactor gRPC                  <- NO AUTH
#     127.0.0.1:1260 prometheus metrics              (already loopback)
#     127.0.0.1:6786 frontend health-check gRPC      (already loopback)
#
# Container Apps ingress publishes only `targetPort`, but ingress is not a
# firewall: a replica holds a VNet IP from the environment's infrastructure
# subnet, so a sibling app in that subnet reaches those ports on the pod IP
# directly. The meta gRPC service alone can create and drop catalog objects.
#
# `single_node` CANNOT be made to bind them anywhere else. Upstream hard-codes
# the addresses in `map_single_node_opts_to_standalone_opts`
# (src/cmd_all/src/single_node.rs, v2.1.3):
#
#     meta_opts.listen_addr      = "0.0.0.0:5690".to_string();
#     meta_opts.dashboard_host   = Some("0.0.0.0:5691".to_string());
#     compute_opts.listen_addr   = "0.0.0.0:5688".to_string();
#     compactor_opts.listen_addr = "0.0.0.0:6660".to_string();
#
# and `single_node --help` exposes only `--listen-addr` (the FRONTEND) and
# `--prometheus-listener-addr`. There is no flag and no env var that reaches the
# other three. So this entrypoint runs the engine in `standalone` mode instead,
# which does expose per-node options, and passes every non-wire listener a
# loopback address. Everything else is byte-identical to what `single_node`
# derives — verified by diffing the engine's own parsed-opts log lines between
# `single_node` and this invocation on the pinned image: the meta backend
# (Sqlite), `--sql-endpoint <store>/meta_store/single_node.db`, the
# `hummock+fs://<store>/state_store` state store, `hummock_001`,
# `total_memory_bytes 4509715660`, `parallelism 2` and both
# `*_total_memory_bytes` all match; only the four addresses differ.
#
# Neither network-shaped fix closes it, which is why the seal is in-process:
#   * ACA ingress IP rules (`ipSecurityRestrictions`) can only name CIDRs, and
#     every app in a Container Apps environment draws its pod IP from the SAME
#     infrastructure subnet, so an allow-list that admits the Console
#     necessarily admits loom-script-runner and loom-udf-runtime. It also only
#     applies to the ingress path, not to a direct pod-IP connect.
#   * A dedicated Container Apps environment has the same problem one level up:
#     its infrastructure subnet is routable from the peer subnets in the VNet.
#   * An in-container packet filter needs NET_ADMIN, which Container Apps does
#     not grant.
# Removing the listener is strictly stronger than filtering it.
#
# ── THE CONTRACT ─────────────────────────────────────────────────────────────
#   1. LOOM_RW_ROOT_PASSWORD must be present and non-empty. It arrives as a
#      Container Apps SECRET REFERENCE (Key-Vault-backed; see
#      platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep), never
#      as a plain env literal. If it is missing the container REFUSES TO START.
#      There is no "unauthenticated fallback" branch anywhere below.
#   2. Phase 1 (SEALED) starts the engine with EVERY listener — including the
#      wire port — on 127.0.0.1, then ASSERTS THE NEGATIVE: `/proc/net/tcp` and
#      `/proc/net/tcp6` must show ZERO routable listening sockets OWNED BY THE
#      ENGINE'S PROCESS TREE. That is the measurement that proves the per-node
#      loopback options actually took effect on this binary, and it is taken
#      while nothing of the engine's is reachable from the pod IP. If any
#      engine-owned routable listener exists, the engine is killed and the
#      container exits non-zero.
#      OWNERSHIP SCOPING (2026-08-06, measured live on cae-csa-loom-centralus):
#      a Container Apps replica SHARES its network namespace with
#      platform-injected agents — four wildcard listeners (v4 8578/23045 and
#      two v6 ports) exist in every replica of every app, are not created by
#      this container, and cannot be removed by it. The original whole-netns
#      assertion therefore crash-looped on ACA while the engine itself was
#      correctly loopback-only (the docker measurement modeled the code's
#      assumption, not the ACA reality). The scan now matches the engine tree's
#      /proc/<pid>/fd socket inodes against the inode column of
#      /proc/net/tcp{,6}, so it asserts exactly what the contract promises: the
#      ENGINE exposes nothing routable. Platform sockets the platform owns are
#      the platform's posture, not this image's.
#   3. Still in phase 1, `ALTER USER root PASSWORD '<secret>'` is applied and
#      then VERIFIED: a password-less connection must be REJECTED and the
#      configured one ACCEPTED, or the container dies.
#   4. Phase 2 (SERVING) restarts the engine against the SAME store directory
#      (the SQLite meta store now holds root's md5 credential) with the SAME
#      loopback options and ONLY the frontend moved to 0.0.0.0. It then asserts
#      the routable surface again: EXACTLY ONE routable listener, and it must be
#      the wire port. Anything else and the container dies rather than serve.
#
# Rotation is free: the ALTER is re-applied on every boot, so a new Key Vault
# secret value simply takes effect on the next revision/restart.
#
# `--selftest` runs the routable-listener classifier against fixtures and exits;
# the Dockerfile runs it at BUILD time so a regression in the detection logic
# fails the build instead of silently passing every runtime assertion.
#
# POSIX sh only (`set -eu`) — this image has no bash guarantee.

set -eu

log() { echo "[loom-risingwave] $*" >&2; }

# ── Routable-listener enumeration ─────────────────────────────────────────────
# Reads LISTEN sockets (st == 0A) straight out of procfs — no ss/netstat/lsof
# dependency, none of which are in this image. Emits "<address> <port>" for every
# socket whose bind address is NOT loopback.
#
# /proc/net/tcp holds the v4 address as little-endian hex, so the FIRST octet is
# the LAST hex byte pair: 127.0.0.1 is 0100007F, 127.0.0.11 is 0B00007F, and the
# wildcard 0.0.0.0 is 00000000. The loopback test is therefore "the v4 hex ends
# in 7F", i.e. the whole 127.0.0.0/8 block — NOT an equality check against
# 0100007F. That distinction is not academic: a container in a user-defined
# Docker network has Docker's embedded DNS resolver listening on 127.0.0.11, and
# an equality check flagged it as routable and refused to start. Any sidecar or
# platform agent that binds a 127.x address other than 127.0.0.1 would do the
# same, which in Container Apps means a crash-loop.
#
# /proc/net/tcp6 holds 16 bytes as 4 little-endian words. ::1 is
# 00000000000000000000000001000000; an IPv4-mapped address is
# 0000000000000000FFFF0000<v4-le>, so mapped loopback again ends in 7F.
# Everything else — including both wildcards and any real interface address —
# is reachable from off-host and therefore routable.
#
# LOOM_RW_PROCNET_FILES overrides the input files (used by --selftest only).
#
# LOOM_RW_SOCKET_INODES ("<inode> <inode> ...") scopes the scan to sockets OWNED
# by those inodes — the runtime sets it from the live engine process tree before
# every assertion (see engine_socket_inodes), because an ACA replica's netns
# also carries platform-agent sockets this container does not own. When the
# variable is unset the scan covers the WHOLE namespace — the conservative
# (over-strict, fail-closed) direction.
routable_listeners() {
  _files="${LOOM_RW_PROCNET_FILES:-}"
  if [ -z "$_files" ]; then
    for _f in /proc/net/tcp /proc/net/tcp6; do
      [ -r "$_f" ] && _files="$_files $_f"
    done
  fi
  [ -n "$_files" ] || return 0
  # /proc/net/tcp{,6} field 10 is the socket inode — the join key to
  # /proc/<pid>/fd. The filter drops rows whose socket the engine tree does
  # not hold.
  # shellcheck disable=SC2086
  awk -v inodes="${LOOM_RW_SOCKET_INODES:-}" '
    BEGIN { n = split(inodes, only, " "); for (i = 1; i <= n; i++) own[only[i]] = 1 }
    FNR == 1 { next }
    $4 != "0A" { next }
    n > 0 && !($10 in own) { next }
    { m = split($2, a, ":"); if (m == 2) print toupper(a[1]) " " toupper(a[2]) }
  ' $_files 2>/dev/null \
    | while read -r _addr _hexport; do
        case "$_addr" in
          # 127.0.0.0/8 (v4). The v4 hex is exactly 8 chars and the FIRST octet is
          # the trailing pair, so this is six wildcards then 7F — 0100007F,
          # 0B00007F and every other 127.x.y.z.
          ??????7F) continue ;;
          # ::1
          00000000000000000000000001000000) continue ;;
          # ::ffff:127.0.0.0/8 — IPv4-mapped loopback.
          0000000000000000FFFF0000????????) case "$_addr" in *7F) continue ;; esac ;;
        esac
        # Decode v4 for the log line; leave v6 as hex (it is the rare case).
        case "$_addr" in
          ????????)
            _o1=$((0x$(printf '%s' "$_addr" | cut -c7-8)))
            _o2=$((0x$(printf '%s' "$_addr" | cut -c5-6)))
            _o3=$((0x$(printf '%s' "$_addr" | cut -c3-4)))
            _o4=$((0x$(printf '%s' "$_addr" | cut -c1-2)))
            _pretty="${_o1}.${_o2}.${_o3}.${_o4}"
            ;;
          *) _pretty="[v6:${_addr}]" ;;
        esac
        printf '%s %d\n' "$_pretty" "$((0x$_hexport))"
      done
}

# Just the ports, ascending — what the assertions compare against.
routable_ports() {
  routable_listeners | awk '{ print $2 }' | sort -un
}

# ── Engine-owned socket enumeration ───────────────────────────────────────────
# The engine's process tree: ENGINE_PID plus every descendant (the compute node
# can spawn a JVM connector child), found by a ppid scan of /proc/*/stat. The
# comm field may contain spaces or parens, so the ppid is read from the SECOND
# field after the LAST ')' — the only parse the proc(5) format guarantees.
engine_pids() {
  _all=" ${ENGINE_PID} "
  _grew=1
  while [ "$_grew" -eq 1 ]; do
    _grew=0
    for _sf in /proc/[0-9]*/stat; do
      [ -r "$_sf" ] || continue
      _line=$(cat "$_sf" 2>/dev/null) || continue
      _pid=${_line%% *}
      _rest=${_line##*) }
      _ppid=$(printf '%s' "$_rest" | awk '{ print $2 }')
      case "$_all" in *" ${_pid} "*) continue ;; esac
      case "$_all" in *" ${_ppid} "*) _all="${_all}${_pid} "; _grew=1 ;; esac
    done
  done
  printf '%s\n' "$_all"
}

# Socket inodes held by the engine tree, space-separated ("socket:[N]" fd links
# under /proc/<pid>/fd). Empty output means enumeration FAILED or the engine
# holds no sockets — the assertions treat that as an error, never as "clean",
# because a vacuous pass is exactly the gate-that-measures-nothing failure mode.
engine_socket_inodes() {
  for _p in $(engine_pids); do
    for _fd in /proc/"$_p"/fd/*; do
      _tgt=$(readlink "$_fd" 2>/dev/null) || continue
      case "$_tgt" in
        'socket:['*']') _i=${_tgt#socket:[}; printf '%s\n' "${_i%]}" ;;
      esac
    done
  done | sort -un | tr '\n' ' ' | sed 's/ *$//'
}

# ── --selftest: prove the classifier, at build time ───────────────────────────
# Exercises every address shape that matters against a synthetic procfs
# snapshot. This is the piece most likely to be quietly wrong (a bad hex
# comparison would make every runtime assertion pass vacuously, or refuse to
# start on a harmless loopback sidecar), so it is asserted where a failure stops
# the image from being produced.
if [ "${1:-}" = "--selftest" ]; then
  _t=$(mktemp -d)
  # sl local_address rem_address st ...   (st 0A == LISTEN, 01 == ESTABLISHED)
  #   0100007F -> 127.0.0.1        loopback
  #   0B00007F -> 127.0.0.11       loopback (Docker's embedded DNS resolver)
  #   00000000 -> 0.0.0.0          ROUTABLE (wildcard)
  #   0245A8C0 -> 192.168.69.2     ROUTABLE (a real interface address — the shape
  #                                a Container Apps pod IP takes)
  cat > "$_t/tcp" <<'EOF'
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:04EC 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1
   1: 00000000:11D2 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2
   2: 0100007F:1636 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3
   3: 00000000:1F40 0100007F:E1F0 01 00000000:00000000 00:00000000 00000000     0        0 4
   4: 0B00007F:8E99 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5
   5: 0245A8C0:1652 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 6
EOF
  cat > "$_t/tcp6" <<'EOF'
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1A0A 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 7
   1: 0000000000000000FFFF00000100007F:1A0B 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 8
   2: 00000000000000000000000000000000:1A0C 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9
   3: 0D01A8C0FFFF0000000000000000007F:1A0D 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 10
EOF
  # Expected routable ports: 0x11D2 = 4562 (v4 wildcard, inode 2), 0x1652 = 5714
  # (real interface address, inode 6), 0x1A0C = 6668 (v6 wildcard, inode 9) and
  # 0x1A0D = 6669 (inode 10 — a 32-char v6 address that merely ENDS in 7F
  # without the ::ffff: prefix; it must not be mistaken for mapped loopback).
  # Everything else is inside 127.0.0.0/8, is ::1 / ::ffff:127.x, or is
  # ESTABLISHED rather than LISTEN.
  LOOM_RW_PROCNET_FILES="$_t/tcp $_t/tcp6"
  export LOOM_RW_PROCNET_FILES
  # Pass 1 — classifier, whole namespace (no ownership filter).
  _got=$(routable_ports | tr '\n' ',')
  _pretty=$(routable_listeners | sort | tr '\n' ';')
  # Pass 2 — OWNERSHIP scoping, the ACA case: the netns carries routable
  # platform sockets (inodes 6 and 10 here) the engine does not own. With the
  # engine holding only inodes 2 and 9, exactly those two routable ports may
  # be reported; flagging the unowned ones is the docker-measured bug that
  # crash-looped every ACA replica on 2026-08-06.
  LOOM_RW_SOCKET_INODES="2 9"
  export LOOM_RW_SOCKET_INODES
  _got_owned=$(routable_ports | tr '\n' ',')
  unset LOOM_RW_SOCKET_INODES
  unset LOOM_RW_PROCNET_FILES
  rm -rf "$_t"
  if [ "$_got" != "4562,5714,6668,6669," ]; then
    log "SELFTEST FAILED: routable_ports returned '${_got}', expected '4562,5714,6668,6669,'."
    log "SELFTEST FAILED: the loopback/routable classifier is broken. Too permissive and"
    log "SELFTEST FAILED: every runtime port assertion passes vacuously; too strict and the"
    log "SELFTEST FAILED: container crash-loops on a harmless loopback sidecar. Refusing to build."
    exit 1
  fi
  case "$_pretty" in
    *192.168.69.2\ 5714*) : ;;
    *)
      log "SELFTEST FAILED: the v4 address decoder produced '${_pretty}'; expected a"
      log "SELFTEST FAILED: '192.168.69.2 5714' entry. The FATAL diagnostics would name the"
      log "SELFTEST FAILED: wrong address. Refusing to build."
      exit 1
      ;;
  esac
  if [ "$_got_owned" != "4562,6668," ]; then
    log "SELFTEST FAILED: with LOOM_RW_SOCKET_INODES='2 9' routable_ports returned"
    log "SELFTEST FAILED: '${_got_owned}', expected '4562,6668,'. The ownership filter is"
    log "SELFTEST FAILED: broken: too permissive and unowned sockets vanish from the real"
    log "SELFTEST FAILED: assertions too; too strict and every ACA replica crash-loops on"
    log "SELFTEST FAILED: the platform's own agent sockets. Refusing to build."
    exit 1
  fi
  log "selftest passed: 127.0.0.0/8 + ::1 + ::ffff:127.x classified loopback; wildcard and interface addresses classified routable; v4 decoder correct; inode ownership filter scopes the scan"
  exit 0
fi

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
  log "FATAL: the risingwave binary was not found (looked at /risingwave/bin/risingwave and \$PATH)."
  exit 1
fi
FRONTEND_PORT="${LOOM_RW_FRONTEND_PORT:-4566}"
STORE_DIR="${LOOM_RW_STORE_DIRECTORY:-/root/.risingwave}"
BOOTSTRAP_DB="${LOOM_RW_BOOTSTRAP_DATABASE:-dev}"
BOOTSTRAP_TIMEOUT="${LOOM_RW_BOOTSTRAP_TIMEOUT_SECS:-180}"
SERVE_TIMEOUT="${LOOM_RW_SERVE_TIMEOUT_SECS:-180}"

# ── 1. FAIL CLOSED ────────────────────────────────────────────────────────────
# No password => no database. Exiting 1 here is half the security property:
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

mkdir -p "$STORE_DIR" "$STORE_DIR/meta_store" "$STORE_DIR/state_store"

# Upstream's CMD was `["single_node"]` (an ARGUMENT to its `risingwave`
# ENTRYPOINT). This entrypoint supplies the subcommand itself, so a stale
# `--command single_node` override from an older deployment template would land
# as a spurious positional and clap would reject it. Drop it defensively.
if [ "${1:-}" = "single_node" ]; then
  shift
fi

# ── 2. The per-node option set: ONE routable listener, by construction ────────
# Every address below is loopback except the frontend's, which phase 1 also
# pins to loopback and only phase 2 opens. Ports match upstream's single_node
# choices so nothing else in the deployment (docs, probes, the BFF) shifts.
#
# The meta store / state store values reproduce single_node's derivation
# exactly: `format!("{}/meta_store", store_directory)` + `single_node.db`, and
# `format!("hummock+fs://{}", state_store_dir)` with data_directory
# "hummock_001". RW_STATE_STORE / RW_DATA_DIRECTORY now actually take effect —
# under single_node they were silently overwritten by the local-fs values after
# clap read them, so the module's `stateStore` knob was inert.
META_ADDR="127.0.0.1:${LOOM_RW_META_PORT:-5690}"
DASHBOARD_ADDR="127.0.0.1:${LOOM_RW_DASHBOARD_PORT:-5691}"
COMPUTE_ADDR="127.0.0.1:${LOOM_RW_COMPUTE_PORT:-5688}"
COMPACTOR_ADDR="127.0.0.1:${LOOM_RW_COMPACTOR_PORT:-6660}"
META_URL="http://${META_ADDR}/"
STATE_STORE="${RW_STATE_STORE:-hummock+fs://${STORE_DIR}/state_store}"
DATA_DIRECTORY="${RW_DATA_DIRECTORY:-hummock_001}"

META_OPTS="--listen-addr ${META_ADDR} --advertise-addr ${META_ADDR} --dashboard-host ${DASHBOARD_ADDR} --backend sqlite --sql-endpoint ${STORE_DIR}/meta_store/single_node.db --state-store ${STATE_STORE} --data-directory ${DATA_DIRECTORY}"
COMPUTE_OPTS="--listen-addr ${COMPUTE_ADDR} --advertise-addr ${COMPUTE_ADDR} --meta-address ${META_URL}"
COMPACTOR_OPTS="--listen-addr ${COMPACTOR_ADDR} --advertise-addr ${COMPACTOR_ADDR} --meta-address ${META_URL}"

# $1 = the frontend bind address; any remaining args are passed through to
# `risingwave standalone` (its own flags only — --prometheus-listener-addr and
# --config-path; NOT single_node flags, which this subcommand does not accept).
# A pass-through --prometheus-listener-addr on a routable address is not a hole:
# the phase-1 assertion below sees it and refuses to continue.
# Starts the engine in the background and sets ENGINE_PID.
start_engine() {
  _bind="$1"
  shift
  "$RW_BIN" standalone \
    --meta-opts="$META_OPTS" \
    --compute-opts="$COMPUTE_OPTS" \
    --frontend-opts="--listen-addr ${_bind} --meta-addr ${META_URL}" \
    --compactor-opts="$COMPACTOR_OPTS" \
    "$@" &
  ENGINE_PID=$!
}

# Never `kill 0` — that signals the whole process group. Only ever the engine.
stop_engine() {
  if [ -n "${ENGINE_PID:-}" ]; then
    kill "$ENGINE_PID" 2>/dev/null || true
    wait "$ENGINE_PID" 2>/dev/null || true
  fi
}

fail() {
  log "FATAL: $*"
  stop_engine
  exit 1
}

# psql inherits the password from the environment; it is never passed on a
# command line (argv is world-readable via /proc on a shared kernel).
PSQL_SEALED="psql --host=127.0.0.1 --port=${FRONTEND_PORT} --username=root --dbname=${BOOTSTRAP_DB} --no-password --quiet --tuples-only --no-align"

# Poll until the loopback frontend answers SQL (or the engine dies).
wait_for_sql() {
  _waited=0
  while [ "$_waited" -lt "$BOOTSTRAP_TIMEOUT" ]; do
    if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
      fail "the engine exited during the sealed bootstrap (see the lines above)."
    fi
    if PGPASSWORD='' $PSQL_SEALED --command 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    _waited=$((_waited + 2))
  done
  fail "the sealed frontend did not accept SQL within ${BOOTSTRAP_TIMEOUT}s."
}

# ── 3. PHASE 1 — SEALED BOOT (every listener on loopback) ─────────────────────
log "phase 1/2: starting the engine SEALED — frontend, meta, compute, compactor and dashboard ALL on 127.0.0.1"
start_engine "127.0.0.1:${FRONTEND_PORT}"
wait_for_sql

# THE MEASUREMENT. Nothing of the ENGINE'S may be reachable from the pod IP
# right now. If the per-node loopback options did not take effect on this
# binary (an engine bump that renames a flag, a stale override), this is where
# it stops — before any engine-owned routable port has ever existed. The scan
# is scoped to the engine tree's socket inodes because an ACA replica's netns
# also carries platform-agent listeners this container neither created nor can
# remove (measured live 2026-08-06: the whole-netns scan flagged them and
# crash-looped every replica while the engine itself was correctly sealed).
LOOM_RW_SOCKET_INODES=$(engine_socket_inodes)
export LOOM_RW_SOCKET_INODES
# The engine just answered SQL, so it certainly holds sockets. An empty inode
# set therefore means the ENUMERATION is broken (not that the surface is
# clean) — and an assertion running on an empty set would pass vacuously.
# Fail closed instead, and say what is actually known (deploy-integrity R7).
[ -n "$LOOM_RW_SOCKET_INODES" ] || fail "could not enumerate the engine's socket inodes from /proc/${ENGINE_PID}/fd — the port assertions would pass VACUOUSLY, so this is an error, not a clean surface. Refusing to continue."
SEALED_ROUTABLE=$(routable_ports | tr '\n' ' ' | sed 's/ *$//')
if [ -n "$SEALED_ROUTABLE" ]; then
  log "FATAL: the SEALED phase has ENGINE-OWNED routable listening ports: ${SEALED_ROUTABLE}"
  routable_listeners | while read -r _a _p; do log "FATAL:   routable listener ${_a}:${_p}"; done
  log "FATAL: every RisingWave listener was supposed to be bound to 127.0.0.1 in"
  log "FATAL: this phase, so a non-loopback socket means the per-node options did"
  log "FATAL: NOT take effect (an engine upgrade that renamed --listen-addr /"
  log "FATAL: --dashboard-host, or a --meta-opts override). Upstream's meta,"
  log "FATAL: compute, compactor and dashboard listeners have NO AUTHENTICATION"
  log "FATAL: of any kind, and a Container Apps replica is reachable on its pod IP"
  log "FATAL: from every sibling app in the environment. Refusing to continue."
  fail "sealed-phase port assertion failed."
fi
log "verified: ZERO engine-owned routable listening ports during the sealed phase"
unset LOOM_RW_SOCKET_INODES

# ── 4. SET THE CREDENTIAL ─────────────────────────────────────────────────────
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
  # the other still lands. A silent no-op is impossible: step 5 verifies.
  printf "ALTER USER root PASSWORD '%s';\n" "$ESCAPED_PASSWORD" \
    | PGPASSWORD='' $PSQL_SEALED --set=ON_ERROR_STOP=1 --file=- >/dev/null 2>&1 && return 0
  printf "ALTER USER root WITH PASSWORD '%s';\n" "$ESCAPED_PASSWORD" \
    | PGPASSWORD='' $PSQL_SEALED --set=ON_ERROR_STOP=1 --file=- >/dev/null 2>&1 && return 0
  return 1
}
apply_password || fail "ALTER USER root PASSWORD failed."

# ── 5. VERIFY IT ACTUALLY TOOK ────────────────────────────────────────────────
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

# ── 6. PHASE 2 — SERVING BOOT (exactly one routable port) ─────────────────────
# Stop the sealed instance and restart against the SAME store directory. The
# SQLite meta store under $STORE_DIR carries root's credential across the
# restart, so the port is authenticated from the first packet it ever answers.
log "phase 1 complete — stopping the sealed engine"
stop_engine

log "phase 2/2: starting the engine SERVING on 0.0.0.0:${FRONTEND_PORT} (root now requires a password; every other listener stays on 127.0.0.1)"
start_engine "0.0.0.0:${FRONTEND_PORT}" "$@"

# The shell stays PID 1 so a failed assertion can reliably tear the container
# down (SIGKILL to PID 1 is ignored inside a PID namespace, so a watchdog that
# tried to kill an exec'd engine could not be trusted). Forward the signals ACA
# sends on a revision roll / scale-in.
trap 'kill -TERM "$ENGINE_PID" 2>/dev/null || true' TERM INT HUP

# Wait for the routable wire port to appear among the ENGINE'S OWN sockets,
# then re-assert the surface. The inode set is refreshed every poll (the engine
# binds sockets as it boots; ENGINE_PID changed at the phase-2 restart).
SERVE_WAITED=0
while [ "$SERVE_WAITED" -lt "$SERVE_TIMEOUT" ]; do
  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
    fail "the engine exited during the serving boot (see the lines above)."
  fi
  LOOM_RW_SOCKET_INODES=$(engine_socket_inodes)
  export LOOM_RW_SOCKET_INODES
  if [ -n "$LOOM_RW_SOCKET_INODES" ] && routable_ports | grep -q "^${FRONTEND_PORT}\$"; then
    break
  fi
  sleep 2
  SERVE_WAITED=$((SERVE_WAITED + 2))
done
if [ "$SERVE_WAITED" -ge "$SERVE_TIMEOUT" ]; then
  # Two distinct truths, reported distinctly (deploy-integrity R7): an empty
  # inode set means the ENUMERATION never worked, not that the port is absent.
  if [ -z "${LOOM_RW_SOCKET_INODES:-}" ]; then
    fail "could not enumerate the engine's socket inodes within ${SERVE_TIMEOUT}s — whether the serving frontend bound 0.0.0.0:${FRONTEND_PORT} is UNKNOWN. Refusing to serve unverified."
  fi
  fail "the serving frontend never bound 0.0.0.0:${FRONTEND_PORT} within ${SERVE_TIMEOUT}s (engine-owned sockets were enumerable throughout)."
fi

SERVING_EXTRA=$(routable_ports | grep -v "^${FRONTEND_PORT}\$" | tr '\n' ' ' | sed 's/ *$//')
if [ -n "$SERVING_EXTRA" ]; then
  log "FATAL: the SERVING phase exposes ENGINE-OWNED routable ports beyond the wire port: ${SERVING_EXTRA}"
  routable_listeners | while read -r _a _p; do log "FATAL:   routable listener ${_a}:${_p}"; done
  log "FATAL: upstream's meta (5690), dashboard (5691), compute (5688) and"
  log "FATAL: compactor (6660) listeners have NO AUTHENTICATION, and the root"
  log "FATAL: credential guards ONLY the Postgres wire. A Container Apps replica"
  log "FATAL: is reachable on its pod IP from every sibling app in the"
  log "FATAL: environment, including loom-script-runner and loom-udf-runtime,"
  log "FATAL: which execute user-supplied code. Refusing to serve."
  fail "serving-phase port assertion failed."
fi
log "verified: the ONLY engine-owned routable listening port is ${FRONTEND_PORT}, and it requires the root credential"
routable_listeners | while read -r _a _p; do log "  routable listener: ${_a}:${_p} (Postgres wire, credential-gated)"; done
log "ready — loom-risingwave is serving an authenticated Postgres wire and nothing else"
unset LOOM_RW_SOCKET_INODES

# Hold PID 1 for the life of the engine. `wait` returns early when a trapped
# signal arrives, so loop until the child is genuinely gone.
ENGINE_RC=0
while kill -0 "$ENGINE_PID" 2>/dev/null; do
  wait "$ENGINE_PID" || ENGINE_RC=$?
  [ "$ENGINE_RC" -gt 128 ] || break
done
log "engine exited with ${ENGINE_RC}"
exit "$ENGINE_RC"
