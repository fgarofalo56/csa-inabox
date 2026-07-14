/**
 * skill-store.ts — the Cosmos-backed CTS-07 Copilot skills registry.
 *
 * WHAT THIS IS
 * ------------
 * The server-side store behind the Skills Studio + the orchestrator skill
 * injection. It unifies THREE sources into one normalized
 * {@link SkillDescriptor} view (lib/copilot/skill-registry-core.ts):
 *   1. the hard-coded Microsoft agent skills (lib/copilot/ms-skills.ts →
 *      MS_AGENT_SKILLS), and
 *   2. the hard-coded Power BI authoring skills (lib/copilot/powerbi-skills.ts →
 *      POWERBI_AUTHORING_SKILLS)
 *      — both seeded lazily + idempotently into the `copilot-skills` container
 *      under scope `builtin` with is_builtin:true, and
 *   3. any TENANT-authored custom skills (scope `tenant:<tid>`, is_builtin:false).
 *
 * Per-user on/off overrides (and an optional tenant-default overlay) live in the
 * `copilot-skill-states` container. Resolution is the pure
 * {@link resolveActiveSkills} policy: pane match AND per-user-override-over-
 * tenant-default. Built-in skills are READ-ONLY (update/delete are rejected) but
 * CAN be toggled per user; custom skills are full CRUD.
 *
 * NO-VAPORWARE (.claude/rules/no-vaporware.md)
 * --------------------------------------------
 * Real Cosmos reads/writes — no mock arrays. Seeding is idempotent
 * (create-if-absent, 409-tolerant). {@link resolveSkillsForInjection} +
 * {@link renderSkillInjectionForUser} are best-effort / FAIL-OPEN: any store
 * error falls back to the hard-coded MS-skills-for-pane set so the orchestrator
 * never breaks and the default-ON behavior is preserved.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md)
 * -----------------------------------------------------------
 * The skills themselves are Azure-native-by-default; this store adds no Fabric
 * host or `fabricWorkspaceId` read. Cosmos is the same Console UAMI-authed
 * account every other Loom container uses.
 */

import { randomUUID } from 'node:crypto';
import { copilotSkillsContainer, copilotSkillStatesContainer } from '@/lib/azure/cosmos-client';
import {
  MS_AGENT_SKILLS,
  getMsSkill,
  msSkillsForPane,
  msSkillSystemBlock,
  type MsAgentSkill,
} from '@/lib/copilot/ms-skills';
import { POWERBI_AUTHORING_SKILLS, type LoomCopilotSkill } from '@/lib/copilot/powerbi-skills';
import {
  resolveActiveSkills,
  type SkillDescriptor,
} from '@/lib/copilot/skill-registry-core';

// ---------------------------------------------------------------------------
// Doc shapes + scope helpers
// ---------------------------------------------------------------------------

/** The persisted `copilot-skills` doc: a SkillDescriptor + its partition scope. */
interface SkillDoc extends SkillDescriptor {
  /** Partition key: 'builtin' or `tenant:<tid>`. */
  scope: string;
  /** Redundant-but-queryable mirror of {@link SkillDescriptor.isBuiltin}. */
  is_builtin: boolean;
}

/** The persisted `copilot-skill-states` doc: one per user (or tenant overlay). */
interface SkillStateDoc {
  /** id == userKey (point-read key). */
  id: string;
  /** Partition key: `user:<oid>` or `tenant:<tid>`. */
  userKey: string;
  /** 'user' per-user override map, or 'tenant' default overlay. */
  kind: 'user' | 'tenant';
  /** { skillId: enabled } — an explicit per-skill on/off. */
  states: Record<string, boolean>;
  updatedAt: string;
}

const BUILTIN_SCOPE = 'builtin';
const tenantScope = (tenantId: string) => `tenant:${tenantId}`;
/** CTS-11 — the partition scope SUGGESTED (learner-drafted, admin-review) skills
 *  live under, distinct from the published tenant custom scope. */
const suggestedScope = (tenantId: string) => `suggested:${tenantId}`;
const userKeyFor = (userOid: string) => `user:${userOid}`;
const tenantKeyFor = (tenantId: string) => `tenant:${tenantId}`;

