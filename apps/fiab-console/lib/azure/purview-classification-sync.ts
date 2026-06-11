/**
 * Taxonomy → Microsoft Purview classification sync.
 *
 * Maps Loom's tenant classification TAXONOMY (the custom classification rules
 * managed at /admin/classifications, stored in Cosmos) onto REAL Microsoft
 * Purview CLASSIC Data Map objects so the taxonomy actually classifies data on
 * a scan instead of only living in Cosmos:
 *
 *   1. ensureClassificationDefs([namespaced])  — the Atlas classification
 *      typedef so the catalog knows the classification exists.
 *   2. upsertCustomClassificationRule(...)      — a Purview CUSTOM classification
 *      rule that matches columns / data values and applies the classification.
 *   3. upsertScanRuleset(...)                   — a per-source-kind CUSTOM scan
 *      rule set that INCLUDES the custom rules, so a scan that uses it
 *      auto-assigns the classifications (System rule sets never include custom
 *      classifications — Purview best-practice).
 *
 * Honest-gate behavior (per .claude/rules/no-vaporware.md):
 *   - LOOM_PURVIEW_ACCOUNT unset → NOT an error; returns
 *     { purviewConfigured:false, synced:false, hint } so the caller (the
 *     classifications BFF) can still save to Cosmos and the UI renders a
 *     MessageBar naming LOOM_PURVIEW_ACCOUNT. NEVER fabricated success.
 *   - A 401/403/4xx from the scan plane is surfaced verbatim in `error` (the
 *     UAMI lacks Data Source Administrator) — the Cosmos write is NOT failed.
 *
 * No Microsoft Fabric / Power BI dependency: the classic Data Map scan plane is
 * Azure-native and works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * Grounded in:
 *   https://learn.microsoft.com/purview/data-map-classification-custom
 *   https://learn.microsoft.com/purview/data-map-scan-rule-set
 *   https://learn.microsoft.com/purview/data-gov-best-practices-classification
 */
import {
  ensureClassificationDefs,
  upsertCustomClassificationRule,
  upsertScanRuleset,
  deleteCustomClassificationRule,
  isPurviewConfigured,
  getPurviewAccountName,
  notConfiguredHint,
  PurviewError,
  type PurviewNotConfiguredHint,
} from './purview-client';

/** A single Loom classification rule from the Cosmos taxonomy. */
export interface LoomClassificationRule {
  id: string;
  name: string;
  matchStrategy: 'column-name-regex' | 'data-regex' | 'dictionary';
  matchValue: string;
  classification: string;
}

/** Result of pushing the taxonomy into Purview. */
export interface ClassificationSyncResult {
  purviewConfigured: boolean;
  account: string | null;
  synced: boolean;
  /** Number of Loom rules pushed as Purview custom classification rules. */
  ruleCount: number;
  /** The Purview objects created/updated (for the UI to surface). */
  syncedRules: { loomRuleId: string; purviewRuleName: string; classificationName: string }[];
  /** The CUSTOM scan rule sets (one per source kind) that include the rules. */
  scanRulesets: { name: string; kind: string }[];
  /** Honest-gate hint when not configured. */
  hint?: PurviewNotConfiguredHint;
  /** Verbatim upstream error (e.g. role missing) — Cosmos write still succeeds. */
  error?: string;
}

/**
 * Default data-source KINDS Loom builds a CUSTOM scan rule set for. These are
 * the Azure-native backends Loom registers as Purview data sources (ADLS Gen2
 * for lakehouse/Delta, Azure SQL for the Synapse/warehouse path) — see
 * .claude/rules/no-fabric-dependency.md. No Fabric/OneLake kinds.
 */
export const DEFAULT_SCAN_RULESET_KINDS = ['AdlsGen2', 'AzureSqlDatabase'] as const;

/** 8-char alphanumeric tenant slug (UPPER) for the classification namespace. */
function tenantSlug(tenantId: string): string {
  return (tenantId || 'tenant').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8).toUpperCase() || 'TENANT';
}

