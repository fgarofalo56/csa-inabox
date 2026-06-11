#!/bin/sh
# CSA Loom MCP bridge entrypoint.
#
# Pre-warms the npx/uvx caches for the enabled catalog entries (best-effort,
# so the first console tools/list isn't slowed by a cold package download),
# then launches the bridge HTTP server. The server itself lazily (re)spawns
# each stdio child on first request, so a failed pre-warm is non-fatal.
set -e

CONFIG="${LOOM_MCP_BRIDGE_CONFIG:-/app/config/loom-mcp-bridge.json}"
echo "[mcp-bridge] starting (cloud=${AZURE_CLOUD:-AzureCloud}, config=${CONFIG})"

# Pre-fetch packages for enabled entries matching the active cloud. node parses
# the catalog so we honor the same boundary filtering as the server.
node -e '
const fs = require("fs");
const cloud = (process.env.AZURE_CLOUD || "AzureCloud").trim();
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG, "utf8"));
for (const e of (cfg.servers || [])) {
  if (e.enabled === false) continue;
  if (Array.isArray(e.boundaries) && e.boundaries.length && !e.boundaries.includes(cloud)) continue;
  console.log(`${e.launcher}\t${e.package}`);
}
' CONFIG="$CONFIG" | while IFS="$(printf '\t')" read -r launcher package; do
  [ -z "$launcher" ] && continue
  echo "[mcp-bridge] pre-warming ${launcher} ${package}"
  if [ "$launcher" = "npx" ]; then
    npx -y "$package" --help >/dev/null 2>&1 || true
  elif [ "$launcher" = "uvx" ]; then
    uvx "$package" --help >/dev/null 2>&1 || true
  fi
done

exec node /app/src/server.mjs
