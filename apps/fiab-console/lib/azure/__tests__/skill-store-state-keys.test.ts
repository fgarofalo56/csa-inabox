/**
 * js/remote-property-injection regression for the Copilot skill-state store.
 *
 * WITHDRAWN DISMISSAL (review round 2): this file was triaged as safe because
 * "the values are booleans and the skill ids are in-repo constants". The second
 * half is wrong — the id is the `[id]` PATH SEGMENT of
 * `PATCH /api/copilot/skills/[id]/state`, so it is entirely caller-chosen, and
 * the route serves tenant CUSTOM skills as well as built-ins. The boolean value
 * is exactly what makes it a FALSE RECEIPT rather than a pollution: on a plain
 * object literal `states['__proto__'] = false` is swallowed by the prototype
 * setter, the entry never reaches Cosmos, and the route still answers
 * `{ ok: true, enabled: false }` — the same defect the MDM crosswalk fix closed.
 *
 * These tests drive the REAL store functions against a fake Cosmos container.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, any>();

vi.mock('@/lib/azure/cosmos-client', () => ({
  copilotSkillsContainer: vi.fn(),
  copilotSkillStatesContainer: vi.fn(async () => ({
    item: (id: string) => ({
      read: async () => {
        if (!store.has(id)) throw new Error('NotFound');
        // Cosmos hands back a JSON-parsed document, which carries
        // Object.prototype — reproduce that faithfully.
        return { resource: JSON.parse(JSON.stringify(store.get(id))) };
      },
    }),
    items: { upsert: async (doc: any) => { store.set(doc.id, doc); return { resource: doc }; } },
  })),
}));

import { setUserSkillState, setTenantSkillDefault, getUserSkillState } from '../skill-store';

beforeEach(() => { store.clear(); vi.clearAllMocks(); });

describe('skill state — caller-chosen skill ids are stored as data', () => {
  it('persists a __proto__ skill id instead of silently dropping the toggle', async () => {
    const states = await setUserSkillState('oid-1', '__proto__', false);
    // Pre-fix: the write hit the prototype setter, `states` had NO own key, and
    // the persisted doc carried nothing — while the route reported success.
    expect(Object.prototype.hasOwnProperty.call(states, '__proto__')).toBe(true);
    expect(states['__proto__']).toBe(false);
    const persisted = store.get('user:oid-1');
    expect(Object.keys(persisted.states)).toContain('__proto__');
    expect(JSON.parse(JSON.stringify(persisted.states))['__proto__']).toBe(false);
  });

  it('does not let a prototype-named id shadow a real member on read-back', async () => {
    await setUserSkillState('oid-2', 'toString', false);
    const read = await getUserSkillState('oid-2');
    expect(read['toString']).toBe(false);
    expect(Object.getPrototypeOf(read)).toBeNull();
    // A skill the user never toggled resolves to undefined, never to a Function
    // inherited from Object.prototype.
    expect(read['constructor']).toBeUndefined();
    expect(read['valueOf']).toBeUndefined();
  });

  it('keeps earlier toggles when a later prototype-named id is written', async () => {
    await setUserSkillState('oid-3', 'ms-analyst', false);
    const states = await setUserSkillState('oid-3', '__proto__', true);
    expect(Object.keys(states).sort()).toEqual(['__proto__', 'ms-analyst']);
    expect(states['ms-analyst']).toBe(false);
  });

  it('applies the same guarantee to the tenant-default overlay', async () => {
    const states = await setTenantSkillDefault('tid-1', '__proto__', false);
    expect(Object.prototype.hasOwnProperty.call(states, '__proto__')).toBe(true);
    expect(Object.keys(store.get('tenant:tid-1').states)).toContain('__proto__');
  });
});
