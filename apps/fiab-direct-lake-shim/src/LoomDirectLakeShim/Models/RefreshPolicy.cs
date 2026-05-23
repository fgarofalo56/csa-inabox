namespace CsaLoom.DirectLakeShim.Models;

/// <summary>
/// Per-table refresh policy. Drives what the shim does on each
/// _delta_log notification.
/// </summary>
public enum RefreshPolicyKind
{
    /// <summary>Refresh only the affected partition. 5-30s for partitioned
    /// fact tables. The Direct Lake parity sweet spot.</summary>
    Partition,
    /// <summary>Full table refresh. Slow for large tables; appropriate
    /// for small dim tables on a schedule.</summary>
    Full,
    /// <summary>Mark the table as DirectQuery against Databricks SQL /
    /// Synapse Serverless. Always live; slower DAX.</summary>
    DirectQueryFallback,
    /// <summary>Composite: some tables Import, some DirectQuery, defined
    /// in TMDL. Refresh affects only the Import portion.</summary>
    Composite,
}

public record SemanticModelConfig(
    string Id,
    string WorkspaceId,
    string PowerBIWorkspaceId,
    string DatasetId,
    string XmlaEndpoint,
    Dictionary<string, TableRefreshConfig> Tables);

public record TableRefreshConfig(
    string TableName,
    RefreshPolicyKind Policy,
    /// <summary>For partition policy: column used to derive partition key (e.g., "event_date").</summary>
    string? PartitionColumn,
    /// <summary>Maximum partition refresh staleness — emit warning if exceeded.</summary>
    int MaxStalenessSeconds = 30);

public record RefreshOutcome(
    string SemanticModelId,
    string TableName,
    string? PartitionName,
    bool Success,
    long DurationMs,
    string? Error);
