/**
 * Pins the brownfield attach kind vocabulary + mappings (attached-service-kinds):
 * ARM-type → kind (incl. the AOAI vs Maps Cognitive-account disambiguation), the
 * scan-services key bridge, and the closed-enum guard.
 */
import { describe, it, expect } from 'vitest';
import {
  ATTACHED_KIND_DEFS,
  armTypeToKind,
  scanKeyToKind,
  isAttachedServiceKind,
  getKindDef,
  kindLabel,
  discoveryArmTypes,
} from '../attached-service-kinds';

describe('attached-service-kinds', () => {
  it('maps core ARM types to the right kind', () => {
    expect(armTypeToKind('Microsoft.Synapse/workspaces')).toBe('synapse');
    expect(armTypeToKind('microsoft.kusto/clusters')).toBe('adx');
    expect(armTypeToKind('microsoft.storage/storageAccounts')).toBe('storage-adls');
    expect(armTypeToKind('microsoft.datafactory/factories')).toBe('adf');
    expect(armTypeToKind('microsoft.purview/accounts')).toBe('purview');
    expect(armTypeToKind('microsoft.search/searchservices')).toBe('ai-search');
  });

  it('disambiguates Cognitive Services by kind (AOAI = AIServices)', () => {
    expect(armTypeToKind('microsoft.cognitiveservices/accounts', 'AIServices')).toBe('aoai');
    // A non-AIServices Cognitive account is not an attach target here.
    expect(armTypeToKind('microsoft.cognitiveservices/accounts', 'SpeechServices')).toBeNull();
  });

  it('returns null for a non-attachable ARM type', () => {
    expect(armTypeToKind('microsoft.web/sites')).toBeNull();
    expect(armTypeToKind('')).toBeNull();
  });

  it('bridges scan-services keys to kinds', () => {
    expect(scanKeyToKind('synapse')).toBe('synapse');
    expect(scanKeyToKind('adx')).toBe('adx');
    expect(scanKeyToKind('foundry')).toBe('aoai');
    expect(scanKeyToKind('aisearch')).toBe('ai-search');
    expect(scanKeyToKind('nope')).toBeNull();
  });

  it('every kind def carries a role GUID + tile slug + label', () => {
    for (const d of ATTACHED_KIND_DEFS) {
      expect(d.roleGuid).toMatch(/^[0-9a-f-]{36}$/i);
      expect(d.roleName.length).toBeGreaterThan(0);
      expect(d.tileSlug.length).toBeGreaterThan(0);
      expect(kindLabel(d.kind)).toBe(d.label);
      expect(getKindDef(d.kind)).toBe(d);
    }
  });

  it('closed-enum guard accepts known kinds, rejects junk', () => {
    expect(isAttachedServiceKind('synapse')).toBe(true);
    expect(isAttachedServiceKind('adx')).toBe(true);
    expect(isAttachedServiceKind('made-up')).toBe(false);
    expect(isAttachedServiceKind(42)).toBe(false);
  });

  it('discoveryArmTypes is deduped', () => {
    const types = discoveryArmTypes();
    expect(new Set(types).size).toBe(types.length);
    // Cognitive Services appears once even though two kinds share it.
    expect(types.filter((t) => t === 'microsoft.cognitiveservices/accounts')).toHaveLength(1);
  });
});
