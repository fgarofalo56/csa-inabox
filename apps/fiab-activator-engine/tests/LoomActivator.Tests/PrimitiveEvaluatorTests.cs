using CsaLoom.Activator.Evaluation;
using CsaLoom.Activator.Models;
using FluentAssertions;
using Xunit;

namespace CsaLoom.Activator.Tests;

public class PrimitiveEvaluatorTests
{
    private readonly PrimitiveEvaluator _eval = new();
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-05-22T12:00:00Z");

    private static ObjectState Empty(string id = "obj-1") => new(id, new(), new(), new(), new(), new());

    private static Rule R(Primitive p, double? threshold = null, string? target = null, int? nth = null) => new(
        Id: "r1",
        WorkspaceId: "ws-1",
        Name: "test",
        Enabled: true,
        Primitive: p,
        ObjectFilter: "*",
        Property: "cpu",
        Threshold: threshold,
        TargetValue: target,
        Duration: "PT5M",
        EveryNthInterval: nth,
        Action: ActionType.Teams,
        ActionTarget: "tgt",
        SuppressionDuration: "PT0S");

    [Fact]
    public void IncreasesAbove_fires_on_first_crossing_above_threshold()
    {
        var rule = R(Primitive.IncreasesAbove, 85);
        var state = Empty();
        // First point below threshold establishes prior
        state = state with { LastNumeric = new() { ["cpu"] = 60 } };
        var point = new DataPoint("obj-1", "cpu", 90, null, Now);
        _eval.Evaluate(rule, point, state).Should().NotBeNull();
    }

    [Fact]
    public void IncreasesAbove_does_not_fire_when_already_above()
    {
        var rule = R(Primitive.IncreasesAbove, 85);
        var state = Empty() with { LastNumeric = new() { ["cpu"] = 95 } };
        var point = new DataPoint("obj-1", "cpu", 97, null, Now);
        _eval.Evaluate(rule, point, state).Should().BeNull();
    }

    [Fact]
    public void DecreasesBelow_fires_on_first_crossing_below()
    {
        var rule = R(Primitive.DecreasesBelow, 30);
        var state = Empty() with { LastNumeric = new() { ["cpu"] = 45 } };
        var point = new DataPoint("obj-1", "cpu", 20, null, Now);
        _eval.Evaluate(rule, point, state).Should().NotBeNull();
    }

    [Theory]
    [InlineData(90, true)]
    [InlineData(50, false)]
    public void IsAbove_fires_only_when_above(double value, bool expected)
    {
        var rule = R(Primitive.IsAbove, 80);
        var point = new DataPoint("obj-1", "cpu", value, null, Now);
        ((_eval.Evaluate(rule, point, Empty()) is not null)).Should().Be(expected);
    }

    [Fact]
    public void ChangesTo_fires_on_first_transition_to_target()
    {
        var rule = R(Primitive.ChangesTo, target: "critical");
        var state = Empty() with { LastString = new() { ["cpu"] = "normal" } };
        var point = new DataPoint("obj-1", "cpu", null, "critical", Now);
        _eval.Evaluate(rule, point, state).Should().NotBeNull();
    }

    [Fact]
    public void ChangesTo_does_not_fire_when_already_at_target()
    {
        var rule = R(Primitive.ChangesTo, target: "critical");
        var state = Empty() with { LastString = new() { ["cpu"] = "critical" } };
        var point = new DataPoint("obj-1", "cpu", null, "critical", Now);
        _eval.Evaluate(rule, point, state).Should().BeNull();
    }

    [Fact]
    public void EveryNthTime_fires_on_third_call_when_N_is_3()
    {
        var rule = R(Primitive.EveryNthTime, nth: 3);
        var state = Empty() with { RuleFireCount = new() { ["r1"] = 2 } };
        var point = new DataPoint("obj-1", "cpu", 100, null, Now);
        _eval.Evaluate(rule, point, state).Should().NotBeNull();
    }

    [Fact]
    public void NoPresenceOfData_fires_after_window_elapsed()
    {
        var rule = R(Primitive.NoPresenceOfData);
        var state = Empty() with { LastUpdate = new() { ["cpu"] = Now.AddMinutes(-10) } };
        _eval.EvaluateSilence(rule, state, Now).Should().NotBeNull();
    }

    [Fact]
    public void NoPresenceOfData_does_not_fire_within_window()
    {
        var rule = R(Primitive.NoPresenceOfData);
        var state = Empty() with { LastUpdate = new() { ["cpu"] = Now.AddMinutes(-1) } };
        _eval.EvaluateSilence(rule, state, Now).Should().BeNull();
    }

    [Fact]
    public void Suppression_blocks_repeated_fires_within_window()
    {
        // Suppression duration in this rule is PT0S so it shouldn't suppress;
        // build one with PT1H to test
        var rule = R(Primitive.IsAbove, 50) with { SuppressionDuration = "PT1H" };
        var state = Empty() with { RuleLastFire = new() { ["r1"] = Now.AddMinutes(-10) } };
        var point = new DataPoint("obj-1", "cpu", 80, null, Now);
        _eval.Evaluate(rule, point, state).Should().BeNull();
    }
}