/**
 * Namespaced classification name applied to assets — best-practice format
 * `LOOM.<TENANT>.<CLASSIFICATION>` (cf. MICROSOFT.GOVERNMENT.US.SOCIAL_SECURITY_NUMBER).
 * Custom classifications MUST be namespaced; this also keeps them distinct from
 * the System (MICROSOFT.*) classifications.
 */
export function classificationName(tenantId: string, classification: string): string {
  const c = (classification || 'CLASSIFICATION').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'CLASSIFICATION';
  return `LOOM.${tenantSlug(tenantId)}.${c}`;
}

/**
 * Purview classification-rule RESOURCE name (the {name} in the PUT path).
 * Purview rule names are alphanumeric/underscore only, so we slugify the Loom
 * rule name and namespace it by tenant for uniqueness across tenants.
 */
export function classificationRuleName(tenantId: string, ruleName: string): string {
  const r = (ruleName || 'rule').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'rule';
  return `Loom_${tenantSlug(tenantId)}_${r}`;
}

/** Scan-rule-set RESOURCE name for a given source kind. */
export function scanRulesetName(tenantId: string, kind: string): string {
  const k = (kind || 'kind').replace(/[^a-zA-Z0-9]+/g, '_');
  return `Loom_${tenantSlug(tenantId)}_${k}`;
}

/**
 * Escape a literal string for safe embedding inside a regex character class /
 * alternation (used for the dictionary strategy).
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate a Loom rule's matchStrategy + matchValue into Purview regex
 * pattern arrays.
 *   - column-name-regex → columnPatterns: [matchValue as-is]
 *   - data-regex        → dataPatterns:   [matchValue as-is]
 *   - dictionary        → dataPatterns:   [\b(w1|w2|w3)\b] (comma-split, escaped)
 *
 * NOTE: Loom's regex passes through verbatim — Purview validates it (custom
 * classification rules are English-only; an invalid/non-Latin pattern surfaces
 * Purview's error rather than being silently dropped).
 */
export function rulePatterns(rule: LoomClassificationRule): { columnPatterns: string[]; dataPatterns: string[] } {
  const v = (rule.matchValue || '').trim();
  if (!v) return { columnPatterns: [], dataPatterns: [] };
  if (rule.matchStrategy === 'column-name-regex') return { columnPatterns: [v], dataPatterns: [] };
  if (rule.matchStrategy === 'data-regex') return { columnPatterns: [], dataPatterns: [v] };
  // dictionary → a word-boundary alternation of the comma-separated words.
  const words = v.split(',').map((w) => w.trim()).filter(Boolean).map(escapeRegex);
  if (!words.length) return { columnPatterns: [], dataPatterns: [] };
  return { columnPatterns: [], dataPatterns: [`\\b(${words.join('|')})\\b`] };
}

/**
 * Push the full Loom classification taxonomy into Purview. Best-effort: a
 * not-configured account returns a non-error gate result; an upstream failure
 * is captured in `error`. Callers (the BFF) MUST NOT fail their Cosmos write on
 * a non-synced result.
 *
 * @param rules   the tenant's Loom classification rules (from Cosmos)
 * @param tenantId the tenant oid (used for the LOOM.<TENANT> namespace)
 * @param opts.kinds source-kind list for the CUSTOM scan rule sets
 */
