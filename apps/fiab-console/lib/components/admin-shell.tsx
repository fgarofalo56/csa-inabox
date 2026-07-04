'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useState, useEffect } from 'react';
import { PageShell } from '@/lib/components/page-shell';
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
  Money24Regular,
  type FluentIcon,
} from '@fluentui/react-icons';

interface Section { href: string; label: string; description: string; icon: FluentIcon; }

const SECTIONS: Section[] = [
  { href: '/admin/health', label: 'Health & self-audit', icon: Heart24Regular, description: 'Self-review: identity, data plane, Azure services, permissions, and security posture — with one-click healer (admin-approved) for fixable issues.' },
  { href: '/admin/tenant-settings', label: 'Tenant settings', icon: Settings24Regular, description: 'Per-area switches (Power BI, Fabric, OneLake, Real-Time, AI, Mirroring, Git).' },
  { href: '/admin/capacity', label: 'Capacity & compute', icon: Server24Regular, description: 'Underlying Azure services Loom orchestrates: ACA, Databricks, Synapse, ADF, ADLA, AML, Cosmos, ACR.' },
  { href: '/admin/scaling', label: 'Scale by SKU', icon: GaugeRegular, description: 'Scale Fabric, Synapse, ADX, Databricks, AI Search, APIM, Cosmos, Container Apps, Foundry — real ARM PATCH from inside Loom.' },
  { href: '/admin/usage-chargeback', label: 'Usage & chargeback', icon: Money24Regular, description: 'Unified capacity + chargeback across every engine — real Azure Cost Management spend + Azure Monitor utilization, normalized to one Loom Capacity Unit (LCU) with a throttle/surge gauge. The Azure-native 1:1 of the Fabric Capacity Metrics app.' },
  { href: '/admin/env-config', label: 'Runtime configuration', icon: Wrench24Regular, description: 'View/set the console deployment env vars (Cosmos, AOAI, Synapse, ADX, …) from the UI — real ARM revision + audit trail, no Azure portal. Includes a bicep reconcile snippet so changes survive the next deployment.' },
  { href: '/admin/api-management', label: 'API Management', icon: Settings24Regular, description: 'Manage APIM APIs, products, subscriptions, policies, named values, backends — full marketplace administration.' },
  { href: '/admin/domains', label: 'Domains', icon: Organization24Regular, description: 'Organize workspaces into business domains and subdomains.' },
  { href: '/admin/attribute-groups', label: 'Custom attributes', icon: TagMultiple24Regular, description: 'Define per-domain attribute schemas (text, number, date, single-select) that appear in the Create wizard and item Edit dialogs.' },
  { href: '/admin/deploy-planner', label: 'Deployment planner', icon: CloudArrowUp24Regular, description: 'Visually plan what deploys to which subscription and domain; generate the bicepparam for az deployment.' },
  { href: '/admin/landing-zones', label: 'Landing zones', icon: Server24Regular, description: 'See, visualize and manage every Data Landing Zone attached to your hub — and attach new ones (dlz-attach). Inherits the hub boundary, region and coordinates; a second Console cannot be deployed from here.' },
  { href: '/admin/security', label: 'Security & governance', icon: ShieldCheckmark24Regular, description: 'Sensitivity labels, DLP policies, Purview hub link, workspace identity.' },
  { href: '/admin/permissions', label: 'Feature permissions', icon: Key24Regular, description: 'Fabric-style RBAC — grant Reader/Contributor/Admin on every editor type, admin page, and workload to Entra users and groups.' },
  { href: '/admin/batch-labeling', label: 'Batch labeling', icon: Tag24Regular, description: 'Bulk-apply sensitivity labels to many catalog items at once; optionally propagate to Microsoft Purview asset classifications and Power BI via Admin InformationProtection.setLabels.' },
  { href: '/admin/embed-codes', label: 'Embed codes', icon: Code24Regular, description: 'Generate and revoke read-only signed embed URLs (Blob user-delegation SAS) for reports and visuals — no Fabric / Power BI workspace required.' },
  { href: '/admin/org-visuals', label: 'Organizational visuals', icon: DataPie24Regular, description: 'Upload, version, enable/disable and remove tenant-wide custom visual bundles (.pbiviz), stored Azure-natively in Blob.' },
  { href: '/admin/audit-logs', label: 'Audit logs', icon: ClipboardTask24Regular, description: 'Microsoft 365 audit log activity for every Fabric operation.' },
  { href: '/admin/usage', label: 'Usage metrics', icon: ChartMultiple24Regular, description: 'Feature usage & adoption report, item inventory, item details.' },
  { href: '/admin/copilot-usage', label: 'Copilot usage', icon: Sparkle24Regular, description: 'Per-persona Copilot token consumption from App Insights — real prompt + completion tokens by persona, model, day, and user (hashed). No synthetic numbers.' },
  { href: '/admin/mcp-servers', label: 'MCP Servers', icon: PlugConnected24Regular, description: 'Browse + deploy the curated catalog of gov-safe MCP servers (Azure Container Apps + Key Vault secretRef + Azure Files), manage deployed servers with live status + teardown, and connect external MCP endpoints — the single home for Model Context Protocol tools Copilot can call.' },
  { href: '/admin/security?tab=dspm', label: 'DSPM for AI', icon: ShieldLock24Regular, description: 'AI data-security posture: which agents / Copilots touch sensitive-labeled data, the max sensitivity label exposed, its protection state, and real per-agent usage. The Azure-native 1:1 of Purview DSPM for AI.' },
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
});

const STORAGE_KEY = 'loom-admin-nav-collapsed';

export function AdminShell({ sectionTitle, children }: { sectionTitle?: string; children: ReactNode }) {
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
          {sectionTitle && <Title3 as="h2" style={{ marginBottom: tokens.spacingVerticalL }}>{sectionTitle}</Title3>}
          {children}
        </div>
      </div>
    </PageShell>
  );
}
