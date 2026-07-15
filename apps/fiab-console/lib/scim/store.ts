/**
 * BR-SCIM — Cosmos-backed persistence for SCIM users + groups (real backend,
 * no mocks per no-vaporware.md).
 *
 * SCIM provisioning is DEPLOYMENT-scoped: the provisioning bearer token is a
 * single deployment secret, so every provisioned identity belongs to the
 * deployment's Entra tenant. We stamp `tenantId` from the ambient tenant so a
 * future multi-tenant provisioning model can partition on it, and list queries
 * filter by it. Point reads/writes key on the SCIM resource `id` (PK /id).
 *
 * Group membership is bidirectional: patching a group's members updates each
 * user doc's `groupIds`, so `GET /Users/{id}` reflects the user's groups and a
 * user delete prunes it from every group.
 */

import crypto from 'node:crypto';
import { scimUsersContainer, scimGroupsContainer } from '@/lib/azure/cosmos-client';
import type { ScimUser, ScimGroup, ScimUserDoc, ScimGroupDoc } from './types';
import { primaryEmail } from './core';

/** The ambient deployment tenant these SCIM resources belong to. */
export function scimTenantId(): string {
  return process.env.LOOM_TENANT_ID || process.env.LOOM_ENTRA_TENANT_ID || 'default';
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Users ─────────────────────────────────────────────────────────────────────

/** Create a user from a SCIM wire resource. Returns the persisted doc. */
export async function createUser(input: ScimUser): Promise<ScimUserDoc> {
  const c = await scimUsersContainer();
  const ts = nowIso();
  const doc: ScimUserDoc = {
    id: crypto.randomUUID(),
    tenantId: scimTenantId(),
    externalId: input.externalId,
    userName: input.userName,
    active: input.active ?? true,
    displayName: input.displayName,
    name: input.name,
    emails: input.emails,
    groupIds: [],
    createdAt: ts,
    updatedAt: ts,
  };
  const { resource } = await c.items.create<ScimUserDoc>(doc);
  return resource ?? doc;
}

/** Point-read a user by id (null when absent). */
export async function getUser(id: string): Promise<ScimUserDoc | null> {
  try {
    const c = await scimUsersContainer();
    const { resource } = await c.item(id, id).read<ScimUserDoc>();
    return resource ?? null;
  } catch {
    return null;
  }
}

/** Find a user by userName within the deployment tenant (for conflict checks). */
export async function findUserByUserName(userName: string): Promise<ScimUserDoc | null> {
  const c = await scimUsersContainer();
  const { resources } = await c.items
    .query<ScimUserDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t AND LOWER(c.userName) = LOWER(@u)',
      parameters: [
        { name: '@t', value: scimTenantId() },
        { name: '@u', value: userName },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/** List all users in the deployment tenant (filtering happens in-route). */
export async function listUsers(): Promise<ScimUserDoc[]> {
  const c = await scimUsersContainer();
  const { resources } = await c.items
    .query<ScimUserDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
      parameters: [{ name: '@t', value: scimTenantId() }],
    })
    .fetchAll();
  return resources;
}

/** Replace a user (PUT) with fields from a SCIM resource, preserving id/groups. */
export async function replaceUser(existing: ScimUserDoc, input: ScimUser): Promise<ScimUserDoc> {
  const c = await scimUsersContainer();
  const next: ScimUserDoc = {
    ...existing,
    externalId: input.externalId ?? existing.externalId,
    userName: input.userName || existing.userName,
    active: input.active ?? existing.active,
    displayName: input.displayName,
    name: input.name,
    emails: input.emails,
    updatedAt: nowIso(),
  };
  const { resource } = await c.item(existing.id, existing.id).replace<ScimUserDoc>(next);
  return resource ?? next;
}

/** Persist a mutated user doc (used by PATCH). */
export async function saveUser(doc: ScimUserDoc): Promise<ScimUserDoc> {
  const c = await scimUsersContainer();
  const next = { ...doc, updatedAt: nowIso() };
  const { resource } = await c.item(doc.id, doc.id).replace<ScimUserDoc>(next);
  return resource ?? next;
}

/** Delete a user and prune it from every group it belonged to. */
export async function deleteUser(doc: ScimUserDoc): Promise<void> {
  const c = await scimUsersContainer();
  // Prune membership from each group first (best-effort per group).
  for (const gid of doc.groupIds) {
    const g = await getGroup(gid);
    if (g && g.memberIds.includes(doc.id)) {
      g.memberIds = g.memberIds.filter((m) => m !== doc.id);
      await saveGroup(g);
    }
  }
  await c.item(doc.id, doc.id).delete();
}

// ── Groups ─────────────────────────────────────────────────────────────────────

export async function createGroup(input: ScimGroup): Promise<ScimGroupDoc> {
  const c = await scimGroupsContainer();
  const ts = nowIso();
  const memberIds = (input.members ?? []).map((m) => m.value).filter(Boolean);
  const doc: ScimGroupDoc = {
    id: crypto.randomUUID(),
    tenantId: scimTenantId(),
    externalId: input.externalId,
    displayName: input.displayName,
    memberIds,
    createdAt: ts,
    updatedAt: ts,
  };
  const { resource } = await c.items.create<ScimGroupDoc>(doc);
  await syncMembership(doc.id, [], memberIds);
  return resource ?? doc;
}

export async function getGroup(id: string): Promise<ScimGroupDoc | null> {
  try {
    const c = await scimGroupsContainer();
    const { resource } = await c.item(id, id).read<ScimGroupDoc>();
    return resource ?? null;
  } catch {
    return null;
  }
}

export async function listGroups(): Promise<ScimGroupDoc[]> {
  const c = await scimGroupsContainer();
  const { resources } = await c.items
    .query<ScimGroupDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
      parameters: [{ name: '@t', value: scimTenantId() }],
    })
    .fetchAll();
  return resources;
}

