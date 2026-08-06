/**
 * adopt-bag — ONE derivation of the `adopt` object for EVERY deploy tier (#3016).
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * `collectAdoptBag()` lived inside `app/api/setup/deploy/route.ts` and had
 * exactly one call site: the copy-paste `az deployment sub create` string built
 * for the HTTP-503 fallback. The three tiers that actually deploy — the
 * user-delegated ARM PUT, the Setup Orchestrator, and the GitHub
 * workflow-dispatch — never saw it. When an in-product deploy succeeded, the
 * operator's "use my existing Purview" pick was silently ignored and the
 * deployment provisioned a duplicate (which then fails the whole run with
 * `EnterpriseTenantAlreadyExists`).
 *
 * The wizard has since grown a first-class {@link DeploymentPlan} (posted as
 * `body.plan`), which the route ignored entirely — so the richer artifact was
 * ALSO discarded on every tier.
 *
 * This module is the single place the submitted request becomes an adopt bag:
 *
 *   - `body.plan` present  → sanitize it and serialize via `planToAdoptBag()`
 *                            (the same serializer `main.bicep`'s `adopt` param
 *                            documents as its emitter).
 *   - legacy fields only   → the old `serviceChoices` + `existing*` collection,
 *                            preserved verbatim so pre-plan clients keep working.
 *
 * FAIL CLOSED. A malformed adopt pick is a `problem` the route must 400 on —
 * never a silently dropped entry. Silently dropping the decision is the exact
 * defect this file exists to remove.
 *
 * Callers (each tier MUST consume the SAME bag — the guard tests in
 * `app/api/setup/__tests__/deploy-adopt-transport.test.ts` go red if one stops):
 *   tier 0  user-ARM PUT      → `buildDlzDeploymentParameters({ adopt })`
 *   tier 1  Setup Orchestrator→ explicit `adopt` field on the POST payload
 *   tier 2  GitHub dispatch   → cannot carry it (no declared input; the API
 *                               422s undeclared inputs and caps inputs at 10) —
 *                               the route SKIPS this tier when the bag holds an
 *                               adopt/skip decision, rather than dispatch-and-discard
 *   tier 3  copy-paste `az`   → `adoptCliParam()`
 */

import { planToAdoptBag, type AdoptBag, type AdoptEntry } from '@/lib/deploy/plan-to-arm';
import type { DeploymentPlan, ServiceDecision } from '@/lib/deploy/plan-model';
import { getServiceDef } from '@/lib/deploy/adoption-catalog';

