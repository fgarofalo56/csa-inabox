// Next.js instrumentation entry — runs once at server startup,
// before any request handlers. Standard hook for telemetry init.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { configureTelemetry } = await import('./lib/telemetry/app-insights');
    await configureTelemetry();
  }
}
