/**
 * #3513 — install-time remediation gates must resolve to the gate registry (G2).
 *
 * THE DEFECT: `.claude/rules/ux-baseline.md` G2 requires every unavoidable gate
 * to (a) carry an inline Fix-it, (b) be registered in the central gate registry
 * so Copilot can discover + resolve it, and (c) appear on the Admin gate page.
 * `lib/gates/registry` already delivers all three for any gate that can be NAMED
 * — `HonestGate` renders a real "Fix it" button + `GateFixitDialog`, and
 * `/admin/gates` lists every gate with its owning surfaces.
 *
 * But `RemediationGate` (the envelope every provisioner returns) had only
 * `{reason, remediation, link}`. There was NO field naming the gate, so all 114
 * `status:'remediation'` sites in this tree resolved to NOTHING: no registry
 * row, no Fix-it, invisible to Copilot. Identical defect class to the UC
 * system-tables error codes fixed by `svc-databricks-system-tables` in #2624.
 *
 * These tests pin the LINK, not a spelling: they scan the real provisioner
 * sources, so a new `gateId` typo'd or pointed at a deleted gate fails here.
 *
 * MUTATION PROOF (break the subject, watch the named spec go red, restore):
 *   a) Change any `gateId: 'svc-adx'` to `gateId: 'svc-adxx'` in kql-db.ts
 *      -> RED: "every gateId used in a provisioner resolves to a real registry gate"
 *   b) Delete `gateId: 'svc-eventhubs'` from eventstream.ts
 *      -> RED: "eventstream's Event Hubs gate names svc-eventhubs"
 *   c) Remove the `gateId?: string` field from RemediationGate in types.ts
 *      -> RED (type error at build; and) "RemediationGate exposes a gateId link"
 *   d) Point `svc-purview-uc`'s fixit at a kind with no resolver, or empty its
 *      requiredSettings -> RED: "every linked gate can actually be fixed"
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getGate, GATES } from '@/lib/gates/registry';

const PROVISIONER_DIR = join(process.cwd(), 'lib/install/provisioners');

/** Every `gateId: '<id>'` literal in the production provisioner sources. */
function collectGateIdUsages(): Array<{ file: string; gateId: string }> {
  const out: Array<{ file: string; gateId: string }> = [];
  for (const file of readdirSync(PROVISIONER_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(PROVISIONER_DIR, file), 'utf8');
    for (const m of src.matchAll(/gateId:\s*'([^']+)'/g)) {
      out.push({ file, gateId: m[1] });
    }
  }
  return out;
}

