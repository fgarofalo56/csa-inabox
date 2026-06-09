/**
 * Datamart-migration naming helpers — pure, dependency-free (no @azure/* imports)
 * so they are unit-testable without pulling the ARM SDK. Used by aas-client.ts
 * (re-exported) and the migrate route.
 */

/**
 * Sanitize a datamart display name into a valid Azure Analysis Services server
 * name. AAS server names: lowercase, 3–63 chars, start with a letter, [a-z0-9].
 */
export function sanitizeAasName(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^[^a-z]+/, '');
  const name = `loom${base}`.slice(0, 63);
  if (name.length < 3) {
    throw new Error(
      `Cannot derive a valid AAS server name from '${raw}' (must be ≥3 chars after sanitization)`,
    );
  }
  return name;
}

/** ARM SKU tier derived from the SKU name prefix (D→Development, B→Basic, else Standard). */
export function skuTier(sku: string): string {
  if (sku.startsWith('D')) return 'Development';
  if (sku.startsWith('B')) return 'Basic';
  return 'Standard';
}

/**
 * Sanitize a datamart display name into a Synapse Serverless database name. The
 * name is quoted with [<name>] in DDL, so only the `loom_dm_` prefix + word-char
 * substitution is needed; capped well under the 128-char limit.
 */
export function sanitizeDbName(raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 112);
  return `loom_dm_${sanitized}`;
}
