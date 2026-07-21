/**
 * a2a-tasks unit tests (WS-5.2) — the platform skill catalog + platform card.
 */
import { describe, it, expect } from 'vitest';
import {
  PLATFORM_SKILLS, A2A_SKILL, isPlatformSkill, inferSkillId, buildPlatformAgentCard,
} from '../a2a-tasks';
import { isValidAgentCard } from '../a2a-protocol';

describe('platform skill catalog', () => {
  it('exposes the four governed skills (data-agent, agent-flow, ontology object + action)', () => {
    const ids = PLATFORM_SKILLS.map((s) => s.id).sort();
    expect(ids).toEqual([
      A2A_SKILL.QUERY_DATA_AGENT, A2A_SKILL.QUERY_ONTOLOGY_OBJECT,
      A2A_SKILL.RUN_AGENT_FLOW, A2A_SKILL.RUN_ONTOLOGY_ACTION,
    ].sort());
    // Every skill has the A2A-required fields.
    for (const s of PLATFORM_SKILLS) {
      expect(s.id && s.name && s.description).toBeTruthy();
      expect(Array.isArray(s.tags) && s.tags.length).toBeTruthy();
    }
  });

  it('recognizes platform skill ids', () => {
    expect(isPlatformSkill('query-data-agent')).toBe(true);
    expect(isPlatformSkill('nope')).toBe(false);
    expect(isPlatformSkill(undefined)).toBe(false);
  });

  it('infers the skill from the delegated data when none is named', () => {
    expect(inferSkillId({ flowId: 'af-1' })).toBe(A2A_SKILL.RUN_AGENT_FLOW);
    expect(inferSkillId({ agentId: 'da-1' })).toBe(A2A_SKILL.QUERY_DATA_AGENT);
    expect(inferSkillId({ action: 'promote' })).toBe(A2A_SKILL.RUN_ONTOLOGY_ACTION);
    expect(inferSkillId({ objectType: 'Customer' })).toBe(A2A_SKILL.QUERY_ONTOLOGY_OBJECT);
    expect(inferSkillId({})).toBeUndefined();
  });
});

describe('buildPlatformAgentCard', () => {
  it('produces a valid A2A card pointing at /api/a2a with all skills', () => {
    const card = buildPlatformAgentCard('https://loom.example.com/');
    expect(isValidAgentCard(card)).toBe(true);
    expect(card.url).toBe('https://loom.example.com/api/a2a');
    expect(card.skills).toHaveLength(PLATFORM_SKILLS.length);
    expect(card.name).toBe('CSA Loom');
  });
});
