import { describe, it, expect } from 'vitest';
import { parseArgs, flagStr, flagBool } from '../src/args.js';

describe('parseArgs', () => {
  it('parses --key=value', () => {
    const { flags } = parseArgs(['--api-url=https://x', '--output=json']);
    expect(flags['api-url']).toBe('https://x');
    expect(flags.output).toBe('json');
  });

  it('parses value flags with space form', () => {
    const { flags } = parseArgs(['--description', 'a b c', '--name', 'WS']);
    expect(flags.description).toBe('a b c');
    expect(flags.name).toBe('WS');
  });

  it('treats unknown flags as boolean', () => {
    const { flags } = parseArgs(['--count', 'extra']);
    expect(flags.count).toBe(true);
    // "extra" is a positional, not consumed by --count
  });

  it('collects positionals', () => {
    const { positionals } = parseArgs(['workspace', 'create', 'My WS']);
    expect(positionals).toEqual(['workspace', 'create', 'My WS']);
  });

  it('stops flag parsing at --', () => {
    const { positionals, flags } = parseArgs(['delete', '--', '--id-looking']);
    expect(positionals).toEqual(['delete', '--id-looking']);
    expect(Object.keys(flags)).toHaveLength(0);
  });

  it('parses combined short booleans', () => {
    const { flags } = parseArgs(['-h']);
    expect(flagBool(flags, 'h')).toBe(true);
  });

  it('flagStr returns undefined for boolean flags', () => {
    const { flags } = parseArgs(['--count']);
    expect(flagStr(flags, 'count')).toBeUndefined();
  });
});
