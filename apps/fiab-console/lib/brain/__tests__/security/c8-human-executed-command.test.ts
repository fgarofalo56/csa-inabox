/**
 * C8 — injection into a human-executed command. The narrow arm is the sibling
 * emitter: escape the field the detector knows about, add a second one.
 */

import { describe, expect, it } from 'vitest';
import { detectHumanExecutedCommand, securityFindingsOf } from '@/lib/brain/security';
import { c8Node, graphOf } from './fixtures/corpus';

const UNESCAPED = {
  name: 'existingClientId',
  source: 'caller-supplied' as const,
  escaped: false,
  allowlisted: false,
  validatedAs: null,
};

const SAFE = {
  name: 'existingClientId',
  source: 'caller-supplied' as const,
  escaped: true,
  allowlisted: true,
  validatedAs: 'guid',
};

describe('C8 — injection into a human-executed command', () => {
  it('POSITIVE: fires on an unescaped caller value in a shell-command field', () => {
    const node = c8Node('fx:c8:raw', {
      route: 'setup/identity',
      field: 'bootstrapScript',
      contentShape: 'shell-command',
      interpolations: [UNESCAPED],
      siblingEmitters: 1,
      siblingEmittersCovered: 1,
    });
    const findings = securityFindingsOf(detectHumanExecutedCommand(graphOf([node])));
    expect(findings).toHaveLength(1);
    expect(findings[0].findingClass).toBe('C8-human-executed-command');
    // The route does not execute the string; that is what makes it invisible to
    // taint analysis, not what makes it safe.
    expect(findings[0].evidence.facts.join('\n')).toContain('no exec on this path');
  });

  it('POSITIVE: fires on a connection-string field too, not only a shell command', () => {
    const node = c8Node('fx:c8:conn', {
      route: 'setup/wire-existing',
      field: 'connectionString',
      contentShape: 'connection-string',
      interpolations: [UNESCAPED],
      siblingEmitters: 1,
      siblingEmittersCovered: 1,
    });
    expect(securityFindingsOf(detectHumanExecutedCommand(graphOf([node])))).toHaveLength(1);
  });

  it('POSITIVE (NARROW): reports an uncovered SIBLING emitter while THIS field is fully escaped', () => {
    // #3602's history exactly: `remediation.commands` was allowlisted in one
    // route and `bootstrapScript` in a sibling was not. A per-field audit of this
    // node reports success.
    const node = c8Node('fx:c8:sibling', {
      route: 'setup/wire-existing',
      field: 'remediationCommands',
      contentShape: 'remediation',
      interpolations: [SAFE],
      siblingEmitters: 2,
      siblingEmittersCovered: 1,
    });
    const result = detectHumanExecutedCommand(graphOf([node]));
    expect(securityFindingsOf(result)).toEqual([]);
    const pop = result.findings.filter((f) => f.findingClass === 'POP-population-integrity');
    expect(pop).toHaveLength(1);
    expect(pop[0].title).toContain('2 command-shaped emitters and 1 are covered');
  });

  it('NEGATIVE CONTROL: does NOT fire on an escaped and allowlisted interpolation', () => {
    const node = c8Node('fx:c8:safe', {
      route: 'setup/identity',
      field: 'bootstrapScript',
      contentShape: 'shell-command',
      interpolations: [SAFE],
      siblingEmitters: 1,
      siblingEmittersCovered: 1,
    });
    expect(detectHumanExecutedCommand(graphOf([node])).findings).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire on a static command string with no interpolation', () => {
    const node = c8Node('fx:c8:static', {
      route: 'setup/identity',
      field: 'bootstrapScript',
      contentShape: 'shell-command',
      interpolations: [],
      siblingEmitters: 1,
      siblingEmittersCovered: 1,
    });
    expect(detectHumanExecutedCommand(graphOf([node])).findings).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire on a non-command field carrying caller data', () => {
    // That is C2's question (what does the response disclose?), not C8's.
    const node = c8Node('fx:c8:other', {
      route: 'setup/identity',
      field: 'displayName',
      contentShape: 'other',
      interpolations: [UNESCAPED],
      siblingEmitters: 1,
      siblingEmittersCovered: 1,
    });
    expect(detectHumanExecutedCommand(graphOf([node])).findings).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire on a server-derived interpolation', () => {
    const node = c8Node('fx:c8:server', {
      route: 'setup/identity',
      field: 'bootstrapScript',
      contentShape: 'shell-command',
      interpolations: [{ ...UNESCAPED, source: 'server-derived' }],
      siblingEmitters: 1,
      siblingEmittersCovered: 1,
    });
    expect(detectHumanExecutedCommand(graphOf([node])).findings).toEqual([]);
  });
});
