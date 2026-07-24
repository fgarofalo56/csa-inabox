/**
 * GOVERNANCE_SECTIONS — the SINGLE SOURCE OF TRUTH for every governance
 * destination, grouped to mirror the Microsoft Purview portal's left nav
 * (Catalog management / Data Map / Discovery & lineage / Policies &
 * protection / Health & quality / Purview portal). Consumed by:
 *   • lib/components/governance-shell.tsx — the sidebar rendered on every
 *     /governance/* page, so each Purview surface is 2 clicks from the rail.
 *   • app/governance/page.tsx — the overview card grid on /governance.
 *
 * Before this module existed the shell sidebar and the overview grid kept two
 * DIVERGING hand-maintained lists (the sidebar omitted protection-policies /
 * workspace-egress / access-requests / mdm; neither listed glossary — a true
 * orphan). One exported constant means neither surface can drift again — the
 * same pattern lib/nav/nav-items.ts uses for the rail + palette + Copilot.
 *
 * Pure data (no React / icon imports) so server-side modules can import it
 * without pulling client-only modules into the server bundle. Presentation
 * (icons, accent colors) is mapped per-href by each consumer, mirroring
 * left-nav.tsx's ICON_BY_HREF pattern.
 */

export interface GovernanceSectionItem {
  href: string;
  label: string;
  /** One-line "what it does" shown in the sidebar and on overview cards. */
  desc: string;
  /** Tenant-admin-only destination (lives in the Admin portal) — hidden for
   * non-admins (rel-T53) so they are never dumped into a per-page 403. */
  adminOnly?: boolean;
}

/** A labeled Purview-style group of governance destinations. */
export interface GovernanceSectionGroup {
  label: string;
  items: GovernanceSectionItem[];
}

export const GOVERNANCE_SECTIONS: GovernanceSectionGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/governance', label: 'Overview', desc: 'Governance posture, coverage scores, recent activity.' },
      { href: '/governance/govern', label: 'Govern', desc: 'My-items posture for data owners — label coverage, curation, recommended actions.' },
    ],
  },
  {
    label: 'Catalog management',
    items: [
      { href: '/governance/catalog', label: 'Governed data catalog', desc: 'Governed data-asset inventory with endorsement, sensitivity, and access requests across OneLake, Synapse, Databricks, ADLS, on-prem.' },
      { href: '/admin/domains', label: 'Governance domains', desc: 'Business domains and subdomains, workspace assignment, delegated settings (Admin portal).', adminOnly: true },
      { href: '/governance/glossary', label: 'Business glossary', desc: 'Standardized business terms on the Purview Atlas glossary — create terms and attach them to data assets.' },
    ],
  },
  {
    label: 'Data Map',
    items: [
      { href: '/governance/scans', label: 'Scans & sources', desc: 'Register data sources, schedule scans, monitor scan history.' },
      { href: '/admin/classifications', label: 'Classifications', desc: 'Sensitive-info types, custom regex classifiers, scan rule sets (Admin portal).', adminOnly: true },
      { href: '/admin/sensitivity-labels', label: 'Sensitivity labels', desc: 'Define and auto-apply labels; enforce encryption and access policies (Admin portal).', adminOnly: true },
    ],
  },
  {
    label: 'Discovery & lineage',
    items: [
      { href: '/catalog', label: 'Search (federated)', desc: 'Federated search across Purview, Unity Catalog, and OneLake.' },
      { href: '/governance/lineage', label: 'Lineage', desc: 'End-to-end lineage across items, pipelines, notebooks, dataflows, and models — Governed / Mesh / Federated scopes.' },
    ],
  },
  {
    label: 'Policies & protection',
    items: [
      { href: '/governance/policies', label: 'Access policies', desc: 'DLP, masking, RLS/CLS, Purview access policies.' },
      { href: '/governance/protection-policies', label: 'Protection policies', desc: 'Label-driven restrict-only allow-lists reconciled into real Azure RBAC (sovereign, no Fabric).' },
      { href: '/governance/workspace-egress', label: 'Outbound access', desc: 'Per-workspace egress allow-lists enforced as real Azure NSG outbound rules (sovereign, no Fabric).' },
      { href: '/governance/access-requests', label: 'Access requests', desc: 'Multi-tier approval inbox — the final approval provisions a real Azure RBAC grant.' },
    ],
  },
  {
    label: 'Health & quality',
    items: [
      { href: '/governance/data-quality', label: 'Data quality', desc: 'Author rules, run on Kusto/Databricks/Synapse, results + Delta/Lakehouse monitors.' },
      { href: '/governance/data-contracts', label: 'Data contracts', desc: 'ODCS 3.1 contracts ENFORCED at ingestion — bindings, quarantine-to-dead-letter posture, and the pass/fail trend.' },
      { href: '/governance/mdm', label: 'Master data', desc: 'Golden-record match/merge + reference-data management on Azure-native compute.' },
      { href: '/governance/irm', label: 'Insider risk', desc: 'IRM indicators — unusual volume, off-hours access, privileged access over audit logs + Monitor.' },
      { href: '/governance/insights', label: 'Insights & reports', desc: 'Compliance reports, ownership coverage, endorsement trends.' },
    ],
  },
  {
    label: 'Purview portal',
    items: [
      { href: '/governance/purview', label: 'Microsoft Purview', desc: 'Connection status + the embedded Purview portal.' },
    ],
  },
];

/** Flat list of every governance destination (all groups). */
export const GOVERNANCE_ITEMS: GovernanceSectionItem[] =
  GOVERNANCE_SECTIONS.flatMap((g) => g.items);
