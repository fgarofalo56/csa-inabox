'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useState, useEffect } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { LearnPopover, type LearnPopoverProps } from '@/lib/components/ui/learn-popover';
import {
  makeStyles, mergeClasses, tokens, Title3, Tooltip, Button,
} from '@fluentui/react-components';
import {
  Settings24Regular, Server24Regular, GaugeRegular, Organization24Regular,
  CloudArrowUp24Regular, ShieldCheckmark24Regular, Key24Regular,
  ClipboardTask24Regular, ChartMultiple24Regular, People24Regular,
  Building24Regular, ArrowSync24Regular, PanelLeftContract24Regular,
  PanelLeftExpand24Regular, Globe24Regular, Heart24Regular,
  Tag24Regular, TagMultiple24Regular, Sparkle24Regular, Code24Regular, DataPie24Regular,
  Wrench24Regular, ShieldLock24Regular, PlugConnected24Regular,
  Money24Regular, Send24Regular, PersonAdd24Regular, Bot24Regular,
  Molecule24Regular,
  type FluentIcon,
} from '@fluentui/react-icons';

interface Section { href: string; label: string; description: string; icon: FluentIcon; }

const SECTIONS: Section[] = [
  { href: '/admin/health', label: 'Health & self-audit', icon: Heart24Regular, description: 'Self-review: identity, data plane, Azure services, permissions, and security posture — with one-click healer (admin-approved) for fixable issues.' },
  { href: '/admin/tenant-settings', label: 'Tenant settings', icon: Settings24Regular, description: 'Per-area switches (Power BI, Fabric, OneLake, Real-Time, AI, Mirroring, Git).' },
  { href: '/admin/capacity', label: 'Capacity & compute', icon: Server24Regular, description: 'Underlying Azure services Loom orchestrates: ACA, Databricks, Synapse, ADF, ADLA, AML, Cosmos, ACR.' },
  { href: '/admin/scaling', label: 'Scale by SKU', icon: GaugeRegular, description: 'Scale Fabric, Synapse, ADX, Databricks, AI Search, APIM, Cosmos, Container Apps, Foundry — real ARM PATCH from inside Loom.' },
  { href: '/admin/performance', label: 'Performance & benchmarks', icon: GaugeRegular, description: 'Repeatable perf suite (PSR-1): p50/p95/p99 + cold-vs-warm for Spark attach, warehouse/ADX query, dashboard tile TTI, Copilot turn, and page TTI — trended against the published Microsoft Fabric bars. Real Azure-native backends, run on demand.' },
  { href: '/admin/usage-chargeback', label: 'Usage & chargeback', icon: Money24Regular, description: 'Unified capacity + chargeback across every engine — real Azure Cost Management spend + Azure Monitor utilization, normalized to one Loom Capacity Unit (LCU) with a throttle/surge gauge. The Azure-native 1:1 of the Fabric Capacity Metrics app.' },
  { href: '/admin/chargeback', label: 'Chargeback report', icon: Money24Regular, description: 'Attribute real Azure Cost Management spend to governance domains via the loom-domain tag — a real per-domain report with stacked bar chart, CSV export, and per-user drill-down. The Azure-native 1:1 of the Fabric Chargeback app.' },
  { href: '/admin/env-config', label: 'Runtime configuration', icon: Wrench24Regular, description: 'View/set the console deployment env vars (Cosmos, AOAI, Synapse, ADX, …) from the UI — real ARM revision + audit trail, no Azure portal. Includes a bicep reconcile snippet so changes survive the next deployment.' },
  { href: '/admin/gates', label: 'Gate registry', icon: Wrench24Regular, description: 'The complete registry of every configuration gate — live configured/blocked status, required env vars/roles/resources per gate, owning surfaces, and a one-click Fix-it wizard that discovers real Azure resources and applies through the audited env-config write path.' },
  { href: '/admin/readiness', label: 'Readiness', icon: GaugeRegular, description: 'Capability dependency graph + workload readiness scorecard (Ready / Partial / Blocked go/no-go) computed from live gate + probe state — each capability’s backends, env vars, RBAC role, bicep module, and probe status, with a one-click Fix it and a ready-to-run tenant profile export (JSON + report).' },
  { href: '/admin/api-management', label: 'API Management', icon: Settings24Regular, description: 'Manage APIM APIs, products, subscriptions, policies, named values, backends — full marketplace administration.' },
  { href: '/admin/domains', label: 'Domains', icon: Organization24Regular, description: 'Organize workspaces into business domains and subdomains.' },
  { href: '/admin/attribute-groups', label: 'Custom attributes', icon: TagMultiple24Regular, description: 'Define per-domain attribute schemas (text, number, date, single-select) that appear in the Create wizard and item Edit dialogs.' },
  { href: '/admin/deploy-planner', label: 'Deployment planner', icon: CloudArrowUp24Regular, description: 'Visually plan what deploys to which subscription and domain; generate the bicepparam for az deployment.' },
  { href: '/admin/landing-zones', label: 'Landing zones', icon: Server24Regular, description: 'See, visualize and manage every Data Landing Zone attached to your hub — and attach new ones (dlz-attach). Inherits the hub boundary, region and coordinates; a second Console cannot be deployed from here.' },
  { href: '/admin/security', label: 'Security & governance', icon: ShieldCheckmark24Regular, description: 'Sensitivity labels, DLP policies, Purview hub link, workspace identity.' },
  { href: '/admin/policy-code', label: 'Policy as code', icon: ShieldCheckmark24Regular, description: 'Governance-as-code — author one policy set (principals × resources × actions × conditions) and compile it in a single pass to Synapse SQL DENY/RLS, Unity Catalog grants + row filters (Databricks or OSS-UC), ADX row-level security, Purview markings, and API scopes. Reconcile loop reads live state, applies the delta, and self-heals drift. Runs from the CLI via `loom policy apply`.' },
  { href: '/admin/permissions', label: 'Feature permissions', icon: Key24Regular, description: 'Fabric-style RBAC — grant Reader/Contributor/Admin on every editor type, admin page, and workload to Entra users and groups.' },
  { href: '/admin/batch-labeling', label: 'Batch labeling', icon: Tag24Regular, description: 'Bulk-apply sensitivity labels to many catalog items at once; optionally propagate to Microsoft Purview asset classifications and Power BI via Admin InformationProtection.setLabels.' },
  { href: '/admin/embed-codes', label: 'Embed codes', icon: Code24Regular, description: 'Generate and revoke read-only signed embed URLs (Blob user-delegation SAS) for reports and visuals — no Fabric / Power BI workspace required.' },
  { href: '/admin/org-visuals', label: 'Organizational visuals', icon: DataPie24Regular, description: 'Upload, version, enable/disable and remove tenant-wide custom visual bundles (.pbiviz), stored Azure-natively in Blob.' },
  { href: '/admin/audit-logs', label: 'Audit logs', icon: ClipboardTask24Regular, description: 'Microsoft 365 audit log activity for every Fabric operation.' },
  { href: '/admin/usage', label: 'Usage metrics', icon: ChartMultiple24Regular, description: 'Feature usage & adoption report, item inventory, item details.' },
  { href: '/admin/copilot-usage', label: 'Copilot usage', icon: Sparkle24Regular, description: 'Per-persona Copilot token consumption from App Insights — real prompt + completion tokens by persona, model, day, and user (hashed). No synthetic numbers.' },
  { href: '/admin/agent-quality', label: 'Agent Quality', icon: Bot24Regular, description: 'Unified agent evals + observability: LLM-judge eval sets with regression-vs-baseline, red-team refusal results, per-agent trace timelines (token/cost/latency + model tier), and the live Copilot turn-latency SLO — one page, all real backends.' },
  { href: '/admin/model-fabric', label: 'Model Fabric', icon: Molecule24Regular, description: 'Closed-loop model optimization: fuses live eval + red-team + serving + latency-SLO signals to automatically promote the winning model/prompt and demote regressions across serving traffic-splits and the reasoning tier. Propose-only or Auto-apply; every promote/demote audited. Real Azure ML / Azure OpenAI backends — no Fabric dependency.' },
  { href: '/admin/mcp-servers', label: 'MCP Servers', icon: PlugConnected24Regular, description: 'Browse + deploy the curated catalog of gov-safe MCP servers (Azure Container Apps + Key Vault secretRef + Azure Files), manage deployed servers with live status + teardown, and connect external MCP endpoints — the single home for Model Context Protocol tools Copilot can call.' },
  { href: '/admin/webhooks', label: 'Event subscriptions', icon: Send24Regular, description: 'Register outbound webhook endpoints that receive Loom events (item lifecycle, workspace, pipeline runs, marketplace subscribe / SLA breach, admin changes). HMAC-SHA256 signed direct HTTPS delivery by default, or Azure Event Grid when configured; per-hook delivery history + test-fire.' },
  { href: '/admin/developer/tokens', label: 'API tokens', icon: Key24Regular, description: 'Tenant-wide inventory of scoped API tokens (PAT) for non-interactive access — who created each token, its scope, last-used and expiry. Revoke any token immediately. Users create + manage their own under Settings → Developer.' },
  { href: '/admin/security?tab=dspm', label: 'DSPM for AI', icon: ShieldLock24Regular, description: 'AI data-security posture: which agents / Copilots touch sensitive-labeled data, the max sensitivity label exposed, its protection state, and real per-agent usage. The Azure-native 1:1 of Purview DSPM for AI.' },
  { href: '/admin/access-requests', label: 'Access requests', icon: PersonAdd24Regular, description: 'Onboarding queue for people who don’t yet have access. Approve a sign-in-boundary “Request access” submission to see the exact Entra step to set them up, or deny it with a recorded reason.' },
  { href: '/admin/access-report', label: 'Access report', icon: ShieldLock24Regular, description: 'Unified who-has-access report — everything a principal can reach, and everyone who can reach a resource. Merges the entitlement ledger, live workspace ACLs, and Entra group members, with CSV export.' },
  { href: '/admin/access-packages', label: 'Access packages', icon: ShieldLock24Regular, description: 'Author entitlement bundles (access packages) users request in one click, and the approval policies + separation-of-duties rules that govern them.' },
  { href: '/admin/access-reviews', label: 'Access reviews', icon: ShieldLock24Regular, description: 'Recertification campaigns — reviewers attest or revoke effective grants on a cadence, with bulk decisions, delegation, and auto-revoke on no-response. Reconcile Entra group targets and run leaver revoke-all. The Azure-native 1:1 of Entra ID Governance Access Reviews.' },
  { href: '/admin/users', label: 'Users & licenses', icon: People24Regular, description: 'Power BI / Fabric license assignments and user inventory.' },
  { href: '/admin/workspaces', label: 'Workspaces', icon: Building24Regular, description: 'Tenant-wide inventory: every workspace, owner, capacity, state.' },
  { href: '/admin/network', label: 'Network & DNS', icon: Globe24Regular, description: 'Private endpoints, copy/paste hosts-file override, and enterprise DNS guidance for reaching the private-by-default Azure services.' },
  { href: '/admin/updates', label: 'Updates & version sync', icon: ArrowSync24Regular, description: 'See your running version vs latest upstream; pull bug fixes and new features.' },
];

