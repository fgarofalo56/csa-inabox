import { describe, it, expect } from 'vitest';
import {
  isLoomEventType,
  auditActionToEventType,
  LOOM_EVENT_TYPES,
  LOOM_EVENT_GROUPS,
} from '../event-types';

describe('event-type catalog', () => {
  it('isLoomEventType accepts catalog members and rejects others', () => {
    expect(isLoomEventType('item.created')).toBe(true);
    expect(isLoomEventType('marketplace.sla.breached')).toBe(true);
    expect(isLoomEventType('webhook.test')).toBe(false); // system-only, not subscribable
    expect(isLoomEventType('nope')).toBe(false);
    expect(isLoomEventType(42)).toBe(false);
  });

  it('every grouped event is a real catalog type (no orphan UI rows)', () => {
    const grouped = LOOM_EVENT_GROUPS.flatMap((g) => g.events.map((e) => e.type));
    for (const t of grouped) expect(LOOM_EVENT_TYPES).toContain(t);
    // and every catalog type is surfaced in exactly one group
    expect(new Set(grouped).size).toBe(LOOM_EVENT_TYPES.length);
  });
});

describe('auditActionToEventType — BR-SIEM choke-point mapping', () => {
  it('maps the known admin actions to their canonical event types', () => {
    expect(auditActionToEventType('workspace.create')).toBe('workspace.created');
    expect(auditActionToEventType('workspace.delete')).toBe('workspace.deleted');
    expect(auditActionToEventType('feature-grant.upsert')).toBe('permission.granted');
    expect(auditActionToEventType('feature-grant.delete')).toBe('permission.revoked');
    expect(auditActionToEventType('mcp-server.deploy')).toBe('mcp-server.deployed');
    expect(auditActionToEventType('mcp-server.teardown')).toBe('mcp-server.removed');
    expect(auditActionToEventType('tenant-settings.update')).toBe('tenant-settings.updated');
    expect(auditActionToEventType('env-config.update')).toBe('config.updated');
    expect(auditActionToEventType('domain.delete')).toBe('domain.deleted');
    expect(auditActionToEventType('platform.update-apply')).toBe('platform.updated');
  });

  it('maps an unknown workspace.* action to workspace.updated', () => {
    expect(auditActionToEventType('workspace.rename')).toBe('workspace.updated');
  });

  it('falls back to admin.mutation for any other action', () => {
    expect(auditActionToEventType('webhook.register')).toBe('admin.mutation');
    expect(auditActionToEventType('something.else')).toBe('admin.mutation');
    expect(auditActionToEventType('')).toBe('admin.mutation');
  });
});
