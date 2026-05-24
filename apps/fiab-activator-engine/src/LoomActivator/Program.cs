using Azure.Identity;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using CsaLoom.Activator.Dispatch;
using CsaLoom.Activator.Evaluation;
using CsaLoom.Activator.Polling;
using CsaLoom.Activator.State;
using Microsoft.Azure.Cosmos;
using StackExchange.Redis;

var builder = Host.CreateApplicationBuilder(args);

// Azure App Configuration + Key Vault
var appConfigEndpoint = Environment.GetEnvironmentVariable("APP_CONFIG_ENDPOINT");
if (!string.IsNullOrEmpty(appConfigEndpoint))
{
    builder.Configuration.AddAzureAppConfiguration(options =>
        options.Connect(new Uri(appConfigEndpoint), new DefaultAzureCredential())
            .ConfigureKeyVault(kv => kv.SetCredential(new DefaultAzureCredential())));
}

// Cosmos DB client (workspace + rule + state config).
// CosmosClient construction is lazy (no network until first request) so
// it's safe to register even before COSMOS_ENDPOINT lands via App Config.
builder.Services.AddSingleton(_ =>
{
    var endpoint = builder.Configuration["COSMOS_ENDPOINT"]
        ?? "https://placeholder.documents.azure.com:443/";
    return new CosmosClient(endpoint, new DefaultAzureCredential());
});

// Redis connection (object state).
// Use abortConnect=false so missing/unreachable Redis surfaces at first
// command, not at host startup.
builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
{
    var conn = builder.Configuration["REDIS_CONNECTION"]
        ?? "localhost:6379";
    var options = ConfigurationOptions.Parse(conn);
    options.AbortOnConnectFail = false;
    return ConnectionMultiplexer.Connect(options);
});

builder.Services.AddHttpClient("action-dispatcher", c =>
{
    c.Timeout = TimeSpan.FromSeconds(15);
});

builder.Services.AddSingleton<RuleStore>();
builder.Services.AddSingleton<ObjectStateStore>();
builder.Services.AddSingleton<PrimitiveEvaluator>();
builder.Services.AddSingleton<ActionDispatcher>();
builder.Services.AddHostedService<AdxRulePoller>();

// Telemetry
var appInsightsConn = builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"];
if (!string.IsNullOrEmpty(appInsightsConn))
{
    builder.Services.AddOpenTelemetry().UseAzureMonitor();
}

var host = builder.Build();
host.Run();
