namespace CsaLoom.Activator.Models;

/// <summary>
/// Activator rule. Mirrors the 8 Fabric Reflex primitives.
/// </summary>
public enum Primitive
{
    /// <summary>Fires when the property crosses the threshold from below.</summary>
    IncreasesAbove,
    /// <summary>Fires when the property crosses the threshold from above.</summary>
    DecreasesBelow,
    /// <summary>Fires while the property remains above the threshold.</summary>
    IsAbove,
    /// <summary>Fires while the property remains below the threshold.</summary>
    IsBelow,
    /// <summary>Fires when a categorical property transitions to a target value.</summary>
    ChangesTo,
    /// <summary>Composite — combined with another primitive plus a duration.</summary>
    AndStays,
    /// <summary>Fires when no events arrive within a duration.</summary>
    NoPresenceOfData,
    /// <summary>Fires every Nth occurrence of a triggering event.</summary>
    EveryNthTime,
}

public enum ActionType
{
    Teams,
    Email,
    LogicApp,
    Webhook,
}

public record Rule(
    string Id,
    string WorkspaceId,
    string Name,
    bool Enabled,
    Primitive Primitive,
    /// <summary>Object identifier — e.g., "server-01" or "*" (all objects).</summary>
    string ObjectFilter,
    string Property,
    double? Threshold,
    /// <summary>Target value for ChangesTo primitive.</summary>
    string? TargetValue,
    /// <summary>ISO-8601 duration (e.g., PT5M).</summary>
    string? Duration,
    int? EveryNthInterval,
    ActionType Action,
    string ActionTarget,
    /// <summary>Suppression window — no double-fires within this duration.</summary>
    string SuppressionDuration);

public record DataPoint(
    string ObjectId,
    string Property,
    double? NumericValue,
    string? StringValue,
    DateTimeOffset Timestamp);

public record ObjectState(
    string ObjectId,
    /// <summary>Per-property last observed value.</summary>
    Dictionary<string, double> LastNumeric,
    Dictionary<string, string> LastString,
    /// <summary>Per-property last update timestamp (for NoPresenceOfData).</summary>
    Dictionary<string, DateTimeOffset> LastUpdate,
    /// <summary>Per-rule fire count for EveryNthTime.</summary>
    Dictionary<string, int> RuleFireCount,
    /// <summary>Per-rule last fire (for suppression).</summary>
    Dictionary<string, DateTimeOffset> RuleLastFire);

public record FireDecision(
    Rule Rule,
    string ObjectId,
    DateTimeOffset Timestamp,
    string Reason,
    DataPoint TriggeringPoint);
