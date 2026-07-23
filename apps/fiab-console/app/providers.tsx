'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/lib/theme/theme-context';
import { useSessionKeepalive } from '@/lib/auth/use-session-keepalive';
import { RumTelemetry } from '@/lib/telemetry/rum';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/**
 * Mounts the sliding-session keepalive ping (no UI). Kept as a child of the
 * client providers so a long-lived idle tab re-slides the loom_session cookie
 * and never bounces to login on the hour. The hook self-disables when the server
 * reports sliding is OFF (LOOM_SESSION_SLIDING_ENABLED=false) — it stops pinging
 * after the first {sliding:false} response, so the env kill switch reverts the
 * proactive sliding without any client-side env plumbing.
 */
function SessionKeepalive() {
  useSessionKeepalive();
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionKeepalive />
      {/* RUM1 — passive browser telemetry capture (no UI). Config-gated
          server-side (LOOM_RUM_ENABLED + rum1-client-telemetry flag) and
          per-session sampled; a silent no-op pre-auth or when disabled. */}
      <RumTelemetry />
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}
