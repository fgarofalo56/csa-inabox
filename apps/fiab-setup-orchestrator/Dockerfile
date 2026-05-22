# Loom Setup Orchestrator — .NET 10 with Microsoft Agent Framework
# Status: SCAFFOLDED — real implementation per PRP-04

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY *.csproj ./
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .
EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000
ENTRYPOINT ["dotnet", "FiabSetupOrchestrator.dll"]

LABEL csa.loom.component="setup-orchestrator"
LABEL csa.loom.version="0.1.0-scaffold"
