#!/bin/bash
# loom-maps-tileserver launcher. Caddy is the foreground (PID 1) process so the
# container stays up as long as the front is serving; tileserver-gl runs in the
# background on :8081. Deliberately NOT `set -e` — a transient tileserver-gl
# hiccup must not kill the front (the readiness probe on :8080/health governs).
set -x
echo "[entrypoint] starting loom-maps-tileserver"
ls -la /usr/src/app 2>/dev/null | head -20 || true

# The maptiler/tileserver-gl image launches the server as `node /usr/src/app/`
# (the package main via package.json), wrapped in xvfb-run — tileserver-gl loads
# native GL bindings at startup that need a virtual display even to serve vector
# tiles/style. Mirror that exact launch on :8081. Fall back to no-xvfb.
# tileserver-gl ignored --port and defaulted to :8080 (EADDRINUSE vs Caddy). The
# PORT env var has unambiguous precedence — pin the backend to :8081.
export PORT=8081
if command -v xvfb-run >/dev/null 2>&1; then
  echo "[entrypoint] tileserver launch: xvfb-run node /usr/src/app/ (PORT=8081)"
  xvfb-run -a --server-args="-screen 0 1024x768x24 -nolisten tcp" \
    node /usr/src/app/ --config /data/config.json --port 8081 --public_url "http://localhost:8080/" 2>&1 &
else
  echo "[entrypoint] tileserver launch: node /usr/src/app/ (no xvfb, PORT=8081)"
  node /usr/src/app/ --config /data/config.json --port 8081 --public_url "http://localhost:8080/" 2>&1 &
fi
TS_PID=$!
echo "[entrypoint] tileserver-gl started pid=$TS_PID (loads mbtiles in background, ~30-60s)"

# Do NOT block on tileserver-gl here: start Caddy IMMEDIATELY so :8080 serves
# /health right away (the ACA readiness probe passes → the revision goes Ready →
# internal ingress routes). tileserver-gl finishes loading in the background;
# /style.json + tile requests succeed once it binds :8081 (the caller retries).
echo "[entrypoint] starting caddy (foreground) on :8080"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
