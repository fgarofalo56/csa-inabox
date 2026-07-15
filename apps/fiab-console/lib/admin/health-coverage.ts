/**
 * CSA Loom health — STRUCTURAL coverage derivation.
 *
 * Instead of hand-listing a check per workload, this module DERIVES checks
 * from the live registries so coverage grows automatically:
 *
 *  1. Workload families — iterates the item-type catalog
 *     (lib/catalog/fabric-item-types.ts, ~130 types across ~22 workload
 *     categories) and, per category, emits ONE health check whose status is
 *     the WORST status of the backend checks mapped to that family in
 *     lib/admin/health-coverage-map.json. A brand-new workload category with
 *     no mapping fails BOTH here (a red check on /admin/health) and in CI
 *     (scripts/ci/check-health-coverage.mjs) — coverage cannot silently lag
 *     the catalog.
 *
 *  2. External gates — consumes the optional lib/gates/registry.ts via the
 *     graceful-absence bridge (lib/admin/gate-registry.ts): every registered
 *     gate becomes a health check automatically once the registry lands.
 *
 * No probe is faked: family checks AGGREGATE real check results (env gates +
 * live probes) — they never invent a green.
 */
import coverageMap from './health-coverage-map.json';
import type { AuditStatus, CheckResult } from './self-audit';
import { loadExternalGates } from './gate-registry';

interface FamilyMapEntry { checks?: string[]; allow?: string; }
const FAMILIES: Record<string, FamilyMapEntry> = (coverageMap as any).families || {};

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const RANK: Record<AuditStatus, number> = { pass: 0, warn: 1, fail: 2 };

/**
 * Derive one aggregated check per workload family in the item-type catalog.
 * `results` are the already-computed env + probe check results this run.
 */
export async function familyCoverageChecks(results: CheckResult[]): Promise<CheckResult[]> {
  // Lazy import: the catalog barrel is large; only load it when the audit runs.
  const { FABRIC_ITEM_TYPES } = await import('@/lib/catalog/fabric-item-types');
  const byId = new Map(results.map((r) => [r.id, r]));

  // Group live catalog slugs by category (skip deprecated — no create path).
  const families = new Map<string, string[]>();
  for (const t of FABRIC_ITEM_TYPES) {
    if (t.deprecated) continue;
    const list = families.get(t.category) || [];
    list.push(t.slug);
    families.set(t.category, list);
  }

  const out: CheckResult[] = [];
  for (const [category, slugs] of families) {
    const id = `family-${kebab(category)}`;
    const entry = FAMILIES[category];
    const base = {
      id, category: 'workloads' as const, severity: 'recommended' as const,
      title: `${category} — backend coverage (${slugs.length} item type${slugs.length === 1 ? '' : 's'})`,
    };
    if (!entry || (!entry.checks?.length && !entry.allow)) {
      // A NEW workload family landed with no health mapping: honest red.
      out.push({
        ...base, status: 'fail',
        detail: `The item-type catalog contains workload family "${category}" (${slugs.slice(0, 8).join(', ')}${slugs.length > 8 ? ', …' : ''}) but lib/admin/health-coverage-map.json has no backend-check mapping for it — its backend is NOT health-monitored.`,
        remediation: `Add a "families" entry for "${category}" in apps/fiab-console/lib/admin/health-coverage-map.json mapping it to the self-audit checks (env gate + live probe) that guard its backend — and add a real probe in lib/admin/health-probes.ts if none exists. scripts/ci/check-health-coverage.mjs blocks merges until this is mapped.`,
      });
      continue;
    }
    const refs = (entry.checks || [])
      .map((cid) => byId.get(cid))
      .filter((r): r is CheckResult => !!r);
    const dangling = (entry.checks || []).filter((cid) => !byId.has(cid));
    if (dangling.length || refs.length === 0) {
      out.push({
        ...base, status: 'fail',
        detail: `Family "${category}" maps to check id(s) that did not run this audit: ${dangling.join(', ') || '(none resolved)'} — the mapping in health-coverage-map.json is stale.`,
        remediation: 'Fix the "families" mapping in apps/fiab-console/lib/admin/health-coverage-map.json to reference existing check ids (scripts/ci/check-health-coverage.mjs validates them).',
      });
      continue;
    }
    const worst = refs.reduce((w, r) => (RANK[r.status] > RANK[w.status] ? r : w), refs[0]);
    const summary = refs.map((r) => `${r.title}: ${r.status}`).join(' · ');
    out.push({
      ...base,
      status: worst.status,
      detail: worst.status === 'pass'
        ? `All ${refs.length} backend check(s) for this family pass — ${summary}.`
        : `Backend degraded for ${slugs.length} item type(s) (${slugs.slice(0, 6).join(', ')}${slugs.length > 6 ? ', …' : ''}) — worst: "${worst.title}" is ${worst.status}. ${summary}.`,
      remediation: worst.status === 'pass' ? undefined : (worst.remediation || `Resolve the underlying "${worst.title}" finding above.`),
      redeploy: worst.status === 'pass' ? undefined : worst.redeploy,
      docs: worst.docs,
      portalSteps: worst.status === 'pass' ? undefined : worst.portalSteps,
      fixScript: worst.status === 'pass' ? undefined : worst.fixScript,
      fixId: worst.status === 'pass' ? undefined : worst.fixId,
    });
  }
  // Stable order for a deterministic report.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Derive one check per gate registered in the (optional) gates registry. */
export async function gateRegistryChecks(): Promise<CheckResult[]> {
  const gates = await loadExternalGates();
  const out: CheckResult[] = [];
  for (const g of gates) {
    try {
      const miss = await g.evaluate();
      out.push({
        id: g.id, category: 'workloads', severity: 'optional',
        title: g.title,
        status: miss ? 'warn' : 'pass',
        detail: miss ? (miss.detail || `Missing: ${miss.missing}.`) : 'Gate satisfied.',
        remediation: miss ? (g.remediation || `Set ${miss.missing}.`) : undefined,
        redeploy: miss ? true : undefined,
      });
    } catch (e: any) {
      out.push({
        id: g.id, category: 'workloads', severity: 'optional',
        title: g.title, status: 'warn',
        detail: `Gate evaluation failed: ${e?.message || String(e)}`,
        remediation: g.remediation,
      });
    }
  }
  return out;
}
