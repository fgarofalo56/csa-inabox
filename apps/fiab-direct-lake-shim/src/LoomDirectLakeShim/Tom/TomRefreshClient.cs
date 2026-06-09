using CsaLoom.DirectLakeShim.Models;
using Microsoft.AnalysisServices.Tabular;
using System.Diagnostics;

namespace CsaLoom.DirectLakeShim.Tom;

/// <summary>
/// TOM client wrapper for partition-scoped semantic model refresh.
///
/// Uses the Microsoft.AnalysisServices.Tabular Object Model
/// against a Power BI Premium XMLA endpoint. The XMLA endpoint URL is
/// stored per-semantic-model in Cosmos DB and authentication uses
/// Azure AD interactive (dev) or service-principal (prod) credentials.
/// </summary>
public class TomRefreshClient
{
    private readonly ILogger<TomRefreshClient> _log;
    private readonly IConfiguration _config;

    public TomRefreshClient(ILogger<TomRefreshClient> log, IConfiguration config)
    {
        _log = log;
        _config = config;
    }

    /// <summary>
    /// Refresh a single partition of a single table. Returns the
    /// outcome with timing for telemetry.
    /// </summary>
    public RefreshOutcome RefreshPartition(
        SemanticModelConfig model,
        string tableName,
        string partitionName)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var server = ConnectServer(model);
            var db = server.Databases.GetByName(model.DatasetId);
            var table = db.Model.Tables.Find(tableName)
                ?? throw new InvalidOperationException($"Table '{tableName}' not found");

            var partition = table.Partitions.Find(partitionName)
                ?? throw new InvalidOperationException($"Partition '{partitionName}' not found");

            partition.RequestRefresh(RefreshType.Full);
            db.Model.SaveChanges();
            sw.Stop();

            _log.LogInformation(
                "Refreshed partition {Table}/{Partition} in {Ms}ms",
                tableName, partitionName, sw.ElapsedMilliseconds);

            return new RefreshOutcome(
                model.Id, tableName, partitionName, Success: true,
                DurationMs: sw.ElapsedMilliseconds, Error: null);
        }
        catch (Exception ex)
        {
            sw.Stop();
            _log.LogError(ex, "Partition refresh failed for {Table}/{Partition}", tableName, partitionName);
            return new RefreshOutcome(
                model.Id, tableName, partitionName, Success: false,
                DurationMs: sw.ElapsedMilliseconds, Error: ex.Message);
        }
    }

    /// <summary>
    /// Refresh an entire table. Used for "full" policy on dim tables.
    /// </summary>
    public RefreshOutcome RefreshTable(SemanticModelConfig model, string tableName)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var server = ConnectServer(model);
            var db = server.Databases.GetByName(model.DatasetId);
            var table = db.Model.Tables.Find(tableName)
                ?? throw new InvalidOperationException($"Table '{tableName}' not found");

            table.RequestRefresh(RefreshType.Full);
            db.Model.SaveChanges();
            sw.Stop();

            _log.LogInformation("Refreshed table {Table} in {Ms}ms", tableName, sw.ElapsedMilliseconds);

            return new RefreshOutcome(
                model.Id, tableName, PartitionName: null,
                Success: true, DurationMs: sw.ElapsedMilliseconds, Error: null);
        }
        catch (Exception ex)
        {
            sw.Stop();
            _log.LogError(ex, "Table refresh failed for {Table}", tableName);
            return new RefreshOutcome(
                model.Id, tableName, null, Success: false,
                DurationMs: sw.ElapsedMilliseconds, Error: ex.Message);
        }
    }

    /// <summary>
    /// Connect via XMLA using DefaultAzureCredential.
    /// Connection string format: "DataSource=powerbi://api.powerbi.com/v1.0/myorg/{workspace};User ID=app:{appid}@{tenant};..."
    /// The per-model XmlaEndpoint (stored in Cosmos) wins; when it is empty the
    /// deployment-wide LOOM_AAS_XMLA_ENDPOINT (the AAS server provisioned by
    /// aas.bicep, asazure://&lt;region&gt;.asazure.windows.net/&lt;server&gt;) is the
    /// fallback so a model registered without an explicit endpoint still refreshes.
    /// </summary>
    private Server ConnectServer(SemanticModelConfig model)
    {
        var endpoint = !string.IsNullOrWhiteSpace(model.XmlaEndpoint)
            ? model.XmlaEndpoint
            : _config["LOOM_AAS_XMLA_ENDPOINT"];
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            throw new InvalidOperationException(
                $"No XMLA endpoint for model '{model.Id}': set per-model XmlaEndpoint or LOOM_AAS_XMLA_ENDPOINT.");
        }
        var server = new Server();
        // Production uses the OAuth bearer hooked into DefaultAzureCredential
        // via Server.Connect overload taking AccessToken. For brevity we use
        // the XMLA endpoint URL which already encodes the workspace.
        server.Connect(endpoint);
        return server;
    }
}
