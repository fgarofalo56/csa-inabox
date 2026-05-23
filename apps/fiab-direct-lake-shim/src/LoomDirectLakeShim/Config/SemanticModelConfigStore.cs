using CsaLoom.DirectLakeShim.Models;
using Microsoft.Azure.Cosmos;

namespace CsaLoom.DirectLakeShim.Config;

/// <summary>
/// Loads SemanticModelConfig records from Cosmos DB
/// <c>direct-lake-config.refresh-policies</c> container. Cached
/// in-memory for 60s.
/// </summary>
public class SemanticModelConfigStore
{
    private readonly Container _container;
    private readonly ILogger<SemanticModelConfigStore> _log;
    private DateTimeOffset _cacheExpiresAt;
    private List<SemanticModelConfig>? _cache;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(60);
    private readonly SemaphoreSlim _lock = new(1, 1);

    public SemanticModelConfigStore(CosmosClient cosmos, IConfiguration config, ILogger<SemanticModelConfigStore> log)
    {
        var db = cosmos.GetDatabase(config["COSMOS_DATABASE"] ?? "direct-lake-config");
        _container = db.GetContainer(config["COSMOS_CONTAINER"] ?? "refresh-policies");
        _log = log;
    }

    public async Task<IReadOnlyList<SemanticModelConfig>> FindModelsContainingTable(string schema, string table)
    {
        var key = $"{schema}.{table}";
        var all = await GetAllAsync();
        return all.Where(m => m.Tables.ContainsKey(key)).ToList();
    }

    private async Task<List<SemanticModelConfig>> GetAllAsync()
    {
        await _lock.WaitAsync();
        try
        {
            if (_cache is not null && DateTimeOffset.UtcNow <= _cacheExpiresAt)
                return _cache;

            var list = new List<SemanticModelConfig>();
            var iter = _container.GetItemQueryIterator<SemanticModelConfig>("SELECT * FROM c");
            while (iter.HasMoreResults)
            {
                foreach (var item in await iter.ReadNextAsync()) list.Add(item);
            }
            _cache = list;
            _cacheExpiresAt = DateTimeOffset.UtcNow + CacheTtl;
            _log.LogDebug("Refreshed semantic-model config cache: {Count} models", list.Count);
            return list;
        }
        finally
        {
            _lock.Release();
        }
    }
}