export async function replaceGroup(existing: ScimGroupDoc, input: ScimGroup): Promise<ScimGroupDoc> {
  const c = await scimGroupsContainer();
  const before = existing.memberIds;
  const after = (input.members ?? []).map((m) => m.value).filter(Boolean);
  const next: ScimGroupDoc = {
    ...existing,
    externalId: input.externalId ?? existing.externalId,
    displayName: input.displayName || existing.displayName,
    memberIds: after,
    updatedAt: nowIso(),
  };
  const { resource } = await c.item(existing.id, existing.id).replace<ScimGroupDoc>(next);
  await syncMembership(existing.id, before, after);
  return resource ?? next;
}

/** Persist a mutated group doc, syncing the back-reference on each user. */
export async function saveGroup(doc: ScimGroupDoc, before?: string[]): Promise<ScimGroupDoc> {
  const c = await scimGroupsContainer();
  const next = { ...doc, updatedAt: nowIso() };
  const { resource } = await c.item(doc.id, doc.id).replace<ScimGroupDoc>(next);
  if (before) await syncMembership(doc.id, before, doc.memberIds);
  return resource ?? next;
}

export async function deleteGroup(doc: ScimGroupDoc): Promise<void> {
  const c = await scimGroupsContainer();
  await syncMembership(doc.id, doc.memberIds, []);
  await c.item(doc.id, doc.id).delete();
}

/**
 * Reconcile the `groupIds` back-reference on each user as a group's membership
 * changes. Adds the group to newly-added members, removes it from dropped ones.
 * Best-effort per user — a missing user id is skipped, never fatal.
 */
async function syncMembership(groupId: string, before: string[], after: string[]): Promise<void> {
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  for (const uid of added) {
    const u = await getUser(uid);
    if (u && !u.groupIds.includes(groupId)) {
      u.groupIds.push(groupId);
      await saveUser(u);
    }
  }
  for (const uid of removed) {
    const u = await getUser(uid);
    if (u && u.groupIds.includes(groupId)) {
      u.groupIds = u.groupIds.filter((g) => g !== groupId);
      await saveUser(u);
    }
  }
}

/** Convenience: derive a display email for logging/audit (never persisted raw). */
export function userLabel(input: ScimUser): string {
  return input.userName || primaryEmail(input) || '(unknown)';
}
