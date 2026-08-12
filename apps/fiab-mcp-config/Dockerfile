# CSA Loom self-hosted Azure MCP server
# Vendors microsoft/mcp/servers/Azure.Mcp.Server and runs it inside
# the customer's Admin Plane (Container App or AKS workload).
#
# Build: docker build -t loom-mcp .
# Run: docker run -p 8080:8080 -e AZURE_CLOUD=AzureCloud loom-mcp

# PINNED TO THE SDK UPSTREAM ACTUALLY DECLARES, not a floating tag.
#
# microsoft/mcp's global.json pins `10.0.302` with `"rollForward": "disable"`.
# This line used to say `sdk:10.0`, a tag that MOVES — and it has moved to
# 10.0.400. Measured in the SDK container against a fresh upstream clone:
#
#   $ docker run --rm -v …:/src -w /src/servers/Azure.Mcp.Server/src #       mcr.microsoft.com/dotnet/sdk:10.0 dotnet restore
#   A compatible .NET SDK was not found.
#   Requested SDK version: 10.0.302
#   global.json file: /src/global.json
#   Installed SDKs:
#   10.0.400 [/usr/share/dotnet/sdk]
#
#   $ … mcr.microsoft.com/dotnet/sdk:10.0.302 dotnet restore
#   Restored /src/servers/Azure.Mcp.Server/src/Azure.Mcp.Server.csproj (in 19.09 sec)
#
# `rollForward: disable` means upstream has decided which SDK builds this tree.
# Tracking a floating tag hands that decision to MCR's release cadence, and the
# build breaks the day the tag rolls — with no commit in this repo.
FROM mcr.microsoft.com/dotnet/sdk:10.0.302 AS build
WORKDIR /src

# Vendor the Microsoft Azure MCP server source.
# A COMMIT SHA, not a branch. `main` moved under us and broke the image with no
# commit in this repo (#3258) - and the last GREEN ref was unrecoverable, because
# nothing recorded what any build had cloned. A SHA makes the image reproducible
# and makes every upstream bump a reviewable diff.
#
# Pinned to upstream main @ 2026-08-11, VERIFIED to restore against the SDK
# pinned above BEFORE being written here (see the FROM comment for the runs).
ARG MS_MCP_REF=e944bde4cfeed8dae8567b924c9fa3f9ee38f0e3
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && git init ms-mcp \
    && git -C ms-mcp remote add origin https://github.com/microsoft/mcp.git \
    && git -C ms-mcp fetch --depth 1 origin ${MS_MCP_REF} \
    && git -C ms-mcp checkout --detach FETCH_HEAD \
    && rm -rf /var/lib/apt/lists/*

# The .csproj lives under servers/Azure.Mcp.Server/src/, not in the
# server root. global.json (at repo root) pins SDK 10.0.201+.
WORKDIR /src/ms-mcp/servers/Azure.Mcp.Server/src
RUN dotnet publish -c Release -o /app --no-self-contained

# Runtime pinned to the same band as the SDK above, for the same reason: a
# floating tag makes the image non-reproducible and lets an upstream release
# change what ships without a commit here.
FROM mcr.microsoft.com/dotnet/aspnet:10.0.3
WORKDIR /app
COPY --from=build /app .
COPY ./config/ /app/config/

# Non-root user
RUN groupadd --system loom && useradd --system --gid loom loom \
    && chown -R loom:loom /app
USER loom

# Default to MCP HTTP transport on 8080
ENV ASPNETCORE_URLS=http://+:8080
ENV LOOM_MCP_CONFIG=/app/config/loom-mcp.json
EXPOSE 8080

# Health endpoint — MCP servers expose /.well-known/health
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8080/.well-known/health || exit 1

# Resolve the actual server entry-point dll at runtime — upstream
# microsoft/mcp occasionally renames the published assembly. Falling
# back to a glob-and-exec keeps us building against `main` without
# pinning to a specific assembly name.
ENTRYPOINT ["/bin/sh", "-c", "dll=$(ls /app/azmcp.dll /app/Azure.Mcp.Server*.dll 2>/dev/null | head -1); if [ -z \"$dll\" ]; then echo 'ERROR: no MCP server dll found in /app:'; ls /app; exit 1; fi; exec dotnet \"$dll\""]
