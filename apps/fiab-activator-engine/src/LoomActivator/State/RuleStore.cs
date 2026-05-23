using CsaLoom.Activator.Models;
using Microsoft.Azure.Cosmos;

namespace CsaLoom.Activator.State;

/// <summary>
/// Loads rule definitions from Cosmos DB `activator-state.rules`
/// container. Cached in-memory with a 30s TTL so per-poll lookups are
/// O(1) without stale-rule risk.
/// </summary>
public class RuleStore
{
    private readonly Container _container;
    private readonly ILogger<RuleStore> _log;
    private DateTimeOffset _cacheExpiresAt;
    private readonly Dictionary<string, List<Rule>> _cacheByWorkspace = new();
    private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(30);
    private readonly SemaphoreSlim _lock = new(1, 1);

    public RuleStore(CosmosClient cosmos, IConfiguration config, ILogger<RuleStore> log)
    {
        var db = cosmos.GetDatabase(config["COSMOS_DATABASE"] ?? "activator-state");
        _container = db.GetContainer(config["COSMOS_CONTAINER"] ?? "rules");
        _log = log;
    }

    public async Task<IReadOnlyList<Rule>> ListEnabledAsync(string workspaceId)
    {
        await _lock.WaitAsync();
        try
        {
            if (DateTimeOffset.UtcNow > _cacheExpiresAt)
            {
                await RefreshCacheAsync();
            }
            return _cacheByWorkspace.TryGetValue(workspaceId, out var list)
                ? list.Where(r => r.Enabled).ToList()
                : Array.Empty<Rule>();
        }
        finally
        {
            _lock.Release();
        }
    }

    private async Task RefreshCacheAsync()
    {
        _cacheByWorkspace.Clear();
        var query = new QueryDefinition("SELECT * FROM c WHERE c.enabled = true");
        var iterator = _container.GetItemQueryIterator<Rule>(query);
        while (iterator.HasMoreResults)
        {
            foreach (var rule in await iterator.ReadNextAsync())
            {
                if (!_cacheByWorkspace.TryGetValue(rule.WorkspaceId, out var list))
                {
                    list = new List<Rule>();
                    _cacheByWorkspace[rule.WorkspaceId] = list;
                }
                list.Add(rule);
            }
        }
        _cacheExpiresAt = DateTimeOffset.UtcNow + CacheTtl;
        _log.LogDebug("Refreshed rule cache: {Count} workspaces", _cacheByWorkspace.Count);
    }
}
