# Loom Activator Engine — .NET 10 + NRules
# Status: SCAFFOLDED — real implementation per PRP-06

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY *.csproj ./
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .
EXPOSE 5001
ENV ASPNETCORE_URLS=http://+:5001
ENTRYPOINT ["dotnet", "FiabActivatorEngine.dll"]

LABEL csa.loom.component="activator-engine"
LABEL csa.loom.version="0.1.0-scaffold"
