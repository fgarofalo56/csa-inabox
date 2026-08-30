/**
 * C8 — injection into a human-executed command. The narrow arm is the sibling
 * emitter: escape the field the detector knows about, add a second one.
 */

import { describe, expect, it } from 'vitest';
import { detectHumanExecutedCommand, securityFindingsOf } from '@/lib/brain/security';
import { c6Node, c8Node, graphOf } from './fixtures/corpus';

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

  // ── POPULATION (#3970) ─────────────────────────────────────────────────────
  //
  // C8 had ZERO assertions about its own population object. The registry-wide
  // census defends every detector against candidate-level narrowing; it cannot
  // see a skip inside THIS predicate, where the node stays judged and only the
  // finding disappears.
  //
  // The class-specific property, and the one #3602's history makes concrete:
  // membership is (kind === 'emitted-command') — every command-shaped emitter,
  // INCLUDING the ones already escaped and allowlisted. Narrowing membership to
  // the unescaped ones is precisely how "allowlist this field" reads as a fix
  // for the class: the fixed field leaves the population and the sibling audit
  // it belongs to reports a smaller, greener denominator.
  describe('POPULATION MEMBERSHIP IS INDEPENDENT OF THE ESCAPING', () => {
    it('a fully escaped, allowlisted field is still a candidate and still judged', () => {
      const fixed = c8Node('fx:c8:pop-safe', {
        route: 'setup/identity',
        field: 'bootstrapScript',
        contentShape: 'shell-command',
        interpolations: [SAFE],
        siblingEmitters: 1,
        siblingEmittersCovered: 1,
      });
      const result = detectHumanExecutedCommand(graphOf([fixed]));
      expect(result.population.candidates).toContain(fixed.id);
      expect(result.population.judged).toContain(fixed.id);
      expect(result.population.unjudged).toEqual([]);
      expect(result.findings).toEqual([]);
    });

    it('every exoneration route keeps the node judged — no predicate skip removes it', () => {
      // The four NEGATIVE CONTROLS above as one corpus: escaped+allowlisted, no
      // interpolation at all, a non-command content shape, and a server-derived
      // value. Each is a separate exit inside the predicate, and each must still
      // count its node.
      const nodes = [
        c8Node('fx:c8:pop-safe-2', {
          route: 'setup/identity', field: 'bootstrapScript', contentShape: 'shell-command',
          interpolations: [SAFE], siblingEmitters: 1, siblingEmittersCovered: 1,
        }),
        c8Node('fx:c8:pop-static', {
          route: 'setup/identity', field: 'bootstrapScript', contentShape: 'shell-command',
          interpolations: [], siblingEmitters: 1, siblingEmittersCovered: 1,
        }),
        c8Node('fx:c8:pop-other', {
          route: 'setup/identity', field: 'displayName', contentShape: 'other',
          interpolations: [UNESCAPED], siblingEmitters: 1, siblingEmittersCovered: 1,
        }),
        c8Node('fx:c8:pop-server', {
          route: 'setup/identity', field: 'bootstrapScript', contentShape: 'shell-command',
          interpolations: [{ ...UNESCAPED, source: 'server-derived' }],
          siblingEmitters: 1, siblingEmittersCovered: 1,
        }),
        c8Node('fx:c8:pop-dirty', {
          route: 'setup/identity', field: 'bootstrapScript', contentShape: 'shell-command',
          interpolations: [UNESCAPED], siblingEmitters: 1, siblingEmittersCovered: 1,
        }),
      ];
      const result = detectHumanExecutedCommand(graphOf(nodes));
      expect(result.population.candidates).toEqual(nodes.map((n) => n.id));
      expect(result.population.judged).toEqual(nodes.map((n) => n.id));
      // Exactly one fires, so the equality above is about counting rather than
      // about a detector that judges everything and finds nothing.
      expect(securityFindingsOf(result)).toHaveLength(1);
    });

    it('the population is SCOPED to this class, not to the whole graph', () => {
      const mine = c8Node('fx:c8:pop-mine', {
        route: 'setup/identity', field: 'bootstrapScript', contentShape: 'shell-command',
        interpolations: [UNESCAPED], siblingEmitters: 1, siblingEmittersCovered: 1,
      });
      const foreign = c6Node('fx:c8:pop-foreign', {
        callSite: 'connectors.fetch',
        attachedCredentials: ['authorization'],
        redirectPolicy: 'follow',
        opener: 'language-default',
        stripsCredentialOnHostChange: false,
        schemeAllowlist: null,
        defaultOpenerInstalledProcessWide: false,
      });
      const result = detectHumanExecutedCommand(graphOf([mine, foreign]));
      expect(result.population.candidates).toEqual([mine.id]);
      expect(result.population.candidates).not.toContain(foreign.id);
      expect(result.population.declaredKinds).toEqual(['emitted-command']);
    });
  });
});
