/**
 * Synapse workspace KQL-script + Spark-job-definition family — BFF route
 * existence + realness test, plus client-shape unit tests.
 *
 * Real test (per .claude/rules/no-vaporware.md): verifies the BFF route files
 * the Workspace Resources navigator + the two new editors fetch actually exist
 * on disk AND wire a real Synapse backing client (not a stub), and that the
 * artifact-client factory helpers emit the correct shapes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  emptyKqlScriptProperties,
  emptySparkJobDefinitionProperties,
  synapseKustoPoolUri,
} from '@/lib/azure/synapse-artifacts-client';

const SYNAPSE_API = resolve(__dirname, '..', '..', '..', 'app', 'api', 'synapse');

// route family → segments that MUST exist (the primary action endpoints).
const REQUIRED_ROUTES: Record<string, string[]> = {
  kqlscripts:           ['', '[name]', '[name]/run'],
  sparkjobdefinitions:  ['', '[name]', '[name]/run'],
};

function readRoute(family: string, sub: string): string | null {
  const path = sub ? join(SYNAPSE_API, family, sub, 'route.ts') : join(SYNAPSE_API, family, 'route.ts');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

function looksReal(src: string): boolean {
  return /from '@\/lib\/azure\/synapse-(artifacts|dev)-client'/.test(src);
}

describe('Synapse KQL-script + Spark-job-definition BFF routes', () => {
  for (const [family, subs] of Object.entries(REQUIRED_ROUTES)) {
    for (const sub of subs) {
      const label = sub ? `${family}/${sub}` : `${family} (collection)`;
      it(`${label} — route.ts exists and wires a real Synapse client`, () => {
        const src = readRoute(family, sub);
        expect(src, `expected route file for ${label}`).toBeTruthy();
        if (!src) return;
        expect(looksReal(src), `route ${label} must import a real synapse client`).toBe(true);
        // Every route validates the session + honest-gates the workspace.
        expect(/getSession\(/.test(src), `route ${label} must check session`).toBe(true);
        expect(/synapseConfigGate|not_configured/.test(src), `route ${label} must honest-gate the workspace`).toBe(true);
      });
    }
  }
});

describe('Synapse artifact-client factory shapes', () => {
  it('emptyKqlScriptProperties pins a KustoPool connection', () => {
    const p = emptyKqlScriptProperties('pool1', 'db1');
    expect(p?.content?.currentConnection?.type).toBe('KustoPool');
    expect(p?.content?.currentConnection?.poolName).toBe('pool1');
    expect(p?.content?.currentConnection?.databaseName).toBe('db1');
    expect(typeof p?.content?.query).toBe('string');
  });

  it('emptyKqlScriptProperties leaves connection unset when no pool given', () => {
    const p = emptyKqlScriptProperties();
    expect(p?.content?.currentConnection?.poolName).toBeUndefined();
    expect(p?.content?.currentConnection?.type).toBe('KustoPool');
  });

  it('emptySparkJobDefinitionProperties targets the given Spark pool', () => {
    const p = emptySparkJobDefinitionProperties('sparkpool1');
    expect(p.targetBigDataPool.referenceName).toBe('sparkpool1');
    expect(p.targetBigDataPool.type).toBe('BigDataPoolReference');
    expect(p.language).toBe('PySpark');
    expect(p.jobProperties).toBeTruthy();
  });

  it('synapseKustoPoolUri builds a workspace-scoped Kusto pool URI', () => {
    process.env.LOOM_SYNAPSE_WORKSPACE = 'myws';
    const uri = synapseKustoPoolUri('mypool');
    // Commercial default host suffix.
    expect(uri).toBe('https://mypool.myws.kusto.azuresynapse.net');
  });
});
