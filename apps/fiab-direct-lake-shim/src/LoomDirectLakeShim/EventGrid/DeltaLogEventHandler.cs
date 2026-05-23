using Azure.Messaging.EventGrid;
using Azure.Messaging.EventGrid.SystemEvents;
using Azure.Messaging.ServiceBus;
using CsaLoom.DirectLakeShim.Models;
using CsaLoom.DirectLakeShim.Tom;
using CsaLoom.DirectLakeShim.Config;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CsaLoom.DirectLakeShim.EventGrid;

/// <summary>
/// Subscribes to Storage Event Grid system topic via Service Bus
/// queue (push delivery). For each BlobCreated event on a path that
/// matches <c>**/_delta_log/*.json</c>, looks up the affected
/// semantic model(s) and triggers the configured refresh policy.
///
/// We use Service Bus rather than direct Event Grid webhook so we can
/// rely on the receiver's PeekLock semantics + dead-letter for failed
/// refreshes; Event Grid webhooks require a synchronous HTTP receiver.
/// </summary>
public class DeltaLogEventHandler : BackgroundService
{
    private readonly ServiceBusClient _sb;
    private readonly TomRefreshClient _tom;
    private readonly SemanticModelConfigStore _configStore;
    private readonly IConfiguration _config;
    private readonly ILogger<DeltaLogEventHandler> _log;

    private static readonly Regex DeltaLogPath =
        new(@"^/[^/]+/(?<schema>[^/]+)/(?<table>[^/]+)/_delta_log/(?<commit>\d+)\.json$",
            RegexOptions.Compiled);

    public DeltaLogEventHandler(
        ServiceBusClient sb,
        TomRefreshClient tom,
        SemanticModelConfigStore configStore,
        IConfiguration config,
        ILogger<DeltaLogEventHandler> log)
    {
        _sb = sb;
        _tom = tom;
        _configStore = configStore;
        _config = config;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var queueName = _config["EVENTGRID_QUEUE"]
            ?? throw new InvalidOperationException("EVENTGRID_QUEUE not set");

        await using var processor = _sb.CreateProcessor(queueName, new ServiceBusProcessorOptions
        {
            AutoCompleteMessages = false,
            MaxConcurrentCalls = 8,
            PrefetchCount = 16,
        });

        processor.ProcessMessageAsync += OnMessage;
        processor.ProcessErrorAsync += args =>
        {
            _log.LogError(args.Exception, "ServiceBus processor error: {Entity}", args.EntityPath);
            return Task.CompletedTask;
        };

        await processor.StartProcessingAsync(stoppingToken);
        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException) { }
        await processor.StopProcessingAsync();
    }

    private async Task OnMessage(ProcessMessageEventArgs args)
    {
        try
        {
            var evt = EventGridEvent.Parse(BinaryData.FromString(args.Message.Body.ToString()));
            if (evt.EventType != SystemEventNames.StorageBlobCreated)
            {
                await args.CompleteMessageAsync(args.Message);
                return;
            }

            var data = evt.Data.ToObjectFromJson<StorageBlobCreatedEventData>();
            var path = new Uri(data.Url).AbsolutePath;
            var match = DeltaLogPath.Match(path);
            if (!match.Success)
            {
                // Not a Delta commit; ignore
                await args.CompleteMessageAsync(args.Message);
                return;
            }

            var schema = match.Groups["schema"].Value;
            var table = match.Groups["table"].Value;
            var commitNumber = match.Groups["commit"].Value;

            _log.LogInformation("Delta commit {Commit} detected on {Schema}.{Table}", commitNumber, schema, table);

            // Find every semantic model that includes this table
            var models = await _configStore.FindModelsContainingTable(schema, table);
            foreach (var model in models)
            {
                if (!model.Tables.TryGetValue($"{schema}.{table}", out var tableCfg)) continue;
                await RefreshFor(model, tableCfg, data.Url);
            }

            await args.CompleteMessageAsync(args.Message);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to process Delta log event");
            // PeekLock will retry; after max-delivery-count, message moves to DLQ
            await args.AbandonMessageAsync(args.Message);
        }
    }

    private async Task RefreshFor(SemanticModelConfig model, TableRefreshConfig tableCfg, string blobUrl)
    {
        switch (tableCfg.Policy)
        {
            case RefreshPolicyKind.Partition:
                var partition = await DerivePartitionName(blobUrl, tableCfg.PartitionColumn);
                _tom.RefreshPartition(model, tableCfg.TableName, partition);
                break;
            case RefreshPolicyKind.Full:
                _tom.RefreshTable(model, tableCfg.TableName);
                break;
            case RefreshPolicyKind.DirectQueryFallback:
                // No-op: DirectQuery is always live
                _log.LogDebug("Table {Table} is DirectQuery; no refresh needed", tableCfg.TableName);
                break;
            case RefreshPolicyKind.Composite:
                // Production walks the TMDL to determine which sub-tables are Import
                _tom.RefreshTable(model, tableCfg.TableName);
                break;
        }
    }

    /// <summary>
    /// Derive the partition name from the Delta commit. Strategy: parse
    /// the latest add file path; the directory layout encodes the
    /// partition values (e.g., `event_date=2026-05-22/`).
    /// In a real impl this reads the commit JSON; here we approximate.
    /// </summary>
    private Task<string> DerivePartitionName(string blobUrl, string? partitionColumn)
    {
        if (string.IsNullOrEmpty(partitionColumn)) return Task.FromResult("default");
        var match = Regex.Match(blobUrl, $@"{partitionColumn}=([^/]+)/");
        return Task.FromResult(match.Success ? $"{partitionColumn}={match.Groups[1].Value}" : "default");
    }
}
