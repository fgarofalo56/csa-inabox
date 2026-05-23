using CsaLoom.Activator.Models;
using System.Xml;

namespace CsaLoom.Activator.Evaluation;

/// <summary>
/// Stateful evaluator for the 8 Fabric Reflex primitives. State per
/// object is loaded from Redis (hot path) with Cosmos DB as durable
/// backup. Evaluation is pure (state-in / decision-out); persistence
/// is the orchestrator's job.
/// </summary>
public class PrimitiveEvaluator
{
    /// <summary>
    /// Evaluate one data point against one rule. Returns a FireDecision
    /// if the rule should fire, otherwise null.
    /// </summary>
    public FireDecision? Evaluate(Rule rule, DataPoint point, ObjectState state)
    {
        if (!rule.Enabled) return null;
        if (!Match(rule.ObjectFilter, point.ObjectId)) return null;
        if (!string.Equals(rule.Property, point.Property, StringComparison.OrdinalIgnoreCase)) return null;

        // Suppression check first — avoids any expensive evaluation when
        // we know we'd suppress anyway.
        if (IsSuppressed(rule, state, point.Timestamp)) return null;

        var fired = rule.Primitive switch
        {
            Primitive.IncreasesAbove => EvalIncreasesAbove(rule, point, state),
            Primitive.DecreasesBelow => EvalDecreasesBelow(rule, point, state),
            Primitive.IsAbove => EvalIsAbove(rule, point),
            Primitive.IsBelow => EvalIsBelow(rule, point),
            Primitive.ChangesTo => EvalChangesTo(rule, point, state),
            Primitive.AndStays => EvalAndStays(rule, point, state),
            Primitive.NoPresenceOfData => null, // evaluated on a timer, not on data arrival
            Primitive.EveryNthTime => EvalEveryNthTime(rule, point, state),
            _ => null,
        };

        return fired;
    }

    /// <summary>
    /// Periodic sweep for NoPresenceOfData. The orchestrator calls
    /// this on a timer (default 30s) for every rule with that primitive.
    /// </summary>
    public FireDecision? EvaluateSilence(Rule rule, ObjectState state, DateTimeOffset now)
    {
        if (rule.Primitive != Primitive.NoPresenceOfData) return null;
        if (!rule.Enabled) return null;
        if (!state.LastUpdate.TryGetValue(rule.Property, out var lastUpdate)) return null;
        if (IsSuppressed(rule, state, now)) return null;

        var window = ParseDuration(rule.Duration ?? "PT10M");
        if (now - lastUpdate < window) return null;

        return new FireDecision(
            rule,
            state.ObjectId,
            now,
            $"No '{rule.Property}' observed for {window}",
            new DataPoint(state.ObjectId, rule.Property, null, null, lastUpdate));
    }

    private static FireDecision? EvalIncreasesAbove(Rule rule, DataPoint point, ObjectState state)
    {
        if (point.NumericValue is null || rule.Threshold is null) return null;
        var prev = state.LastNumeric.TryGetValue(rule.Property, out var p) ? p : double.NaN;
        if (point.NumericValue > rule.Threshold && (double.IsNaN(prev) || prev <= rule.Threshold))
        {
            return new FireDecision(
                rule,
                point.ObjectId,
                point.Timestamp,
                $"{rule.Property} crossed {rule.Threshold} from below: {prev} → {point.NumericValue}",
                point);
        }
        return null;
    }

    private static FireDecision? EvalDecreasesBelow(Rule rule, DataPoint point, ObjectState state)
    {
        if (point.NumericValue is null || rule.Threshold is null) return null;
        var prev = state.LastNumeric.TryGetValue(rule.Property, out var p) ? p : double.NaN;
        if (point.NumericValue < rule.Threshold && (double.IsNaN(prev) || prev >= rule.Threshold))
        {
            return new FireDecision(
                rule,
                point.ObjectId,
                point.Timestamp,
                $"{rule.Property} crossed {rule.Threshold} from above: {prev} → {point.NumericValue}",
                point);
        }
        return null;
    }

    private static FireDecision? EvalIsAbove(Rule rule, DataPoint point)
    {
        if (point.NumericValue is null || rule.Threshold is null) return null;
        return point.NumericValue > rule.Threshold
            ? new FireDecision(rule, point.ObjectId, point.Timestamp, $"{rule.Property} is above {rule.Threshold}", point)
            : null;
    }

    private static FireDecision? EvalIsBelow(Rule rule, DataPoint point)
    {
        if (point.NumericValue is null || rule.Threshold is null) return null;
        return point.NumericValue < rule.Threshold
            ? new FireDecision(rule, point.ObjectId, point.Timestamp, $"{rule.Property} is below {rule.Threshold}", point)
            : null;
    }

    private static FireDecision? EvalChangesTo(Rule rule, DataPoint point, ObjectState state)
    {
        if (point.StringValue is null || rule.TargetValue is null) return null;
        var prev = state.LastString.TryGetValue(rule.Property, out var p) ? p : null;
        if (string.Equals(point.StringValue, rule.TargetValue, StringComparison.Ordinal)
            && !string.Equals(prev, rule.TargetValue, StringComparison.Ordinal))
        {
            return new FireDecision(
                rule,
                point.ObjectId,
                point.Timestamp,
                $"{rule.Property} changed to '{rule.TargetValue}' (was '{prev ?? "(none)"}')",
                point);
        }
        return null;
    }

    /// <summary>
    /// AndStays — composite. The orchestrator pairs this with another
    /// primitive: if the underlying condition has held continuously
    /// for the rule's duration, fire. Here we just check the elapsed
    /// time since the condition first held (tracked in state via the
    /// "_holdStart:{ruleId}" pseudo-key).
    /// </summary>
    private static FireDecision? EvalAndStays(Rule rule, DataPoint point, ObjectState state)
    {
        if (rule.Threshold is null || rule.Duration is null || point.NumericValue is null) return null;
        var holdKey = $"_holdStart:{rule.Id}";
        var heldFor = state.LastUpdate.TryGetValue(holdKey, out var since) ? point.Timestamp - since : TimeSpan.Zero;
        var window = ParseDuration(rule.Duration);
        return heldFor >= window
            ? new FireDecision(rule, point.ObjectId, point.Timestamp, $"{rule.Property} held above {rule.Threshold} for {window}", point)
            : null;
    }

    private static FireDecision? EvalEveryNthTime(Rule rule, DataPoint point, ObjectState state)
    {
        if (rule.EveryNthInterval is null or 0) return null;
        var count = state.RuleFireCount.TryGetValue(rule.Id, out var c) ? c + 1 : 1;
        return count % rule.EveryNthInterval == 0
            ? new FireDecision(rule, point.ObjectId, point.Timestamp, $"Nth ({count}) occurrence", point)
            : null;
    }

    private static bool IsSuppressed(Rule rule, ObjectState state, DateTimeOffset now)
    {
        if (!state.RuleLastFire.TryGetValue(rule.Id, out var lastFire)) return false;
        var window = ParseDuration(rule.SuppressionDuration ?? "PT1H");
        return now - lastFire < window;
    }

    private static bool Match(string filter, string objectId) =>
        filter == "*" || filter == objectId;

    /// <summary>Parse an ISO-8601 duration (e.g., PT5M, P1D, PT1H30M).</summary>
    private static TimeSpan ParseDuration(string duration) =>
        XmlConvert.ToTimeSpan(duration);
}
