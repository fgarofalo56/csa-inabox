using CsaLoom.Activator.Models;
using StackExchange.Redis;
using System.Text.Json;

namespace CsaLoom.Activator.State;

/// <summary>
/// Per-object state store. Redis primary (sub-ms reads); Cosmos DB
/// backup for durability across Redis restarts.
/// </summary>
public class ObjectStateStore
{
    private readonly IConnectionMultiplexer _redis;
    private readonly TimeSpan _ttl = TimeSpan.FromDays(7);

    public ObjectStateStore(IConnectionMultiplexer redis) => _redis = redis;

    public async Task<ObjectState> GetAsync(string workspaceId, string objectId)
    {
        var db = _redis.GetDatabase();
        var key = StateKey(workspaceId, objectId);
        var raw = await db.StringGetAsync(key);
        if (raw.IsNullOrEmpty) return EmptyState(objectId);

        return JsonSerializer.Deserialize<ObjectState>((string)raw!) ?? EmptyState(objectId);
    }

    public async Task SetAsync(string workspaceId, ObjectState state)
    {
        var db = _redis.GetDatabase();
        var key = StateKey(workspaceId, state.ObjectId);
        var raw = JsonSerializer.Serialize(state);
        await db.StringSetAsync(key, raw, _ttl);
    }

    /// <summary>
    /// Update per-property last-seen values + last-update timestamp +
    /// AndStays hold-start tracking on every incoming data point.
    /// </summary>
    public ObjectState Apply(ObjectState state, DataPoint point, Rule? andStaysRule = null)
    {
        var lastNumeric = new Dictionary<string, double>(state.LastNumeric);
        var lastString = new Dictionary<string, string>(state.LastString);
        var lastUpdate = new Dictionary<string, DateTimeOffset>(state.LastUpdate);

        if (point.NumericValue is not null) lastNumeric[point.Property] = point.NumericValue.Value;
        if (point.StringValue is not null) lastString[point.Property] = point.StringValue;
        lastUpdate[point.Property] = point.Timestamp;

        // AndStays hold-start tracking
        if (andStaysRule is not null && andStaysRule.Threshold is not null && point.NumericValue is not null)
        {
            var holdKey = $"_holdStart:{andStaysRule.Id}";
            var conditionHolds = point.NumericValue > andStaysRule.Threshold;
            if (conditionHolds && !lastUpdate.ContainsKey(holdKey))
            {
                lastUpdate[holdKey] = point.Timestamp;
            }
            else if (!conditionHolds && lastUpdate.ContainsKey(holdKey))
            {
                lastUpdate.Remove(holdKey);
            }
        }

        return state with { LastNumeric = lastNumeric, LastString = lastString, LastUpdate = lastUpdate };
    }

    public ObjectState RecordFire(ObjectState state, Rule rule, DateTimeOffset now)
    {
        var fireCount = new Dictionary<string, int>(state.RuleFireCount);
        var lastFire = new Dictionary<string, DateTimeOffset>(state.RuleLastFire);
        fireCount[rule.Id] = (fireCount.TryGetValue(rule.Id, out var c) ? c : 0) + 1;
        lastFire[rule.Id] = now;
        return state with { RuleFireCount = fireCount, RuleLastFire = lastFire };
    }

    private static string StateKey(string workspaceId, string objectId) =>
        $"loom:activator:{workspaceId}:{objectId}";

    private static ObjectState EmptyState(string objectId) => new(
        objectId, new(), new(), new(), new(), new());
}
