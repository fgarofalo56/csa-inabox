/**
 * a2a-agent-card — the ONE spec-conformant A2A Agent Card generator (B-N14d).
 *
 * Before this module Loom had THREE hand-rolled card builders that had drifted
 * apart and had all been written against the A2A **0.3 line**:
 *   - `a2a-protocol.buildAgentCard`   (platform + per-item)
 *   - `a2a-item-server.buildItemAgentCard`
 *   - `agent-registry.buildA2AAgentCard` (mesh — no protocol version at all,
 *     and a `provider` missing the REQUIRED `url`).
 *
 * The current specification (https://a2a-protocol.org/latest/specification/)
 * renamed and restructured the discovery objects. Verbatim from §4.4.1
 * "AgentCard": the REQUIRED fields are `name`, `description`,
 * **`supportedInterfaces`** ("Ordered list of supported interfaces. The first
 * entry is preferred.", `array of AgentInterface`), `version`, `capabilities`,
 * `defaultInputModes`, `defaultOutputModes`, `skills`; OPTIONAL are `provider`,
 * `documentationUrl`, `securitySchemes`, **`securityRequirements`**,
 * `signatures`, `iconUrl`. Notably the 0.3-line top-level `url`,
 * `preferredTransport`, `protocolVersion` and `security` are GONE — the
 * transport tuple now lives per-interface (§4.4.6 `AgentInterface`:
 * `url`, `protocolBinding`, `tenant`, `protocolVersion`), and
 * `supportsAuthenticatedExtendedCard` became `capabilities.extendedAgentCard`
 * (§4.4.3). Security schemes are now a ONE-OF wrapper (§4.5.1: "A
 * SecurityScheme MUST contain exactly one of the following:
 * apiKeySecurityScheme, httpAuthSecurityScheme, oauth2SecurityScheme,
 * openIdConnectSecurityScheme, mtlsSecurityScheme").
 *
 * Sources (fetched, not recalled) — all §-numbers are from the live spec:
 *   §4.4.1 AgentCard · §4.4.2 AgentProvider · §4.4.3 AgentCapabilities ·
 *   §4.4.4 AgentExtension · §4.4.5 AgentSkill · §4.4.6 AgentInterface ·
 *   §4.4.7 AgentCardSignature · §4.5.1–4.5.3 SecurityScheme ·
 *   §8.5 Sample Agent Card · §14.3 Well-Known URI Registration
 *   ("https://agent.example.com/.well-known/agent-card.json" … "The resource at
 *   this URI MUST return an AgentCard object as defined in Section 4.4.1").
 *
 * This module is PURE — no Cosmos / Next / Fluent / network import — so the
 * whole generator + validator is unit-tested in isolation. It generates cards
 * from the agent metadata ALREADY REGISTERED in the platform (a published
 * data-agent or agent-flow workspace item, a mesh agent from the agent
 * registry, or the platform skill catalog); nothing about a card is authored by
 * hand at a call site.
 *
 * Wire compatibility: `generateAgentCard` emits the current-spec fields AND the
 * 0.3-line aliases (`protocolVersion` / `url` / `preferredTransport` /
 * `security` / `supportsAuthenticatedExtendedCard` / `additionalInterfaces`),
 * because the spec's own Appendix A keeps legacy names resolvable and unknown
 * fields are ignored by conformant clients. One document therefore satisfies
 * both a current-line client and the 0.3-line clients already in the field.
 *
 * Azure-native / sovereign: nothing here reaches Fabric or Power BI.
 */

import { trimTrailingSlashes } from '@/lib/util/trim';
import type { A2aAgentSkill } from './a2a-protocol';

// ---------------------------------------------------------------------------
// Spec constants
// ---------------------------------------------------------------------------

/**
 * The A2A protocol version each generated interface advertises. §4.4.6:
 * "The version of the A2A protocol this interface exposes. Use the latest
 * supported minor version per major version. Examples: '0.3', '1.0'".
 */
export const A2A_CARD_PROTOCOL_VERSION = '1.0';

/** The 0.3-line version echoed in the legacy alias fields for old clients. */
export const A2A_LEGACY_PROTOCOL_VERSION = '0.3';

/**
 * §4.4.6 `protocolBinding`: "This is an open form string … The core ones
 * officially supported are JSONRPC, GRPC and HTTP+JSON." Loom serves JSON-RPC.
 */
