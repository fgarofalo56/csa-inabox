/**
 * NAV_ITEMS — the SINGLE SOURCE OF TRUTH for CSA Loom's primary left-nav
 * destinations. Consumed by:
 *   • lib/components/left-nav.tsx            — renders the visual rail (attaches
 *     an icon per href from a local presentation map).
 *   • lib/azure/help-copilot-orchestrator.ts — derives the Copilot `navigate`
 *     tool allow-list, so the assistant can route to EVERY real destination and
 *     a hand-maintained array can never drift out of sync with the rail.
 *
 * Pure data (no React / icon imports) so the server-side orchestrator can import
 * it without pulling client-only modules into the server bundle.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Tenant-admin-only destination — hidden from the rail for non-admins
   * (rel-T53/T54). The Copilot navigate allow-list still includes it; the
   * page enforces its own server-side gate. */
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/workspaces', label: 'Workspaces' },
  { href: '/browse', label: 'Browse' },
  { href: '/onelake', label: 'OneLake catalog' },
  { href: '/org-reports', label: 'Organization reports' },
  { href: '/semantic-model', label: 'Semantic models' },
  { href: '/thread', label: 'Lineage' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/governance', label: 'Governance' },
  { href: '/monitor', label: 'Monitor' },
  { href: '/realtime-hub', label: 'Real-Time Intelligence' },
  { href: '/data-agent', label: 'Data agents' },
  { href: '/experience/data-science/home', label: 'Data Science' },
  { href: '/experience/warp/home', label: 'Warp' },
  { href: '/copilot', label: 'Copilot' },
  { href: '/workload-hub', label: 'Workload hub' },
  { href: '/connections', label: 'Connections' },
  { href: '/deployment-pipelines', label: 'Deployment' },
  { href: '/admin', label: 'Admin portal', adminOnly: true },
  { href: '/setup', label: 'Setup & landing zones', adminOnly: true },
];
