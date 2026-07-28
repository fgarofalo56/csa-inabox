'use client';

/**
 * AccessGovernanceTabs — the /admin/access-governance tab strip (IA-06,
 * loom-apex Phase B).
 *
 * The four identity-governance admin surfaces are one hub instead of four
 * sibling tiles:
 *   • Requests — the sign-in-boundary onboarding queue (was /admin/access-requests).
 *   • Report   — the unified who-has-access report  (was /admin/access-report).
 *   • Packages — requestable access packages, approval policies, SoD rules
 *                (was /admin/access-packages).
 *   • Reviews  — recertification campaigns + leaver revoke-all
 *                (was /admin/access-reviews).
 *
 * Each pane is the SAME panel component the standalone page rendered — moved,
 * not rewritten — and keeps its SectionExplainer intro plus its LearnPopover
 * (now carried by HubTabHeader). All four old routes survive as redirect stubs,
 * so the gate-registry surface paths for the graph-group-sync gate still
 * resolve.
 *
 * Deep-linkable via `?tab=<value>`, the HealthHubTabs pattern.
 *
 * Azure-native throughout (Cosmos entitlement ledger + ARM / data-plane revoke
 * + read-only Entra Graph) — the 1:1 of Entra ID Governance, no Fabric anywhere.
 */

import { useEffect, useState } from 'react';
import { Tab, TabList, makeStyles, tokens } from '@fluentui/react-components';
import {
  PersonAdd24Regular, ShieldLock24Regular, BoxMultiple24Regular,
  ClipboardTask24Regular,
} from '@fluentui/react-icons';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { HubTabHeader } from '@/lib/components/admin/hub-tab-header';
import { AccessRequestsPanel } from '@/lib/components/admin/access-requests-panel';
import { AccessReportPanel } from '@/lib/components/admin/access-report-panel';
import { AccessPackagesPanel } from '@/lib/components/admin/access-packages-panel';
import { AccessReviewsPanel } from '@/lib/components/admin/access-reviews-panel';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  tabs: { marginBottom: tokens.spacingVerticalS },
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export type AccessGovernanceTab = 'requests' | 'report' | 'packages' | 'reviews';

/** Every value `?tab=` accepts — also the contract the redirect stubs target. */
export const ACCESS_GOVERNANCE_TABS: readonly AccessGovernanceTab[] =
  ['requests', 'report', 'packages', 'reviews'] as const;

