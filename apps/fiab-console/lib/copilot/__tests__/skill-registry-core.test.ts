/**
 * Unit tests for the PURE CTS-07 skill resolver (lib/copilot/skill-registry-core).
 *
 * These assert the toggle-over-tenant-default POLICY in isolation — no Cosmos,
 * no Azure, no network — exactly the seam the store + orchestrator depend on:
 *   - pane filter (case-insensitive; unknown/empty slug → [])
 *   - per-user override BEATS the tenant default (both directions)
 *   - a disabled skill is excluded; a re-enabled one is included
 *   - estimateSkillTokens ≈ chars/4 of the guidance blocks
 */
import { describe, it, expect } from 'vitest';
import {
  resolveActiveSkills,
  estimateSkillTokens,
  type SkillDescriptor,
} from '../skill-registry-core';

function mk(partial: Partial<SkillDescriptor> & { id: string }): SkillDescriptor {
  return {
    name: partial.id,
    whenToUse: '',
    guidance: '',
    toolNames: [],
    panes: ['lakehouse'],
    isBuiltin: false,
    enabled: true,
    ...partial,
  };
}

describe('resolveActiveSkills — pane filter', () => {
  const all = [
    mk({ id: 'a', panes: ['lakehouse', 'default'] }),
    mk({ id: 'b', panes: ['notebook'] }),
    mk({ id: 'c', panes: ['LAKEHOUSE'] }), // case-insensitive
  ];

  it('returns only skills whose panes match the slug', () => {
    const ids = resolveActiveSkills(all, 'lakehouse', {}).map((s) => s.id);
    expect(ids.sort()).toEqual(['a', 'c']);
  });

  it('matches panes case-insensitively', () => {
    const ids = resolveActiveSkills(all, 'LaKeHoUsE', {}).map((s) => s.id);
    expect(ids.sort()).toEqual(['a', 'c']);
  });

  it('returns [] for an unknown pane', () => {
    expect(resolveActiveSkills(all, 'does-not-exist', {})).toEqual([]);
  });

  it('returns [] for an empty / null / undefined slug', () => {
    expect(resolveActiveSkills(all, '', {})).toEqual([]);
    expect(resolveActiveSkills(all, '   ', {})).toEqual([]);
    expect(resolveActiveSkills(all, null, {})).toEqual([]);
    expect(resolveActiveSkills(all, undefined, {})).toEqual([]);
  });
});

describe('resolveActiveSkills — toggle policy (user override beats tenant default)', () => {
  it('includes a skill on by tenant default with no user override', () => {
    const all = [mk({ id: 'on', enabled: true })];
    expect(resolveActiveSkills(all, 'lakehouse', {}).map((s) => s.id)).toEqual(['on']);
  });

  it('excludes a skill off by tenant default with no user override', () => {
    const all = [mk({ id: 'off', enabled: false })];
    expect(resolveActiveSkills(all, 'lakehouse', {})).toEqual([]);
  });

  it('user override ON wins over tenant default OFF', () => {
    const all = [mk({ id: 'x', enabled: false })];
    expect(resolveActiveSkills(all, 'lakehouse', { x: true }).map((s) => s.id)).toEqual(['x']);
  });

  it('user override OFF wins over tenant default ON', () => {
    const all = [mk({ id: 'x', enabled: true })];
    expect(resolveActiveSkills(all, 'lakehouse', { x: false })).toEqual([]);
  });

  it('a disabled skill is excluded even when its pane matches', () => {
    const all = [
      mk({ id: 'keep', enabled: true }),
      mk({ id: 'drop', enabled: true }),
    ];
    const ids = resolveActiveSkills(all, 'lakehouse', { drop: false }).map((s) => s.id);
    expect(ids).toEqual(['keep']);
  });

  it('treats a missing `enabled` (undefined) as ON by default', () => {
    const all = [{ ...mk({ id: 'd' }), enabled: undefined as unknown as boolean }];
    expect(resolveActiveSkills(all, 'lakehouse', {}).map((s) => s.id)).toEqual(['d']);
  });
});

describe('estimateSkillTokens', () => {
  it('returns 0 for an empty set', () => {
    expect(estimateSkillTokens([])).toBe(0);
  });

  it('approximates chars/4 over the guidance blocks', () => {
    const skills = [
      mk({ id: 'a', guidance: 'x'.repeat(40) }), // 40 chars → 10
      mk({ id: 'b', guidance: 'y'.repeat(8) }),  // 8 chars → 2
    ];
    expect(estimateSkillTokens(skills)).toBe(12);
  });

  it('rounds up partial tokens', () => {
    expect(estimateSkillTokens([mk({ id: 'a', guidance: 'abcde' })])).toBe(2); // 5/4 → 2
  });

  it('ignores skills with no guidance text', () => {
    expect(estimateSkillTokens([mk({ id: 'a', guidance: '' })])).toBe(0);
  });
});