const useStyles = makeStyles({
  // maxWidth:100% + minWidth:0 on the content track stop wide tables from
  // stretching the whole page past the viewport (the 1fr track defaults to
  // min-width:auto, which is what caused the horizontal-scroll-the-page bug).
  layout: {
    display: 'grid',
    gridTemplateColumns: '248px minmax(0, 1fr)',
    gap: '20px',
    minHeight: '480px',
    maxWidth: '100%',
  },
  layoutCollapsed: { gridTemplateColumns: '52px minmax(0, 1fr)' },
  sidebar: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: '12px',
    minWidth: 0,
  },
  sidebarHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', minHeight: '32px' },
  sidebarHeadCollapsed: { justifyContent: 'center' },
  item: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '8px 10px', borderRadius: '6px',
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  itemCollapsed: { justifyContent: 'center', padding: '8px' },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: '600',
  },
  itemIcon: { flexShrink: 0, display: 'flex', fontSize: '20px', color: tokens.colorNeutralForeground2 },
  itemIconActive: { color: tokens.colorBrandForeground1 },
  itemLabel: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // The content region clips/scrolls its OWN overflow so a wide table gets a
  // local horizontal scrollbar instead of widening the page.
  body: { minWidth: 0, maxWidth: '100%', overflowX: 'auto' },
  // Section-title row: the H2 + an optional contextual-help LearnPopover.
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    marginBottom: tokens.spacingVerticalL,
  },
});

