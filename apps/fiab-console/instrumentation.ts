// Next.js instrumentation entry — runs once at server startup,
// before any request handlers. Standard hook for telemetry init.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  // Positive `=== 'nodejs'` check (not an early return): Next replaces
  // NEXT_RUNTIME at build time per bundle, so the edge bundle drops this import
  // and never tries to resolve node builtins like `crypto` (broke `next dev`).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node');
    await registerNode();
  }
}
