#!/bin/bash
# loom-maps-tileserver launcher. Caddy is the foreground (PID 1) process so the
# container stays up as long as the front is serving; tileserver-gl runs in the
# background on :8081. Deliberately NOT `set -e` — a transient tileserver-gl
# hiccup must not kill the front (the readiness probe on :8080/health governs).
set -x
echo "[entrypoint] starting loom-maps-tileserver"
ls -la /usr/src/app 2>/dev/null | head -20 || true

# The maptiler/tileserver-gl image launches the server via its own entrypoint /
# `node /usr/src/app/`, NOT a `tileserver-gl` binary on PATH. Serving vector
# tiles + style.json needs no xvfb (only server-side raster rendering does), so
# invoke node directly on :8081. Fall back across known layouts.
if [ -f /usr/src/app/src/main.js ]; then
  TS_CMD="node /usr/src/app/src/main.js"
elif [ -x /usr/src/app/docker-entrypoint.sh ]; then
  TS_CMD="/usr/src/app/docker-entrypoint.sh"
else
  TS_CMD="node /usr/src/app/"
fi
echo "[entrypoint] tileserver launch: $TS_CMD"
# shellcheck disable=SC2086
$TS_CMD --config /data/config.json --port 8081 --public_url "http://localhost:8080/" 2>&1 &
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