const STORAGE_KEY = 'loom-admin-nav-collapsed';

export function AdminShell({ sectionTitle, learn, children }: { sectionTitle?: string; learn?: LearnPopoverProps; children: ReactNode }) {
  const styles = useStyles();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Restore the user's collapsed preference.
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(STORAGE_KEY) === '1'); } catch { /* ignore */ }
  }, []);
  const toggle = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  return (
    <PageShell
      title="Admin portal"
      subtitle="Tenant-wide settings, capacity, governance, audit, and usage for everyone in your organization."
    >
      <div className={mergeClasses(styles.layout, collapsed && styles.layoutCollapsed)}>
        <nav className={styles.sidebar} aria-label="Admin sections">
          <div className={mergeClasses(styles.sidebarHead, collapsed && styles.sidebarHeadCollapsed)}>
            <Tooltip content={collapsed ? 'Expand navigation' : 'Collapse navigation'} relationship="label">
              <Button
                appearance="subtle"
                size="small"
                icon={collapsed ? <PanelLeftExpand24Regular /> : <PanelLeftContract24Regular />}
                onClick={toggle}
                aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              />
            </Tooltip>
          </div>
          {SECTIONS.map((s) => {
            const active = pathname === s.href;
            const Icon = s.icon;
            const link = (
              <Link
                key={s.href}
                href={s.href}
                className={mergeClasses(styles.item, collapsed && styles.itemCollapsed, active && styles.itemActive)}
                aria-label={s.label}
                aria-current={active ? 'page' : undefined}
              >
                <span className={mergeClasses(styles.itemIcon, active && styles.itemIconActive)}><Icon /></span>
                {!collapsed && <span className={styles.itemLabel}>{s.label}</span>}
              </Link>
            );
            // Tooltip carries the label + description (always when collapsed; as
            // a helpful hover when expanded).
            return (
              <Tooltip
                key={s.href}
                content={collapsed ? `${s.label} — ${s.description}` : s.description}
                relationship="label"
                positioning="after"
              >
                {link}
              </Tooltip>
            );
          })}
        </nav>
        <div className={styles.body}>
          {sectionTitle && (
            <div className={styles.sectionHead}>
              <Title3 as="h2">{sectionTitle}</Title3>
              {learn && <LearnPopover {...learn} />}
            </div>
          )}
          {children}
        </div>
      </div>
    </PageShell>
  );
}
