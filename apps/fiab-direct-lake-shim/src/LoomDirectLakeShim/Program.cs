using Azure.Identity;
using Azure.Messaging.ServiceBus;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using CsaLoom.DirectLakeShim.Config;
using CsaLoom.DirectLakeShim.EventGrid;
using CsaLoom.DirectLakeShim.Tom;
using Microsoft.Azure.Cosmos;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddSingleton(_ =>
{
    var endpoint = builder.Configuration["COSMOS_ENDPOINT"]
        ?? "https://placeholder.documents.azure.com:443/";
    return new CosmosClient(endpoint, new DefaultAzureCredential());
});

builder.Services.AddSingleton(_ =>
{
    var ns = builder.Configuration["SERVICEBUS_NAMESPACE"]
        ?? "placeholder.servicebus.windows.net";
    return new ServiceBusClient(ns, new DefaultAzureCredential());
});

builder.Services.AddSingleton<TomRefreshClient>();
builder.Services.AddSingleton<SemanticModelConfigStore>();
builder.Services.AddHostedService<DeltaLogEventHandler>();

var appInsightsConn = builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"];
if (!string.IsNullOrEmpty(appInsightsConn))
{
    builder.Services.AddOpenTelemetry().UseAzureMonitor();
}

var host = builder.Build();
host.Run();
