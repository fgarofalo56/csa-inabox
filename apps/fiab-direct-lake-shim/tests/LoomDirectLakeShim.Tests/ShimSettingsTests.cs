using System.Runtime.CompilerServices;
using CsaLoom.DirectLakeShim.Config;
using CsaLoom.DirectLakeShim.EventGrid;
using CsaLoom.DirectLakeShim.Tom;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace CsaLoom.DirectLakeShim.Tests;

public class ShimSettingsTests
{
    private static Func<string, string?> Env(string? enabled, string? ns, string? queue) => k => k switch
    {
        "LOOM_DIRECT_LAKE_SHIM_ENABLED" => enabled,
        "SERVICEBUS_NAMESPACE" => ns,
        "EVENTGRID_QUEUE" => queue,
        _ => null,
    };

    // The live crash shape: all three blank. Breaks if Resolve validates the
    // namespace before checking the enabled flag (it would throw here).
    [Theory]
    [InlineData("", "", "")]
    [InlineData(null, null, null)]
    [InlineData("false", "", "")]
    [InlineData("0", "ns.servicebus.windows.net", "q")]
    [InlineData("yes", "", "")]
    public void Disabled_does_not_throw_and_is_not_enabled(string? enabled, string? ns, string? q)
    {
        var s = ShimSettings.Resolve(Env(enabled, ns, q));
        s.Enabled.Should().BeFalse($"flag '{enabled}' is not a clear true");
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(null)]
    public void Enabled_with_blank_namespace_fails_naming_the_variable(string? ns)
    {
        // Breaks if blank namespace falls back to a placeholder or passes through.
        var act = () => ShimSettings.Resolve(Env("true", ns, "q"));
        act.Should().Throw<InvalidOperationException>().WithMessage("*SERVICEBUS_NAMESPACE*");
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData(null)]
    public void Enabled_with_blank_queue_fails_naming_the_variable(string? q)
    {
        // Breaks if a missing queue silently idles (fake-healthy).
        var act = () => ShimSettings.Resolve(Env("TRUE", "ns.servicebus.windows.net", q));
        act.Should().Throw<InvalidOperationException>().WithMessage("*EVENTGRID_QUEUE*");
    }

    [Theory]
    [InlineData("true")]
    [InlineData("TRUE")]
    [InlineData("1")]
    public void Enabled_and_configured_carries_values_through(string flag)
    {
        var s = ShimSettings.Resolve(Env(flag, "ns.servicebus.windows.net", "delta-queue"));
        s.Enabled.Should().BeTrue();
        s.ServiceBusNamespace.Should().Be("ns.servicebus.windows.net");
        s.QueueName.Should().Be("delta-queue");
    }

    [Fact]
    public async Task Disabled_handler_idles_until_stopped_without_a_servicebus_client()
    {
        // Breaks if the handler touches a null Service Bus client when disabled
        // (NullReferenceException => task faults) or returns early.
        var settings = ShimSettings.Resolve(Env("", "", ""));
        var tom = new TomRefreshClient(NullLogger<TomRefreshClient>.Instance, new ConfigurationBuilder().Build());
        var store = (SemanticModelConfigStore)RuntimeHelpers.GetUninitializedObject(typeof(SemanticModelConfigStore));
        var handler = new DeltaLogEventHandler(settings, tom, store, NullLogger<DeltaLogEventHandler>.Instance);

        await handler.StartAsync(CancellationToken.None);
        await Task.Delay(200);
        handler.ExecuteTask!.IsCompleted.Should().BeFalse("a disabled shim must idle, not exit or fault");
        await handler.StopAsync(CancellationToken.None);
        handler.ExecuteTask.IsFaulted.Should().BeFalse();
    }
}