export type { AdoptBag, AdoptEntry };

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Azure resource-name-ish: bounded, no quotes/newlines that could break a CLI line. */
const SAFE_VALUE = /^[^'"\r\n\\]{0,260}$/;

/**
 * Maps a scan-and-choose service key → the bicep enable flag that governs
 * provisioning (`flag` null = DLZ-provisioned service with no toggle), plus
 * whether a reuse choice may contribute an adopt-bag entry. Moved here from the
 * deploy route so the bag derivation and the flag emission share one table.
 */
export const SERVICE_PARAM_MAP: Record<string, { adoptable: boolean; flag: string | null }> = {
  aisearch: { adoptable: true, flag: 'aiSearchEnabled' },
  apim: { adoptable: true, flag: 'apimEnabled' },
  adx: { adoptable: true, flag: 'adxEnabled' },
  foundry: { adoptable: true, flag: 'aiFoundryEnabled' },
  purview: { adoptable: true, flag: 'purviewEnabled' },
  maps: { adoptable: true, flag: 'azureMapsEnabled' },
  synapse: { adoptable: true, flag: null },
  cosmos: { adoptable: true, flag: null },
  adf: { adoptable: true, flag: null },
  eventhubs: { adoptable: true, flag: null },
  databricks: { adoptable: true, flag: null },
  postgres: { adoptable: false, flag: 'postgresEnabled' },
  storage: { adoptable: false, flag: null },
  keyvault: { adoptable: false, flag: null },
};

/** The request fields this derivation reads (subset of the route's SetupConfig). */
export interface AdoptBagSource {
  plan?: unknown;
  serviceChoices?: Record<
    string,
    { mode: 'new' | 'use-existing' | 'disable'; existing?: { name: string; rg: string; sub: string } }
  >;
  existingCosmosAccount?: string;
  existingCosmosRg?: string;
  existingCosmosSub?: string;
  existingAdxClusterName?: string;
  existingEventHubNamespace?: string;
  existingAsaJob?: string;
}

export interface DerivedAdoptBag {
  bag: AdoptBag;
  source: 'plan' | 'legacy' | 'none';
  /**
   * Fail-closed contract: any entry here means an adopt pick could NOT be
   * honoured as submitted. The route must refuse the submit (400) — proceeding
   * would deploy something other than what the operator chose.
   */
  problems: string[];
  /** The sanitized plan when `source === 'plan'` — the fitness gate consumes it. */
  plan: DeploymentPlan | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Sanitize the CLIENT-POSTED plan down to the shape the serializers read.
 * Only `services` is trusted enough to act on here; everything else on the
 * plan is advisory to this derivation. Unknown/unsafe content is a `problem`,
 * not a silent drop.
 */
export function sanitizeSubmittedPlan(raw: unknown): { plan: DeploymentPlan | null; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { plan: null, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { plan: null, problems: ['plan is not an object'] };
  }
  const services = (raw as { services?: unknown }).services;
  if (services === undefined || services === null) {
    return { plan: null, problems: ['plan carries no services record'] };
  }
  if (typeof services !== 'object' || Array.isArray(services)) {
    return { plan: null, problems: ['plan.services is not a record'] };
  }

  const clean: Record<string, ServiceDecision> = {};
  for (const [key, rawDecision] of Object.entries(services as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{1,40}$/.test(key)) {
      problems.push(`plan.services key "${String(key).slice(0, 40)}" is not a valid service key`);
      continue;
    }
    const d = rawDecision as Partial<ServiceDecision> | null;
    const mode = d?.mode;
    if (mode !== 'adopt' && mode !== 'create' && mode !== 'skip') {
      problems.push(`plan.services.${key}.mode "${String(mode).slice(0, 20)}" is not adopt|create|skip`);
      continue;
    }
    if (mode === 'adopt') {
      if (!getServiceDef(key)) {
        // planToAdoptBag would silently drop an unknown key — for an ADOPT pick
        // that silence is the defect, so it is a refusal here.
        problems.push(`plan adopts "${key}", which is not in the adoption catalog — the deployment could not honour it`);
        continue;
      }
      const name = str(d?.target?.name);
      const rg = str(d?.target?.rg);
      const sub = str(d?.target?.sub);
      if (!name) {
        problems.push(`plan adopts ${key} but names no resource`);
        continue;
      }
      for (const [field, value] of [['name', name], ['rg', rg]] as const) {
        if (!SAFE_VALUE.test(value)) {
          problems.push(`plan.services.${key}.target.${field} contains characters a resource coordinate cannot`);
        }
      }
      if (sub && !GUID_RE.test(sub)) {
        problems.push(`plan.services.${key}.target.sub is not a subscription GUID`);
      }
    }
    const extraIn = d?.extra && typeof d.extra === 'object' && !Array.isArray(d.extra) ? d.extra : undefined;
    const extra: Record<string, string> = {};
    for (const [ek, ev] of Object.entries(extraIn ?? {})) {
      if (/^[A-Za-z0-9_-]{1,60}$/.test(ek) && typeof ev === 'string' && SAFE_VALUE.test(ev)) extra[ek] = ev;
    }
    // `source` survives when it is a known value — validatePlan's singleton
    // protection ('create-not-permitted') keys on source==='discovered', so
    // flattening it to 'manual' would disarm that check server-side.
    const sourceIn = (d as ServiceDecision | null)?.source;
    const source: ServiceDecision['source'] =
      sourceIn === 'discovered' || sourceIn === 'default' || sourceIn === 'reconciled' || sourceIn === 'manual'
        ? sourceIn
        : 'manual';
    // A target on a create/skip decision is kept when SAFE (it is what makes a
    // discovered-candidate create recognisable to the singleton check) and
    // silently dropped when not — the decision itself is not coordinate-bearing.
    const rawTarget = d?.target;
    const targetSafe =
      rawTarget &&
      SAFE_VALUE.test(str(rawTarget.name)) &&
      SAFE_VALUE.test(str(rawTarget.rg)) &&
      (!str(rawTarget.sub) || GUID_RE.test(str(rawTarget.sub)));
    clean[key] = {
      mode,
      source,
      ...(mode === 'adopt'
        ? { target: { name: str(d?.target?.name), rg: str(d?.target?.rg), sub: str(d?.target?.sub) } }
        : targetSafe && str(rawTarget?.name)
          ? { target: { name: str(rawTarget?.name), rg: str(rawTarget?.rg), sub: str(rawTarget?.sub) } }
          : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
      // Carried through UNTRUSTED-as-submitted; the fitness gate re-reads it.
      ...(d && (d as ServiceDecision).fitness ? { fitness: (d as ServiceDecision).fitness } : {}),
      decidedBy: str((d as ServiceDecision | null)?.decidedBy) || 'setup-wizard',
      decidedAt: str((d as ServiceDecision | null)?.decidedAt) || new Date().toISOString(),
    };
  }

  if (problems.length > 0) return { plan: null, problems };
  const src = raw as Partial<DeploymentPlan>;
  // validatePlan dereferences scanScope/scanResults — guarantee their shape so
  // a client that omits them yields an empty ledger, not a 500.
  const scanScope = {
    subscriptions: Array.isArray(src.scanScope?.subscriptions)
      ? src.scanScope.subscriptions.filter((s): s is string => typeof s === 'string')
      : [],
    managementGroups: Array.isArray(src.scanScope?.managementGroups)
      ? src.scanScope.managementGroups.filter((s): s is string => typeof s === 'string')
      : [],
  };
  const plan = {
    ...src,
    services: clean,
    scanScope,
    scanResults: Array.isArray(src.scanResults) ? src.scanResults : [],
  } as DeploymentPlan;
  return { plan, problems };
}

/** The legacy (pre-plan) collection, preserved verbatim from the deploy route. */
export function collectLegacyAdoptBag(body: AdoptBagSource): { bag: AdoptBag; problems: string[] } {
  const bag: AdoptBag = {};
  const problems: string[] = [];
  const put = (key: string, name?: string, rg?: string, sub?: string) => {
    if (!name) return;
    for (const [field, value] of [['name', name], ['rg', rg ?? ''], ['sub', sub ?? '']] as const) {
      if (!SAFE_VALUE.test(value)) {
        problems.push(`${key} reuse ${field} contains characters a resource coordinate cannot`);
        return;
      }
    }
    if (sub && !GUID_RE.test(sub)) {
      problems.push(`${key} reuse subscription is not a GUID`);
      return;
    }
    bag[key] = { mode: 'adopt', target: { name, rg: rg ?? '', sub: sub ?? '' } };
  };

  for (const [svc, choice] of Object.entries(body.serviceChoices ?? {})) {
    const map = SERVICE_PARAM_MAP[svc];
    if (!map?.adoptable) continue;
    if (choice.mode !== 'use-existing' || !choice.existing) continue;
    put(svc, choice.existing.name, choice.existing.rg, choice.existing.sub);
  }
  // The dedicated top-level fields the wizard still posts for the Console
  // Cosmos and the RTI backends — same decision, same bag.
  put('cosmos', body.existingCosmosAccount, body.existingCosmosRg, body.existingCosmosSub);
  put('adx', body.existingAdxClusterName);
  put('eventhubs', body.existingEventHubNamespace);
  put('streamanalytics', body.existingAsaJob);
  return { bag, problems };
}

/**
 * Derive THE adopt bag for this submit. Every deploy tier consumes this one
 * result — deriving it twice (or per-tier) is how the tiers diverged before.
 */
export function deriveAdoptBag(body: AdoptBagSource): DerivedAdoptBag {
  const { plan, problems: planProblems } = sanitizeSubmittedPlan(body.plan);
  if (planProblems.length > 0) {
    return { bag: {}, source: 'plan', problems: planProblems, plan: null };
  }
  if (plan) {
    return { bag: planToAdoptBag(plan), source: 'plan', problems: [], plan };
  }
  const { bag, problems } = collectLegacyAdoptBag(body);
  if (problems.length > 0) return { bag: {}, source: 'legacy', problems, plan: null };
  return { bag, source: Object.keys(bag).length ? 'legacy' : 'none', problems: [], plan: null };
}

/**
 * True when the bag carries at least one decision the deployment MUST honour —
 * an `adopt` or a `skip`. A plan built from discovery seeds EVERY service with
 * a `create` entry (plan-builder), and an all-create bag is behaviourally
 * identical to no bag (`adoptMode()` defaults absent keys to 'create'), so a
 * pure-greenfield submit keeps every tier — including GitHub dispatch —
 * exactly as before. The full bag (create entries included) is still emitted
 * whenever this is true: an explicit `create` is the belt against a stale
 * `LOOM_ADOPT_JSON` env merge rebinding a resource (plan-to-arm rule 1).
 */
export function adoptBagHasDecisions(bag: AdoptBag): boolean {
  return Object.values(bag).some((e) => e.mode !== 'create');
}

/**
 * The copy-paste `-p adopt=…` line. Single-quoted for the shell with embedded
 * quotes escaped the POSIX way — same policy as `planToCliTokens()`, so the
 * copy-paste tier cannot drift from the serializer the other tiers use.
 */
export function adoptCliParam(bag: AdoptBag): string {
  const json = JSON.stringify(bag);
  return `adopt='${json.replace(/'/g, `'\\''`)}'`;
}
