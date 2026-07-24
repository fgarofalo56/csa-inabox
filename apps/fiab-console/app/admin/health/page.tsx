import { AdminShell } from '@/lib/components/admin-shell';
import { HealthHubTabs } from '@/lib/components/admin/health-hub-tabs';
import { runtimeFlag } from '@/lib/admin/runtime-flags';

export const dynamic = 'force-dynamic';

export default async function AdminHealthPage() {
  // FLAG0 kill-switch (default-ON, fail-open): flipping 'v1-journeys-tab' OFF
  // reverts /admin/health to the pre-V1 self-audit-only layout in seconds.
  const journeysEnabled = await runtimeFlag('v1-journeys-tab');
  // A10: 'a10-spark-tab' OFF hides the Spark pools tab (surface-only revert).
  const sparkEnabled = await runtimeFlag('a10-spark-tab');
  // A11: 'a11-spark-autorecover' — the AUTO toggle state for FAULTED-pool
  // auto-recovery (default-ON). The manual "Recreate pool" button stays either way.
  const autorecoverEnabled = await runtimeFlag('a11-spark-autorecover');
  // SLO1: 'slo1-slo-tab' OFF hides the SLO / error-budget tab (surface-only revert).
  const sloEnabled = await runtimeFlag('slo1-slo-tab');
  // CH1: 'ch1-dependency-chaos' — deliberately OPT-IN (default:false). ON reveals
  // the dependency-fault chaos tab; arming a fault is still triple-gated server-side.
  const chaosEnabled = await runtimeFlag('ch1-dependency-chaos', { default: false });
  return (
    <AdminShell
      sectionTitle="Health & Reliability"
      learn={{
        title: 'Health & Reliability',
        content: 'The one reliability hub. Self-audit reviews the deployment across identity, data plane, Azure services, permissions, and security posture — each check probes a real backend, and fixable issues offer a one-click healer (admin-approved). Exercise services runs a tiny real operation through every backend data path. The Journeys tab shows the scheduled synthetic user-journey monitor: six real end-to-end journeys (including a TRUE MSAL login probe) run against the live deployment every 15 minutes from inside the VNet, so a broken sign-in path or a dead editor is caught within one cycle — not by the first user.',
        tips: [
          'Run the self-audit after a deploy or config change to confirm every plane is wired correctly.',
          'The one-click healer only runs with admin approval and targets issues Loom can safely fix.',
          'Failed checks name the exact env var, role, or resource to fix — treat them as your remediation list.',
          'Exercise services executes a real end-to-end operation per backend — a green self-audit with a red exercise means the resource exists but cannot do work (e.g. a faulted Spark pool).',
          'Secret & credential health tracks the MSAL app secrets + tracked Key Vault credentials with days-to-expiry — rotate anything red or amber via the secret-rotation runbook before it breaks sign-in.',
          'Journeys: a red J1 with every other journey green means SIGN-IN is broken while the app is healthy — rotate/verify the MSAL client secret first (the 2026-07-19 outage class).',
          'Spark pools: a pool can report Succeeded and still be unable to launch any application (FAULTED). A "Suspect — breaker armed" badge or leak candidates mean follow the spark-pools runbook: delete + recreate, and if sessions still wedge, a NEW pool name.',
          'SLO & error budgets: each SLI shows objective vs 28-day attainment vs error-budget burn. A red "2×+ burn" badge on an availability or latency SLI means the budget is being spent twice as fast as allowed — a P2 has already paged; follow the slo-error-budget runbook. The cache-hit SLI is an efficiency floor and never pages.',
          'Dependency chaos: a deliberately opt-in resilience DRILL tab (default hidden). Arm a Cosmos/Azure OpenAI/ADX/Key Vault fault against this replica to prove a surface degrades to serve-stale or an honest gate — never a crash. It is triple-gated (flag + LOOM_DEPENDENCY_CHAOS_ENABLED + internal token) and every fault auto-expires; keep it OFF in production.',
        ],
      }}
    >
      <HealthHubTabs journeysEnabled={journeysEnabled} sparkEnabled={sparkEnabled} autorecoverEnabled={autorecoverEnabled} sloEnabled={sloEnabled} chaosEnabled={chaosEnabled} />
    </AdminShell>
  );
}