/** Typed error the routes map to the right HTTP status. */
export class SkillStoreError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'skill_error') {
    super(message);
    this.name = 'SkillStoreError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Built-in → descriptor mapping
// ---------------------------------------------------------------------------

function msSkillToDescriptor(sk: MsAgentSkill): SkillDescriptor {
  return {
    id: sk.id,
    name: sk.name,
    whenToUse: sk.whenToUse,
    guidance: sk.guidance,
    toolNames: sk.toolNames ?? [],
    panes: sk.panes ?? [],
    mcpToolPrefix: sk.mcpToolPrefix,
    category: 'Microsoft agent skill',
    tags: [],
    isBuiltin: true,
    enabled: true,
    attribution: sk.attribution,
  };
}

function pbiSkillToDescriptor(sk: LoomCopilotSkill): SkillDescriptor {
  return {
    id: sk.id,
    name: sk.name,
    whenToUse: sk.whenToUse,
    guidance: sk.guidance,
    toolNames: sk.toolNames ?? [],
    panes: sk.panes ?? [],
    mcpToolPrefix: sk.mcpToolPrefix ?? sk.pbiMcpToolPrefix,
    category: 'Power BI authoring',
    tags: [],
    isBuiltin: true,
    enabled: true,
    attribution: sk.attribution,
  };
}

/** The full set of built-in descriptors (MS ∪ Power BI), the seed source. */
function builtinDescriptors(): SkillDescriptor[] {
  return [
    ...MS_AGENT_SKILLS.map(msSkillToDescriptor),
    ...POWERBI_AUTHORING_SKILLS.map(pbiSkillToDescriptor),
  ];
}

/** The set of built-in skill ids — used to reject write ops on read-only skills. */
function builtinIdSet(): Set<string> {
  return new Set(builtinDescriptors().map((d) => d.id));
}

/** Strip Cosmos meta (_rid/_etc) + the scope fields, returning a clean descriptor. */
function docToDescriptor(doc: SkillDoc): SkillDescriptor {
  return {
    id: doc.id,
    name: doc.name,
    whenToUse: doc.whenToUse,
    guidance: doc.guidance,
    toolNames: Array.isArray(doc.toolNames) ? doc.toolNames : [],
    panes: Array.isArray(doc.panes) ? doc.panes : [],
    mcpToolPrefix: doc.mcpToolPrefix,
    category: doc.category,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    isBuiltin: doc.is_builtin === true || doc.isBuiltin === true,
    enabled: doc.enabled !== false,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    attribution: doc.attribution,
  };
}

// ---------------------------------------------------------------------------
// Idempotent built-in seeding
// ---------------------------------------------------------------------------

let _builtinsSeeded = false;

/**
 * Seed the built-in skills into the `builtin` partition once, idempotently.
 * Reads the existing builtin ids, then create-if-absent for each source skill;
 * 409 (a concurrent replica beat us) is tolerated. Cached per-process so the hot
 * read path pays for this at most once.
 */
async function ensureBuiltinsSeeded(): Promise<void> {
  if (_builtinsSeeded) return;
  const c = await copilotSkillsContainer();
  const { resources } = await c.items
    .query<{ id: string }>(
      { query: 'SELECT c.id FROM c WHERE c.scope = @s', parameters: [{ name: '@s', value: BUILTIN_SCOPE }] },
      { partitionKey: BUILTIN_SCOPE },
    )
    .fetchAll();
  const have = new Set(resources.map((r) => r.id));
  for (const d of builtinDescriptors()) {
    if (have.has(d.id)) continue;
    const doc: SkillDoc = { ...d, scope: BUILTIN_SCOPE, is_builtin: true };
    try {
      await c.items.create(doc);
    } catch (e: any) {
      // 409 = another replica already seeded this id — fine.
      if (e?.code !== 409) throw e;
    }
  }
  _builtinsSeeded = true;
}

// ---------------------------------------------------------------------------
// Skill CRUD + listing
// ---------------------------------------------------------------------------

/** Input for creating / updating a custom skill (form-driven, never raw JSON config). */
export interface CustomSkillInput {
  name: string;
  whenToUse: string;
  guidance: string;
  panes: string[];
  toolNames?: string[];
  mcpToolPrefix?: string;
  category?: string;
  tags?: string[];
}

function normalizeInput(input: Partial<CustomSkillInput>): CustomSkillInput {
  const name = String(input.name ?? '').trim();
  const whenToUse = String(input.whenToUse ?? '').trim();
  const guidance = String(input.guidance ?? '').trim();
  const panes = Array.isArray(input.panes)
    ? input.panes.map((p) => String(p).trim().toLowerCase()).filter(Boolean)
    : [];
  const toolNames = Array.isArray(input.toolNames)
    ? input.toolNames.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const mcpToolPrefix = input.mcpToolPrefix ? String(input.mcpToolPrefix).trim() : undefined;
  const category = input.category ? String(input.category).trim() : 'Custom';
  if (!name) throw new SkillStoreError('name is required', 400, 'invalid_skill');
  if (!guidance) throw new SkillStoreError('guidance is required', 400, 'invalid_skill');
  if (panes.length === 0) throw new SkillStoreError('at least one pane is required', 400, 'invalid_skill');
  return { name, whenToUse, guidance, panes, toolNames, mcpToolPrefix, category, tags };
}

/**
 * Read the tenant-default overlay ({ skillId: enabled }) a tenant admin has set,
 * or {} when none. Applied on top of each skill's own `enabled` in listSkills.
 */
async function getTenantSkillDefaults(tenantId?: string): Promise<Record<string, boolean>> {
  if (!tenantId) return {};
  const c = await copilotSkillStatesContainer();
  const key = tenantKeyFor(tenantId);
  try {
    const { resource } = await c.item(key, key).read<SkillStateDoc>();
    return resource?.states ?? {};
  } catch {
    return {};
  }
}

/**
 * The tenant's full skill catalog: seeded built-ins ∪ tenant custom skills,
 * with each skill's tenant-default `enabled` overlaid from the tenant overlay doc.
 */
export async function listSkills(tenantId?: string): Promise<SkillDescriptor[]> {
  await ensureBuiltinsSeeded();
  const c = await copilotSkillsContainer();
  const { resources: builtins } = await c.items
    .query<SkillDoc>(
      { query: 'SELECT * FROM c WHERE c.scope = @s', parameters: [{ name: '@s', value: BUILTIN_SCOPE }] },
      { partitionKey: BUILTIN_SCOPE },
    )
    .fetchAll();
  let custom: SkillDoc[] = [];
  if (tenantId) {
    const scope = tenantScope(tenantId);
    const { resources } = await c.items
      .query<SkillDoc>(
        { query: 'SELECT * FROM c WHERE c.scope = @s', parameters: [{ name: '@s', value: scope }] },
        { partitionKey: scope },
      )
      .fetchAll();
    custom = resources;
  }
  const tenantDefaults = await getTenantSkillDefaults(tenantId);
  return [...builtins, ...custom].map((doc) => {
    const d = docToDescriptor(doc);
    if (Object.prototype.hasOwnProperty.call(tenantDefaults, d.id)) {
      d.enabled = tenantDefaults[d.id] !== false;
    }
    return d;
  });
}

/** A skill decorated with the caller's effective + explicit toggle state (UI view). */
export interface SkillWithUserState extends SkillDescriptor {
  /** The effective on/off for this user: userOverride ?? enabled ?? true. */
  effectiveEnabled: boolean;
  /** The explicit per-user override, or null when the user hasn't toggled it. */
  userOverride: boolean | null;
}

/** List the tenant catalog decorated with the caller's per-user toggle state. */
export async function listSkillsForUser(
  tenantId: string | undefined,
  userOid: string,
): Promise<SkillWithUserState[]> {
  const [all, userState] = await Promise.all([listSkills(tenantId), getUserSkillState(userOid)]);
  return all.map((d) => {
    const has = Object.prototype.hasOwnProperty.call(userState, d.id);
    const userOverride = has ? userState[d.id] : null;
    const effectiveEnabled = (userOverride ?? d.enabled ?? true) !== false;
    return { ...d, userOverride, effectiveEnabled };
  });
}

/** Create a tenant-scoped custom skill. */
export async function createCustomSkill(
  tenantId: string,
  actorOid: string,
  rawInput: Partial<CustomSkillInput>,
): Promise<SkillDescriptor> {
  const input = normalizeInput(rawInput);
  const now = new Date().toISOString();
  const scope = tenantScope(tenantId);
  const doc: SkillDoc = {
    id: randomUUID(),
    scope,
    is_builtin: false,
    isBuiltin: false,
    enabled: true,
    name: input.name,
    whenToUse: input.whenToUse,
    guidance: input.guidance,
    toolNames: input.toolNames ?? [],
    panes: input.panes,
    mcpToolPrefix: input.mcpToolPrefix,
    category: input.category,
    tags: input.tags ?? [],
    createdBy: actorOid,
    createdAt: now,
    updatedAt: now,
  };
  const c = await copilotSkillsContainer();
  await c.items.create(doc);
  return docToDescriptor(doc);
}

/** Update a tenant-scoped custom skill. Built-in skills are read-only. */
export async function updateCustomSkill(
  tenantId: string,
  id: string,
  patch: Partial<CustomSkillInput> & { enabled?: boolean },
): Promise<SkillDescriptor> {
  if (builtinIdSet().has(id)) {
    throw new SkillStoreError(
      'Built-in skills are read-only. Toggle them on/off per user, or duplicate to customize.',
      409,
      'builtin_readonly',
    );
  }
  const scope = tenantScope(tenantId);
  const c = await copilotSkillsContainer();
  let existing: SkillDoc | undefined;
  try {
    const { resource } = await c.item(id, scope).read<SkillDoc>();
    existing = resource ?? undefined;
  } catch {
    existing = undefined;
  }
  if (!existing) throw new SkillStoreError('Skill not found', 404, 'not_found');
  if (existing.is_builtin) {
    throw new SkillStoreError('Built-in skills are read-only', 409, 'builtin_readonly');
  }
  // Only the form-editable fields may change; identity/scope/authorship stay.
  const next: SkillDoc = { ...existing };
  if (patch.name !== undefined) next.name = String(patch.name).trim();
  if (patch.whenToUse !== undefined) next.whenToUse = String(patch.whenToUse).trim();
  if (patch.guidance !== undefined) next.guidance = String(patch.guidance).trim();
  if (patch.panes !== undefined) {
    next.panes = (patch.panes || []).map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  }
  if (patch.toolNames !== undefined) {
    next.toolNames = (patch.toolNames || []).map((t) => String(t).trim()).filter(Boolean);
  }
  if (patch.tags !== undefined) {
    next.tags = (patch.tags || []).map((t) => String(t).trim()).filter(Boolean);
  }
  if (patch.mcpToolPrefix !== undefined) {
    next.mcpToolPrefix = String(patch.mcpToolPrefix).trim() || undefined;
  }
  if (patch.category !== undefined) next.category = String(patch.category).trim() || 'Custom';
  if (patch.enabled !== undefined) next.enabled = patch.enabled !== false;
  if (!next.name) throw new SkillStoreError('name is required', 400, 'invalid_skill');
  if (!next.guidance) throw new SkillStoreError('guidance is required', 400, 'invalid_skill');
  if (!next.panes.length) throw new SkillStoreError('at least one pane is required', 400, 'invalid_skill');
  next.updatedAt = new Date().toISOString();
  await c.item(id, scope).replace(next);
  return docToDescriptor(next);
}

/** Delete a tenant-scoped custom skill. Built-in skills cannot be deleted. */
export async function deleteCustomSkill(tenantId: string, id: string): Promise<void> {
  if (builtinIdSet().has(id)) {
    throw new SkillStoreError('Built-in skills cannot be deleted', 409, 'builtin_readonly');
  }
  const scope = tenantScope(tenantId);
  const c = await copilotSkillsContainer();
  let existing: SkillDoc | undefined;
  try {
    const { resource } = await c.item(id, scope).read<SkillDoc>();
    existing = resource ?? undefined;
  } catch {
    existing = undefined;
  }
  if (!existing) throw new SkillStoreError('Skill not found', 404, 'not_found');
  if (existing.is_builtin) throw new SkillStoreError('Built-in skills cannot be deleted', 409, 'builtin_readonly');
  await c.item(id, scope).delete();
}

/** Duplicate any skill (built-in or custom) into a new tenant-scoped custom skill. */
export async function duplicateSkill(
  tenantId: string,
  actorOid: string,
  id: string,
): Promise<SkillDescriptor> {
  const all = await listSkills(tenantId);
  const src = all.find((s) => s.id === id);
  if (!src) throw new SkillStoreError('Skill not found', 404, 'not_found');
  return createCustomSkill(tenantId, actorOid, {
    name: `${src.name} (copy)`,
    whenToUse: src.whenToUse,
    guidance: src.guidance,
    panes: src.panes,
    toolNames: src.toolNames,
    mcpToolPrefix: src.mcpToolPrefix,
    category: 'Custom',
    tags: src.tags,
  });
}

// ---------------------------------------------------------------------------
// Per-user toggle state (+ tenant default overlay)
// ---------------------------------------------------------------------------

/** Read a user's { skillId: enabled } override map ({} when none / on error). */
export async function getUserSkillState(userOid: string): Promise<Record<string, boolean>> {
  const c = await copilotSkillStatesContainer();
  const key = userKeyFor(userOid);
  try {
    const { resource } = await c.item(key, key).read<SkillStateDoc>();
    return resource?.states ?? {};
  } catch {
    return {};
  }
}

/** Set a single per-user override for a skill (upsert-merge the user's doc). */
export async function setUserSkillState(
  userOid: string,
  skillId: string,
  enabled: boolean,
): Promise<Record<string, boolean>> {
  const c = await copilotSkillStatesContainer();
  const key = userKeyFor(userOid);
  let states: Record<string, boolean> = {};
  try {
    const { resource } = await c.item(key, key).read<SkillStateDoc>();
    states = resource?.states ?? {};
  } catch {
    states = {};
  }
  states[skillId] = enabled;
  const doc: SkillStateDoc = { id: key, userKey: key, kind: 'user', states, updatedAt: new Date().toISOString() };
  await c.items.upsert(doc);
  return states;
}

/**
 * Set a tenant-DEFAULT override for a skill (tenant-admin action). Applied on top
 * of each skill's own `enabled` in {@link listSkills}; a per-user override still
 * wins over it at resolution time.
 */
export async function setTenantSkillDefault(
  tenantId: string,
  skillId: string,
  enabled: boolean,
): Promise<Record<string, boolean>> {
  const c = await copilotSkillStatesContainer();
  const key = tenantKeyFor(tenantId);
  let states: Record<string, boolean> = {};
  try {
    const { resource } = await c.item(key, key).read<SkillStateDoc>();
    states = resource?.states ?? {};
  } catch {
    states = {};
  }
  states[skillId] = enabled;
  const doc: SkillStateDoc = { id: key, userKey: key, kind: 'tenant', states, updatedAt: new Date().toISOString() };
  await c.items.upsert(doc);
  return states;
}

// ---------------------------------------------------------------------------
// CTS-11 — SUGGESTED skills (learner-drafted, admin-reviewed)
// ---------------------------------------------------------------------------

/** Provenance for a learner-drafted suggestion — what usage pattern produced it. */
export interface SkillProvenance {
  /** The recurring keywords the gap surfaced. */
  keywords: string[];
  /** How many prompts fed the gap. */
  sampleCount: number;
  /** The pane the gap was found on. */
  pane?: string;
  /** A few representative (already-redacted) prompts. */
  samplePrompts?: string[];
}

/** A learner-drafted candidate skill (form-shaped, never raw JSON config). */
export interface SuggestedSkillDraft {
  name: string;
  whenToUse: string;
  guidance: string;
  panes: string[];
  toolNames?: string[];
  category?: string;
  tags?: string[];
}

/** The persisted SUGGESTED-skill doc (scope `suggested:<tid>`). */
interface SuggestedSkillDoc extends SkillDoc {
  status: 'suggested';
  proposedFrom?: SkillProvenance;
  proposedAt?: string;
}

/** A suggestion decorated for the admin review queue (descriptor + provenance). */
export interface SuggestedSkill extends SkillDescriptor {
  status: 'suggested';
  proposedFrom?: SkillProvenance;
  proposedAt?: string;
}

/**
 * Persist ONE learner-drafted candidate as a SUGGESTED skill under
 * `suggested:<tid>`. Nothing here is injected into any turn — a suggestion is
 * inert until an admin PROMOTES it (see {@link promoteSuggestedSkill}). The draft
 * is normalized through the SAME form validator as a custom skill so a malformed
 * draft is rejected before it reaches the review queue.
 */
export async function createSuggestedSkill(
  tenantId: string,
  draft: SuggestedSkillDraft,
  provenance?: SkillProvenance,
): Promise<SuggestedSkill> {
  const input = normalizeInput(draft);
  const now = new Date().toISOString();
  const scope = suggestedScope(tenantId);
  const doc: SuggestedSkillDoc = {
    id: randomUUID(),
    scope,
    is_builtin: false,
    isBuiltin: false,
    enabled: true,
    status: 'suggested',
    name: input.name,
    whenToUse: input.whenToUse,
    guidance: input.guidance,
    toolNames: input.toolNames ?? [],
    panes: input.panes,
    mcpToolPrefix: input.mcpToolPrefix,
    category: input.category ?? 'Suggested',
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
    proposedFrom: provenance,
    proposedAt: now,
  };
  const c = await copilotSkillsContainer();
  await c.items.create(doc);
  return suggestedDocToView(doc);
}

function suggestedDocToView(doc: SuggestedSkillDoc): SuggestedSkill {
  return {
    ...docToDescriptor(doc),
    status: 'suggested',
    proposedFrom: doc.proposedFrom,
    proposedAt: doc.proposedAt,
  };
}

/** List the tenant's pending SUGGESTED skills (the admin review queue). */
export async function listSuggestedSkills(tenantId: string): Promise<SuggestedSkill[]> {
  const scope = suggestedScope(tenantId);
  const c = await copilotSkillsContainer();
  const { resources } = await c.items
    .query<SuggestedSkillDoc>(
      { query: 'SELECT * FROM c WHERE c.scope = @s', parameters: [{ name: '@s', value: scope }] },
      { partitionKey: scope },
    )
    .fetchAll();
  return resources
    .map(suggestedDocToView)
    .sort((a, b) => (b.proposedAt ?? '').localeCompare(a.proposedAt ?? ''));
}

/** Read one suggested doc (or undefined). */
async function readSuggested(tenantId: string, id: string): Promise<SuggestedSkillDoc | undefined> {
  const scope = suggestedScope(tenantId);
  const c = await copilotSkillsContainer();
  try {
    const { resource } = await c.item(id, scope).read<SuggestedSkillDoc>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * PROMOTE a suggested skill to a published TENANT CUSTOM skill (scope
 * `tenant:<tid>`), clearing the suggested status, then delete the suggestion.
 * An admin may pass `edits` (form fields) to publish an EDITED version — the
 * edits are applied over the draft before it is created. Returns the new custom
 * skill descriptor.
 */
export async function promoteSuggestedSkill(
  tenantId: string,
  id: string,
  actorOid: string,
  edits?: Partial<CustomSkillInput>,
): Promise<SkillDescriptor> {
  const doc = await readSuggested(tenantId, id);
  if (!doc) throw new SkillStoreError('Suggested skill not found', 404, 'not_found');
  // Apply admin edits over the drafted fields, then publish through the SAME
  // create path a hand-authored custom skill uses (full validation).
  const merged: Partial<CustomSkillInput> = {
    name: edits?.name ?? doc.name,
    whenToUse: edits?.whenToUse ?? doc.whenToUse,
    guidance: edits?.guidance ?? doc.guidance,
    panes: edits?.panes ?? doc.panes,
    toolNames: edits?.toolNames ?? doc.toolNames,
    mcpToolPrefix: edits?.mcpToolPrefix ?? doc.mcpToolPrefix,
    category: edits?.category ?? (doc.category === 'Suggested' ? 'Custom' : doc.category),
    tags: edits?.tags ?? doc.tags,
  };
  const created = await createCustomSkill(tenantId, actorOid, merged);
  // Remove the suggestion now that it's published (best-effort — a lingering
  // suggestion doc is harmless but we clean it up so the queue reflects reality).
  const scope = suggestedScope(tenantId);
  const c = await copilotSkillsContainer();
  try {
    await c.item(id, scope).delete();
  } catch {
    /* already gone / concurrent dismiss — fine */
  }
  return created;
}

/** DISMISS a suggested skill — delete it from the review queue. Idempotent. */
export async function dismissSuggestedSkill(tenantId: string, id: string): Promise<void> {
  const doc = await readSuggested(tenantId, id);
  if (!doc) throw new SkillStoreError('Suggested skill not found', 404, 'not_found');
  const scope = suggestedScope(tenantId);
  const c = await copilotSkillsContainer();
  await c.item(id, scope).delete();
}

// ---------------------------------------------------------------------------
// Orchestrator injection (best-effort / fail-open)
// ---------------------------------------------------------------------------

/**
 * The ACTIVE (post-toggle) skills for a pane, resolved against the caller's
 * per-user overrides + the tenant catalog. FAIL-OPEN: any store error returns
 * the hard-coded MS-skills-for-pane set mapped to descriptors, so the caller
 * never breaks and the default-ON behavior is preserved.
 */
export async function resolveSkillsForInjection(
  userOid: string,
  tenantId: string | undefined,
  slug: string | null | undefined,
): Promise<SkillDescriptor[]> {
  try {
    const [all, userState] = await Promise.all([listSkills(tenantId), getUserSkillState(userOid)]);
    return resolveActiveSkills(all, slug, userState);
  } catch {
    return msSkillsForPane(slug).map(msSkillToDescriptor);
  }
}

/** Simple renderer for a CUSTOM skill's injected system block (mirrors msSkillSystemBlock). */
function renderCustomSkillBlock(d: SkillDescriptor): string {
  const lines: string[] = [];
  lines.push(`# Active skill: ${d.name}`);
  lines.push(`When to use: ${d.whenToUse}`);
  lines.push('');
  lines.push(d.guidance);
  if (d.toolNames.length) {
    lines.push('');
    lines.push(
      `Default tools for this skill (Azure-native, always available): ${d.toolNames.join(', ')}.`,
    );
  }
  return lines.join('\n').trim();
}

/**
 * The RENDERED system-message block for the resolved active skills of a pane,
 * plus their names (for the CTS-05 meter). Reuses {@link msSkillSystemBlock} for
 * built-in Microsoft skills and a simple renderer for custom skills.
 *
 * SCOPE: only the Microsoft built-ins + custom skills are rendered here — the
 * Power BI built-ins are injected by the separate per-pane persona path
 * (skillSystemBlocksForPane), so rendering them here too would double-inject.
 * With NO user state + no custom skills the output is byte-identical to the
 * previous `msSkillSystemBlocksForPane(slug, {connectedPrefixes})` — preserving
 * the orchestrator's default behavior. Returns null on ANY error so the caller
 * falls back to the hard-coded path (fail-open).
 */
export async function renderSkillInjectionForUser(
  userOid: string,
  tenantId: string | undefined,
  slug: string | null | undefined,
  opts?: { connectedPrefixes?: string[] },
): Promise<{ block: string; names: string[] } | null> {
  try {
    const [all, userState] = await Promise.all([listSkills(tenantId), getUserSkillState(userOid)]);
    const active = resolveActiveSkills(all, slug, userState);
    const prefixes = opts?.connectedPrefixes;
    const msIds = new Set(MS_AGENT_SKILLS.map((s) => s.id));
    const blocks: string[] = [];
    const names: string[] = [];
    for (const d of active) {
      if (d.isBuiltin) {
        if (!msIds.has(d.id)) continue; // skip Power BI built-ins (persona path injects them)
        const sk = getMsSkill(d.id);
        if (!sk) continue;
        const block = prefixes && sk.mcpToolPrefix
          ? msSkillSystemBlock(sk, { connected: prefixes.includes(sk.mcpToolPrefix) })
          : msSkillSystemBlock(sk);
        blocks.push(block);
        names.push(d.name);
      } else {
        blocks.push(renderCustomSkillBlock(d));
        names.push(d.name);
      }
    }
    return { block: blocks.join('\n\n').trim(), names };
  } catch {
    return null;
  }
}
