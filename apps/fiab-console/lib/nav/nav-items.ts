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
 * Fabric-style verb sections (Create / Home / Data / Build / Operate / Analyze /
 * Admin) keep the rail to a handful of scannable groups instead of a flat list.
 * Labels are plain-language (rel-T52): the last internal codename, "Warp", is
 * surfaced as "Orchestration (Warp)" — the plain verb primary with the product
 * codename kept parenthetically.
 *
 * IA reorg 2026-07-24 (nav audit): the single-link "Govern" group was noise, so
 * /governance folded into Data (IA-13); Scheduler moved out of Analyze into the
 * job-oriented "Operate" group (IA-09); the overloaded 8-item "Build" group was
 * split, with the platform-meta rows (Deployment / Workload hub) re-homed under
 * "Operate" (IA-10); /data-products joined Data beside Marketplace (IA-02);
 * "OneLake catalog" → "Lakehouse catalog" (Azure-native framing, IA-11); and the
 * federated-search rail label "Catalog (federated search)" → "Search" (IA-05).
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
      // IA-11: Azure-native framing — the lakehouse catalog is ADLS Gen2 + Delta
      // by default (no-fabric-dependency), so it no longer reads "OneLake".
      { href: '/onelake', label: 'Lakehouse catalog' },
      // IA-05: the /catalog rail label is now "Search" — the UNIFIED/federated
      // search surface (Search/Browse/Unity/Metastores/Permissions/Lineage),
      // disambiguated from /admin/catalog ("External-engine federation
      // (Iceberg)") and /governance/catalog ("Governed data catalog"). Re-homed
      // onto the rail in the 2026-07-22 reorg; it resolves its sub-tabs in 2
      // clicks instead of 3.
      { href: '/catalog', label: 'Search' },
      { href: '/marketplace', label: 'Marketplace' },
      // IA-02: /data-products was a true orphan (reachable only by URL). It
      // belongs beside Marketplace so it enters the flat NAV_ITEMS the command
      // palette + Copilot navigate allow-list consume.
      { href: '/data-products', label: 'Data products' },
      { href: '/connections', label: 'Connections' },
      // IA-13: the former single-link "Govern" group was collapsed into Data —
      // a one-item labeled group is nav noise. /governance is unchanged (same
      // href, same page), it just lives under the Data header now.
      { href: '/governance', label: 'Governance' },
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
      { href: '/developer', label: 'Developer' },
    ],
  },
  {
    // IA-09 + IA-10: job/lifecycle operations. Scheduler (schedules jobs) moved
    // here out of Analyze; Deployment + Workload hub (platform-meta) split out
    // of the overloaded Build group.
    label: 'Operate',
    items: [
      { href: '/deployment-pipelines', label: 'Deployment' },
      { href: '/workload-hub', label: 'Workload hub' },
      { href: '/scheduler', label: 'Scheduler' },
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
      { href: '/copilot', label: 'Copilot' },
    ],
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
  // IA-08: the Copilot Skills Studio was link-only (reachable from inside
  // /copilot but not from the palette / Copilot navigate allow-list). Demoting
  // it here makes it Ctrl+K- and Copilot-reachable without adding a thin rail row.
  { href: '/copilot/skills', label: 'Skills Studio' },
  // N7b — the Debezium CDC connector control plane (source-connector wizard +
  // live snapshot/streaming/dead-letter monitor over the Azure-native mirror
  // engine). Off-rail (single-purpose), reachable via palette + Copilot + URL.
  { href: '/cdc', label: 'CDC connectors' },
  // NB: /admin/autopilot is intentionally NOT here (IA-12). An /admin/* page
  // belongs to the Admin portal sidebar (admin-shell.tsx SECTIONS), not the
  // demoted top-level rail set — it stays fully reachable there.
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
