namespace CsaLoom.DirectLakeShim;

/// <summary>
/// Startup decision for the shim, kept pure so it is unit-testable.
///
/// Disabled (LOOM_DIRECT_LAKE_SHIM_ENABLED not "1"/"true", case-insensitive):
///   the host starts and idles; no Service Bus client is built.
/// Enabled but SERVICEBUS_NAMESPACE or EVENTGRID_QUEUE is null/empty/whitespace:
///   fail fast with ONE error naming the variable (a fake-healthy idle would
///   hide a real misconfiguration).
/// Enabled and configured: the Service Bus path, unchanged.
/// </summary>
public sealed record ShimSettings(bool Enabled, string? ServiceBusNamespace, string? QueueName)
{
    public static ShimSettings Resolve(Func<string, string?> get)
    {
        var flag = get("LOOM_DIRECT_LAKE_SHIM_ENABLED")?.Trim();
        var enabled = string.Equals(flag, "1", StringComparison.Ordinal)
            || string.Equals(flag, "true", StringComparison.OrdinalIgnoreCase);
        if (!enabled)
        {
            return new ShimSettings(false, null, null);
        }

        var ns = get("SERVICEBUS_NAMESPACE");
        if (string.IsNullOrWhiteSpace(ns))
        {
            throw new InvalidOperationException(
                "LOOM_DIRECT_LAKE_SHIM_ENABLED is true but SERVICEBUS_NAMESPACE is not set (null, empty or whitespace).");
        }

        var queue = get("EVENTGRID_QUEUE");
        if (string.IsNullOrWhiteSpace(queue))
        {
            throw new InvalidOperationException(
                "LOOM_DIRECT_LAKE_SHIM_ENABLED is true but EVENTGRID_QUEUE is not set (null, empty or whitespace).");
        }

        return new ShimSettings(true, ns, queue);
    }
}
