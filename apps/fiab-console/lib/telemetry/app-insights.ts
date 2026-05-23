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
 */

import { useAzureMonitor, AzureMonitorOpenTelemetryOptions } from '@azure/monitor-opentelemetry';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let _configured = false;

export function configureTelemetry(): void {
  if (_configured) return;
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!conn) {
    console.log('[telemetry] APPLICATIONINSIGHTS_CONNECTION_STRING not set; telemetry disabled');
    return;
  }

  const options: AzureMonitorOpenTelemetryOptions = {
    azureMonitorExporterOptions: { connectionString: conn },
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'loom-console',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.1.0',
      'deployment.environment': process.env.CSA_LOOM_BOUNDARY || 'Unknown',
      'csa-loom.tier': 'console',
      'csa-loom.app': 'fiab-console',
    }),
    enableLiveMetrics: true,
  };

  useAzureMonitor(options);
  _configured = true;
  console.log('[telemetry] App Insights configured for loom-console');
}
