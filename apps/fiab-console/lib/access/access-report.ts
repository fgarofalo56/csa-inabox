/**
 * Unified "who has access" report — pure merge logic (access-governance W1).
 *
 * The report answers two questions from one normalized row shape (`AccessEntry`):
 *   • per-principal — everything a principal can reach
 *   • per-resource  — every principal with access to a resource
 *
 * The BFF route fetches the raw sources (entitlement ledger + live workspace
 * ACLs + optional Entra group expansion) and hands them here as `AccessEntry[]`.
 * This module normalizes, de-duplicates, and sorts — no Cosmos/Graph, so it is
 * fully unit-testable. De-dup matters because a workspace role can appear both
 * in the ledger (recorded going forward) and in the live `workspace-roles`
 * container (authoritative today); the same effective grant collapses to one row.
 */
import type { AccessAssignment } from '@/lib/types/access-assignment';
import type { WorkspaceRoleAssignment } from '@/lib/azure/workspace-roles-client';

export interface AccessEntry {
  /** Ledger assignment id (present for ledger-sourced rows; enables Activate). */
  id?: string;
  principalId: string;
  principalUpn?: string;
  principalType: string;
  resourceType: string;
  resourceRef: string;
  resourceName?: string;
  role: string;
  permission?: string;
  source: string;
  sourceRef?: string;
  grantedBy?: string;
  grantedAt?: string;
  expiresAt?: string | null;
  state: string;
  /** Set when the entry was expanded from a group membership. */
  viaGroupId?: string;
  viaGroupName?: string;
}

/** Normalize a ledger assignment into a report entry. */
export function assignmentToEntry(a: AccessAssignment): AccessEntry {
  return {
    id: a.id,
    principalId: a.principalId,
    principalUpn: a.principalUpn,
    principalType: a.principalType,
    resourceType: a.resourceType,
    resourceRef: a.resourceRef,
    resourceName: a.resourceName,
    role: a.role,
    permission: a.permission,
    source: a.source,
    sourceRef: a.sourceRef,
    grantedBy: a.grantedBy,
    grantedAt: a.grantedAt,
    expiresAt: a.expiresAt ?? null,
    state: a.state,
  };
}

/** Normalize a live workspace-roles row into a report entry. */
export function workspaceRoleToEntry(w: WorkspaceRoleAssignment): AccessEntry {
  return {
    principalId: w.principalId,
    principalUpn: (w as any).displayName,
    principalType: w.principalType,
    resourceType: 'workspace',
    resourceRef: w.workspaceId,
    resourceName: (w as any).displayName,
    role: w.role,
    permission: undefined,
    source: 'workspace-acl',
    sourceRef: w.id,
    grantedBy: w.addedBy,
    grantedAt: w.addedAt,
    expiresAt: null,
    state: 'active',
  };
}

/** De-dup key — the same effective grant collapses to one row. */
function entryKey(e: AccessEntry): string {
  return `${e.principalId}|${e.resourceType}|${e.resourceRef}|${e.role}|${e.source}|${e.viaGroupId || ''}`;
}

/**
 * Merge, de-dup (keeping the most recent grant / preferring an active state),
 * and sort newest-first. A revoked/expired row never masks an active one for the
 * same tuple.
 */
export function mergeEntries(entries: AccessEntry[]): AccessEntry[] {
  const byKey = new Map<string, AccessEntry>();
  for (const e of entries) {
    const k = entryKey(e);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, e); continue; }
    // Prefer active over revoked/expired; otherwise keep the most recent grant.
    const preferNew =
      (e.state === 'active' && prev.state !== 'active') ||
      (e.state === prev.state && (e.grantedAt || '') > (prev.grantedAt || ''));
    if (preferNew) byKey.set(k, e);
  }
  return [...byKey.values()].sort((a, b) => (b.grantedAt || '').localeCompare(a.grantedAt || ''));
}

/** Per-principal view — everything the principal can reach. */
export function buildPrincipalReport(entries: AccessEntry[], principalId: string): AccessEntry[] {
  return mergeEntries(entries.filter((e) => e.principalId === principalId));
}

/** Per-resource view — every principal with access to the resource. */
export function buildResourceReport(entries: AccessEntry[], resourceRef: string, resourceType?: string): AccessEntry[] {
  return mergeEntries(
    entries.filter((e) => e.resourceRef === resourceRef && (!resourceType || e.resourceType === resourceType)),
  );
}

/** CSV serialization for the export button (RFC-4180 quoting). */
export function entriesToCsv(entries: AccessEntry[]): string {
  const cols: (keyof AccessEntry)[] = [
    'principalUpn', 'principalId', 'principalType',
    'resourceType', 'resourceRef', 'resourceName',
    'role', 'permission', 'source', 'grantedBy', 'grantedAt', 'expiresAt', 'state',
    'viaGroupName',
  ];
  const esc = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.join(',');
  const rows = entries.map((e) => cols.map((c) => esc(e[c])).join(','));
  return [header, ...rows].join('\r\n');
}
