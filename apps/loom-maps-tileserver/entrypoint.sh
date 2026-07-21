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
if command -v xvfb-run >/dev/null 2>&1; then
  echo "[entrypoint] tileserver launch: xvfb-run node /usr/src/app/"
  xvfb-run -a --server-args="-screen 0 1024x768x24 -nolisten tcp" \
    node /usr/src/app/ --config /data/config.json --port 8081 --public_url "http://localhost:8080/" 2>&1 &
else
  echo "[entrypoint] tileserver launch: node /usr/src/app/ (no xvfb)"
  node /usr/src/app/ --config /data/config.json --port 8081 --public_url "http://localhost:8080/" 2>&1 &
fi
TS_PID=$!
echo "[entrypoint] tileserver-gl started pid=$TS_PID"

# Wait (bounded) for tileserver-gl to bind before Caddy fronts it.
for i in $(seq 1 40); do
  if curl -fsS "http://localhost:8081/health" >/dev/null 2>&1; then echo "[entrypoint] tileserver-gl healthy"; break; fi
  if ! kill -0 "$TS_PID" 2>/dev/null; then echo "[entrypoint] ERROR: tileserver-gl exited early"; break; fi
  sleep 2
done

# Caddy in the foreground = container lifecycle. Serves /health, /style.json,
# /maplibre-gl.* and proxies the rest to tileserver-gl.
echo "[entrypoint] starting caddy (foreground) on :8080"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
