/**
 * ADMIN_SECTIONS — the SINGLE SOURCE OF TRUTH for every Admin-portal
 * destination, grouped into the labeled clusters the admin sidebar renders.
 * Consumed by:
 *   • lib/components/admin-shell.tsx — the grouped sidebar rendered on every
 *     /admin/* page (icons are mapped per-href there, mirroring left-nav.tsx's
 *     ICON_BY_HREF presentation map).
 *   • lib/panes/admin-overview.tsx  — the /admin landing tile grid, which is a
 *     CURATED SUBSET of these destinations (the live-count-bearing ones).
 *   • lib/nav/__tests__/admin-sections.test.ts — the guard test that stops a
 *     refactor from orphaning a surface or breaking a legacy deep link.
 *
 * Pure data (no React / icon imports) so server-side modules and node-env
 * vitest can import it without pulling client-only modules into the bundle —
 * the same pattern lib/nav/nav-items.ts and lib/nav/governance-sections.ts use.
 *
 * IA-03 / IA-04 / IA-06 (loom-apex Phase B) folded eleven thin admin pages into
 * three tabbed hubs (FinOps, AI operations, Access governance). The folded
 * routes still exist as redirect stubs — see ADMIN_LEGACY_REDIRECTS — so every
 * bookmark, gate-registry surface path, and Fix-it link keeps working.
 */

export interface AdminDestination {
  href: string;
  label: string;
  /** One-line "what it does" shown in the sidebar tooltip. */
  desc: string;
}

/** A labeled cluster of admin destinations (IA-01 nav audit 2026-07-24). */
export interface AdminSectionGroup {
  label: string;
  items: AdminDestination[];
}

