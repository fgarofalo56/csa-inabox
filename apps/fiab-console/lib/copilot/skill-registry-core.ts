/**
 * skill-registry-core.ts — the PURE, dependency-free heart of the CTS-07 skills
 * registry (per-user toggle over tenant default).
 *
 * WHAT THIS IS
 * ------------
 * A single normalized {@link SkillDescriptor} shape that unifies the two
 * hard-coded built-in skill families (lib/copilot/ms-skills.ts →
 * MS_AGENT_SKILLS and lib/copilot/powerbi-skills.ts → POWERBI_AUTHORING_SKILLS)
 * with any TENANT-authored custom skills the Skills Studio creates, plus the two
 * pure selectors the orchestrator + store consume:
 *   - {@link resolveActiveSkills} — pane filter + per-user-toggle-over-tenant-
 *     default resolution (the actual policy: a skill is active on a pane iff its
 *     pane matches AND the user hasn't turned it off / the tenant default is on).
 *   - {@link estimateSkillTokens} — a chars/4 approximation of the injected
 *     guidance blocks for the CTS-05 context-window meter's "skills" segment.
 *
 * WHY IT IS PURE (no Azure/React/network imports)
 * -----------------------------------------------
 * The store (lib/azure/skill-store.ts) maps Cosmos docs + the built-in arrays
 * INTO SkillDescriptor and then calls these selectors; the orchestrator consumes
 * the resolved set. Keeping the shape + the resolution policy here — with ZERO
 * side-effecting imports — makes the toggle semantics unit-testable on their own
 * (see lib/copilot/__tests__/skill-registry-core.test.ts) and reusable on both
 * the server (store) and, if needed, the client (Studio preview) without pulling
 * the Cosmos SDK into a bundle.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md)
 * -----------------------------------------------------------
 * This module carries no backend at all — the built-in skills it normalizes are
 * already Azure-native-by-default (their `mcpToolPrefix` is opt-in only). Nothing
 * here reads `fabricWorkspaceId` or a Fabric host.
 */

/**
 * The normalized, store-level descriptor for ONE Copilot/agent skill. Built-in
 * skills (MS + Power BI) are mapped INTO this shape by the store with
 * `isBuiltin:true`; tenant-authored custom skills are stored as this shape with
 * `isBuiltin:false`. It is a superset of the fields the two hard-coded families
 * expose ({@link import('./ms-skills').MsAgentSkill} /
 * {@link import('./powerbi-skills').LoomCopilotSkill}) plus registry metadata
 * (tenant-default `enabled`, authorship, timestamps).
 */
export interface SkillDescriptor {
  /** Stable id. Built-ins keep the upstream skill id; custom skills use a UUID. */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** One-line "when should Copilot reach for this skill" hint. */
  whenToUse: string;
  /** Best-practice system text injected as an extra system message when active. */
  guidance: string;
  /** Names of REAL registered LoomToolRegistry tools this skill drives. */
  toolNames: string[];
  /** Pane / persona slugs this skill is relevant to (case-insensitive match). */
  panes: string[];
  /**
   * `mcp_<slug>_` prefix of the OPT-IN Microsoft MCP server backing this skill,
   * surfaced only once that server is connected (mirrors MsAgentSkill). Optional.
   */
  mcpToolPrefix?: string;
  /** Grouping label for the Studio catalog (e.g. 'Infra & Ops', 'Custom'). */
  category?: string;
  /** Free-form tags for filtering/search in the Studio. */
  tags?: string[];
  /** True for the hard-coded MS/Power BI skills; false for tenant custom skills. */
  isBuiltin: boolean;
  /**
   * The TENANT DEFAULT on/off state for this skill (default true). A per-user
   * override — see {@link resolveActiveSkills} — always wins over this value.
   */
  enabled: boolean;
  /** Author oid for a custom skill (unset for built-ins). */
  createdBy?: string;
  /** ISO create timestamp for a custom skill. */
  createdAt?: string;
  /** ISO last-update timestamp for a custom skill. */
  updatedAt?: string;
  /** Optional upstream attribution line (github.com/microsoft/skills, …). */
  attribution?: string;
}

/**
 * Resolve the ACTIVE skills for a pane, applying the CTS-07 policy:
 *   active(skill) = paneMatches(skill, slug) AND (userState[skill.id] ?? skill.enabled ?? true)
 *
 * i.e. a skill shows on a pane iff one of its `panes` case-insensitively equals
 * the slug AND it is turned on for this user — where the PER-USER override
 * (`userState[skill.id]`) takes precedence over the TENANT DEFAULT (`skill.enabled`),
 * which itself defaults to `true` when unset. An unknown / empty slug yields [].
 *
 * Pure + deterministic — no I/O. The store passes the union of built-in + custom
 * descriptors as `all` and the caller's override map as `userState`.
 */
export function resolveActiveSkills(
  all: SkillDescriptor[],
  slug: string | null | undefined,
  userState: Record<string, boolean>,
): SkillDescriptor[] {
  if (!slug) return [];
  const s = String(slug).trim().toLowerCase();
  if (!s) return [];
  const state = userState || {};
  return all.filter((skill) => {
    const paneMatch = Array.isArray(skill.panes) && skill.panes.some((p) => String(p).toLowerCase() === s);
    if (!paneMatch) return false;
    // Per-user override wins; else tenant default; else on.
    const active = state[skill.id] ?? skill.enabled ?? true;
    return active !== false;
  });
}

/**
 * Approximate the token cost of injecting the given skills' guidance blocks, for
 * the CTS-05 context-window meter's "skills" segment. Uses the repo-wide chars/4
 * heuristic (≈ 4 chars per token) over each skill's `guidance` text — the same
 * body {@link import('./ms-skills').msSkillSystemBlock} emits. Returns 0 for an
 * empty set.
 */
export function estimateSkillTokens(skills: SkillDescriptor[]): number {
  if (!Array.isArray(skills) || skills.length === 0) return 0;
  const chars = skills.reduce((n, sk) => n + (sk?.guidance ? sk.guidance.length : 0), 0);
  return Math.ceil(chars / 4);
}
