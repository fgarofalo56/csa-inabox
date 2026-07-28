'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { AccessGovernanceTabs } from '@/lib/components/admin/access-governance-tabs';

/**
 * /admin/access-governance — the ONE identity-governance hub (IA-06, loom-apex
 * Phase B).
 *
 * Four tabs replacing four sibling admin pages: the onboarding Requests queue,
 * the unified who-has-access Report, requestable access Packages with approval
 * policies + separation-of-duties, and recertification Reviews. Every panel was
 * moved verbatim; the four old routes remain as redirect stubs into the
 * matching `?tab=` deep link.
 */
export default function AdminAccessGovernancePage() {
  return (
    <AdminShell
      sectionTitle="Access governance"
      learn={{
        title: 'Access governance — the Entra ID Governance 1:1',
        content:
          'One hub for the identity-governance lifecycle. Requests is the onboarding queue for people who cannot sign in yet. Report answers "what can this principal reach?" and "who can reach this resource?" by merging the entitlement ledger, live workspace ACLs and Entra group membership. Packages bundles {resource, role} grants into one requestable unit with an approval policy and separation-of-duties rules. Reviews runs recertification campaigns with bulk decisions, delegation and auto-revoke on no-response — every revoke tears down the real ARM / data-plane grant. Azure-native throughout; no Fabric dependency.',
        tips: [
          'Deep-link a tab with ?tab=requests | report | packages | reviews.',
          'The four former routes (/admin/access-requests, access-report, access-packages, access-reviews) redirect straight to their tab.',
          'Grants flow through one entitlement ledger (Cosmos, PK /principalId) so all four tabs agree on the same effective access.',
          'Entra group reconciliation is read-only and opt-in via the graph-group-sync gate — Loom never mutates tenant groups.',
        ],
        learnMoreHref: 'https://learn.microsoft.com/entra/id-governance/identity-governance-overview',
      }}
    >
      <AccessGovernanceTabs />
    </AdminShell>
  );
}
