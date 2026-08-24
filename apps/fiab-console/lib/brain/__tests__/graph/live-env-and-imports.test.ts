/**
 * LOOM BRAIN — the live container-app env extractor (`configured`) and the
 * source-import extractor (`imports`).
 *
 * The load-bearing assertions:
 *
 *   • `secretRef` is INDETERMINATE, not empty (R7). A secret-backed variable HAS
 *     a value; this process cannot see it. Calling that an empty wire would
 *     manufacture a dangling edge for a correctly-configured variable and put a
 *     healthy service on a cleanup list.
 *   • `value: ''` on a LIVE app is an empty wire, same as in bicep — and this is
 *     the half no amount of reading bicep can see.
 *   • A hand-set variable that no bicep emits produces a `configured` edge with
 *     no `declared` counterpart. MEASURED on this estate: the live Commercial
 *     console carries a hand-added `LOOM_CAPACITY_BROKER_URL` alongside the
 *     bicep-emitted `LOOM_BROKER_URL`.
 *   • The import extractor does not GUESS at bare specifiers; it records them.
 */
import { describe, it, expect } from 'vitest';
import {
  azureResourceNodeId,
  buildGraph,
  codeModuleNodeId,
  extractFromContainerAppEnv,
  extractFromSourceImports,
  nodesWithNoInboundEdge,
  type NodeId,
} from '../../graph';

const SUB = '11111111-1111-1111-1111-111111111111';
const CONSOLE_ARM = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/loom-console`;
const BROKER_ID = azureResourceNodeId(
  `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/loom-capacity-broker`,
) as NodeId;

describe('extractFromContainerAppEnv', () => {
  it('an EMPTY live value is a dangling edge with the evidence attached', () => {
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        envVarBindings: { LOOM_BROKER_URL: BROKER_ID },
        env: [{ name: 'LOOM_BROKER_URL', value: '' }],
      },
    ]);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.emptyValue).toBe(true);
    expect(r.edges[0]!.provenance).toBe('configured');
    expect(r.edges[0]!.intendedTo).toBe(BROKER_ID);
    expect(r.edges[0]!.evidence.artifact).toBe(CONSOLE_ARM);
  });

  it('SECRETREF IS INDETERMINATE: no edge, and a reason that refuses to call it empty', () => {
    const r = extractFromContainerAppEnv([
      { appResourceId: CONSOLE_ARM, env: [{ name: 'LOOM_DB_URL', secretRef: 'db-conn' }] },
    ]);
    expect(r.edges).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toMatch(/INDETERMINATE/);
    expect(r.skipped[0]!.reason).toMatch(/not an empty wire/i);
  });

  it('a secret-backed variable does NOT make its service look unreachable', () => {
    // The discriminating case: were secretRef treated as empty, the target would
    // land in the unreachable set and a healthy service would be recommended for
    // cleanup.
    const secretTarget = azureResourceNodeId(
      `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/secret-backed`,
    );
    const r = extractFromContainerAppEnv([
      { appResourceId: CONSOLE_ARM, envVarBindings: { SVC_URL: secretTarget }, env: [{ name: 'SVC_URL', secretRef: 's' }] },
    ]);
    const g = buildGraph([r]);
    // No edge at all — so no DANGLING edge claiming the wire is empty.
    expect(g.edges).toHaveLength(0);
    expect(g.danglingEdgesIntendedFor(secretTarget).result).toHaveLength(0);
  });

  it('an entry with neither value nor secretRef is indeterminate, not empty', () => {
    const r = extractFromContainerAppEnv([{ appResourceId: CONSOLE_ARM, env: [{ name: 'X' }] }]);
    expect(r.edges).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/indeterminate, not empty/i);
  });

  it('a resolvable FQDN becomes a RESOLVED configured edge', () => {
    const target = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/svc`;
    const r = extractFromContainerAppEnv([
      { appResourceId: CONSOLE_ARM, env: [{ name: 'SVC_URL', value: 'https://svc.internal.example.io' }] },
    ]);
    const g = buildGraph([
      {
        source: 'resource-graph',
        nodes: [
          {
            id: azureResourceNodeId(target),
            kind: 'azure-resource',
            displayName: 'svc',
            source: 'resource-graph',
            resourceId: target,
            resourceType: 'Microsoft.App/containerApps',
            subscriptionId: SUB,
            resourceGroup: 'rg',
            tags: {},
            ingress: { external: false, fqdn: 'svc.internal.example.io' },
          },
          {
            id: azureResourceNodeId(CONSOLE_ARM),
            kind: 'azure-resource',
            displayName: 'loom-console',
            source: 'resource-graph',
            resourceId: CONSOLE_ARM,
            resourceType: 'Microsoft.App/containerApps',
            subscriptionId: SUB,
            resourceGroup: 'rg',
            tags: {},
          },
        ],
        edges: [],
        population: { subject: 'nodes', examined: 2, edgesExamined: 0, scope: 't', blind: false, byProvenance: { declared: 0, configured: 0, imports: 0, observed: 0, owns: 0 } },
        skipped: [],
      },
      r,
    ]);
    expect(g.inboundEdges(azureResourceNodeId(target), 'configured').result).toHaveLength(1);
    expect(nodesWithNoInboundEdge(g, 'configured').result.map((n) => n.id)).not.toContain(
      azureResourceNodeId(target),
    );
  });

  it('a flag or a number is not a wire', () => {
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        env: [
          { name: 'FEATURE_ON', value: 'true' },
          { name: 'TIMEOUT_MS', value: '3000' },
        ],
      },
    ]);
    expect(r.edges).toHaveLength(0);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0]!.reason).toMatch(/does not name a target/);
  });

  it('onlyNames narrows the scan, and the population says so', () => {
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        onlyNames: ['LOOM_BROKER_URL'],
        env: [
          { name: 'LOOM_BROKER_URL', value: '' },
          { name: 'UNRELATED', value: 'x' },
        ],
      },
    ]);
    expect(r.edges).toHaveLength(1);
    expect(r.population.scope).toMatch(/1 env entr\(ies\) examined \(name-filtered\)/);
  });

  it('EMPTY input is BLIND', () => {
    expect(extractFromContainerAppEnv([]).population.blind).toBe(true);
  });

  it('an app that DID yield edges is NOT blind, and counts them as `configured`', () => {
    // Counterpart to the blind-on-empty case above: that assertion is vacuous
    // unless `blind` can also be false. It could not be — the extractor passed
    // an empty array to makePopulation, pinning `blind` true and `byProvenance`
    // all-zero regardless of what it emitted.
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        env: [
          { name: 'LOOM_BROKER_URL', value: '' },
          { name: 'FEATURE_ON', value: 'true' },
        ],
      },
    ]);
    expect(r.edges).toHaveLength(1);
    expect(r.population.blind).toBe(false);
    expect(r.population.edgesExamined).toBe(1);
    expect(r.population.byProvenance.configured).toBe(1);
    // This extractor reads a LIVE deployment, so it never emits `declared`.
    expect(r.population.byProvenance.declared).toBe(0);
  });
});

