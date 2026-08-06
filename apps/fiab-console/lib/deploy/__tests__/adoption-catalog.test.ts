/**
 * adoption-catalog tests — the ANTI-DRIFT guard, in test form.
 *
 * The catalog this replaces had a "no drift" test that asserted only
 * `expect(def.enabledFlag).toBeTruthy()`. It compared no names, so it passed
 * happily while `maps` carried `loomMapsEnabled` in the CLI and
 * `azureMapsEnabled` in TypeScript, and while `foundry` pointed at two
 * different Azure accounts depending on which surface you asked. These tests
 * compare NAMES against `platform/fiab/bicep/main.bicep` on disk.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ADOPTION_CATALOG,
  adoptionArmTypes,
  armTypeToServiceKey,
  adoptableServices,
  getServiceDef,
  serviceLabel,
} from '../adoption-catalog';

const MAIN_BICEP = path.resolve(
  __dirname,
  '../../../../../platform/fiab/bicep/main.bicep',
);

function declaredBicepParams(): Set<string> {
  const src = readFileSync(MAIN_BICEP, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/^param\s+([A-Za-z0-9_]+)\s+/gm)) out.add(m[1]);
  return out;
}

describe('adoption-catalog', () => {
  it('reads main.bicep and finds a plausible parameter set (fixture sanity)', () => {
    // If this fails the path is wrong and every flag assertion below would be
    // vacuously true — the failure mode that made the old guard useless.
    const params = declaredBicepParams();
    expect(params.size).toBeGreaterThan(100);
    expect(params.has('purviewEnabled')).toBe(true);
  });

  it('every enableFlag is a parameter main.bicep actually declares', () => {
    const params = declaredBicepParams();
    // `enableFlag` is OPTIONAL in the canonical shape (`string | undefined`),
    // not `string | null`: an absent flag means the service has no provisioning
    // toggle. Only a DECLARED flag has to exist in main.bicep.
    const missing = ADOPTION_CATALOG.filter(
      (d) => !!d.enableFlag && !params.has(d.enableFlag),
    ).map((d) => `${d.key} → ${d.enableFlag}`);
    expect(missing).toEqual([]);
  });

  it('asserts a non-trivial number of flags (the guard cannot pass vacuously)', () => {
    const flagged = ADOPTION_CATALOG.filter((d) => !!d.enableFlag);
    expect(flagged.length).toBeGreaterThanOrEqual(10);
  });

  it('service keys are unique', () => {
    const keys = ADOPTION_CATALOG.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('provisionVar names are unique (two services must never share one gate)', () => {
    // Only DECLARED provision vars — a create-only / attach-in-place row has
    // none, and counting several `undefined`s as duplicates is a false alarm.
    const vars = ADOPTION_CATALOG.map((d) => d.provisionVar).filter(Boolean);
    expect(new Set(vars).size).toBe(vars.length);
    // The check must not be able to pass vacuously.
    expect(vars.length).toBeGreaterThanOrEqual(13);
  });

  it('every armType is lower-case (the ARG `type in~` literal is built verbatim)', () => {
    const wrong = ADOPTION_CATALOG.filter((d) => d.armType !== d.armType.toLowerCase());
    expect(wrong.map((d) => d.key)).toEqual([]);
  });

  it('every create-only service explains WHY, at length', () => {
    for (const d of ADOPTION_CATALOG.filter((x) => x.cls === 'create-only')) {
      expect(d.createOnlyReason, `${d.key} is create-only with no reason`).toBeTruthy();
      // A one-word reason is indistinguishable from "we didn't build it".
      expect(d.createOnlyReason!.length).toBeGreaterThan(80);
    }
  });

  it('every adoptable service declares what Loom would CHANGE about it', () => {
    for (const d of ADOPTION_CATALOG.filter((x) => x.cls === 'adoptable' || x.cls === 'adopt-required')) {
      if (d.readOnlyAdoption) {
        // The ONE legitimate empty case, and it has to be claimed explicitly so
        // "we forgot to write them down" cannot masquerade as "there are none".
        expect(d.mutations, `${d.key} claims read-only adoption but lists mutations`).toEqual([]);
        continue;
      }
      expect(d.mutations.length, `${d.key} declares no mutations`).toBeGreaterThan(0);
      for (const m of d.mutations) expect(m.trim().length).toBeGreaterThan(10);
    }
    // The loop must not be able to pass vacuously.
    const adoptables = ADOPTION_CATALOG.filter((x) => x.cls === 'adoptable' || x.cls === 'adopt-required');
    expect(adoptables.length).toBeGreaterThanOrEqual(13);
    expect(adoptables.filter((d) => !d.readOnlyAdoption).length).toBeGreaterThanOrEqual(10);
  });

  it('a create-only service is excluded from adoptableServices()', () => {
    const keys = adoptableServices().map((d) => d.key);
    expect(keys).not.toContain('keyvault');
    expect(keys).not.toContain('azurefirewall');
    expect(keys).toContain('purview');
  });

  it('Purview is the tenant singleton (a second account fails at ARM)', () => {
    const p = getServiceDef('purview');
    expect(p?.singleton).toBe('tenant');
    expect(p?.cls).toBe('adopt-required');
  });

  it('adoptionArmTypes() is deduped and sorted', () => {
    const types = adoptionArmTypes();
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual(types);
  });

  describe('armTypeToServiceKey — kind disambiguation', () => {
    it('maps an AIServices Cognitive account to foundry', () => {
      expect(armTypeToServiceKey('microsoft.cognitiveservices/accounts', 'AIServices')).toBe('foundry');
    });

    it('does NOT mis-file a Speech account as foundry', () => {
      // Same ARM type, different kind. The old code paths that filtered in
      // memory on a regex over the whole row would have claimed this one.
      expect(armTypeToServiceKey('microsoft.cognitiveservices/accounts', 'SpeechServices')).toBeNull();
    });

    it('is case-insensitive on the ARM type', () => {
      expect(armTypeToServiceKey('Microsoft.Purview/Accounts')).toBe('purview');
    });

    it('returns null for an ARM type the catalog does not cover', () => {
      expect(armTypeToServiceKey('microsoft.web/sites')).toBeNull();
    });
  });

  it('serviceLabel falls back to the raw key', () => {
    expect(serviceLabel('purview')).toBe('Microsoft Purview');
    expect(serviceLabel('not-a-service')).toBe('not-a-service');
  });
});