export async function syncClassificationTaxonomyToPurview(
  rules: LoomClassificationRule[],
  tenantId: string,
  opts: { kinds?: readonly string[] } = {},
): Promise<ClassificationSyncResult> {
  const account = getPurviewAccountName();
  if (!isPurviewConfigured()) {
    // Honest gate — not an error. Surface the same structured hint the client
    // throws on a not-configured call, computed directly (no dead probe: an
    // empty-array ensureClassificationDefs() early-returns and never throws).
    return {
      purviewConfigured: false,
      account: null,
      synced: false,
      ruleCount: 0,
      syncedRules: [],
      scanRulesets: [],
      hint: notConfiguredHint('LOOM_PURVIEW_ACCOUNT'),
    };
  }

  const kinds = (opts.kinds && opts.kinds.length ? opts.kinds : DEFAULT_SCAN_RULESET_KINDS);
  const valid = (rules || []).filter((r) => r && r.name && r.matchValue && r.classification);

  try {
    const syncedRules: ClassificationSyncResult['syncedRules'] = [];
    const ruleNames: string[] = [];

    // The set of namespaced classifications referenced by the rules — ensure
    // each exists as an Atlas classification typedef first (idempotent).
    const classNames = [...new Set(valid.map((r) => classificationName(tenantId, r.classification)))];
    if (classNames.length) await ensureClassificationDefs(classNames);

    for (const r of valid) {
      const cName = classificationName(tenantId, r.classification);
      const ruleName = classificationRuleName(tenantId, r.name);
      const { columnPatterns, dataPatterns } = rulePatterns(r);
      if (!columnPatterns.length && !dataPatterns.length) continue;
      await upsertCustomClassificationRule({
        name: ruleName,
        classificationName: cName,
        description: `Loom taxonomy rule "${r.name}" → ${r.classification} (${r.matchStrategy})`,
        columnPatterns,
        dataPatterns,
        // 60% is the Purview default min match for data patterns; column-name-only
        // rules ignore it. Keeps parity with the portal's default.
        ...(dataPatterns.length ? { minimumPercentageMatch: 60 } : {}),
      });
      ruleNames.push(ruleName);
      syncedRules.push({ loomRuleId: r.id, purviewRuleName: ruleName, classificationName: cName });
    }

    // Roll every rule into one CUSTOM scan rule set per source kind, so a scan
    // that selects scanRulesetType:'Custom' applies the whole taxonomy.
    const scanRulesets: ClassificationSyncResult['scanRulesets'] = [];
    if (ruleNames.length) {
      for (const kind of kinds) {
        const name = scanRulesetName(tenantId, kind);
        await upsertScanRuleset({
          name,
          kind,
          description: `Loom classification taxonomy (${ruleNames.length} rule(s)) for ${kind} sources.`,
          includedCustomClassificationRuleNames: ruleNames,
        });
        scanRulesets.push({ name, kind });
      }
    }

    return {
      purviewConfigured: true,
      account,
      synced: true,
      ruleCount: syncedRules.length,
      syncedRules,
      scanRulesets,
    };
  } catch (e) {
    // Upstream failure (e.g. UAMI lacks Data Source Administrator). Surface it,
    // but do NOT fail — the caller keeps the Cosmos write.
    const msg = e instanceof PurviewError ? e.message : (e as any)?.message || String(e);
    return {
      purviewConfigured: true,
      account,
      synced: false,
      ruleCount: 0,
      syncedRules: [],
      scanRulesets: [],
      error: msg,
    };
  }
}

/**
 * Remove a single Loom rule's Purview custom classification rule (best-effort).
 * Used when a rule is deleted from the Cosmos taxonomy so the Purview side does
 * not drift. Never throws — returns whether the delete happened (or the reason
 * it didn't). The scan rule set keeps the remaining rule names (re-synced by
 * the caller after the delete).
 */
export async function removeClassificationRuleFromPurview(
  tenantId: string,
  loomRuleName: string,
): Promise<{ purviewConfigured: boolean; deleted: boolean; error?: string }> {
  if (!isPurviewConfigured()) return { purviewConfigured: false, deleted: false };
  try {
    const deleted = await deleteCustomClassificationRule(classificationRuleName(tenantId, loomRuleName));
    return { purviewConfigured: true, deleted };
  } catch (e) {
    const msg = e instanceof PurviewError ? e.message : (e as any)?.message || String(e);
    return { purviewConfigured: true, deleted: false, error: msg };
  }
}
