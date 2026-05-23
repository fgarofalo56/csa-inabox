# Loom Direct-Lake Shim — .NET 10 + TOM client
# Status: SCAFFOLDED — real implementation per PRP-08

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY *.csproj ./
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .
EXPOSE 5002
ENV ASPNETCORE_URLS=http://+:5002
ENTRYPOINT ["dotnet", "FiabDirectLakeShim.dll"]

LABEL csa.loom.component="direct-lake-shim"
LABEL csa.loom.version="0.1.0-scaffold"
