# Loom Direct-Lake Shim — .NET 8 Worker Service
#
# Service: loom-direct-lake-shim
# Image:   loom/direct-lake-shim:v0.1
# Port:    8080 (health probe only; no public ingress)

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Solution + project file restore (cache layer)
COPY src/LoomDirectLakeShim/LoomDirectLakeShim.csproj src/LoomDirectLakeShim/
COPY tests/LoomDirectLakeShim.Tests/LoomDirectLakeShim.Tests.csproj tests/LoomDirectLakeShim.Tests/
WORKDIR /src/src/LoomDirectLakeShim
RUN dotnet restore

# Full build
WORKDIR /src
COPY src/ ./src/
WORKDIR /src/src/LoomDirectLakeShim
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
RUN groupadd --system loom && useradd --system --gid loom --uid 10001 loom
COPY --from=build --chown=loom:loom /app .
USER loom

EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
ENV DOTNET_RUNNING_IN_CONTAINER=true

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

ENTRYPOINT ["dotnet", "CsaLoom.DirectLakeShim.dll"]

LABEL org.opencontainers.image.title="Loom Direct-Lake Shim"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL csa.loom.component="direct-lake-shim"
LABEL csa.loom.version="0.1.0"
