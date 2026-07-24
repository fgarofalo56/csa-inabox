/**
 * NAV_ITEMS / NAV_SECTIONS — the SINGLE SOURCE OF TRUTH for CSA Loom's primary
 * left-nav destinations. Consumed by:
 *   • lib/components/left-nav.tsx            — renders the visual rail, grouped
 *     into labeled sections (NAV_SECTIONS); attaches an icon per href from a
 *     local presentation map.
 *   • lib/components/command-palette.tsx     — Ctrl+K search over EVERY navigable
 *     destination (the flat NAV_ITEMS, which includes demoted pages).
 *   • lib/azure/help-copilot-orchestrator.ts — derives the Copilot `navigate`
 *     tool allow-list from the flat NAV_ITEMS, so the assistant can route to
 *     EVERY real destination (rail + demoted) and a hand-maintained array can
 *     never drift out of sync with the rail.
 *
 * Pure data (no React / icon imports) so the server-side orchestrator can import
 * it without pulling client-only modules into the server bundle.
 *
 * IA (rel-T45/T52): the rail is grouped into labeled sections (Fabric-style)
 * rather than a flat list of 21 entries, and single-item / thin pages are
 * DEMOTED off the visual rail (still fully reachable via the command palette,
 * Browse, the workload hub, and the Copilot navigate allow-list — see
 * DEMOTED_NAV_ITEMS). The flat NAV_ITEMS derived at the bottom stays the
 * complete set of destinations so the palette + Copilot allow-list can't drift.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Tenant-admin-only destination — hidden from the rail for non-admins
   * (rel-T53/T54). The Copilot navigate allow-list still includes it; the
   * page enforces its own server-side gate. */
  adminOnly?: boolean;
}

/** A labeled group of rail destinations. `label` is omitted for the top
 * ungrouped action row (the "+ Create" button), which has no header. */
export interface NavSection {
  label?: string;
  items: NavItem[];
}

/**
 * NAV_SECTIONS — the GROUPED structure that drives the visual left-nav rail.
 * Fabric-style verb sections (Create / Home / Data / Build / Analyze / Govern /
 * Admin) keep the rail to a handful of scannable groups instead of 21 flat rows.
 * Labels are plain-language (rel-T52): the last internal codename, "Warp", is
 * surfaced as "Orchestration (Warp)" — the plain verb primary with the product
 * codename kept parenthetically.
 */
export const NAV_SECTIONS: NavSection[] = [
  // Ungrouped top action — opens the New Item dialog inline (no header).
  { items: [{ href: '/new', label: 'Create' }] },
  {
    label: 'Home',
    items: [
      { href: '/', label: 'Home' },
      { href: '/workspaces', label: 'Workspaces' },
      { href: '/browse', label: 'Browse' },
    ],
  },
  {
    label: 'Data',
    items: [
      { href: '/onelake', label: 'OneLake catalog' },
      // Re-homed onto the rail (nav-IA reorg 2026-07-22): /catalog is the
      // federated search surface (Search/Browse/Unity/Metastores/Permissions/
      // Lineage) — distinct from /governance/catalog (governed inventory). It
      // had been dropped from the rail without a demoted entry, stranding its
      // sub-tabs at 3 clicks; on the rail they resolve in 2.
      { href: '/catalog', label: 'Catalog (federated search)' },
      { href: '/marketplace', label: 'Marketplace' },
      { href: '/connections', label: 'Connections' },
    ],
  },
  {
    label: 'Build',
    items: [
      { href: '/realtime-hub', label: 'Real-Time Intelligence' },
      { href: '/experience/data-science/home', label: 'Data Science' },
      { href: '/experience/warp/home', label: 'Orchestration (Warp)' },
      { href: '/estate', label: 'Estate builder' },
      { href: '/mesh', label: 'Agent Mesh' },
      { href: '/deployment-pipelines', label: 'Deployment' },
      { href: '/workload-hub', label: 'Workload hub' },
      { href: '/developer', label: 'Developer' },
    ],
  },
  {
    label: 'Analyze',
    items: [
      { href: '/thread', label: 'Lineage' },
      // N5 — the estate as a graph of SOFTWARE-DEFINED ASSETS (freshness
      // policies + data-aware materialization), derived from the same lineage
      // /thread draws. It sits beside Lineage because that is the mental model:
      // lineage is what connects to what; Assets is what is fresh and what runs.
      { href: '/assets', label: 'Assets' },
      { href: '/monitor', label: 'Monitor' },
      { href: '/org-reports', label: 'Reports' },
      { href: '/scheduler', label: 'Scheduler' },
      { href: '/copilot', label: 'Copilot' },
    ],
  },
  {
    label: 'Govern',
    items: [{ href: '/governance', label: 'Governance' }],
  },
  {
    label: 'Admin',
    items: [
      { href: '/admin', label: 'Admin portal', adminOnly: true },
      { href: '/setup', label: 'Setup & landing zones', adminOnly: true },
    ],
  },
];

/**
 * DEMOTED_NAV_ITEMS — single-item-type / thin pages promoted OFF the primary
 * rail (rel-T45). They are NOT rendered in the visual rail, but remain fully
 * reachable: searchable in the command palette (Ctrl+K), surfaced via Browse +
 * the workload hub, and included in the Copilot navigate allow-list. They are
 * merged into the flat NAV_ITEMS below so palette + Copilot never lose an href.
 */
export const DEMOTED_NAV_ITEMS: NavItem[] = [
  { href: '/semantic-model', label: 'Semantic models' },
  { href: '/data-agent', label: 'Data agents' },
  // The persona-experience landing hub (UX-1012). The rail links straight to
  // the /experience/*/home children, so the hub itself lives off-rail — but it
  // stays reachable via the palette + Copilot allow-list (it was a true orphan
  // before the nav-IA reorg 2026-07-22).
  { href: '/experience', label: 'Experiences' },
  { href: '/admin/autopilot', label: 'Autopilot (self-driving FinOps)', adminOnly: true },
];

/**
 * NAV_ITEMS — the FLAT, COMPLETE set of every navigable destination (grouped
 * rail items + demoted pages). This is what the command palette and the Copilot
 * navigate allow-list consume, so neither can drift and EVERY real href stays
 * reachable even after it's demoted from the visual rail.
 */
export const NAV_ITEMS: NavItem[] = [
  ...NAV_SECTIONS.flatMap((section) => section.items),
  ...DEMOTED_NAV_ITEMS,
];