export const A2A_PROTOCOL_BINDING_JSONRPC = 'JSONRPC';

/** §14.3 Well-Known URI Registration — the registered discovery suffix. */
export const A2A_WELL_KNOWN_PATH = '/.well-known/agent-card.json';

/** The legacy (0.1/0.2-line) discovery path many deployed clients still probe. */
export const A2A_WELL_KNOWN_LEGACY_PATH = '/.well-known/agent.json';

// ---------------------------------------------------------------------------
// Spec types (§4.4.x / §4.5.x)
// ---------------------------------------------------------------------------

/** §4.4.6 AgentInterface — a (url, protocolBinding, tenant?, protocolVersion) tuple. */
export interface A2aAgentInterface {
  url: string;
  protocolBinding: string;
  /**
   * §4.4.6: "An opaque string used for routing requests to a specific agent or
   * tenant when multiple agents are served behind a single A2A endpoint. When
   * set, clients MUST include this value in the tenant field of all request
   * messages sent to this interface." Loom uses it to address ONE registered
   * agent behind the shared platform endpoint (`<kind>:<agentId>`).
   */
  tenant?: string;
  protocolVersion: string;
}

/** §4.4.4 AgentExtension — a declared protocol extension. */
export interface A2aAgentExtension {
  uri?: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

/** §4.4.3 AgentCapabilities. */
export interface A2aCardCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: A2aAgentExtension[];
  extendedAgentCard?: boolean;
}

/** §4.4.2 AgentProvider — BOTH fields are required by the spec. */
export interface A2aCardProvider {
  url: string;
  organization: string;
}

/** §4.5.3 HTTPAuthSecurityScheme. */
export interface A2aHttpAuthSecurityScheme {
  description?: string;
  scheme: string;
  bearerFormat?: string;
}

/** §4.5.1 SecurityScheme — a one-of wrapper (exactly one member present). */
export interface A2aCardSecurityScheme {
  apiKeySecurityScheme?: Record<string, unknown>;
  httpAuthSecurityScheme?: A2aHttpAuthSecurityScheme;
  oauth2SecurityScheme?: Record<string, unknown>;
  openIdConnectSecurityScheme?: Record<string, unknown>;
  mtlsSecurityScheme?: Record<string, unknown>;
}

/**
 * SecurityRequirement, in the shape the spec's §8.5 sample card uses:
 * `"securityRequirements": [{ "schemes": { "google": { "list": [...] } } }]`.
 */
export interface A2aCardSecurityRequirement {
  schemes: Record<string, { list: string[] }>;
}

/** §4.4.7 AgentCardSignature — the JWS (RFC 7515) JSON form. */
export interface A2aCardSignature {
  protected: string;
  signature: string;
  header?: Record<string, unknown>;
}

/** §4.4.5 AgentSkill (adds the current-spec `securityRequirements` member). */
export interface A2aCardSkill extends A2aAgentSkill {
  securityRequirements?: A2aCardSecurityRequirement[];
}

/** §4.4.1 AgentCard — current spec, plus the 0.3-line compat aliases. */
export interface A2aSpecAgentCard {
  // ── current-spec required ──
  name: string;
  description: string;
  supportedInterfaces: A2aAgentInterface[];
  version: string;
  capabilities: A2aCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aCardSkill[];
  // ── current-spec optional ──
  provider?: A2aCardProvider;
  documentationUrl?: string;
  securitySchemes?: Record<string, A2aCardSecurityScheme>;
  securityRequirements?: A2aCardSecurityRequirement[];
  signatures?: A2aCardSignature[];
  iconUrl?: string;
  // ── 0.3-line compat aliases (Appendix A keeps legacy names resolvable) ──
  /** @deprecated 0.3 alias of `supportedInterfaces[0].protocolVersion`. */
  protocolVersion?: string;
  /** @deprecated 0.3 alias of `supportedInterfaces[0].url`. */
  url?: string;
  /** @deprecated 0.3 alias of `supportedInterfaces[0].protocolBinding`. */
  preferredTransport?: string;
  /** @deprecated 0.3 alias of `supportedInterfaces.slice(1)`. */
  additionalInterfaces?: A2aAgentInterface[];
  /** @deprecated 0.3 alias of `securityRequirements`. */
  security?: Array<Record<string, string[]>>;
  /** @deprecated 0.3 alias of `capabilities.extendedAgentCard`. */
  supportsAuthenticatedExtendedCard?: boolean;
}

