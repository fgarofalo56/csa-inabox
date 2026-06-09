/**
 * Unit tests for the slash-command parser + registry (the acceptance criterion:
 * "unit test asserts parser extracts command + arg"). Pure logic — no Azure, no
 * React, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSlashCommand,
  isSlashMenuOpen,
  matchSlashCommands,
  getSlashCommand,
  isKnownCommand,
  SLASH_COMMAND_REGISTRY,
  KNOWN_COMMANDS,
} from '../slash-commands';

describe('parseSlashCommand', () => {
  it('extracts the command and the arg for /explain <query>', () => {
    expect(parseSlashCommand('/explain SELECT 1')).toEqual({
      command: 'explain',
      arg: 'SELECT 1',
      raw: '/explain SELECT 1',
    });
  });

  it('extracts a bare command with an empty arg', () => {
    expect(parseSlashCommand('/fix')).toEqual({ command: 'fix', arg: '', raw: '/fix' });
  });

  it('lower-cases the command token but preserves the arg casing', () => {
    expect(parseSlashCommand('/Optimize SELECT Col FROM T')).toEqual({
      command: 'optimize',
      arg: 'SELECT Col FROM T',
      raw: '/Optimize SELECT Col FROM T',
    });
  });

  it('captures a multi-line arg whole (pasted query)', () => {
    const parsed = parseSlashCommand('/comments SELECT a\nFROM t\nWHERE a > 1');
    expect(parsed?.command).toBe('comments');
    expect(parsed?.arg).toBe('SELECT a\nFROM t\nWHERE a > 1');
  });

  it('returns null for an unknown slash command (fixed allowlist)', () => {
    expect(parseSlashCommand('/unknown foo')).toBeNull();
    expect(parseSlashCommand('/drop table')).toBeNull();
  });

  it('returns null for plain text with no leading slash', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('explain this')).toBeNull();
  });

  it('returns null for non-string / empty input', () => {
    expect(parseSlashCommand('')).toBeNull();
    // @ts-expect-error — defensive runtime guard
    expect(parseSlashCommand(undefined)).toBeNull();
  });

  it('accepts all four known commands', () => {
    for (const c of KNOWN_COMMANDS) {
      expect(parseSlashCommand(`/${c} x`)?.command).toBe(c);
    }
  });
});

describe('isSlashMenuOpen', () => {
  it('opens on a bare slash and a partial command', () => {
    expect(isSlashMenuOpen('/')).toBe(true);
    expect(isSlashMenuOpen('/ex')).toBe(true);
    expect(isSlashMenuOpen('/explain')).toBe(true);
  });

  it('closes once a space is typed (command committed)', () => {
    expect(isSlashMenuOpen('/explain ')).toBe(false);
    expect(isSlashMenuOpen('/explain SELECT 1')).toBe(false);
  });

  it('stays closed for plain text', () => {
    expect(isSlashMenuOpen('hello')).toBe(false);
    expect(isSlashMenuOpen('')).toBe(false);
  });
});

describe('matchSlashCommands', () => {
  it('prefix-matches the typed partial', () => {
    expect(matchSlashCommands('/ex').map((c) => c.command)).toEqual(['explain']);
    expect(matchSlashCommands('/').length).toBe(SLASH_COMMAND_REGISTRY.length);
  });

  it('is empty for committed / non-slash input', () => {
    expect(matchSlashCommands('/explain ')).toEqual([]);
    expect(matchSlashCommands('hi')).toEqual([]);
  });
});

describe('SLASH_COMMAND_REGISTRY', () => {
  it('contains exactly the four commands', () => {
    expect(SLASH_COMMAND_REGISTRY.map((c) => c.command).sort()).toEqual(
      ['comments', 'explain', 'fix', 'optimize'],
    );
  });

  it('marks explain as prose (no code) and the rest as code-producing', () => {
    expect(getSlashCommand('explain').producesCode).toBe(false);
    expect(getSlashCommand('fix').producesCode).toBe(true);
    expect(getSlashCommand('comments').producesCode).toBe(true);
    expect(getSlashCommand('optimize').producesCode).toBe(true);
  });

  it('every entry has a slash label and help text', () => {
    for (const c of SLASH_COMMAND_REGISTRY) {
      expect(c.label).toBe(`/${c.command}`);
      expect(c.help.length).toBeGreaterThan(0);
    }
  });
});

describe('isKnownCommand', () => {
  it('accepts the allowlist and rejects everything else', () => {
    expect(isKnownCommand('explain')).toBe(true);
    expect(isKnownCommand('optimize')).toBe(true);
    expect(isKnownCommand('delete')).toBe(false);
    expect(isKnownCommand('')).toBe(false);
  });
});
