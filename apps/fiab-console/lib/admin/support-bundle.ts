/**
 * DIAG1 — one-click diagnostics / support bundle (assembler + redactor).
 *
 * No single export of {gate state, env posture, health probes, config
 * snapshot, version} existed for incident triage. This module assembles that
 * bundle from the REAL in-process registries + probes the route feeds it, and
 * — critically — SCRUBS it: env values are masked at source (maskValue →
 * secrets become '***') AND every free-text field is run through a secret
 * scrubber as defence-in-depth, so a support bundle can be safely attached to
 * an incident ticket with ZERO secrets, tokens, or connection strings.
 *
 * The scrubber + env-posture masking are the security-critical PURE core and
 * are unit-tested (support-bundle.test.ts) against seeded fake secrets. The
 * route (app/api/admin/diagnostics/bundle) is the only place that reads live
 * backends; everything here is pure over its inputs.
 *
 * NO Fabric / Power BI dependency (no-vaporware.md, no-fabric-dependency.md).
 */

import type { EnvSpec } from '@/lib/admin/env-checks';
import { maskValue } from '@/lib/admin/env-config';

export const SUPPORT_BUNDLE_SCHEMA = 'loom-support-bundle/v1';

// ── Secret scrubber (PURE — the security-critical core) ─────────────────────

/**
 * Ordered redaction rules. Each replaces the SECRET part of a match with
 * '***REDACTED***' while keeping enough context to stay diagnostically useful
 * (the key name, the scheme). Deliberately TARGETED — it must not nuke resource
 * GUIDs, build SHAs, or ISO timestamps (those are safe and useful in a bundle).
 */
