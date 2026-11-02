/**
 * Application Insights integration for Loom Console (server-side).
 *
 * Wired via `instrumentation.ts` (Next.js convention) so it loads
 * before any request handlers. Standardized resource attributes:
 *   service.name = "loom-console"
 *   csa-loom.boundary = process.env.CSA_LOOM_BOUNDARY
 *   csa-loom.tier = "console"
 *
 * No-op unless BOTH are set (deploy-readiness #1382):
 *   - LOOM_CONSOLE_TELEMETRY_ENABLED === 'true'  (opt-out flag, default-on in bicep)
 *   - APPLICATIONINSIGHTS_CONNECTION_STRING       (telemetry destination)
 *
 * Crash-safety: `@azure/monitor-opentelemetry`'s Live Metrics path uses a
 * native QUIC/gRPC channel that has SIGSEGV'd the Node process *after* boot on
 * Container Apps — a fault a try/catch cannot trap. We therefore (a) keep the
 * SDK behind the opt-out env gate, (b) hard-disable Live Metrics (the common
 * SIGSEGV trigger), and (c) install a last-resort `uncaughtException` /
 * `unhandledRejection` guard scoped to telemetry init so a telemetry fault
 * logs and is swallowed instead of taking the request-serving process down.
 * The Console then serves traffic with telemetry degraded rather than
 * crash-looping behind Envoy "connection refused".
 */

let _configured = false;
let _guardInstalled = false;

/**
 * Returns true when console telemetry is enabled for this deployment. The bicep
 * wires LOOM_CONSOLE_TELEMETRY_ENABLED='true' by default (opt-out); when an
 * operator disables it the var is '' and the connection string is withheld, so
 * either signal alone disables the SDK.
 */
export function isTelemetryEnabled(): boolean {
  const flag = (process.env.LOOM_CONSOLE_TELEMETRY_ENABLED ?? '').trim().toLowerCase();
  // Default-on only when the flag is explicitly 'true'. Any other value
  // (including unset, in dev/test) disables the OTel SDK.
  if (flag !== 'true') return false;
  return !!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
}

/**
 * Install a one-time, telemetry-scoped crash guard. A native fault from the
 * OTel / Live-Metrics layer surfaces as an uncaughtException / unhandledRejection;
 * without a handler Node exits non-zero and the revision crash-loops. We log
 * and keep the process up for telemetry-attributable faults — telemetry
 * degraded, app still serving — while re-throwing genuinely unrelated faults so
 * real bugs still surface.
 */
const isTelemetryFault = (err: unknown): boolean => {
  const s = String((err as Error)?.stack || err || '');
  return /monitor-opentelemetry|applicationinsights|opentelemetry|live[\s-]?metrics|quickpulse/i.test(s);
};

/**
 * A client that hangs up mid-request makes Node emit `Error: aborted` (ECONNRESET) on the
 * request stream; with no listener it surfaces as an uncaughtException. It is the CLIENT's
 * fault, not the process's: rethrowing it killed the replica with exit code 7 on 2026-11-02
 * (a slow request abandoned at the UI's 20 s timeout), 503ing every other in-flight request.
 * Matched on all three of code, message and the http-server frame, so an ECONNRESET from an
 * outbound call (a real fault) is still rethrown.
 */
export function isClientAbort(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; stack?: unknown } | null;
  return (
    e?.code === 'ECONNRESET' &&
    e?.message === 'aborted' &&
    /_http_server|abortIncoming/.test(String(e?.stack ?? ''))
  );
}

/** What the uncaughtException handler does with `err`: log-and-continue, or rethrow. */
export function classifyUncaught(err: unknown): 'telemetry' | 'client-abort' | 'rethrow' {
  if (isTelemetryFault(err)) return 'telemetry';
  if (isClientAbort(err)) return 'client-abort';
  return 'rethrow';
}

function installCrashGuard(): void {
  if (_guardInstalled) return;
  _guardInstalled = true;
  process.on('uncaughtException', (err) => {
    const verdict = classifyUncaught(err);
    if (verdict === 'telemetry') {
      console.error('[telemetry] swallowed uncaughtException from telemetry layer; app continues:', err);
      return;
    }
    if (verdict === 'client-abort') {
      console.warn('[console] client aborted an in-flight request (ECONNRESET); not a process fault, app continues');
      return;
    }
    throw err;
  });
  process.on('unhandledRejection', (reason) => {
    if (isTelemetryFault(reason)) {
      console.error('[telemetry] swallowed unhandledRejection from telemetry layer; app continues:', reason);
      return;
    }
    // Non-telemetry rejections keep their default (logged) behavior.
    console.error('[telemetry] unhandledRejection (non-telemetry):', reason);
  });
}

export async function configureTelemetry(): Promise<void> {
  if (_configured) return;

  if (!isTelemetryEnabled()) {
    console.log(
      '[telemetry] disabled (LOOM_CONSOLE_TELEMETRY_ENABLED!=="true" or APPLICATIONINSIGHTS_CONNECTION_STRING unset); skipping OTel init',
    );
    return;
  }

  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING!;

  // Install the guard BEFORE touching the native SDK so an init-time fault is trapped.
  installCrashGuard();

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
      // Live Metrics' native channel is the historical SIGSEGV source on
      // Container Apps (#1382). Distributed traces + metrics + logs still flow
      // to App Insights; only the real-time "Live Metrics" stream is dropped.
      enableLiveMetrics: false,
    });
    _configured = true;
    console.log('[telemetry] App Insights configured for loom-console (live metrics disabled)');
  } catch (err) {
    console.warn('[telemetry] @azure/monitor-opentelemetry init failed; continuing without telemetry:', err);
  }
}
