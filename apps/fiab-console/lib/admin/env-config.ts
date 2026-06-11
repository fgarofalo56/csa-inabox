/**
 * Editable runtime-config (env-var) registry for /admin/env-config.
 *
 * This is the **no-freeform-config whitelist** (per .claude/rules/loom_no_freeform_config):
 * the env-config admin surface accepts ONLY keys present in EDITABLE_ENV — any
 * other key in a PUT body is dropped, exactly like tenant-settings' validKeys.
 *
 * The registry is DERIVED from `self-audit.ts:ENV_CHECKS` (the single declarative
 * source of every LOOM_ / SESSION_SECRET runtime var, grouped by category +
 * severity, each with its remediation) so the two surfaces never drift. We
 * flatten the `required` + `anyOf` groups into individual editable keys and
 * layer on:
 *   - `secret`  — value is sensitive (SESSION_SECRET / *_KEY / *CONNECTION* /
 *                 *PASSWORD*). The UI never renders a current secret value and
 *                 the write path routes it through an ACA secret, never a plain
 *                 env value.
 *   - `valueHint` — placeholder/example (from self-audit's VALUE_HINT).
 *   - `il5Restricted` — keys whose value is constrained in IL5/DoD (e.g. the
 *                 notebook exec backend must not be `databricks`), so the pane
 *                 can warn / disable in a sovereign boundary.
 *
 * Pure data + helpers — no Azure SDK import — so it is unit-testable and safe to
 * import from both the BFF route and (the type only) the client pane.
 */
import { ENV_CHECKS, VALUE_HINT, CTX, type AuditCategory, type AuditSeverity } from './self-audit';

export interface EditableEnvVar {
  key: string;
  category: AuditCategory;
  severity: AuditSeverity;
  /** Human label of the owning check (e.g. "Cosmos DB (Loom store)"). */
  label: string;
  /** Placeholder / example value. */
  valueHint: string;
  /** True when the value is sensitive — stored as an ACA secret, never echoed. */
  secret: boolean;
  /** True when this key is part of a `required` group (vs an optional service). */
  required: boolean;
  /** True when the value is constrained / unavailable in IL5 / DoD boundaries. */
  il5Restricted?: boolean;
}

/** A value is treated as secret when its key matches any of these. */
function isSecretKey(key: string): boolean {
  return /SECRET|PASSWORD|CONNECTION_STRING|CONNECTIONSTRING|_KEY$|_KEYS$|_PWD$/i.test(key);
}

/** Keys whose value is constrained in the Azure Government L5 (DoD/IL5)
 * boundary. Today: the notebook exec backend must not be `databricks` at IL5
 * (see admin-plane/main.bicep) — flagged so the pane can warn before a write. */
const IL5_RESTRICTED = new Set<string>([
  'LOOM_NOTEBOOK_EXEC_BACKEND',
]);

/**
 * The editable env-var whitelist, derived from ENV_CHECKS. Each `anyOf` group
 * contributes its individual member keys (the admin may set any of them); the
 * preferred key of a group still appears so it is settable. Deduped by key
 * (first spec wins for label/category/severity).
 */
export const EDITABLE_ENV: EditableEnvVar[] = (() => {
  const out: EditableEnvVar[] = [];
  const seen = new Set<string>();
  const add = (key: string, category: AuditCategory, severity: AuditSeverity, label: string, required: boolean) => {
    const k = key.trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({
      key: k,
      category,
      severity,
      label,
      valueHint: VALUE_HINT[k] || '',
      secret: isSecretKey(k),
      required,
      il5Restricted: IL5_RESTRICTED.has(k) || undefined,
    });
  };
  for (const spec of ENV_CHECKS) {
    for (const k of spec.required || []) add(k, spec.category, spec.severity, spec.title, true);
    for (const group of spec.anyOf || []) for (const k of group) add(k, spec.category, spec.severity, spec.title, false);
  }
  return out;
})();

const EDITABLE_BY_KEY = new Map(EDITABLE_ENV.map((e) => [e.key, e]));

/** Is `key` in the editable whitelist? */
export function isEditableEnvKey(key: string): boolean {
  return EDITABLE_BY_KEY.has(key);
}

/** Look up the registry entry for a key (or undefined). */
export function getEditableEnv(key: string): EditableEnvVar | undefined {
  return EDITABLE_BY_KEY.get(key);
}

/** Mask a value for audit/return — secrets become '***', plain values pass through. */
export function maskValue(key: string, value: string | undefined | null): string {
  if (value == null) return '';
  return isSecretKey(key) ? '***' : value;
}

export interface SyncArtifacts {
  /** `az containerapp update --set-env-vars …` — applies immediately (already
   * the recipe self-audit emits). Secrets are shown as `KEY=secretref:<name>`. */
  cliScript: string;
  /** Bicep `env:` array entries to fold into the loom-console app block in
   * admin-plane/main.bicep so the next `az deployment` does not revert the UI
   * change (the env array is inline literals, not bicepparams). */
  bicepEnvSnippet: string;
}

/**
 * Build the IaC + CLI reconciliation artifacts for a set of changed keys. The
 * UI surfaces these so an admin can fold a UI-driven change into IaC — honoring
 * the zero-Azure-portal mandate while staying truthful about the
 * Cosmos-vs-bicep reconciliation (per no-vaporware.md).
 */
export function buildSyncArtifacts(
  changes: Record<string, string>,
  secretKeys: string[],
): SyncArtifacts {
  const app = CTX.app;
  const adminRg = CTX.adminRg;
  const sub = CTX.sub;
  const plainArgs = Object.entries(changes)
    .map(([k, v]) => `"${k}=${v}"`)
    .join(' ');
  const secretArgs = secretKeys
    .map((k) => `"${k}=secretref:${k.toLowerCase().replace(/[^a-z0-9-]/g, '-')}"`)
    .join(' ');
  const cli: string[] = [
    '# CSA Loom — apply the same env change to the Console container app (rolls a new revision).',
    '# Run in Azure Cloud Shell (PowerShell) or local pwsh with the Az CLI.',
    `az account set --subscription "${sub}"`,
  ];
  for (const k of secretKeys) {
    cli.push(`az containerapp secret set --name "${app}" --resource-group "${adminRg}" --secrets "${k.toLowerCase().replace(/[^a-z0-9-]/g, '-')}=<value>"`);
  }
  if (plainArgs || secretArgs) {
    cli.push(`az containerapp update --name "${app}" --resource-group "${adminRg}" \``);
    cli.push(`  --set-env-vars ${[plainArgs, secretArgs].filter(Boolean).join(' ')}`);
  }
  const bicepLines = Object.entries(changes).map(([k, v]) => `            { name: '${k}', value: '${v.replace(/'/g, "\\'")}' }`);
  for (const k of secretKeys) {
    bicepLines.push(`            { name: '${k}', secretRef: '${k.toLowerCase().replace(/[^a-z0-9-]/g, '-')}' }  // value via Key Vault / secret`);
  }
  const bicep = [
    '// Fold into the loom-console `env:` array in',
    '// platform/fiab/bicep/modules/admin-plane/main.bicep so the next',
    '// `az deployment` keeps this change (the env array is inline literals).',
    ...bicepLines,
  ].join('\n');
  return { cliScript: cli.join('\n'), bicepEnvSnippet: bicep };
}
