/**
 * connectable-types — the pure mapping layer for the /connections "Add existing"
 * cross-subscription import path.
 *
 * Asserts:
 *   - every connectable ARM type maps to a valid Loom ConnectionType,
 *   - the ConnectionType label + tile-slug maps cover EVERY mapped type,
 *   - each tile-slug resolves to a KNOWN item-type-visual (no neutral fallback),
 *   - normalizeHost strips scheme / :443 / trailing slash to a bare FQDN.
 */
import { describe, it, expect } from 'vitest';
import {
  CONNECTABLE_ARM_TYPES, armTypeToConnType, normalizeHost,
  CONN_TYPE_LABEL, CONN_TILE_SLUG,
} from '../connectable-types';
import { isKnownItemType } from '@/lib/components/ui/item-type-visual';

describe('connectable-types', () => {
  it('maps every connectable ARM type to a ConnectionType (case-insensitive)', () => {
    for (const c of CONNECTABLE_ARM_TYPES) {
      expect(armTypeToConnType(c.armType)).toBe(c.connType);
      expect(armTypeToConnType(c.armType.toUpperCase())).toBe(c.connType);
    }
  });

  it('returns null for an unknown ARM type', () => {
    expect(armTypeToConnType('microsoft.web/sites')).toBeNull();
    expect(armTypeToConnType('')).toBeNull();
  });

  it('covers every mapped ConnectionType with a label and a tile slug', () => {
    for (const c of CONNECTABLE_ARM_TYPES) {
      expect(CONN_TYPE_LABEL[c.connType]).toBeTruthy();
      expect(CONN_TILE_SLUG[c.connType]).toBeTruthy();
    }
  });

  it('every tile slug resolves to a KNOWN visual (branded icon, not the neutral fallback)', () => {
    for (const slug of Object.values(CONN_TILE_SLUG)) {
      expect(isKnownItemType(slug)).toBe(true);
    }
  });

  it('normalizeHost strips scheme, :443 and trailing slash', () => {
    expect(normalizeHost('https://acct.documents.azure.com:443/')).toBe('acct.documents.azure.com');
    expect(normalizeHost('sb://ns.servicebus.windows.net/')).toBe('ns.servicebus.windows.net');
    expect(normalizeHost('https://kv.vault.usgovcloudapi.net/')).toBe('kv.vault.usgovcloudapi.net');
    expect(normalizeHost('srv.database.windows.net')).toBe('srv.database.windows.net');
    expect(normalizeHost('')).toBe('');
    expect(normalizeHost(undefined)).toBe('');
  });
});
