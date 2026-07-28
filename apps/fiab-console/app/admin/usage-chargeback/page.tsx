import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/usage-chargeback — kept as a stable deep link (IA-03).
 *
 * The unified capacity + chargeback dashboard is now the "Capacity & LCU" TAB
 * of the FinOps hub. The full surface (CapacityChargebackPane) is unchanged —
 * it was moved, not rewritten — so bookmarks, the gate-registry surface paths
 * (svc-cost-management / svc-lcu-admission) and any external link keep landing
 * on exactly the same UI.
 */
export default function UsageChargebackRedirect() {
  redirect('/admin/finops?tab=capacity');
}