export const ADMIN_SECTIONS: AdminSectionGroup[] = [
  {
    label: 'Reliability & performance',
    items: [
      { href: '/admin/health', label: 'Health & Reliability', desc: 'The one reliability hub: self-audit (identity, data plane, Azure services, permissions, security posture) with a one-click healer, backend exercise probes, and the synthetic user-journey monitor (Journeys tab — six real journeys incl. a TRUE MSAL login probe, every 15 min).' },
      { href: '/admin/performance', label: 'Performance & benchmarks', desc: 'Repeatable perf suite (PSR-1): p50/p95/p99 + cold-vs-warm for Spark attach, warehouse/ADX query, dashboard tile TTI, Copilot turn, and page TTI — trended against the published Microsoft Fabric bars. Real Azure-native backends, run on demand.' },
      { href: '/admin/rum', label: 'Real-user monitoring', desc: 'What real browsers experience: page-load p50/p95 by surface, Web Vitals (LCP/FCP/TTFB/CLS/INP), and top client errors — first-party capture (no CDN), PII-scrubbed, shipped to App Insights and charted from Log Analytics. Kill-switch: the rum1-client-telemetry runtime flag.' },
      { href: '/admin/readiness', label: 'Readiness', desc: 'Capability dependency graph + workload readiness scorecard (Ready / Partial / Blocked go/no-go) computed from live gate + probe state — each capability’s backends, env vars, RBAC role, bicep module, and probe status, with a one-click Fix it and a ready-to-run tenant profile export (JSON + report).' },
      { href: '/admin/diagnostics', label: 'Diagnostics', desc: 'One-click support bundle: export a point-in-time, secret-scrubbed JSON of the deployment posture — version + ACA revision, gate-registry state, masked env posture, live probes, last synthetic run, and recent audit rows — to attach to an incident.' },
      { href: '/admin/incident-console', label: 'Incident console', desc: 'N17 — OpenLineage-backed data observability: per-table freshness / volume / schema-drift monitors (Monte-Carlo style, baselines reuse the anomaly detector — no external ML), an incident timeline (open→acknowledged→resolved, every state change audited), and a downstream-impact panel rendered from the unified lineage graph. Consumes N7d data-quality findings; incident alerts route through the one shared action group. Fully in-boundary (IL5-safe).' },
    ],
  },
  {
    label: 'Capacity & cost',
    items: [
      { href: '/admin/capacity', label: 'Capacity & compute', desc: 'Underlying Azure services Loom orchestrates: ACA, Databricks, Synapse, ADF, ADLA, AML, Cosmos, ACR.' },
      { href: '/admin/scaling', label: 'Scale by SKU', desc: 'Scale Fabric, Synapse, ADX, Databricks, AI Search, APIM, Cosmos, Container Apps, Foundry — real ARM PATCH from inside Loom.' },
      // IA-03: /admin/usage-chargeback + /admin/chargeback are now the Capacity
      // and Chargeback report TABS of this hub (both routes redirect here).
      { href: '/admin/finops', label: 'FinOps & chargeback', desc: 'The one cost hub: the FinOps cockpit (real Cost Management forecast, live cost-anomaly feed + rules editor, per-scope breakdown, real Azure Budgets CRUD), the unified capacity + chargeback dashboard normalized to one Loom Capacity Unit (Capacity & LCU tab — the Azure-native 1:1 of the Fabric Capacity Metrics app), and the per-domain chargeback report with CSV export (Chargeback report tab — the 1:1 of the Fabric Chargeback app).' },
    ],
  },
  {
    label: 'Configuration & gates',
    items: [
      { href: '/admin/tenant-settings', label: 'Tenant settings', desc: 'Per-area switches (Power BI, Fabric, OneLake, Real-Time, AI, Mirroring, Git).' },
      { href: '/admin/env-config', label: 'Runtime configuration', desc: 'View/set the console deployment env vars (Cosmos, AOAI, Synapse, ADX, …) from the UI — real ARM revision + audit trail, no Azure portal. Includes a bicep reconcile snippet so changes survive the next deployment.' },
      { href: '/admin/gates', label: 'Gate registry', desc: 'The complete registry of every configuration gate — live configured/blocked status, required env vars/roles/resources per gate, owning surfaces, and a one-click Fix-it wizard that discovers real Azure resources and applies through the audited env-config write path.' },
      { href: '/admin/runtime-flags', label: 'Runtime flags', desc: 'Operational kill-switches for user-visible features: flip a registered flag OFF to revert its surface to the previous behavior in seconds — no rebuild, no revision roll. Default-ON, never a spend/config gate; every flip is audited.' },
      { href: '/admin/api-management', label: 'API Management', desc: 'Manage APIM APIs, products, subscriptions, policies, named values, backends — full marketplace administration.' },
    ],
  },
  {
    label: 'Catalog & domains',
    items: [
      { href: '/admin/catalog', label: 'External-engine federation (Iceberg)', desc: 'N1 — what EXTERNAL engines see: every Apache Iceberg namespace + table the self-hosted Iceberg REST Catalog serves, format badges (Delta ✓ / Iceberg ✓), the Unity Catalog grant mapping, and copy-paste connect strings for Trino / Spark / DuckDB / Snowflake / Databricks. Zero copy — the same Parquet files in your own ADLS Gen2, no export, no Fabric, no SaaS catalog.' },
      { href: '/admin/domains', label: 'Domains', desc: 'Organize workspaces into business domains and subdomains.' },
      { href: '/admin/attribute-groups', label: 'Custom attributes', desc: 'Define per-domain attribute schemas (text, number, date, single-select) that appear in the Create wizard and item Edit dialogs.' },
    ],
  },
  {
    label: 'Access & security governance',
    items: [
      { href: '/admin/security', label: 'Security & governance', desc: 'Sensitivity labels, DLP policies, Purview hub link, workspace identity.' },
      { href: '/admin/policy-code', label: 'Policy as code', desc: 'Governance-as-code — author one policy set (principals × resources × actions × conditions) and compile it in a single pass to Synapse SQL DENY/RLS, Unity Catalog grants + row filters (Databricks or OSS-UC), ADX row-level security, Purview markings, and API scopes. Reconcile loop reads live state, applies the delta, and self-heals drift. Runs from the CLI via `loom policy apply`.' },
      { href: '/admin/permissions', label: 'Feature permissions', desc: 'Fabric-style RBAC — grant Reader/Contributor/Admin on every editor type, admin page, and workload to Entra users and groups.' },
      // IA-06: access-requests / access-report / access-packages / access-reviews
      // are now the four TABS of this hub (all four routes redirect here).
      { href: '/admin/access-governance', label: 'Access governance', desc: 'The one identity-governance hub: the onboarding Requests queue, the unified who-has-access Report (principal ↔ resource, with CSV export), requestable access Packages with approval policies + separation-of-duties, and recertification Reviews with bulk decisions, delegation and auto-revoke. The Azure-native 1:1 of Entra ID Governance.' },
      { href: '/admin/batch-labeling', label: 'Batch labeling', desc: 'Bulk-apply sensitivity labels to many catalog items at once; optionally propagate to Microsoft Purview asset classifications and Power BI via Admin InformationProtection.setLabels.' },
      { href: '/admin/embed-codes', label: 'Embed codes', desc: 'Generate and revoke read-only signed embed URLs (Blob user-delegation SAS) for reports and visuals — no Fabric / Power BI workspace required.' },
      { href: '/admin/org-visuals', label: 'Organizational visuals', desc: 'Upload, version, enable/disable and remove tenant-wide custom visual bundles (.pbiviz), stored Azure-natively in Blob.' },
      { href: '/admin/security?tab=dspm', label: 'DSPM for AI', desc: 'AI data-security posture: which agents / Copilots touch sensitive-labeled data, the max sensitivity label exposed, its protection state, and real per-agent usage. The Azure-native 1:1 of Purview DSPM for AI.' },
    ],
  },
  {
    label: 'AI operations',
    items: [
      // IA-04: copilot-usage / agent-quality / copilot-quality / model-fabric /
      // parity-autopilot are now the five TABS of this hub (all redirect here).
      { href: '/admin/ai-operations', label: 'AI operations', desc: 'The one AI-ops hub: per-persona Copilot token metering (Usage), agent evals + red-team + traces + latency SLO (Agent quality), per-surface answer/search/tier/prompt/budget quality (Copilot quality), the closed-loop promote/demote Model Fabric, and the Parity Autopilot run ledger. Every tab reads a real Azure OpenAI / Cosmos / Azure ML backend — no Fabric dependency.' },
      { href: '/admin/autopilot', label: 'Autopilot', desc: 'Self-driving FinOps (LCU-Autopilot): reads real LCU telemetry + Azure Monitor utilization + the gate/self-audit signal, then a policy engine (thresholds + hysteresis) recommends pausing idle compute, right-sizing the LCU capacity ceiling, or migrating workloads. Propose-only or Auto-apply; every pause/roll audited. Real Synapse/ADX pause + env-config revision — no Fabric dependency.' },
      { href: '/admin/mcp-servers', label: 'MCP Servers', desc: 'Browse + deploy the curated catalog of gov-safe MCP servers (Azure Container Apps + Key Vault secretRef + Azure Files), manage deployed servers with live status + teardown, and connect external MCP endpoints — the single home for Model Context Protocol tools Copilot can call.' },
    ],
  },
  {
    label: 'Audit & usage',
    items: [
      { href: '/admin/audit-logs', label: 'Audit logs', desc: 'Microsoft 365 audit log activity for every Fabric operation.' },
      { href: '/admin/usage', label: 'Usage metrics', desc: 'Feature usage & adoption report, item inventory, item details.' },
      { href: '/admin/webhooks', label: 'Event subscriptions', desc: 'Register outbound webhook endpoints that receive Loom events (item lifecycle, workspace, pipeline runs, marketplace subscribe / SLA breach, admin changes). HMAC-SHA256 signed direct HTTPS delivery by default, or Azure Event Grid when configured; per-hook delivery history + test-fire.' },
      { href: '/admin/developer/tokens', label: 'API tokens', desc: 'Tenant-wide inventory of scoped API tokens (PAT) for non-interactive access — who created each token, its scope, last-used and expiry. Revoke any token immediately. Users create + manage their own under Settings → Developer.' },
    ],
  },
  {
    label: 'Platform (network / updates)',
    items: [
      { href: '/admin/migrate', label: 'Migrate', desc: 'M1 — the inbound-migration on-ramp: point Loom at a Snowflake / Databricks Unity Catalog / Microsoft Fabric / Power BI estate, enumerate its schemas, tables, models, notebooks and reports, and get a migration-readiness report mapping every object to a Loom item type with a 1:1 / needs-review effort flag. A Fabric / Power BI estate is only ever a migration SOURCE — Loom itself needs no Fabric. Real data via the audited loom-migrate reader; unwired source connectors are honestly gated.' },
      { href: '/admin/deploy-planner', label: 'Deployment planner', desc: 'Visually plan what deploys to which subscription and domain; generate the bicepparam for az deployment.' },
      { href: '/admin/landing-zones', label: 'Landing zones', desc: 'See, visualize and manage every Data Landing Zone attached to your hub — and attach new ones (dlz-attach). Inherits the hub boundary, region and coordinates; a second Console cannot be deployed from here.' },
      { href: '/admin/users', label: 'Users & licenses', desc: 'Power BI / Fabric license assignments and user inventory.' },
      { href: '/admin/workspaces', label: 'Workspaces', desc: 'Tenant-wide inventory: every workspace, owner, capacity, state.' },
      { href: '/admin/network', label: 'Network & DNS', desc: 'Private endpoints, copy/paste hosts-file override, and enterprise DNS guidance for reaching the private-by-default Azure services.' },
      { href: '/admin/updates', label: 'Updates & version sync', desc: 'See your running version vs latest upstream; pull bug fixes and new features.' },
    ],
  },
];