// ---------------------------------------------------------------------------
// Registered-agent metadata (the generator's INPUT)
// ---------------------------------------------------------------------------

/** Which platform registry an agent card is generated from. */
export type RegisteredAgentKind = 'platform' | 'data-agent' | 'agent-flow' | 'mesh';

/**
 * The normalized view of an agent ALREADY REGISTERED in Loom. Every adapter
 * below (`registeredAgentFromItem` / `registeredAgentFromMeshAgent` /
 * `registeredPlatformAgent`) produces this from real platform state; the
 * generator never invents metadata.
 */
export interface RegisteredAgentMeta {
  kind: RegisteredAgentKind;
  /** Stable platform id (the workspace item id / mesh agent id / 'platform'). */
  id: string;
  name: string;
  description: string;
  /** Semver-ish agent version — the item's published version when it has one. */
  version: string;
  /** Absolute A2A JSON-RPC endpoint for this agent. */
  endpoint: string;
  /** Extra interfaces (same functionality over another binding / a shared endpoint). */
  additionalInterfaces?: A2aAgentInterface[];
  skills: A2aCardSkill[];
  documentationUrl?: string;
  iconUrl?: string;
  /** Free-form provenance surfaced as a declared extension (never invented). */
  extensions?: A2aAgentExtension[];
  /** Whether the agent supports the authenticated extended card (§3.1.11). */
  extendedAgentCard?: boolean;
  streaming?: boolean;
  pushNotifications?: boolean;
}

/** Loom's provider block (§4.4.2 — `url` + `organization` both required). */
export const LOOM_AGENT_PROVIDER: A2aCardProvider = {
  organization: 'CSA Loom',
  url: 'https://csa-loom.limitlessdata.ai',
};

/** The Bearer scheme every Loom A2A endpoint accepts, in §4.5.1 one-of form. */
export const LOOM_BEARER_SCHEME_ID = 'loomBearer';

function loomSecuritySchemes(): Record<string, A2aCardSecurityScheme> {
  return {
    [LOOM_BEARER_SCHEME_ID]: {
      httpAuthSecurityScheme: {
        scheme: 'Bearer',
        bearerFormat: 'loom_pat',
        description:
          'A scoped Loom API token (Authorization: Bearer loom_pat_…) or a Console session cookie.',
      },
    },
  };
}

