/**
 * BR-SCIM — apply RFC 7644 §3.5.2 PATCH operations to a user/group doc.
 *
 * Entra's PATCH traffic is narrow and predictable:
 *   - User deactivate:  { op:"replace", value:{ active:false } }  (or path:"active")
 *   - User attr update: { op:"replace", path:"displayName", value:"…" }
 *   - Group add member: { op:"add", path:"members", value:[{value:"<userId>"}] }
 *   - Group remove one: { op:"remove", path:"members[value eq \"<id>\"]" }
 *   - Group remove all: { op:"remove", path:"members" }
 *
 * These pure functions mutate a shallow copy and return it; the route persists
 * the result. Unsupported ops are ignored (SCIM allows a server to no-op an op
 * it doesn't model) rather than failing the whole request.
 */

import type { ScimUserDoc, ScimGroupDoc, ScimPatchOperation } from './types';

function opName(op: string): 'add' | 'remove' | 'replace' | 'unknown' {
  const o = (op || '').toLowerCase();
  if (o === 'add' || o === 'remove' || o === 'replace') return o;
  return 'unknown';
}

/** Coerce a SCIM boolean value (may arrive as boolean or "true"/"false"). */
function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v.toLowerCase() === 'true') return true;
    if (v.toLowerCase() === 'false') return false;
  }
  return undefined;
}

/** Apply a list of PATCH ops to a user doc, returning the mutated copy. */
export function applyUserPatch(doc: ScimUserDoc, ops: ScimPatchOperation[]): ScimUserDoc {
  const next: ScimUserDoc = { ...doc };
  for (const op of ops) {
    const name = opName(op.op);
    if (name === 'unknown') continue;
    // Path-less replace with an object value: assign each key.
    if (!op.path && (name === 'replace' || name === 'add') && op.value && typeof op.value === 'object') {
      const obj = op.value as Record<string, unknown>;
      if ('active' in obj) { const b = asBool(obj.active); if (b !== undefined) next.active = b; }
      if (typeof obj.displayName === 'string') next.displayName = obj.displayName;
      if (typeof obj.userName === 'string') next.userName = obj.userName;
      if (typeof obj.externalId === 'string') next.externalId = obj.externalId;
      if (obj.name && typeof obj.name === 'object') next.name = obj.name as ScimUserDoc['name'];
      if (Array.isArray(obj.emails)) next.emails = obj.emails as ScimUserDoc['emails'];
      continue;
    }
    // Path-targeted op.
    const path = (op.path || '').toLowerCase();
    if (path === 'active') {
      const b = asBool(op.value);
      if (b !== undefined) next.active = b;
    } else if (path === 'displayname') {
      if (typeof op.value === 'string') next.displayName = op.value;
    } else if (path === 'username') {
      if (typeof op.value === 'string') next.userName = op.value;
    } else if (path === 'externalid') {
      if (typeof op.value === 'string') next.externalId = op.value;
    }
    // Other paths (name.*, emails) are accepted-but-ignored to keep provisioning green.
  }
  return next;
}

/**
 * Apply PATCH ops to a group doc's membership, returning the mutated copy.
 * Handles add/remove/replace of `members`, including the
 * `members[value eq "<id>"]` remove-one path Entra emits.
 */
export function applyGroupPatch(doc: ScimGroupDoc, ops: ScimPatchOperation[]): ScimGroupDoc {
  let members = [...doc.memberIds];
  let displayName = doc.displayName;
  for (const op of ops) {
    const name = opName(op.op);
    if (name === 'unknown') continue;
    const path = (op.path || '').toLowerCase();

    // displayName rename.
    if (path === 'displayname' && typeof op.value === 'string') {
      displayName = op.value;
      continue;
    }
    if (!op.path && (name === 'replace' || name === 'add') && op.value && typeof op.value === 'object' && !Array.isArray(op.value)) {
      const obj = op.value as Record<string, unknown>;
      if (typeof obj.displayName === 'string') displayName = obj.displayName;
      if (Array.isArray(obj.members)) {
        const ids = extractMemberIds(obj.members);
        members = name === 'add' ? unique([...members, ...ids]) : ids;
      }
      continue;
    }

    // members-targeted ops.
    if (path === 'members' || path.startsWith('members[')) {
      // remove-one: members[value eq "<id>"]
      const m = /members\[\s*value\s+eq\s+"([^"]+)"\s*\]/i.exec(op.path || '');
      if (m && name === 'remove') {
        members = members.filter((id) => id !== m[1]);
        continue;
      }
      if (name === 'remove' && (path === 'members')) {
        members = [];
        continue;
      }
      const ids = extractMemberIds(op.value);
      if (name === 'add') members = unique([...members, ...ids]);
      else if (name === 'replace') members = ids;
      else if (name === 'remove') members = members.filter((id) => !ids.includes(id));
    }
  }
  return { ...doc, displayName, memberIds: members };
}

function extractMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).value === 'string') {
      out.push((v as Record<string, string>).value);
    } else if (typeof v === 'string') {
      out.push(v);
    }
  }
  return out;
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}
