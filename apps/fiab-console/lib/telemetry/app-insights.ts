/**
 * Application Insights integration for Loom Console (server-side).
 *
 * Wired via `instrumentation.ts` (Next.js convention) so it loads
 * before any request handlers. Standardized resource attributes:
 *   service.name = "loom-console"
 *   csa-loom.boundary = process.env.CSA_LOOM_BOUNDARY
 *   csa-loom.tier = "console"
 *
 * No-op if APPLICATIONINSIGHTS_CONNECTION_STRING is unset (dev / test).
 *
 * Implementation note: lazy-import @azure/monitor-opentelemetry so dev
 * builds don't fail when the dep tree is incomplete. Errors are
 * swallowed so a misconfigured environment doesn't crash app boot.
 */

let _configured = false;

export async function configureTelemetry(): Promise<void> {
  if (_configured) return;
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!conn) {
    console.log('[telemetry] APPLICATIONINSIGHTS_CONNECTION_STRING not set; telemetry disabled');
    return;
  }

  try {
    const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
    useAzureMonitor({
      azureMonitorExporterOptions: { connectionString: conn },
      resource: {
        attributes: {
          'service.name': 'loom-console',
          'service.version': process.env.npm_package_version || '0.1.0',
          'deployment.environment': process.env.CSA_LOOM_BOUNDARY || 'Unknown',
          'csa-loom.tier': 'console',
          'csa-loom.app': 'fiab-console',
        },
      } as any,
      enableLiveMetrics: true,
    });
    _configured = true;
    console.log('[telemetry] App Insights configured for loom-console');
  } catch (err) {
    console.warn('[telemetry] @azure/monitor-opentelemetry init failed:', err);
  }
}
