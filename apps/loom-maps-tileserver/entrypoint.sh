#!/bin/bash
# Start tileserver-gl on :8081 (internal), then Caddy on :8080 (ingress targetPort).
# Caddy serves the maplibre-gl assets + a root /style.json and proxies the rest.
set -e

# tileserver-gl v4 exposes the `tileserver-gl` launcher on PATH.
tileserver-gl --config /data/config.json --port 8081 --public_url "http://localhost:8080/" &
TS_PID=$!

# Give tileserver-gl a moment to bind before Caddy starts proxying.
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:8081/health" >/dev/null 2>&1 || curl -fsS "http://localhost:8081/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Caddy in the foreground = PID 1 replacement (container lifecycle follows it).
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
CADDY_PID=$!

# If either dies, exit so the platform restarts the container.
wait -n "$TS_PID" "$CADDY_PID"
exit $?
