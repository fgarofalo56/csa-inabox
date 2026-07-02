/**
 * powerbi-skills.ts — the 5 Power BI agent skills, expressed as CSA Loom-native
 * Copilot skill descriptors.
 *
 * WHAT THIS IS
 * ------------
 * Microsoft ships an open-source set of "agent skills" for Power BI authoring
 * (github.com/microsoft/skills-for-fabric, plugin `powerbi-authoring`). They are
 * markdown skill folders that teach an agent HOW to author Power BI artifacts
 * well (star-schema modeling, DAX, PBIP/PBIR formats, report design, planning,
 * publish/management). This module distills those five skills into pure,
 * client-safe descriptors that the CSA Loom Copilot loads ON DEMAND, keyed off
 * the active pane/persona.
 *
 * WHY IT IS PURE DATA + SELECTORS (no parallel system)
 * ----------------------------------------------------
 * We REUSE Loom's existing copilot infrastructure rather than build a new loop:
 *   - The skill `guidance` is injected as an extra system message via the
 *     existing per-pane persona path (lib/azure/copilot-personas.ts →
 *     PersonaEntry.systemPrompt + the orchestrate panePersona step).
 *   - The skill's `toolNames` are advertised — they map ONE-FOR-ONE to tools
 *     ALREADY registered in the LoomToolRegistry (dax_*, tabular_*, report_*,
 *     item_create/item_configure/item_list). No new tools are minted here.
 * So this file has no Azure SDK, no network, no React — it is safe in any bundle
 * and is unit-testable on its own.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md)
 * -----------------------------------------------------------
 * Every skill's `defaultTarget` is `'azure-native'`. The DEFAULT day-one path is
 * Loom's OWN Azure-native authoring:
 *   - a Loom *semantic model* is the tabular layer over the Synapse dedicated
 *     SQL pool (dax_* + tabular_* tools), and
 *   - a Loom *report* is rendered by the Loom-native report renderer
 *     (report_query_model + report_suggest_visual).
 * The Power BI remote MCP server (https://api.fabric.microsoft.com/v1/mcp/powerbi)
 * and any Power BI REST call are STRICTLY OPT-IN and config-gated — surfaced only
 * via `pbiMcpToolPrefix` when the operator has connected the remote MCP (set the
 * Entra client id + the PBI admin has enabled the tenant setting). The
 * best-practice *guidance* itself needs NO Fabric/Power BI tenant — it grounds
 * the Azure-native tools just as well, so it works day-one with nothing bound.
 *
 * NO-VAPORWARE (.claude/rules/no-vaporware.md)
 * --------------------------------------------
 * These descriptors never claim a capability that isn't wired. The tools they
 * advertise are real (already registered + backed by Synapse SQL / Cosmos). The
 * opt-in PBI MCP tools only appear once the remote server is actually connected;
 * until then `skillSystemBlock` emits an HONEST note naming the exact env var,
 * tenant setting, and Entra app reg required to connect (the MCP client surfaces
 * the same as a Fluent MessageBar gate). No mock data, no dead advertisement.
 */

// ---------------------------------------------------------------------------
// Honest opt-in gate facts (single source of the human-readable requirements).
//
// The CANONICAL machine config for the remote PBI MCP lives on the catalog
// entry (lib/mcp/catalog.ts → RemoteBuiltinMcp) and the McpServerConfig row.
// These string constants exist only so the injected GUIDANCE can name the exact
// remediation honestly — they are documentation text, not a second config store.
// ---------------------------------------------------------------------------

/** Env var holding the Entra app (client) id used for the per-user OBO token. */
export const POWERBI_MCP_CLIENT_ID_ENV = 'LOOM_POWERBI_MCP_CLIENT_ID';
/** Env var overriding the remote MCP endpoint (defaults below). */
export const POWERBI_MCP_ENDPOINT_ENV = 'LOOM_POWERBI_MCP_ENDPOINT';
/** Default remote, web-hostable Power BI MCP endpoint (Streamable HTTP). */
export const POWERBI_MCP_DEFAULT_ENDPOINT = 'https://api.fabric.microsoft.com/v1/mcp/powerbi';
/** Power BI tenant setting a PBI admin must enable before the endpoint works. */
export const POWERBI_MCP_TENANT_SETTING =
  'Users can use the Power BI Model Context Protocol server endpoint (preview)';