/** Flat list of every admin destination (sidebar order preserved). */
export const ADMIN_DESTINATIONS: AdminDestination[] = ADMIN_SECTIONS.flatMap((g) => g.items);

/**
 * A route that used to be its own admin page and is now a TAB of a hub. The
 * old route still exists as a `redirect()` stub (app/admin/<from>/page.tsx) so
 * bookmarks, gate-registry surface paths, Copilot navigate targets, and any
 * external link keep resolving — they simply land on the right hub tab.
 */
export interface AdminLegacyRedirect {
  /** The preserved legacy route (still a real page under app/admin). */
  from: string;
  /** The hub deep link it bounces to (`/admin/<hub>?tab=<tab>`). */
  to: string;
}

export const ADMIN_LEGACY_REDIRECTS: AdminLegacyRedirect[] = [
  // IA-03 — FinOps hub
  { from: '/admin/usage-chargeback', to: '/admin/finops?tab=capacity' },
  { from: '/admin/chargeback', to: '/admin/finops?tab=chargeback' },
  // IA-04 — AI operations hub
  { from: '/admin/copilot-usage', to: '/admin/ai-operations?tab=usage' },
  { from: '/admin/agent-quality', to: '/admin/ai-operations?tab=agents' },
  { from: '/admin/copilot-quality', to: '/admin/ai-operations?tab=quality' },
  { from: '/admin/model-fabric', to: '/admin/ai-operations?tab=fabric' },
  { from: '/admin/parity-autopilot', to: '/admin/ai-operations?tab=autopilot' },
  // IA-06 — Access governance hub
  { from: '/admin/access-requests', to: '/admin/access-governance?tab=requests' },
  { from: '/admin/access-report', to: '/admin/access-governance?tab=report' },
  { from: '/admin/access-packages', to: '/admin/access-governance?tab=packages' },
  { from: '/admin/access-reviews', to: '/admin/access-governance?tab=reviews' },
];
