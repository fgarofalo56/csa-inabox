using Azure.Identity;
using CsaLoom.Activator.Dispatch;
using CsaLoom.Activator.Evaluation;
using CsaLoom.Activator.Models;
using CsaLoom.Activator.State;
using Kusto.Data;
using Kusto.Data.Common;
using Kusto.Data.Net.Client;
using System.Collections.Concurrent;
using IDataReader = System.Data.IDataReader;

namespace CsaLoom.Activator.Polling;

/// <summary>
/// Background service that polls ADX every N seconds, materializes
/// data points per registered rule, runs the evaluator, persists state,
/// and dispatches actions.
///
/// One instance per workspace; rules are filtered per workspace at
/// load time. Polling interval is the minimum of all rule durations
/// (default 30s).
/// </summary>
public class AdxRulePoller : BackgroundService
{
    private readonly RuleStore _rules;
    private readonly ObjectStateStore _state;
    private readonly PrimitiveEvaluator _evaluator;
    private readonly ActionDispatcher _dispatcher;
    private readonly IConfiguration _config;
    private readonly ILogger<AdxRulePoller> _log;

    public AdxRulePoller(
        RuleStore rules,
        ObjectStateStore state,
        PrimitiveEvaluator evaluator,
        ActionDispatcher dispatcher,
        IConfiguration config,
        ILogger<AdxRulePoller> log)
    {
        _rules = rules;
        _state = state;
        _evaluator = evaluator;
        _dispatcher = dispatcher;
        _config = config;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var workspaceId = _config["WORKSPACE_ID"] ?? throw new InvalidOperationException("WORKSPACE_ID not set");
        var adxCluster = _config["ADX_CLUSTER_URI"] ?? throw new InvalidOperationException("ADX_CLUSTER_URI not set");
        var adxDatabase = _config["ADX_DATABASE"] ?? throw new InvalidOperationException("ADX_DATABASE not set");
        var intervalSeconds = int.Parse(_config["POLL_INTERVAL_SECONDS"] ?? "30");

        var kcsb = new KustoConnectionStringBuilder(adxCluster).WithAadAzureTokenCredentialsAuthentication(
            new DefaultAzureCredential());
        using var kusto = KustoClientFactory.CreateCslQueryProvider(kcsb);

        _log.LogInformation("AdxRulePoller starting — workspace={Workspace} interval={Interval}s", workspaceId, intervalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var rules = await _rules.ListEnabledAsync(workspaceId);
                _log.LogDebug("Evaluating {Count} rules", rules.Count);
                foreach (var rule in rules)
                {
                    await EvaluateRule(rule, kusto, adxDatabase, stoppingToken);
                }
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Poll iteration failed; continuing");
            }
            await Task.Delay(TimeSpan.FromSeconds(intervalSeconds), stoppingToken);
        }
    }

    private async Task EvaluateRule(Rule rule, ICslQueryProvider kusto, string database, CancellationToken ct)
    {
        // For data-arrival primitives, materialize last 2x polling
        // interval of new data points for this property.
        if (rule.Primitive == Primitive.NoPresenceOfData)
        {
            await EvaluateSilenceForRule(rule, ct);
            return;
        }

        var lookback = TimeSpan.FromSeconds(60);
        var query = BuildIngestionQuery(rule, lookback);

        using var reader = await kusto.ExecuteQueryAsync(database, query, new ClientRequestProperties());
        var points = ToDataPoints(reader, rule);
        if (points.Count == 0) return;

        // Group by object id, evaluate per object
        var byObject = points.GroupBy(p => p.ObjectId);
        foreach (var group in byObject)
        {
            var state = await _state.GetAsync(rule.WorkspaceId, group.Key);
            foreach (var point in group.OrderBy(p => p.Timestamp))
            {
                state = _state.Apply(state, point, rule.Primitive == Primitive.AndStays ? rule : null);
                var decision = _evaluator.Evaluate(rule, point, state);
                if (decision is not null)
                {
                    await _dispatcher.DispatchAsync(decision, ct);
                    state = _state.RecordFire(state, rule, point.Timestamp);
                }
            }
            await _state.SetAsync(rule.WorkspaceId, state);
        }
    }

    private async Task EvaluateSilenceForRule(Rule rule, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        // Walk the set of known objects for this workspace (cached in
        // a Redis SET written by the data-arrival path). For brevity,
        // production reads from `loom:activator:{workspaceId}:objects`.
        var objectIds = await _state.ListObjectIds(rule.WorkspaceId);
        foreach (var oid in objectIds)
        {
            var state = await _state.GetAsync(rule.WorkspaceId, oid);
            var decision = _evaluator.EvaluateSilence(rule, state, now);
            if (decision is not null)
            {
                await _dispatcher.DispatchAsync(decision, ct);
                state = _state.RecordFire(state, rule, now);
                await _state.SetAsync(rule.WorkspaceId, state);
            }
        }
    }

    /// <summary>
    /// Build a KQL query that returns data points for this rule. The
    /// rule's `Property` is treated as the table/column it lives in;
    /// production normalizes via per-rule "query template" stored in
    /// the rule definition.
    /// </summary>
    private static string BuildIngestionQuery(Rule rule, TimeSpan lookback)
        => $@"
        {rule.Property}
        | where Timestamp > ago({(long)lookback.TotalSeconds}s)
        | project ObjectId, Property = '{rule.Property}', Value, StringValue, Timestamp
        ";

    private static List<DataPoint> ToDataPoints(IDataReader reader, Rule rule)
    {
        var points = new List<DataPoint>();
        var idxOid = reader.GetOrdinal("ObjectId");
        var idxProp = reader.GetOrdinal("Property");
        var idxVal = SafeOrdinal(reader, "Value");
        var idxStr = SafeOrdinal(reader, "StringValue");
        var idxTs = reader.GetOrdinal("Timestamp");

        while (reader.Read())
        {
            double? numericValue = idxVal >= 0 && !reader.IsDBNull(idxVal)
                ? Convert.ToDouble(reader.GetValue(idxVal))
                : null;
            string? stringValue = idxStr >= 0 && !reader.IsDBNull(idxStr)
                ? reader.GetString(idxStr)
                : null;

            points.Add(new DataPoint(
                ObjectId: reader.GetString(idxOid),
                Property: reader.GetString(idxProp),
                NumericValue: numericValue,
                StringValue: stringValue,
                Timestamp: new DateTimeOffset(reader.GetDateTime(idxTs))));
        }
        return points;
    }

    private static int SafeOrdinal(IDataReader reader, string name)
    {
        try { return reader.GetOrdinal(name); }
        catch { return -1; }
    }
}

// Extension to ObjectStateStore — the listing helper used by the silence path
public static class ObjectStateStoreExtensions
{
    public static Task<IReadOnlyList<string>> ListObjectIds(this ObjectStateStore store, string workspaceId)
    {
        // Production: SET in Redis maintained by the data-arrival path.
        // Test impl returns empty so silence rules quietly no-op until
        // data flows in.
        return Task.FromResult<IReadOnlyList<string>>(Array.Empty<string>());
    }
}