/** Tool-name prefix Loom assigns the remote PBI MCP server's tools (buildMcpShim:
 *  `mcp_<server>_<tool>`, server id `powerbiremote`). */
export const POWERBI_MCP_TOOL_PREFIX = 'mcp_powerbiremote_';

/** One honest sentence describing how to enable the opt-in remote PBI MCP. */
export const POWERBI_REMOTE_MCP_GATE_TEXT =
  `The Power BI remote MCP is OPT-IN. To enable it, set ${POWERBI_MCP_CLIENT_ID_ENV} ` +
  `(an Entra app registration with the delegated Power BI scopes Dataset.Read.All, ` +
  `MLModel.Execute.All, Workspace.Read.All on resource https://analysis.windows.net/powerbi/api), ` +
  `optionally override ${POWERBI_MCP_ENDPOINT_ENV} (default ${POWERBI_MCP_DEFAULT_ENDPOINT}), and ` +
  `have a Power BI admin enable the tenant setting "${POWERBI_MCP_TENANT_SETTING}". Until then, the ` +
  `Azure-native authoring tools below are fully functional on their own.`;

/** Credit line for the upstream open-source skills. */
const SKILLS_ATTRIBUTION =
  'Adapted from the open-source "powerbi-authoring" agent skills ' +
  '(github.com/microsoft/skills-for-fabric), grounded for CSA Loom\'s Azure-native ' +
  'semantic-model + report authoring path.';

// ---------------------------------------------------------------------------
// The descriptor contract (shared with the orchestrator + catalog wiring).
// ---------------------------------------------------------------------------

export interface LoomCopilotSkill {
  /** Stable id (matches the upstream skill folder name). */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** One-line "when should the Copilot reach for this skill" hint. */
  whenToUse: string;
  /**
   * Best-practice system text injected as an extra system message when the skill
   * is active. Pure guidance — works WITHOUT any Fabric/Power BI tenant because
   * it grounds the Azure-native tools (defaultTarget below).
   */
  guidance: string;
  /** Every skill defaults to Loom's Azure-native authoring path. */
  defaultTarget: 'azure-native';
  /**
   * Names of EXISTING LoomToolRegistry tools this skill drives by default. These
   * are advertised to the model when the skill is active.
   */
  toolNames: string[];
  /**
   * When set, the OPT-IN tools whose names start with this prefix (the remote
   * Power BI MCP's schema-aware query + Copilot-DAX tools) ALSO belong to this
   * skill — surfaced only once the remote MCP is connected. Only the
   * query-bearing skills carry it.
   */
  pbiMcpToolPrefix?: string;
  /**
   * GENERAL form of {@link pbiMcpToolPrefix} for ANY connected Microsoft MCP
   * server (not just Power BI). When set, the OPT-IN tools whose names start
   * with this prefix (e.g. `mcp_learn_`, `mcp_azure_`, `mcp_graph_`) belong to
   * this skill and are surfaced only once that server is connected. This is the
   * single field the sibling `ms-skills.ts` descriptors use — they REUSE this
   * same interface rather than declaring a parallel type. `pbiMcpToolPrefix`
   * remains the Power BI-specific alias so the existing skills are unchanged.
   */
  mcpToolPrefix?: string;
  /**
   * Optional upstream credit line (e.g. "github.com/microsoft/skills") shown by
   * descriptors sourced from an open-source skill repo. The Power BI skills here
   * carry their attribution inline in `guidance`; `ms-skills.ts` sets this field
   * so its attribution is machine-readable for the admin UI and analytics.
   */
  attribution?: string;
  /**
   * Pane / persona slugs this skill is relevant to. The orchestrator calls
   * {@link skillsForPane} with the active editor's slug. Uses item-type slugs
   * ('semantic-model', 'report') plus the catch-all 'powerbi' so a dedicated
   * Power BI Copilot pane surfaces the full set.
   */
  panes: string[];
}

