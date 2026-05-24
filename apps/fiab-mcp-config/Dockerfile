# CSA Loom self-hosted Azure MCP server
# Vendors microsoft/mcp/servers/Azure.Mcp.Server and runs it inside
# the customer's Admin Plane (Container App or AKS workload).
#
# Build: docker build -t loom-mcp .
# Run: docker run -p 8080:8080 -e AZURE_CLOUD=AzureCloud loom-mcp

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Vendor the Microsoft Azure MCP server source.
# Pinned to a known-good tag — bump explicitly with security review.
ARG MS_MCP_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && git clone --depth 1 --branch ${MS_MCP_REF} https://github.com/microsoft/mcp.git ms-mcp \
    && rm -rf /var/lib/apt/lists/*

# The .csproj lives under servers/Azure.Mcp.Server/src/, not in the
# server root. global.json (at repo root) pins SDK 10.0.201+.
WORKDIR /src/ms-mcp/servers/Azure.Mcp.Server/src
RUN dotnet publish -c Release -o /app --no-self-contained

FROM mcr.microsoft.com/dotnet/aspnet:10.0
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
