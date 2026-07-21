/**
 * API-scope compiler — `PolicyCodeSet` → BFF route-scope grants. A resource with
 * `backend: 'api-scope'` names a route glob (e.g. `/api/items/warehouse/*`); the
 * statement's principals + actions compile to scope entries that the route-guard
 * layer consults. `reconcile.ts` persists the compiled manifest as the
 * authoritative `api-scope` registry doc in Cosmos (the surface a route reads to
 * decide allow/deny), so drift = the live registry differing from the desired
 * manifest.
 *
 * action → HTTP verb class: read=GET, write=mutating, admin=all, deny=explicit
 * deny. Pure string output; no Azure imports.
 */

import type { PolicyCodeSet } from '../dsl';
import { type CompiledArtifact, type CompiledOp, dedupeOps } from './types';

const VERB_CLASS: Record<'read' | 'write' | 'admin' | 'deny', string> = {
  read: 'GET',
  write: 'MUTATE',
  admin: 'ALL',
  deny: 'DENY',
};

export function compileApiScope(set: PolicyCodeSet): CompiledArtifact {
  const ops: CompiledOp[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];

  for (const stmt of set.statements) {
    for (const res of stmt.resources) {
      if (res.backend !== 'api-scope') continue;
      const route = res.object;
      if (!route.startsWith('/')) {
        warnings.push(`statement "${stmt.id}": api-scope object "${route}" is not a route path (must start with "/"); skipped.`);
        continue;
      }
      for (const action of stmt.actions) {
        const verb = VERB_CLASS[action];
        const verbAllow = action === 'deny' ? 'DENY' : 'ALLOW';
        for (const p of stmt.principals) {
          ops.push({
            key: `api-scope:${action}:${route}:${p.id}`,
            kind: 'scope',
            statement: `${verbAllow} ${verb} ${route} → ${p.kind}:${p.id}`,
            target: route,
            principals: [p.id],
            from: stmt.id,
          });
        }
      }
    }
  }

  const deduped = dedupeOps(ops);
  if (deduped.length) summary.push(`${deduped.length} route-scope entr(y|ies)`);
  return { backend: 'api-scope', applicable: deduped.length > 0, ops: deduped, warnings, summary };
}

/**
 * The api-scope registry doc shape reconcile persists (the route-guard read
 * surface). A route matcher checks the most specific matching entry.
 */
export interface ApiScopeEntry {
  route: string;
  action: 'read' | 'write' | 'admin' | 'deny';
  principalId: string;
  principalKind: 'group' | 'user';
}

/** Project the compiled scope ops into the persisted registry entries. */
export function toApiScopeEntries(artifact: CompiledArtifact): ApiScopeEntry[] {
  const entries: ApiScopeEntry[] = [];
  for (const op of artifact.ops) {
    if (op.kind !== 'scope') continue;
    // key form: `api-scope:<action>:<route>:<principalId>`
    const m = /^api-scope:(read|write|admin|deny):(.+):([^:]+)$/.exec(op.key);
    if (!m) continue;
    const [, action, route, principalId] = m;
    const kind = op.statement.includes('group:') ? 'group' : 'user';
    entries.push({ route, action: action as ApiScopeEntry['action'], principalId, principalKind: kind });
  }
  return entries;
}
