import { describe, it, expect, afterEach } from 'vitest';
import {
  userDocToScim,
  groupDocToScim,
  scimListResponse,
  scimError,
  scimVersion,
  verifyScimBearer,
  scimAuthConfigured,
  primaryEmail,
} from '../core';
import { SCIM_USER_SCHEMA, SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA, SCIM_ERROR_SCHEMA, type ScimUserDoc, type ScimGroupDoc } from '../types';

const userDoc: ScimUserDoc = {
  id: 'u1',
  tenantId: 't',
  externalId: 'ext-1',
  userName: 'alice@contoso.com',
  active: true,
  displayName: 'Alice',
  emails: [{ value: 'alice@contoso.com', primary: true }],
  groupIds: ['g1'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const groupDoc: ScimGroupDoc = {
  id: 'g1',
  tenantId: 't',
  displayName: 'Engineers',
  memberIds: ['u1', 'u2'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

describe('doc → SCIM mapping', () => {
  it('maps a user doc with schema, groups, and meta', () => {
    const u = userDocToScim(userDoc, 'https://loom.example.com');
    expect(u.schemas).toEqual([SCIM_USER_SCHEMA]);
    expect(u.userName).toBe('alice@contoso.com');
    expect(u.groups).toEqual([{ value: 'g1' }]);
    expect(u.meta?.resourceType).toBe('User');
    expect(u.meta?.location).toBe('https://loom.example.com/api/scim/v2/Users/u1');
    expect(u.meta?.version).toMatch(/^W\//);
  });

  it('maps a group doc with members + meta', () => {
    const g = groupDocToScim(groupDoc, 'https://loom.example.com');
    expect(g.schemas).toEqual([SCIM_GROUP_SCHEMA]);
    expect(g.members).toEqual([{ value: 'u1' }, { value: 'u2' }]);
    expect(g.meta?.location).toBe('https://loom.example.com/api/scim/v2/Groups/g1');
  });

  it('version is stable for the same doc + changes when updatedAt changes', () => {
    const a = scimVersion(userDoc);
    const b = scimVersion({ ...userDoc, updatedAt: '2026-02-02T00:00:00Z' });
    expect(a).toBe(scimVersion(userDoc));
    expect(a).not.toBe(b);
  });
});

describe('response envelopes', () => {
  it('builds a ListResponse', () => {
    const r = scimListResponse([1, 2], { totalResults: 2, startIndex: 1, itemsPerPage: 2 });
    expect(r.schemas).toEqual([SCIM_LIST_SCHEMA]);
    expect(r.totalResults).toBe(2);
    expect((r.Resources as unknown[]).length).toBe(2);
  });

  it('builds an error body', () => {
    const e = scimError(409, 'dup', 'uniqueness');
    expect(e.schemas).toEqual([SCIM_ERROR_SCHEMA]);
    expect(e.status).toBe('409');
    expect(e.scimType).toBe('uniqueness');
  });
});

describe('primaryEmail', () => {
  it('picks the primary email, else the first', () => {
    expect(primaryEmail({ schemas: [], userName: 'x', emails: [{ value: 'a' }, { value: 'b', primary: true }] })).toBe('b');
    expect(primaryEmail({ schemas: [], userName: 'x', emails: [{ value: 'a' }] })).toBe('a');
    expect(primaryEmail({ schemas: [], userName: 'x' })).toBeUndefined();
  });
});

describe('provisioning bearer auth', () => {
  afterEach(() => {
    delete process.env.LOOM_SCIM_BEARER_TOKEN;
  });

  it('is unconfigured (honest gate) when the env var is unset', () => {
    expect(scimAuthConfigured()).toBe(false);
    expect(verifyScimBearer('Bearer anything')).toBe(false);
  });

  it('accepts the exact bearer, constant-time', () => {
    process.env.LOOM_SCIM_BEARER_TOKEN = 'super-secret-token';
    expect(scimAuthConfigured()).toBe(true);
    expect(verifyScimBearer('Bearer super-secret-token')).toBe(true);
    expect(verifyScimBearer('bearer super-secret-token')).toBe(true);
    expect(verifyScimBearer('Bearer wrong')).toBe(false);
    expect(verifyScimBearer(null)).toBe(false);
  });
});