describe('#3513 — provisioner remediation gates link to the registry', () => {
  it('RemediationGate exposes a gateId link to the registry', () => {
    const types = readFileSync(join(PROVISIONER_DIR, 'types.ts'), 'utf8');
    // The field must exist on the interface every provisioner returns —
    // without it no install gate can ever reach HonestGate's Fix-it.
    expect(types).toMatch(/export interface RemediationGate\b/);
    expect(types).toMatch(/\bgateId\?:\s*string/);
  });

  it('at least one provisioner actually uses the link (the field is not dead)', () => {
    // Guards the vacuous-pass shape: a gateId field nobody populates would make
    // every "resolves to a real gate" assertion below trivially true.
    expect(collectGateIdUsages().length).toBeGreaterThanOrEqual(15);
  });

  it('every gateId used in a provisioner resolves to a real registry gate', () => {
    const unresolved = collectGateIdUsages()
      .filter((u) => !getGate(u.gateId))
      .map((u) => `${u.file} -> '${u.gateId}'`);
    expect(unresolved, `unknown gate ids: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('every linked gate can actually be fixed (a Fix-it that cannot fix is worse than none)', () => {
    for (const { file, gateId } of collectGateIdUsages()) {
      const gate = getGate(gateId)!;
      expect(gate.fixit, `${file}: gate ${gateId} has no fixit`).toBeTruthy();
      expect(gate.fixit.kind, `${file}: gate ${gateId} has no fixit kind`).toBeTruthy();
      // A gate whose Fix-it is an env/resource picker MUST name the settings the
      // dialog writes, or the button opens on an empty form.
      if (gate.fixit.kind === 'env-picker' || gate.fixit.kind === 'resource-picker') {
        expect(
          gate.requiredSettings.length,
          `${file}: gate ${gateId} has a ${gate.fixit.kind} Fix-it but no settings to set`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every linked gate is discoverable on /admin/gates as firing during app install', () => {
    // (c) of G2: the Admin gate page renders `g.surfaces` and searches them, so
    // a gate that fires at install must SAY so or the operator cannot find it.
    const linked = [...new Set(collectGateIdUsages().map((u) => u.gateId))];
    const missingInstallSurface = linked.filter((id) => {
      const gate = getGate(id)!;
      return !gate.surfaces.some((sf) => sf.path.includes('/api/apps/') && sf.path.includes('install'));
    });
    expect(
      missingInstallSurface,
      `gates linked from a provisioner but not listing the install surface: ${missingInstallSurface.join(', ')}`,
    ).toEqual([]);
  });

  // ── the specific links, so a silent DELETION of one is caught ──────────────
  const EXPECTED: Array<[file: string, gateId: string, why: string]> = [
    ['ai-search.ts', 'svc-aisearch', 'LOOM_AI_SEARCH_SERVICE'],
    ['adf-pipeline.ts', 'svc-adf', 'LOOM_ADF_FACTORY / LOOM_ADF_RG'],
    ['databricks-job.ts', 'svc-databricks', 'LOOM_DATABRICKS_HOSTNAME'],
    ['eventstream.ts', 'svc-eventhubs', 'LOOM_EVENTHUB_NAMESPACE'],
    ['kql-db.ts', 'svc-adx', 'LOOM_KUSTO_CLUSTER_URI'],
    ['kql-dashboard.ts', 'svc-adx', 'LOOM_KUSTO_CLUSTER_URI'],
    ['workspace-monitor.ts', 'svc-adx', 'LOOM_KUSTO_CLUSTER_URI'],
    ['logic-app.ts', 'svc-logic-apps', 'Logic Apps ARM coordinates'],
    ['mirrored-database.ts', 'svc-adf', 'LOOM_ADF_FACTORY / LOOM_ADF_RG'],
    ['mirrored-database.ts', 'svc-adls', 'LOOM_ADLS_ACCOUNT'],
    ['ml-model.ts', 'svc-databricks', 'LOOM_DATABRICKS_HOSTNAME'],
    ['synapse-pipeline.ts', 'svc-synapse', 'LOOM_SYNAPSE_WORKSPACE'],
    ['warehouse.ts', 'svc-synapse', 'LOOM_SYNAPSE_WORKSPACE + dedicated pool'],
    ['activator.ts', 'svc-monitor-alerts', 'LOOM_LOG_ANALYTICS_RESOURCE_ID'],
    ['data-product.ts', 'svc-purview-uc', 'LOOM_PURVIEW_UC_ENDPOINT'],
  ];

  it.each(EXPECTED)('%s links its config gate to %s (%s)', (file, gateId) => {
    const usages = collectGateIdUsages().filter((u) => u.file === file);
    expect(
      usages.map((u) => u.gateId),
      `${file} no longer names ${gateId}`,
    ).toContain(gateId);
  });

  it('each linked gate governs the env vars its provisioner actually checks', () => {
    // R7 — do not assert a mapping we did not establish. A Fix-it for a gate
    // that writes UNRELATED env vars would not unblock the install.
    const bySetting: Record<string, string> = {
      'svc-aisearch': 'LOOM_AI_SEARCH_SERVICE',
      'svc-adx': 'LOOM_KUSTO_CLUSTER_URI',
      'svc-eventhubs': 'LOOM_EVENTHUB_NAMESPACE',
      'svc-databricks': 'LOOM_DATABRICKS_HOSTNAME',
      'svc-synapse': 'LOOM_SYNAPSE_WORKSPACE',
      'svc-adls': 'LOOM_ADLS_ACCOUNT',
      'svc-purview-uc': 'LOOM_PURVIEW_UC_ENDPOINT',
      'svc-monitor-alerts': 'LOOM_LOG_ANALYTICS_RESOURCE_ID',
      'svc-adf': 'LOOM_ADF_FACTORY',
    };
    for (const [gateId, envVar] of Object.entries(bySetting)) {
      const gate = getGate(gateId)!;
      expect(gate, `gate ${gateId} missing`).toBeTruthy();
      expect(
        gate.requiredSettings.map((s) => s.envVar),
        `gate ${gateId} does not govern ${envVar}`,
      ).toContain(envVar);
    }
  });

  it('gate ids are still unique in the registry (no duplicate claim)', () => {
    const ids = GATES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
