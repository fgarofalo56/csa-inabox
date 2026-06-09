/**
 * Unit tests for copilot personas — the acceptance criterion "commands
 * unavailable in a persona are hidden (not stubbed)". Pure data; no Azure.
 */
import { describe, it, expect } from 'vitest';
import {
  PERSONAS,
  getPersona,
  getPersonaCommands,
  personaHasCommand,
  type PersonaId,
} from '../copilot-personas-slash';

describe('copilot personas', () => {
  it('notebook exposes all four commands', () => {
    expect(getPersonaCommands('notebook').map((c) => c.command).sort()).toEqual(
      ['comments', 'explain', 'fix', 'optimize'],
    );
  });

  it('sql-warehouse exposes all four commands', () => {
    expect(getPersonaCommands('sql-warehouse').map((c) => c.command).sort()).toEqual(
      ['comments', 'explain', 'fix', 'optimize'],
    );
  });

  it('cross-item exposes all four commands', () => {
    expect(getPersonaCommands('cross-item').map((c) => c.command).sort()).toEqual(
      ['comments', 'explain', 'fix', 'optimize'],
    );
  });

  it('kql-queryset HIDES comments and optimize (explain + fix only)', () => {
    const cmds = getPersonaCommands('kql-queryset').map((c) => c.command);
    expect(cmds).toContain('explain');
    expect(cmds).toContain('fix');
    expect(cmds).not.toContain('comments');
    expect(cmds).not.toContain('optimize');
    // Truly hidden — the entries are absent, not present-but-flagged.
    expect(cmds.length).toBe(2);
  });

  it('personaHasCommand mirrors the visible set', () => {
    expect(personaHasCommand('kql-queryset', 'explain')).toBe(true);
    expect(personaHasCommand('kql-queryset', 'optimize')).toBe(false);
    expect(personaHasCommand('sql-warehouse', 'optimize')).toBe(true);
  });

  it('getPersonaCommands preserves registry order', () => {
    expect(getPersonaCommands('notebook').map((c) => c.command)).toEqual([
      'explain',
      'fix',
      'comments',
      'optimize',
    ]);
  });

  it('persona ids are the authoritative enum with no typos', () => {
    const ids = PERSONAS.map((p) => p.id).sort();
    expect(ids).toEqual(['cross-item', 'kql-queryset', 'notebook', 'sql-warehouse']);
    for (const id of ids as PersonaId[]) {
      expect(getPersona(id).id).toBe(id);
      expect(getPersona(id).commands.length).toBeGreaterThan(0);
    }
  });
});