// ---------------------------------------------------------------------------
// The 5 skills.
// ---------------------------------------------------------------------------

export const POWERBI_AUTHORING_SKILLS: LoomCopilotSkill[] = [
  {
    id: 'semantic-model-authoring',
    name: 'Semantic model authoring',
    whenToUse:
      'Designing or refining a semantic model — star schema, relationships, DAX measures, ' +
      'storage mode, and AI-readiness so the model answers natural-language questions well.',
    defaultTarget: 'azure-native',
    pbiMcpToolPrefix: POWERBI_MCP_TOOL_PREFIX,
    panes: ['semantic-model', 'powerbi'],
    toolNames: [
      'dax_describe_model',
      'dax_model_context',
      'dax_explain',
      'dax_optimize',
      'dax_save_descriptions',
      'dax_eval_probe',
      'tabular_list_models',
      'tabular_list_tables',
      'tabular_list_measures',
      'tabular_eval_dax',
      'item_create',
      'item_configure',
    ],
    guidance: [
      'SKILL: Semantic model authoring.',
      'In CSA Loom a "semantic model" is the Azure-native tabular layer over the Synapse ' +
        'dedicated SQL pool (item type `semantic-model`). Author it with the dax_* / tabular_* ' +
        'tools and persist changes with item_create / item_configure on type `semantic-model`. ' +
        'No Power BI or Fabric workspace is required for any of this.',
      '',
      'Modeling best practices:',
      '- Prefer a STAR schema: narrow fact tables surrounded by dimension tables; avoid ' +
        'snowflaking and avoid wide flat tables. One single-direction (one-to-many) relationship ' +
        'per dimension; reserve bidirectional cross-filtering for genuine many-to-many bridges only.',
      '- Mark a dedicated Date dimension as the date table and drive all time-intelligence through it.',
      '- DAX: write reusable MEASURES (not calculated columns) for aggregations; factor repeated ' +
        'logic into VAR; use DIVIDE() to guard against divide-by-zero; keep filter context explicit ' +
        'with CALCULATE. Validate every measure with dax_eval_probe before saving.',
      '- Storage mode: default to Import (in-pool tables) for speed; use DirectQuery semantics when ' +
        'data must stay at the source / is too large to copy. (Direct Lake in Fabric maps to Loom ' +
        'querying Delta-on-ADLS via Synapse serverless — same "no-copy over Delta" idea, Azure-native.)',
      '- AI-readiness: give every table/column/measure a clear business name + a one-sentence ' +
        'description (dax_save_descriptions), hide technical/key columns, and add synonyms so the ' +
        'data agent and report Copilot can ground questions correctly.',
      '- The open PBIP/TMDL model format is a local, source-controllable artifact — usable for ' +
        'authoring without a tenant; publishing to a Power BI workspace is the opt-in step only.',
      '',
      SKILLS_ATTRIBUTION,
    ].join('\n'),
  },

  {
    id: 'power-bi-report-authoring',
    name: 'Report authoring (PBIR)',
    whenToUse:
      'Building or editing the visuals on a report — creating pages, placing visuals, validating ' +
      'the report definition against its schema.',
    defaultTarget: 'azure-native',
    panes: ['report', 'powerbi'],
    toolNames: ['report_query_model', 'report_suggest_visual', 'item_create', 'item_configure'],
    guidance: [
      'SKILL: Report authoring (PBIR create / edit / validate).',
      'In CSA Loom a "report" (item type `report`) is rendered by the Loom-native report renderer ' +
        'over the bound semantic model — no live Power BI is required. Ground EVERY visual on real ' +
        'aggregates: call report_query_model to compute the numbers, then report_suggest_visual to ' +
        'propose one visual at a time (the user approves before it is written). Persist with ' +
        'item_create / item_configure on type `report`.',
      '',
      'Authoring best practices (PBIR open format conventions):',
      '- One clear insight per visual; never suggest a visual whose field is not a column returned ' +
        'by the grounding query.',
      '- Choose the visual type for the message: trend over time → lineChart/areaChart; comparison ' +
        'across categories → columnChart/barChart; single KPI → card; composition → pieChart ' +
        '(sparingly); detail → tableEx.',
      '- Keep a consistent theme, readable contrast, and a sensible reading order; align visuals to ' +
        'a grid and avoid overlap.',
      '- Treat the report definition as VALIDATABLE: visual types must be from the supported set, ' +
        'every field must resolve to a real model column, and titles must be present before publish.',
      '',
      SKILLS_ATTRIBUTION,
    ].join('\n'),
  },

  {
    id: 'power-bi-report-design',
    name: 'Report design',
    whenToUse:
      'Producing a design brief for a report before building it — audience, key questions, layout, ' +
      'visual hierarchy, color, and typography.',
    defaultTarget: 'azure-native',
    panes: ['report', 'powerbi'],
    toolNames: ['report_query_model', 'report_suggest_visual', 'item_configure'],
    guidance: [
      'SKILL: Report design (design brief).',
      'Produce a short DESIGN BRIEF before placing visuals, then drive report_suggest_visual from it. ' +
        'This runs entirely on the Loom-native report path (no Power BI dependency).',
      '',
      'A good brief states:',
      '- Audience + the top 3-5 business questions the report must answer.',
      '- Page layout: a clear grid; KPI cards / headline numbers top-left where the eye lands; ' +
        'detail and breakdowns below; consistent slicers/filters in a fixed rail.',
      '- Visual hierarchy: size and position by importance; use whitespace; limit each page to a ' +
        'focused set of visuals rather than crowding.',
      '- A restrained color palette (accent for emphasis, neutral elsewhere) with accessible ' +
        'contrast, and consistent, legible typography.',
      '- For each headline question, name the measure that answers it and the visual that shows it — ' +
        'so authoring can ground it on a real report_query_model result.',
      '',
      SKILLS_ATTRIBUTION,
    ].join('\n'),
  },

  {
    id: 'power-bi-report-planner',
    name: 'Report planner',
    whenToUse:
      'Planning a complete report from an existing semantic model — inspecting its tables and ' +
      'measures, then proposing pages and visuals grounded in real fields.',
    defaultTarget: 'azure-native',
    pbiMcpToolPrefix: POWERBI_MCP_TOOL_PREFIX,
    panes: ['report', 'semantic-model', 'powerbi'],
    toolNames: [
      'tabular_list_models',
      'tabular_list_tables',
      'tabular_list_measures',
      'report_query_model',
      'report_suggest_visual',
      'item_create',
    ],
    guidance: [
      'SKILL: Report planner (guided plan-from-model).',
      'Plan a report from an EXISTING Loom semantic model. First INSPECT the real model — ' +
        'tabular_list_models to find it, then tabular_list_tables and tabular_list_measures to read ' +
        'its actual tables, columns, and measures. Never invent fields.',
      '',
      'Then produce a plan:',
      '- Group the available measures into the questions they answer; map each question to a page.',
      '- For each page, propose the visuals (type + the measure/field each uses + a one-line why), ' +
        'an overview page first (headline KPIs), then drill-down/detail pages.',
      '- Validate feasibility with report_query_model on a sample aggregate before committing a visual.',
      '- When approved, create the report with item_create (type `report`) and hand off to the ' +
        'report-authoring skill to place the visuals.',
      'This works on the Azure-native model by default; when the opt-in Power BI remote MCP is ' +
        'connected its schema-aware query + Copilot-DAX tools augment the model inspection.',
      '',
      SKILLS_ATTRIBUTION,
    ].join('\n'),
  },

  {
    id: 'power-bi-report-management',
    name: 'Report management',
    whenToUse:
      'Listing, organizing, and (opt-in) publishing reports — getting/managing report items and ' +
      'publishing to a Power BI / Fabric workspace when that backend is connected.',
    defaultTarget: 'azure-native',
    panes: ['report', 'powerbi'],
    toolNames: ['item_list', 'item_configure'],
    guidance: [
      'SKILL: Report management (get / publish / manage).',
      'On the DEFAULT path, "managing reports" means managing Loom report items: use item_list to ' +
        'find them and item_configure to rename / re-describe / re-bind them. A Loom report is served ' +
        'by the Loom-native renderer — it needs no Power BI or Fabric workspace.',
      '',
      'Publishing to a Power BI / Fabric workspace is OPT-IN and config-gated:',
      `- ${POWERBI_REMOTE_MCP_GATE_TEXT}`,
      '- Do NOT claim a report was published to Power BI / Fabric unless the opt-in remote MCP is ' +
        'connected and the publish call really ran. If it is not configured, say so plainly and offer ' +
        'the Loom-native report instead — never fabricate a published-to-Fabric result.',
      '',
      SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
];

// ---------------------------------------------------------------------------
// Selectors (consumed by the orchestrator's per-pane persona path).
// ---------------------------------------------------------------------------

/** Look a skill up by its stable id. Returns undefined when unknown. */
export function getPowerBiSkill(id: string | null | undefined): LoomCopilotSkill | undefined {
  if (!id) return undefined;
  const k = String(id).trim().toLowerCase();
  return POWERBI_AUTHORING_SKILLS.find((s) => s.id.toLowerCase() === k);
}

/**
 * Skills relevant to a given pane / persona slug. The orchestrator passes the
 * active editor's slug (e.g. the item-type slug `semantic-model` / `report`, or
 * the catch-all `powerbi`); matching is case-insensitive. Unknown slug → [].
 */
export function skillsForPane(slug: string | null | undefined): LoomCopilotSkill[] {
  if (!slug) return [];
  const s = String(slug).trim().toLowerCase();
  if (!s) return [];
  return POWERBI_AUTHORING_SKILLS.filter((skill) =>
    skill.panes.some((p) => p.toLowerCase() === s),
  );
}

/**
 * Render a skill as the extra system-message block the orchestrator injects when
 * the skill is active. Always frames the Azure-native default; advertises the
 * skill's real Loom tools; and — only when the opt-in Power BI remote MCP is
 * connected — additionally advertises its `mcp_powerbiremote_*` schema-aware
 * query + Copilot-DAX tools. When NOT connected, it emits the honest gate naming
 * the exact env var + tenant setting + Entra app required (no-vaporware).
 */
export function skillSystemBlock(
  skill: LoomCopilotSkill,
  opts?: { pbiMcpConnected?: boolean },
): string {
  const pbiConnected = Boolean(opts?.pbiMcpConnected);
  const lines: string[] = [];

  lines.push(`# Active skill: ${skill.name}`);
  lines.push(`When to use: ${skill.whenToUse}`);
  lines.push('');
  lines.push(skill.guidance);
  lines.push('');

  // Default (Azure-native) tools — always real, always advertised.
  lines.push(
    `Default tools for this skill (Azure-native, always available): ${skill.toolNames.join(', ')}.`,
  );

  // Opt-in remote PBI MCP tools — only when actually connected.
  if (skill.pbiMcpToolPrefix) {
    if (pbiConnected) {
      lines.push(
        `The Power BI remote MCP is connected: you may ALSO use its schema-aware query + ` +
          `Copilot-DAX tools (names beginning "${skill.pbiMcpToolPrefix}"). They run read-only ` +
          `under the signed-in user's Power BI RBAC.`,
      );
    } else {
      lines.push(POWERBI_REMOTE_MCP_GATE_TEXT);
    }
  }

  return lines.join('\n').trim();
}

/**
 * Convenience: the combined system blocks for every skill active in a pane.
 * Returns '' when no skill applies (the orchestrator then injects nothing extra).
 */
export function skillSystemBlocksForPane(
  slug: string | null | undefined,
  opts?: { pbiMcpConnected?: boolean },
): string {
  return skillsForPane(slug)
    .map((skill) => skillSystemBlock(skill, opts))
    .join('\n\n')
    .trim();
}
