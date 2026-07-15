/**
 * BR-SCIM — SCIM 2.0 (RFC 7643 / 7644) type definitions + persisted doc shapes.
 *
 * These model the wire resources an identity provider (Entra) exchanges with
 * Loom's provisioning endpoints, plus the Cosmos docs we persist. The store
 * keys resources by a Loom-minted UUID (`id`) and remembers the IdP's
 * `externalId` so re-sync is idempotent.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_SPC_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
export const SCIM_RESOURCE_TYPE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';

export interface ScimName {
  formatted?: string;
  givenName?: string;
  familyName?: string;
}

export interface ScimEmail {
  value: string;
  type?: string;
  primary?: boolean;
}

export interface ScimMemberRef {
  value: string; // the referenced resource id
  display?: string;
  $ref?: string;
}

export interface ScimGroupRef {
  value: string; // group id
  display?: string;
}

export interface ScimMeta {
  resourceType: 'User' | 'Group';
  created: string;
  lastModified: string;
  location: string;
  version: string; // weak ETag
}

/** SCIM User as sent on the wire (RFC 7643 §4.1, common subset). */
export interface ScimUser {
  schemas: string[];
  id?: string;
  externalId?: string;
  userName: string;
  active?: boolean;
  displayName?: string;
  name?: ScimName;
  emails?: ScimEmail[];
  groups?: ScimGroupRef[];
  meta?: ScimMeta;
}

/** SCIM Group as sent on the wire (RFC 7643 §4.2). */
export interface ScimGroup {
  schemas: string[];
  id?: string;
  externalId?: string;
  displayName: string;
  members?: ScimMemberRef[];
  meta?: ScimMeta;
}

/** A single PATCH operation (RFC 7644 §3.5.2). */
export interface ScimPatchOperation {
  op: string; // add | remove | replace (case-insensitive)
  path?: string;
  value?: unknown;
}

export interface ScimPatchRequest {
  schemas: string[];
  Operations: ScimPatchOperation[];
}

// ── Persisted docs (Cosmos) ──────────────────────────────────────────────────

/** A SCIM user row in `loom-scim-users` (PK /id). */
export interface ScimUserDoc {
  id: string;
  tenantId: string;
  externalId?: string;
  userName: string;
  active: boolean;
  displayName?: string;
  name?: ScimName;
  emails?: ScimEmail[];
  /** group ids this user belongs to (maintained from Group.members patches). */
  groupIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** A SCIM group row in `loom-scim-groups` (PK /id). */
export interface ScimGroupDoc {
  id: string;
  tenantId: string;
  externalId?: string;
  displayName: string;
  /** member user ids. */
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}