const REDACTED = '***REDACTED***';
const SCRUB_RULES: Array<{ re: RegExp; replace: (m: string, ...g: string[]) => string }> = [
  // JWT / AAD access tokens (three base64url segments).
  { re: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, replace: () => `${REDACTED}(jwt)` },
  // Authorization: Bearer <token>
  { re: /(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replace: (_m, p1: string) => `${p1}${REDACTED}` },
  // Storage / SAS keys: AccountKey=, SharedAccessKey=, sig=, sv=&sig=
  { re: /(AccountKey|SharedAccessKey|SharedSecretValue)=([^;&"\s]+)/gi, replace: (_m, k: string) => `${k}=${REDACTED}` },
  { re: /([?&]sig=)[^&"\s]+/gi, replace: (_m, p1: string) => `${p1}${REDACTED}` },
  // Connection-string password / pwd / secret assignments.
  { re: /(Password|Pwd|AccountSecret|ClientSecret)=([^;&"\s]+)/gi, replace: (_m, k: string) => `${k}=${REDACTED}` },
  // key=value where the KEY name implies a secret (SECRET/PASSWORD/TOKEN/KEY/
  // CONNECTIONSTRING/ACCOUNTKEY), JSON or env form. Group 1 = key+separator.
  {
    re: /(["']?[A-Za-z0-9_.-]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|ACCOUNTKEY|CONN(?:ECTION)?STRING)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^"',;\s}]{4,})/gi,
    replace: (_m, p1: string) => `${p1}${REDACTED}`,
  },
  // Azure Storage account keys — 86–88 char base64 ending in '=='.
  { re: /[A-Za-z0-9+/]{86,88}==/g, replace: () => `${REDACTED}(key)` },
];

/** Scrub secrets from a single string (idempotent). */
export function scrubSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const rule of SCRUB_RULES) out = out.replace(rule.re, rule.replace as (m: string, ...g: string[]) => string);
  return out;
}

/**
 * Recursively scrub every string in a JSON-serializable value. Object KEYS are
 * preserved (they are field names, not secrets); string VALUES are scrubbed.
 * The defence-in-depth net over free-text fields (probe errors, audit detail,
 * synthetic-run notes) that env-masking at source does not cover.
 */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v);
    return out as T;
  }
  return value;
}

// ── Env posture (masked at source) ──────────────────────────────────────────

/** One env var's presence + MASKED value (secrets → '***', never the value). */
export interface EnvVarPosture {
  key: string;
  present: boolean;
  /** Masked: secret keys → '***'; plain keys → their value; absent → ''. */
  value: string;
}

/** Flatten the env var names an EnvSpec references (required + anyOf groups). */
export function envVarKeysOf(spec: Pick<EnvSpec, 'required' | 'anyOf'>): string[] {
  const keys = new Set<string>();
  for (const k of spec.required ?? []) keys.add(k);
  for (const group of spec.anyOf ?? []) for (const k of group) keys.add(k);
  return [...keys];
}

/**
 * Build the MASKED env posture for every var referenced by the ENV_CHECKS
 * specs, from an env snapshot. Secret values NEVER appear — `maskValue`
 * collapses them to '***'. Sorted + de-duplicated for a stable bundle.
 */
export function buildEnvPosture(
  specs: ReadonlyArray<Pick<EnvSpec, 'required' | 'anyOf'>>,
  env: Record<string, string | undefined>,
): EnvVarPosture[] {
  const keys = new Set<string>();
  for (const s of specs) for (const k of envVarKeysOf(s)) keys.add(k);
  return [...keys]
    .sort()
    .map((key) => {
      const raw = env[key];
      const present = raw != null && String(raw).trim() !== '';
      return { key, present, value: present ? maskValue(key, raw) : '' };
    });
}

// ── The assembled bundle ────────────────────────────────────────────────────

export interface GatePosture {
  id: string;
  status: string;
  missing: string[];
  availability?: string;
}
export interface ProbeResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}
export interface BundleVersion {
  version: string;
  sha?: string;
  stamp?: string;
  /** ACA revision serving this replica (CONTAINER_APP_REVISION). */
  revision?: string;
  app?: string;
  cloud?: string;
}
export interface SyntheticRunLite {
  runId: string;
  ts: string;
  pass: number;
  fail: number;
  skip: number;
}
export interface AuditRowLite {
  at: string;
  who: string;
  kind: string;
  target?: string;
}

export interface SupportBundle {
  schema: typeof SUPPORT_BUNDLE_SCHEMA;
  generatedAt: string;
  generatedBy: string;
  version: BundleVersion;
  gateSummary: { total: number; configured: number; blocked: number; cloudUnavailable: number };
  gates: GatePosture[];
  env: EnvVarPosture[];
  probes: ProbeResult[];
  lastSyntheticRun?: SyntheticRunLite;
  recentAudit: AuditRowLite[];
  /** Honest notes for feeds that are absent in this deployment (never silent). */
  notes: string[];
}

/** Inputs the route resolves from the real registries/backends (pure here). */
export interface SupportBundleInputs {
  now: Date;
  generatedBy: string;
  version: BundleVersion;
  gates: GatePosture[];
  env: EnvVarPosture[];
  probes: ProbeResult[];
  lastSyntheticRun?: SyntheticRunLite;
  recentAudit: AuditRowLite[];
  notes: string[];
}

/**
 * Assemble + SCRUB the support bundle. Env is already masked at source; the
 * final `scrubDeep` is the defence-in-depth pass over every field so nothing —
 * a token accidentally logged into a probe error, a connection string in an
 * audit detail — can leak. The returned object is safe to serialize + attach.
 */
export function assembleSupportBundle(inputs: SupportBundleInputs): SupportBundle {
  const configured = inputs.gates.filter((g) => g.status === 'configured').length;
  const blocked = inputs.gates.filter((g) => g.status === 'blocked').length;
  const cloudUnavailable = inputs.gates.filter((g) => g.status === 'cloud-unavailable').length;
  const bundle: SupportBundle = {
    schema: SUPPORT_BUNDLE_SCHEMA,
    generatedAt: inputs.now.toISOString(),
    generatedBy: inputs.generatedBy,
    version: inputs.version,
    gateSummary: { total: inputs.gates.length, configured, blocked, cloudUnavailable },
    gates: inputs.gates,
    env: inputs.env,
    probes: inputs.probes,
    lastSyntheticRun: inputs.lastSyntheticRun,
    recentAudit: inputs.recentAudit,
    notes: inputs.notes,
  };
  // Defence in depth: scrub the WHOLE bundle. Env values are already masked;
  // this catches anything free-text (errors, audit detail, run notes).
  return scrubDeep(bundle);
}

/** Stable download filename for a bundle (safe chars only). */
export function supportBundleFilename(now: Date, sha?: string): string {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const tag = sha ? `-${sha.slice(0, 8)}` : '';
  return `loom-support-bundle-${ts}${tag}.json`;
}