export function AccessGovernanceTabs() {
  const styles = useStyles();
  const [tab, setTab] = useState<AccessGovernanceTab>('requests');

  // Deep link: /admin/access-governance?tab=reviews (client-only read — no
  // Suspense dance), the same pattern HealthHubTabs uses.
  useEffect(() => {
    try {
      const wanted = new URLSearchParams(window.location.search).get('tab');
      if (wanted && (ACCESS_GOVERNANCE_TABS as readonly string[]).includes(wanted)) {
        setTab(wanted as AccessGovernanceTab);
      }
    } catch { /* no window (SSR) — default tab stands */ }
  }, []);

  return (
    <div className={styles.root}>
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as AccessGovernanceTab)}
        aria-label="Access governance sections"
      >
        <Tab value="requests" icon={<PersonAdd24Regular />}>Requests</Tab>
        <Tab value="report" icon={<ShieldLock24Regular />}>Report</Tab>
        <Tab value="packages" icon={<BoxMultiple24Regular />}>Packages</Tab>
        <Tab value="reviews" icon={<ClipboardTask24Regular />}>Reviews</Tab>
      </TabList>

      {tab === 'requests' && (
        <>
          <HubTabHeader
            title="Access requests"
            learn={{
              title: 'Access requests',
              content:
                "Onboarding queue for people who don't yet have access. Approving a sign-in-boundary “Request access” submission surfaces the exact Entra step to set the person up; denying records a reason. Approval never silently mints access.",
              tips: [
                'Distinct from marketplace subscribe + the F16 asset-access workflow',
                'Backed by the signin-access-requests container (PK /tenantId)',
                'Tenant-admin only',
              ],
              learnMoreHref: 'https://learn.microsoft.com/entra/external-id/b2b-quickstart-add-guest-users-portal',
            }}
          />
          <div className={styles.explainer}>
            <SectionExplainer>
              The onboarding queue for people who don&apos;t yet have access to CSA Loom. When someone
              hits the sign-in screen without access, they can use “Request access” to submit their
              Microsoft identity and a reason. Approve a request to see the exact step to onboard them
              (which Entra group to add them to), or deny it with a recorded reason.{' '}
              <LearnPopover
                title="How onboarding works"
                content="Group membership is the authorization source. Approving records the decision and shows you the precise Entra step; Loom does not modify tenant group membership on your behalf, so you add the user to the configured admin/onboarding group in Entra, after which they can sign in. Denials require a note and are written to the audit log."
                tips={['Requests are rate-limited per IP and per email', 'A duplicate pending request from the same email is de-duplicated', 'Set LOOM_ACCESS_REQUEST_WEBHOOK to also get a Teams/Logic App ping on each new request']}
              />
            </SectionExplainer>
          </div>
          <AccessRequestsPanel />
        </>
      )}

      {tab === 'report' && (
        <>
          <HubTabHeader
            title="Access report"
            learn={{
              title: 'Who has access',
              content:
                'A unified view of every effective access grant across Loom — answer "what can this person reach?" and "who has access to this resource?" from one place. Merges the entitlement ledger, live workspace ACLs, and Entra group membership.',
              tips: [
                'Backed by the access-assignments entitlement ledger (PK /principalId)',
                'Per-resource view expands Entra groups to their members where Graph is available',
                'Run backfill once to seed the ledger from existing grants',
                'Tenant-admin only',
              ],
              learnMoreHref: 'https://learn.microsoft.com/entra/id-governance/entitlement-management-overview',
            }}
          />
          <div className={styles.explainer}>
            <SectionExplainer>
              Every effective access grant in Loom, in one report. Look up a <strong>principal</strong> to
              see everything they can reach, or a <strong>resource</strong> to see everyone who can reach
              it — direct grants, data-product subscriptions, and workspace roles, with Entra group members
              expanded where available.{' '}
              <LearnPopover
                title="Where the data comes from"
                content="The report merges the access-assignments entitlement ledger (written by every grant path going forward) with the live workspace-roles ACL container, de-duplicating the same effective grant. If the ledger is empty, run Backfill to seed it from your existing F15/F16 requests and workspace ACLs."
                tips={['CSV export respects the current filter', 'Group expansion is honest — it no-ops when Graph identity is not configured']}
              />
            </SectionExplainer>
          </div>
          <AccessReportPanel />
        </>
      )}

      {tab === 'packages' && (
        <>
          <HubTabHeader
            title="Access packages"
            learn={{
              title: 'Access packages & approval policies',
              content:
                'Bundle related grants into a single requestable access package, and define who approves requests. A package groups {resource, role} grants; an approval policy picks which of the four approval stages apply and who approves each. Separation-of-duties rules block incompatible package combinations.',
              tips: [
                'Requesting a package opens one approval per grant in the standard inbox',
                'The default approval policy = the full four-stage chain (unchanged)',
                'SoD conflicts can block or warn at request time',
                'Tenant-admin only',
              ],
              learnMoreHref: 'https://learn.microsoft.com/entra/id-governance/entitlement-management-access-package-create',
            }}
          />
          <div className={styles.explainer}>
            <SectionExplainer>
              Author <strong>access packages</strong> — reusable bundles of grants users can request in one
              click — and the <strong>approval policies</strong> that govern them. A package request opens the
              normal multi-tier approval per grant; the final approval provisions real Azure RBAC.{' '}
              <LearnPopover
                title="Packages, policies & SoD"
                content="An approval policy selects an ordered subset of the four canonical stages (manager, privacy reviewer, approver, access provider) and can name approvers per stage. The default policy enables all four — identical to the built-in chain. A separation-of-duties rule marks two packages incompatible: requesting one while holding the other blocks (or warns)."
                tips={['Everything is authored with pickers — no JSON', 'The final access-provider stage is always on so a grant can complete']}
              />
            </SectionExplainer>
          </div>
          <AccessPackagesPanel />
        </>
      )}

      {tab === 'reviews' && (
        <>
          <HubTabHeader
            title="Access reviews"
            learn={{
              title: 'Access reviews & recertification',
              content:
                'Schedule recertification campaigns that ask reviewers to attest or revoke each effective grant, with bulk decisions, reviewer delegation, and auto-revoke of anything left undecided when the campaign closes. The Azure-native 1:1 of Microsoft Entra ID Governance Access Reviews.',
              tips: [
                'Campaigns snapshot in-scope grants from the entitlement ledger (PK /principalId)',
                'Every revoke runs the real ARM / data-plane revoke, then marks the ledger row revoked',
                'Auto-revoke-on-close and the deadline sweep enforce "no response = removed"',
                'Entra group targets reconcile via read-only Graph (opt-in graph-group-sync gate)',
              ],
              learnMoreHref: 'https://learn.microsoft.com/entra/id-governance/access-reviews-overview',
            }}
          />
          <div className={styles.explainer}>
            <SectionExplainer>
              Run <strong>recertification campaigns</strong> — reviewers attest or revoke access on a
              cadence, in bulk, with delegation and auto-revoke on no-response. Reconcile{' '}
              <strong>Entra group-targeted</strong> packages and run a <strong>leaver revoke-all</strong>{' '}
              when someone departs.{' '}
              <LearnPopover
                title="Real backend, real revokes"
                content="A campaign snapshots the in-scope grants from the access-assignments entitlement ledger. Attest records a decision; Revoke tears down the real Azure grant (ARM role assignment + Synapse/ADX/storage data-plane) and marks the ledger row revoked — the same path the expiry sweeper uses. Closing a campaign auto-revokes anything still undecided when you opted in."
                tips={['The review sweep closes past-deadline campaigns automatically', 'Group sync is read-only on Entra — Loom never mutates tenant groups']}
              />
            </SectionExplainer>
          </div>
          <AccessReviewsPanel />
        </>
      )}
    </div>
  );
}
