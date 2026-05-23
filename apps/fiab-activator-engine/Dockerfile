# Loom Activator Engine — .NET 8 Worker Service
#
# Service: loom-activator
# Image:   loom/activator:v0.1
# Port:    8080 (health probe only; ADX poller is background)

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY src/LoomActivator/LoomActivator.csproj src/LoomActivator/
COPY tests/LoomActivator.Tests/LoomActivator.Tests.csproj tests/LoomActivator.Tests/
WORKDIR /src/src/LoomActivator
RUN dotnet restore

WORKDIR /src
COPY src/ ./src/
WORKDIR /src/src/LoomActivator
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

ENTRYPOINT ["dotnet", "CsaLoom.Activator.dll"]

LABEL org.opencontainers.image.title="Loom Activator Engine"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL csa.loom.component="activator-engine"
LABEL csa.loom.version="0.1.0"