describe('extractFromSourceImports', () => {
  const A = 'apps/fiab-console/lib/brain/a.ts';
  const B = 'apps/fiab-console/lib/brain/b.ts';

  it('a relative import becomes an imports edge that resolves', () => {
    const r = extractFromSourceImports([
      { path: A, text: "import { x } from './b';\n" },
      { path: B, text: 'export const x = 1;\n' },
    ]);
    const g = buildGraph([r]);
    const inbound = g.inboundEdges(codeModuleNodeId(B), 'imports');
    expect(inbound.result).toHaveLength(1);
    expect(inbound.result[0]!.from).toBe(codeModuleNodeId(A));
    expect(inbound.result[0]!.evidence.line).toBe(1);
  });

  it('finds a module that NOTHING imports — the dead-code shape', () => {
    const ORPHAN = 'apps/fiab-console/lib/brain/orphan.ts';
    const r = extractFromSourceImports([
      { path: A, text: "import { x } from './b';\n" },
      { path: B, text: 'export const x = 1;\n' },
      { path: ORPHAN, text: 'export const dead = 1;\n' },
    ]);
    const g = buildGraph([r]);
    const q = nodesWithNoInboundEdge(g, 'imports', { kind: 'code-module', describe: 'code modules' });
    const ids = q.result.map((n) => n.id);
    expect(ids).toContain(codeModuleNodeId(ORPHAN));
    // A is an entry point — also uncited. The CONTROL is B, which is imported
    // and must not appear.
    expect(ids).not.toContain(codeModuleNodeId(B));
    expect(q.population.byProvenance.imports).toBeGreaterThan(0);
  });

  it('handles export-from, dynamic import and require', () => {
    const r = extractFromSourceImports([
      { path: A, text: "export { y } from './b';\nconst z = await import('./b');\nconst w = require('./b');\n" },
      { path: B, text: 'export const y = 1;\n' },
    ]);
    expect(r.edges.filter((e) => e.provenance === 'imports')).toHaveLength(3);
  });

  it('RECORDS a bare specifier rather than guessing at node resolution', () => {
    const r = extractFromSourceImports([{ path: A, text: "import React from 'react';\n" }]);
    expect(r.edges).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/bare specifier/);
    expect(r.skipped[0]!.subject).toContain('react');
  });

  it("records a '@/' specifier when no aliasRoot is supplied, and resolves it when one is", () => {
    const withoutRoot = extractFromSourceImports([{ path: A, text: "import { z } from '@/lib/brain/b';\n" }]);
    expect(withoutRoot.edges).toHaveLength(0);
    expect(withoutRoot.skipped[0]!.reason).toMatch(/no aliasRoot supplied/);

    const withRoot = extractFromSourceImports(
      [
        { path: A, text: "import { z } from '@/lib/brain/b';\n" },
        { path: B, text: 'export const z = 1;\n' },
      ],
      { aliasRoot: 'apps/fiab-console' },
    );
    const g = buildGraph([withRoot]);
    expect(g.inboundEdges(codeModuleNodeId(B), 'imports').result).toHaveLength(1);
  });

  it('CRLF and LF give the same edges and the same line numbers', () => {
    const lines = ["import { a } from './b';", "import { c } from './d';"];
    const lf = extractFromSourceImports([{ path: A, text: lines.join('\n') }]);
    const crlf = extractFromSourceImports([{ path: A, text: lines.join('\r\n') }]);
    expect(crlf.edges.map((e) => e.evidence.line)).toEqual(lf.edges.map((e) => e.evidence.line));
    expect(lf.edges.map((e) => e.evidence.line)).toEqual([1, 2]);
  });

  it('EMPTY input is BLIND', () => {
    expect(extractFromSourceImports([]).population.blind).toBe(true);
  });

  it('modules that DID yield edges are NOT blind, and count them as `imports`', () => {
    const r = extractFromSourceImports([
      { path: A, text: "import { x } from './b';\n" },
      { path: B, text: 'export const x = 1;\n' },
    ]);
    expect(r.edges).toHaveLength(1);
    expect(r.population.blind).toBe(false);
    expect(r.population.edgesExamined).toBe(1);
    expect(r.population.byProvenance.imports).toBe(1);
    expect(r.population.byProvenance.declared).toBe(0);
    expect(r.population.byProvenance.configured).toBe(0);
  });
});