/** The card's §4.4.1 `securityRequirements` (and its 0.3 `security` alias). */
function loomSecurityRequirements(): A2aCardSecurityRequirement[] {
  return [{ schemes: { [LOOM_BEARER_SCHEME_ID]: { list: [] } } }];
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function trimSlashes(s: string): string {
  return trimTrailingSlashes(s || '');
}

/** The opaque §4.4.6 `tenant` routing id for a registered agent. */
export function agentInterfaceTenant(kind: RegisteredAgentKind, id: string): string | undefined {
  if (kind === 'platform') return undefined;
  return `${kind}:${id}`;
}

/**
 * Generate the spec-conformant Agent Card for one registered Loom agent.
 *
 * The first `supportedInterfaces` entry is the agent's own JSON-RPC endpoint
 * (§4.4.1: "The first entry is preferred"); any `additionalInterfaces` follow
 * in the order the caller registered them. Legacy 0.3 aliases mirror the
 * preferred interface so a 0.3-line client reading the same document still
 * finds `url` / `preferredTransport` / `protocolVersion`.
 */
export function generateAgentCard(meta: RegisteredAgentMeta): A2aSpecAgentCard {
  const preferred: A2aAgentInterface = {
    url: trimSlashes(meta.endpoint),
    protocolBinding: A2A_PROTOCOL_BINDING_JSONRPC,
    protocolVersion: A2A_CARD_PROTOCOL_VERSION,
    ...(agentInterfaceTenant(meta.kind, meta.id) ? { tenant: agentInterfaceTenant(meta.kind, meta.id) } : {}),
  };
  const extra = (meta.additionalInterfaces || []).filter((i) => i && i.url && i.protocolBinding);
  const supportedInterfaces = [preferred, ...extra];
  const capabilities: A2aCardCapabilities = {
    streaming: meta.streaming === true,
    pushNotifications: meta.pushNotifications === true,
    extendedAgentCard: meta.extendedAgentCard === true,
    ...(meta.extensions && meta.extensions.length ? { extensions: meta.extensions } : {}),
  };
  return {
    name: meta.name,
    description: meta.description,
    supportedInterfaces,
    version: meta.version || '1.0.0',
    capabilities,
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: meta.skills,
    provider: LOOM_AGENT_PROVIDER,
    ...(meta.documentationUrl ? { documentationUrl: meta.documentationUrl } : {}),
    ...(meta.iconUrl ? { iconUrl: meta.iconUrl } : {}),
    securitySchemes: loomSecuritySchemes(),
    securityRequirements: loomSecurityRequirements(),
    // ── 0.3-line aliases (see the module header) ──
    protocolVersion: A2A_LEGACY_PROTOCOL_VERSION,
    url: preferred.url,
    preferredTransport: preferred.protocolBinding,
    ...(extra.length ? { additionalInterfaces: extra } : {}),
    security: [{ [LOOM_BEARER_SCHEME_ID]: [] }],
    supportsAuthenticatedExtendedCard: meta.extendedAgentCard === true,
  };
}

// ---------------------------------------------------------------------------
// Adapters — registered platform metadata → RegisteredAgentMeta
// ---------------------------------------------------------------------------

/** The minimum workspace-item shape a card is generated from (no import cycle). */
export interface AgentItemLike {
  id: string;
  displayName?: string;
  description?: string;
  state?: Record<string, unknown> | null;
}

/** A2A skill-id slug for a published item agent (kebab, stable, id-safe). */
export function itemAgentSkillId(nameOrId: string): string {
  const slug = (nameOrId || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'agent';
  return `ask-${slug}`;
}

/** Read a published item's version from its registered state (never invented). */
function itemVersion(state: Record<string, unknown> | null | undefined): string {
  const v = state?.publishedVersion ?? state?.version;
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  return s || '1.0.0';
}

/**
 * Build the registered-agent metadata for a published `data-agent` /
 * `agent-flow` workspace item. `endpoint` is the item's own A2A JSON-RPC route;
 * `platformEndpoint` (optional) is registered as an ADDITIONAL interface with
 * the §4.4.6 `tenant` routing id, so a client that only knows the shared
 * platform endpoint can still address this agent.
 */
export function registeredAgentFromItem(opts: {
  item: AgentItemLike;
  kind: 'data-agent' | 'agent-flow';
  endpoint: string;
  platformEndpoint?: string;
  documentationUrl?: string;
}): RegisteredAgentMeta {
  const label = opts.kind === 'agent-flow' ? 'agent flow' : 'data agent';
  const name = opts.item.displayName?.trim() || (opts.kind === 'agent-flow' ? 'Agent flow' : 'Data agent');
  const state = (opts.item.state || {}) as Record<string, unknown>;
  const description =
    opts.item.description?.trim() ||
    `A published CSA Loom ${label}, delegable over A2A. It answers grounded on its configured Azure-native backend, governed by the caller's Loom permissions.`;
  const skillId = itemAgentSkillId(name);
  const tenant = agentInterfaceTenant(opts.kind, opts.item.id);
  const additional: A2aAgentInterface[] = opts.platformEndpoint
    ? [{
        url: trimSlashes(opts.platformEndpoint),
        protocolBinding: A2A_PROTOCOL_BINDING_JSONRPC,
        protocolVersion: A2A_CARD_PROTOCOL_VERSION,
        ...(tenant ? { tenant } : {}),
      }]
    : [];
  return {
    kind: opts.kind,
    id: opts.item.id,
    name,
    description,
    version: itemVersion(state),
    endpoint: opts.endpoint,
    additionalInterfaces: additional,
    documentationUrl: opts.documentationUrl,
    skills: [{
      id: skillId,
      name: `Ask ${name}`,
      description:
        `Delegate a natural-language task to the "${name}" Loom ${label}. Send a text part with the request; ` +
        `it runs the ${label}'s real, governed backend and returns the answer.`,
      tags: [opts.kind, 'nl-query', 'grounded', 'governed'],
      examples: [`Ask ${name}: "summarize the latest results"`],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: loomSecurityRequirements(),
    }],
  };
}

/** The minimum mesh-agent shape a card is generated from (no import cycle). */
export interface MeshAgentLike {
  id: string;
  name: string;
  description?: string;
  kind: string;
  egressProfile?: string;
}

/**
 * Build the registered-agent metadata for a WS-9 mesh agent. The agent's egress
 * profile is declared as a §4.4.4 `AgentExtension` (rather than the previous
 * non-spec top-level `loomEgressProfile` key), so the information survives into
 * a conformant card instead of being dropped by a strict client.
 */
export function registeredAgentFromMeshAgent(opts: {
  agent: MeshAgentLike;
  endpoint: string;
  documentationUrl?: string;
}): RegisteredAgentMeta {
  const a = opts.agent;
  const description =
    a.description?.trim() ||
    `Delegate a natural-language task to the "${a.name}" ${a.kind} agent. It answers grounded on its in-VNet tools; the result is policy-governed.`;
  return {
    kind: 'mesh',
    id: a.id,
    name: a.name,
    description,
    version: '1.0.0',
    endpoint: opts.endpoint,
    documentationUrl: opts.documentationUrl,
    extensions: a.egressProfile
      ? [{
          uri: 'https://csa-loom.limitlessdata.ai/a2a/extensions/egress-profile/v1',
          description:
            `Loom sovereign egress profile enforced on this agent ("${a.egressProfile}"): outbound A2A calls are ` +
            'restricted to the hosts that profile allows, and fail CLOSED when the profile is air-gapped.',
          required: false,
          params: { egressProfile: a.egressProfile },
        }]
      : undefined,
    skills: [{
      id: `delegate-${a.kind}`,
      name: `${a.name} task`,
      description,
      tags: [a.kind, 'loom', 'governed', ...(a.egressProfile ? [a.egressProfile] : [])],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: loomSecurityRequirements(),
    }],
  };
}

/**
 * Build the registered-agent metadata for the PLATFORM card served at
 * `/.well-known/agent-card.json` — Loom itself, advertising its platform skill
 * catalog at `/api/a2a`.
 */
export function registeredPlatformAgent(opts: {
  origin: string;
  skills: A2aCardSkill[];
}): RegisteredAgentMeta {
  const origin = trimSlashes(opts.origin);
  return {
    kind: 'platform',
    id: 'platform',
    name: 'CSA Loom',
    description:
      'CSA Loom exposes its governed data agents, agent flows, and WS-6 ontology objects/actions (OSDK) as ' +
      "delegable A2A tasks. Delegate a task in and receive a result governed by the caller's Loom permissions, " +
      'PDP policy, and audit — Azure-native, sovereign, no Microsoft Fabric dependency.',
    version: '1.0.0',
    endpoint: `${origin}/api/a2a`,
    documentationUrl: `${origin}/learn`,
    skills: opts.skills,
  };
}

// ---------------------------------------------------------------------------
// Validator (§4.4.1 – §4.4.7)
// ---------------------------------------------------------------------------

/** The result of validating a card against the current spec. */
export interface AgentCardValidation {
  /** True when there are ZERO errors (warnings do not fail conformance). */
  ok: boolean;
  /** Spec violations — each names the offending field + its §-number. */
  errors: string[];
  /** Non-fatal observations (e.g. a non-HTTPS interface URL). */
  warnings: string[];
}

const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateInterface(i: unknown, idx: number, errors: string[], warnings: string[]): void {
  const it = i as Record<string, unknown> | null;
  const at = `supportedInterfaces[${idx}]`;
  if (!it || typeof it !== 'object') {
    errors.push(`${at} must be an AgentInterface object (§4.4.6)`);
    return;
  }
  if (!nonEmptyString(it.url)) errors.push(`${at}.url is required (§4.4.6)`);
  if (!nonEmptyString(it.protocolBinding)) errors.push(`${at}.protocolBinding is required (§4.4.6)`);
  if (!nonEmptyString(it.protocolVersion)) errors.push(`${at}.protocolVersion is required (§4.4.6)`);
  if (it.tenant !== undefined && !nonEmptyString(it.tenant)) {
    errors.push(`${at}.tenant, when present, must be a non-empty opaque string (§4.4.6)`);
  }
  if (nonEmptyString(it.url) && !/^https:\/\//i.test(it.url) && !/^[\w.-]+:\d+$/.test(it.url)) {
    warnings.push(
      `${at}.url is not an absolute HTTPS URL — §4.4.6 requires HTTPS in production for HTTP-based transports`,
    );
  }
}

function validateSkill(s: unknown, idx: number, errors: string[], warnings: string[]): void {
  const sk = s as Record<string, unknown> | null;
  const at = `skills[${idx}]`;
  if (!sk || typeof sk !== 'object') {
    errors.push(`${at} must be an AgentSkill object (§4.4.5)`);
    return;
  }
  if (!nonEmptyString(sk.id)) errors.push(`${at}.id is required (§4.4.5)`);
  if (!nonEmptyString(sk.name)) errors.push(`${at}.name is required (§4.4.5)`);
  if (!nonEmptyString(sk.description)) errors.push(`${at}.description is required (§4.4.5)`);
  if (!Array.isArray(sk.tags)) errors.push(`${at}.tags is required and must be an array of string (§4.4.5)`);
  else if (!sk.tags.every((t) => nonEmptyString(t))) errors.push(`${at}.tags must contain only non-empty strings (§4.4.5)`);
  for (const modeKey of ['inputModes', 'outputModes'] as const) {
    const v = sk[modeKey];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((m) => nonEmptyString(m) && MEDIA_TYPE_RE.test(m))) {
      warnings.push(`${at}.${modeKey} should be an array of media types (§4.4.5)`);
    }
  }
}

const SECURITY_SCHEME_MEMBERS = [
  'apiKeySecurityScheme',
  'httpAuthSecurityScheme',
  'oauth2SecurityScheme',
  'openIdConnectSecurityScheme',
  'mtlsSecurityScheme',
] as const;

/**
 * Validate a candidate Agent Card against the CURRENT spec (§4.4.1 – §4.5.1).
 * Pure + total: never throws, always returns a report. Used by the card routes
 * (so a generated card is proven conformant before it is served) and by the
 * unit tests.
 */
export function validateAgentCard(card: unknown): AgentCardValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, errors: ['the agent card must be a JSON object (§4.4.1)'], warnings };
  }
  const c = card as Record<string, unknown>;

  if (!nonEmptyString(c.name)) errors.push('name is required (§4.4.1)');
  if (!nonEmptyString(c.description)) errors.push('description is required (§4.4.1)');
  if (!nonEmptyString(c.version)) errors.push('version is required (§4.4.1)');

  if (!Array.isArray(c.supportedInterfaces) || c.supportedInterfaces.length === 0) {
    errors.push('supportedInterfaces is required and must list at least one AgentInterface (§4.4.1)');
  } else {
    c.supportedInterfaces.forEach((i, idx) => validateInterface(i, idx, errors, warnings));
  }

  if (!c.capabilities || typeof c.capabilities !== 'object' || Array.isArray(c.capabilities)) {
    errors.push('capabilities is required and must be an AgentCapabilities object (§4.4.1/§4.4.3)');
  } else {
    const cap = c.capabilities as Record<string, unknown>;
    for (const b of ['streaming', 'pushNotifications', 'extendedAgentCard'] as const) {
      if (cap[b] !== undefined && typeof cap[b] !== 'boolean') {
        errors.push(`capabilities.${b} must be a boolean when present (§4.4.3)`);
      }
    }
    if (cap.extensions !== undefined && !Array.isArray(cap.extensions)) {
      errors.push('capabilities.extensions must be an array of AgentExtension when present (§4.4.3/§4.4.4)');
    }
  }

  for (const modeKey of ['defaultInputModes', 'defaultOutputModes'] as const) {
    const v = c[modeKey];
    if (!Array.isArray(v) || v.length === 0) errors.push(`${modeKey} is required and must be a non-empty array (§4.4.1)`);
    else if (!v.every((m) => nonEmptyString(m) && MEDIA_TYPE_RE.test(m))) {
      warnings.push(`${modeKey} should contain media types (e.g. "text/plain") (§4.4.1)`);
    }
  }

  if (!Array.isArray(c.skills)) errors.push('skills is required and must be an array of AgentSkill (§4.4.1)');
  else c.skills.forEach((s, idx) => validateSkill(s, idx, errors, warnings));

  if (c.provider !== undefined) {
    const p = c.provider as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') errors.push('provider must be an AgentProvider object when present (§4.4.2)');
    else {
      if (!nonEmptyString(p.organization)) errors.push('provider.organization is required (§4.4.2)');
      if (!nonEmptyString(p.url)) errors.push('provider.url is required (§4.4.2)');
    }
  }

  if (c.securitySchemes !== undefined) {
    const ss = c.securitySchemes as Record<string, unknown> | null;
    if (!ss || typeof ss !== 'object' || Array.isArray(ss)) {
      errors.push('securitySchemes must be a map of string to SecurityScheme when present (§4.4.1)');
    } else {
      for (const [id, scheme] of Object.entries(ss)) {
        const sc = scheme as Record<string, unknown> | null;
        if (!sc || typeof sc !== 'object') {
          errors.push(`securitySchemes["${id}"] must be a SecurityScheme object (§4.5.1)`);
          continue;
        }
        const present = SECURITY_SCHEME_MEMBERS.filter((m) => sc[m] !== undefined);
        if (present.length !== 1) {
          errors.push(
            `securitySchemes["${id}"] must contain exactly one of ${SECURITY_SCHEME_MEMBERS.join(', ')} (§4.5.1) — found ${present.length}`,
          );
        }
        const http = sc.httpAuthSecurityScheme as Record<string, unknown> | undefined;
        if (http && !nonEmptyString(http.scheme)) {
          errors.push(`securitySchemes["${id}"].httpAuthSecurityScheme.scheme is required (§4.5.3)`);
        }
      }
    }
  }

  if (c.securityRequirements !== undefined) {
    if (!Array.isArray(c.securityRequirements)) {
      errors.push('securityRequirements must be an array of SecurityRequirement when present (§4.4.1)');
    } else {
      c.securityRequirements.forEach((r, idx) => {
        const rr = r as Record<string, unknown> | null;
        if (!rr || typeof rr !== 'object' || typeof rr.schemes !== 'object' || rr.schemes === null) {
          errors.push(`securityRequirements[${idx}].schemes must be a map of scheme id to { list: string[] } (§4.4.1)`);
        }
      });
    }
  }

  if (c.signatures !== undefined) {
    if (!Array.isArray(c.signatures)) errors.push('signatures must be an array of AgentCardSignature when present (§4.4.7)');
    else {
      c.signatures.forEach((s, idx) => {
        const sg = s as Record<string, unknown> | null;
        if (!sg || typeof sg !== 'object') { errors.push(`signatures[${idx}] must be an AgentCardSignature object (§4.4.7)`); return; }
        if (!nonEmptyString(sg.protected)) errors.push(`signatures[${idx}].protected is required (§4.4.7)`);
        if (!nonEmptyString(sg.signature)) errors.push(`signatures[${idx}].signature is required (§4.4.7)`);
      });
    }
  }

  if (c.iconUrl !== undefined && !nonEmptyString(c.iconUrl)) {
    errors.push('iconUrl must be a non-empty string when present (§4.4.1)');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Generate a card and validate it in one step. Throws only on a PROGRAMMING
 * error (a generated card that violates the spec) — routes surface the report
 * instead, so a conformance regression is visible rather than silent.
 */
export function generateValidatedAgentCard(
  meta: RegisteredAgentMeta,
): { card: A2aSpecAgentCard; validation: AgentCardValidation } {
  const card = generateAgentCard(meta);
  return { card, validation: validateAgentCard(card) };
}

// ---------------------------------------------------------------------------
// Discovery catalog
// ---------------------------------------------------------------------------

/** One row of the authenticated agent-card discovery catalog. */
export interface AgentCardCatalogEntry {
  kind: RegisteredAgentKind;
  id: string;
  name: string;
  description: string;
  /** Absolute URL that serves this agent's card. */
  cardUrl: string;
  /** The agent's A2A JSON-RPC endpoint (the preferred interface url). */
  endpoint: string;
  /** §4.4.6 routing id for addressing this agent behind the platform endpoint. */
  tenant?: string;
  skillIds: string[];
  /** Whether the generated card passes `validateAgentCard`. */
  conformant: boolean;
}

/** Build the catalog row for a registered agent (card generated + validated). */
export function agentCardCatalogEntry(meta: RegisteredAgentMeta, cardUrl: string): AgentCardCatalogEntry {
  const { card, validation } = generateValidatedAgentCard(meta);
  return {
    kind: meta.kind,
    id: meta.id,
    name: card.name,
    description: card.description,
    cardUrl,
    endpoint: card.supportedInterfaces[0]?.url || '',
    tenant: card.supportedInterfaces[0]?.tenant,
    skillIds: card.skills.map((s) => s.id),
    conformant: validation.ok,
  };
}
