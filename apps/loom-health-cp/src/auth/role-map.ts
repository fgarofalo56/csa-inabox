// Typed loader for role-scope-map.v1.json. The JSON is the single source for
// ceilings; code reads it, it is never transcribed (security.md A4).

import map from './role-scope-map.v1.json' with { type: 'json' };
import { parseDataScope, type DataScope, type GrantType } from './scopes.js';

export interface RoleRow {
  id: string;
  ceiling: Record<GrantType, string[]>;
  operations: string[];
}

export const SCOPE_MAP_VERSION: string = map.version;
export const ROLES: readonly RoleRow[] = map.roles as unknown as RoleRow[];
export const ROLE_IDS: ReadonlySet<string> = new Set(ROLES.map((r) => r.id));

/** Union of the ceilings of the given roles for a grant type. Unknown role ids contribute nothing. */
export function ceilingsFor(roleIds: readonly string[], grant: GrantType): DataScope[] {
  const out: DataScope[] = [];
  for (const id of roleIds) {
    const row = ROLES.find((r) => r.id === id);
    if (!row) continue;
    for (const raw of row.ceiling[grant]) {
      const p = parseDataScope(raw, { v1: false });
      if (p) out.push(p);
    }
  }
  return out;
}

export function operationsFor(roleIds: readonly string[]): string[] {
  const ops = new Set<string>();
  for (const id of roleIds) for (const o of ROLES.find((r) => r.id === id)?.operations ?? []) ops.add(o);
  return [...ops];
}
