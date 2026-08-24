/**
 * The REMEDIATOR — and the claim that its output is **structurally incapable of
 * executing**.
 *
 * That claim is checked four independent ways, because any one of them alone is
 * weak:
 *
 *   TYPE     the proposal's `requiresHumanApproval` / `mutatesAzure` are literal
 *            types the substrate pins; the substrate's own build-checked
 *            assertions fail `next build` if either is widened to `boolean`.
 *   VALUE    the whole draft is inert JSON — no function, no promise, no class
 *            instance, at any depth.
 *   TRANSIT  the draft survives `JSON.parse(JSON.stringify(...))` unchanged,
 *            which is what it means for a thing to be data.
 *   SOURCE   see `no-azure-mutation.test.ts`: nothing in the directory can call
 *            Azure at all.
 *
 * The purity check carries a CONTROL — an object that deliberately contains a
 * function, asserted to fail `isPureData`. Without it, a check that returned
 * `true` for everything would pass this suite silently, which is the exact
 * failure mode this repo has found in guard after guard.
 */

import { describe, expect, it } from 'vitest';
import {
  DESTRUCTIVE_PATTERNS,
  destructiveMatchesIn,
  draftRemediations,
  isPureData,
  parseDraft,
} from '@/lib/brain/agents';
import { makeFinding, stubClient, throwingClient } from './fixtures';

describe('remediator — the output cannot execute', () => {
  it('every proposal pins requiresHumanApproval=true and mutatesAzure=false', async () => {
    const out = await draftRemediations({
      findings: [makeFinding(), makeFinding()],
      client: stubClient({ remediator: { summary: 's', change: 'diff --git a b' } }),
    });
    for (const d of out.result) {
      expect(d.proposal.kind).toBe('proposal');
      expect(d.proposal.requiresHumanApproval).toBe(true);
      expect(d.proposal.mutatesAzure).toBe(false);
    }
  });

  it('a model reply claiming self-approval CANNOT weaken the proposal', async () => {
    // The model returns fields that, if merged, would flip the posture. They are
    // never read — the proposal is built through the substrate's constructor.
    const out = await draftRemediations({
      findings: [makeFinding()],
      client: stubClient({
        remediator: {
          summary: 's',
          change: 'c',
          requiresHumanApproval: false,
          mutatesAzure: true,
          kind: 'action',
        },
      }),
    });
    expect(out.result[0]!.proposal.requiresHumanApproval).toBe(true);
    expect(out.result[0]!.proposal.mutatesAzure).toBe(false);
    expect(out.result[0]!.proposal.kind).toBe('proposal');
  });

  it('the draft holds no callable at any depth', async () => {
    const out = await draftRemediations({
      findings: [makeFinding()],
      client: stubClient({ remediator: { summary: 's', change: 'c' } }),
    });
    expect(isPureData(out.result[0])).toBe(true);
    expect(isPureData(out.result)).toBe(true);
    expect(deepFindFunction(out.result[0])).toBeNull();
  });

  it('CONTROL — isPureData rejects an object that DOES hold a function', () => {
    // Without this the purity assertions above would pass against an
    // always-true check.
    expect(isPureData({ a: 1, nested: { run: () => 1 } })).toBe(false);
    expect(isPureData(() => 1)).toBe(false);
    expect(isPureData({ p: Promise.resolve(1) })).toBe(false);
    expect(isPureData({ d: new Date() })).toBe(false);
    expect(isPureData({ m: new Map() })).toBe(false);
  });

  it('the draft round-trips through JSON unchanged — it IS data', async () => {
    const out = await draftRemediations({
      findings: [makeFinding()],
      client: stubClient({ remediator: { summary: 's', change: 'c' } }),
    });
    const d = out.result[0]!;
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('the proposed change carries the review notice in its text', async () => {
    const out = await draftRemediations({ findings: [makeFinding()] });
    expect(out.result[0]!.proposal.proposedChange).toMatch(
      /This is a PROPOSAL\. It requires human review and approval\. Nothing in Loom Brain applies it\./,
    );
  });
});

describe('remediator — destructive-command flagging', () => {
  it('flags an az delete in the drafted text', async () => {
    const out = await draftRemediations({
      findings: [makeFinding()],
      client: stubClient({
        remediator: { summary: 'remove it', change: 'az containerapp delete -n app-alpha -g rg' },
      }),
    });
    expect(out.result[0]!.containsDestructiveCommand).toBe(true);
    expect(out.result[0]!.destructiveMatches).toContain('az-delete');
  });

  it('does not flag a non-destructive change', async () => {
    const out = await draftRemediations({
      findings: [makeFinding()],
      client: stubClient({
        remediator: { summary: 'wire it', change: "set LOOM_BROKER_URL to 'https://<fqdn>'" },
      }),
    });
    expect(out.result[0]!.containsDestructiveCommand).toBe(false);
    expect(out.result[0]!.destructiveMatches).toEqual([]);
  });

  it('every named pattern actually matches something — no dead entry in the list', () => {
    const samples: Record<string, string> = {
      'az-delete': 'az group delete --name rg',
      'az-purge': 'az keyvault purge --name kv',
      'powershell-remove': 'Remove-AzContainerApp -Name app',
      'terraform-destroy': 'terraform destroy -auto-approve',
      'kubectl-delete': 'kubectl delete deploy/app',
      'sql-drop': 'DROP TABLE dbo.things',
      'rm-rf': 'rm -rf ./node_modules',
      'force-push': 'git push origin main --force',
    };
    for (const p of DESTRUCTIVE_PATTERNS) {
      expect(samples[p.name], `no sample for pattern ${p.name}`).toBeDefined();
      expect(destructiveMatchesIn(samples[p.name]!), `pattern ${p.name} matched nothing`).toContain(
        p.name,
      );
    }
  });

  it('CONTROL — an innocuous string matches no pattern', () => {
    expect(destructiveMatchesIn('update the bicep module and redeploy')).toEqual([]);
  });
});

describe('remediator — degradation', () => {
  it("with no model, the detector's own remediation still ships", async () => {
    const out = await draftRemediations({ findings: [makeFinding()], client: throwingClient() });
    expect(out.result).toHaveLength(1);
    expect(out.result[0]!.degraded).toBe(true);
    expect(out.result[0]!.proposal.summary).toBe('Wire the variable or scale to zero');
    expect(out.result[0]!.proposal.proposedChange).toMatch(/edit main\.bicep:4730/);
    expect(out.population.modelUnavailable).toBe(1);
  });

  it('parses defensively', () => {
    expect(parseDraft(null)).toEqual({ summary: null, change: null });
    expect(parseDraft({ summary: 7, change: [] })).toEqual({ summary: null, change: null });
    expect(parseDraft({ summary: ' s ', change: ' c ' })).toEqual({ summary: 's', change: 'c' });
  });

  it('an empty finding list is BLIND', async () => {
    const out = await draftRemediations({ findings: [] });
    expect(out.population.blind).toBe(true);
  });
});

/** Walk an object graph and return the path to the first function found. */
function deepFindFunction(v: unknown, path = '$', depth = 0): string | null {
  if (depth > 12) return null;
  if (typeof v === 'function') return path;
  if (v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const hit = deepFindFunction(v[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const hit = deepFindFunction(val, `${path}.${k}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}
