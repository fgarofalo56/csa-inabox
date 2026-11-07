using Azure.Identity;
using Azure.Messaging.ServiceBus;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using CsaLoom.DirectLakeShim;
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

// Throws (fail fast, one named-variable error) only when enabled but misconfigured.
var settings = ShimSettings.Resolve(k => builder.Configuration[k]);
builder.Services.AddSingleton(settings);
if (settings.Enabled)
{
    builder.Services.AddSingleton(_ =>
        new ServiceBusClient(settings.ServiceBusNamespace!, new DefaultAzureCredential()));
}

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
