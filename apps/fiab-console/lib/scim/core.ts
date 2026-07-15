/**
 * BR-SCIM — SCIM 2.0 response builders + doc↔wire mapping + provisioning-token
 * auth. Pure/deterministic helpers (unit-tested); the Cosmos I/O lives in
 * `store.ts` and the auth env read is isolated in `scimAuthConfigured`.
 */

import crypto from 'node:crypto';
import {
  SCIM_USER_SCHEMA,
  SCIM_GROUP_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_ERROR_SCHEMA,
  type ScimUser,
  type ScimGroup,
  type ScimUserDoc,
  type ScimGroupDoc,
} from './types';

/** Content type every SCIM response carries (RFC 7644 §3.1). */
export const SCIM_CONTENT_TYPE = 'application/scim+json';

/** A weak ETag over the mutable fields of a doc (RFC 7644 §3.14). */
export function scimVersion(doc: { updatedAt: string; id: string }): string {
  const h = crypto.createHash('sha1').update(`${doc.id}:${doc.updatedAt}`).digest('hex').slice(0, 16);
  return `W/"${h}"`;
}

function location(base: string, resource: 'Users' | 'Groups', id: string): string {
  const b = (base || '').replace(/\/+$/, '');
  return `${b}/api/scim/v2/${resource}/${id}`;
}

/** Map a persisted user doc to the SCIM wire resource. */
export function userDocToScim(doc: ScimUserDoc, baseUrl: string): ScimUser {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: doc.id,
    ...(doc.externalId ? { externalId: doc.externalId } : {}),
    userName: doc.userName,
    active: doc.active,
    ...(doc.displayName ? { displayName: doc.displayName } : {}),
    ...(doc.name ? { name: doc.name } : {}),
    ...(doc.emails && doc.emails.length ? { emails: doc.emails } : {}),
    ...(doc.groupIds.length ? { groups: doc.groupIds.map((value) => ({ value })) } : {}),
    meta: {
      resourceType: 'User',
      created: doc.createdAt,
      lastModified: doc.updatedAt,
      location: location(baseUrl, 'Users', doc.id),
      version: scimVersion(doc),
    },
  };
}

/** Map a persisted group doc to the SCIM wire resource. */
export function groupDocToScim(doc: ScimGroupDoc, baseUrl: string): ScimGroup {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: doc.id,
    ...(doc.externalId ? { externalId: doc.externalId } : {}),
    displayName: doc.displayName,
    ...(doc.memberIds.length ? { members: doc.memberIds.map((value) => ({ value })) } : {}),
    meta: {
      resourceType: 'Group',
      created: doc.createdAt,
      lastModified: doc.updatedAt,
      location: location(baseUrl, 'Groups', doc.id),
      version: scimVersion(doc),
    },
  };
}

/** Build a SCIM ListResponse envelope (RFC 7644 §3.4.2). */
export function scimListResponse(
  resources: unknown[],
  opts: { totalResults: number; startIndex: number; itemsPerPage: number },
): Record<string, unknown> {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: opts.totalResults,
    startIndex: opts.startIndex,
    itemsPerPage: opts.itemsPerPage,
    Resources: resources,
  };
}

/** Build a SCIM error body (RFC 7644 §3.12). */
export function scimError(status: number, detail: string, scimType?: string): Record<string, unknown> {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

/** Extract the primary email string from a SCIM user, if any. */
export function primaryEmail(user: ScimUser): string | undefined {
  if (!user.emails || !user.emails.length) return undefined;
  const primary = user.emails.find((e) => e.primary) ?? user.emails[0];
  return primary?.value;
}

// ── Provisioning-token auth ──────────────────────────────────────────────────

/**
 * Whether SCIM provisioning is configured on this deployment. Honest-gate: when
 * `LOOM_SCIM_BEARER_TOKEN` is unset, the endpoints return 501 naming the exact
 * secret to set (no-vaporware.md), rather than silently accepting traffic.
 */
export function scimAuthConfigured(): boolean {
  return !!(process.env.LOOM_SCIM_BEARER_TOKEN && process.env.LOOM_SCIM_BEARER_TOKEN.trim());
}

/**
 * Constant-time compare of a presented `Authorization: Bearer <token>` against
 * the configured provisioning secret. Returns false for a missing/malformed
 * header or a mismatch. NEVER throws.
 */
export function verifyScimBearer(authorization: string | null | undefined): boolean {
  const expected = process.env.LOOM_SCIM_BEARER_TOKEN;
  if (!expected || !expected.trim()) return false;
  if (!authorization) return false;
  const m = /^bearer\s+(.+)$/i.exec(authorization.trim());
  const presented = (m ? m[1] : authorization).trim();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected.trim());
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
