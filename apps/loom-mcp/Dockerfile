# Deployable image for the M1 loom-catalog MCP server (stdio).
#
# BUILD CONTEXT MUST BE THE REPO ROOT — the build needs both apps/loom-sdk (the
# sibling the file: dependency resolves to) and apps/loom-mcp:
#
#   docker build -f apps/loom-mcp/Dockerfile -t loom-catalog-mcp .
#
# An MCP client attaches over stdin/stdout:
#
#   docker run --rm -i -e LOOM_API_URL -e LOOM_TOKEN loom-catalog-mcp
#
# ---- build stage -----------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /build

# 1) Build the SDK first so its dist/ exists (the file: dep packs dist/ in).
COPY apps/loom-sdk/ ./apps/loom-sdk/
RUN cd apps/loom-sdk && npm install --no-audit --no-fund && npm run build

# 2) Install + build the MCP server. --install-links materializes the file:
#    @csa-loom/sdk dependency as real files (not a symlink), so the runtime
#    node_modules is self-contained when copied across stages.
COPY apps/loom-mcp/ ./apps/loom-mcp/
RUN cd apps/loom-mcp && npm install --no-audit --no-fund --install-links && npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /build/apps/loom-mcp/package.json ./package.json
COPY --from=build /build/apps/loom-mcp/node_modules ./node_modules
COPY --from=build /build/apps/loom-mcp/dist ./dist

# Run as the built-in non-root node user.
USER node

# stdio transport: the MCP client speaks JSON-RPC over stdin/stdout.
ENTRYPOINT ["node", "dist/servers/loom-catalog/bin.js"]
