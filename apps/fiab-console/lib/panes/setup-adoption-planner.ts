/**
 * useAdoptionPlanner — the state machine behind the deployment wizard's
 * scope → discovery → plan → review steps.
 *
 * Kept OUT of `setup-wizard.tsx` deliberately: that file is already 1,800+
 * lines and is the highest-traffic file in the setup surface. Everything the
 * greenfield/brownfield flow needs lives here, so the wizard's own diff is a
 * handful of lines and this logic is independently testable.
 *
 * THE FLOW (design §1.2), and the one thing it deliberately does NOT do:
 *
 *   scope      the operator confirms which subscriptions may be read
 *   discovery  one read-only Resource Graph pass → a coverage ledger
 *   plan       per-service reuse / deploy-new / skip, pre-set to a
 *              recommendation that always shows its reason
 *   review     the whole plan, hashed, before anything runs
 *
 * It never asks "greenfield or brownfield?". That is a question operators
 * frequently answer incorrectly about their own tenant, and asking it is a
 * `no_questions_in_product` violation. The discovery result determines the
 * path: an estate with nothing adoptable simply yields an all-`create` plan,
 * and `isGreenfieldPlan()` derives the label from the decisions.
 */
'use client';

import { useCallback, useState } from 'react';
import { clientFetch, CROSS_SUB_FETCH_TIMEOUT_MS, describeNonJsonResponse } from '@/lib/client-fetch';
import {
  applyDecision,
  applyFitness,
  buildPlanFromDiscovery,
  type ServiceScanRow,
} from '@/lib/deploy/plan-builder';
import { randomSuffix } from '@/lib/util/random-id';
import {
  type DeploymentPlan,
  type PlanBoundary,
  type PlanTopology,
  type ServiceMode,
  type ServiceTarget,
  type SubscriptionScanResult,
} from '@/lib/deploy/plan-model';

export interface ScanError {
  title: string;
  message: string;
}

export interface AdoptionPlannerArgs {
  boundary: PlanBoundary;
  topology: PlanTopology;
  installSubscriptionId: string;
  region: string;
  createdBy: string;
}

/**
 * A ULID-ish, monotonic-enough plan id. The timestamp prefix keeps plan ids
 * sortable in the Cosmos container without a second index.
 *
 * The random half comes from `lib/util/random-id`, which is crypto-backed and
 * REFUSES to fall back to `Math.random()`. The first cut of this had a
 * `: Math.random().toString(36)` fallback arm — a plan id is the key a deploy is
 * addressed by, and a predictable one is not a cosmetic problem. Refusing to
 * mint an id is the correct behaviour when no CSPRNG is available.
 */
export function newPlanId(now: () => number = Date.now): string {
  const ts = now().toString(36).padStart(9, '0');
  return `plan_${ts}_${randomSuffix(12)}`;
}

export interface AdoptionPlannerState {
  /** Subscriptions the operator consented to scan. */
  scope: string[];
  ledger: SubscriptionScanResult[] | null;
  rows: ServiceScanRow[] | null;
  plan: DeploymentPlan | null;
  loading: boolean;
  /** True while the adopt-fitness probe is running. Distinct from `loading`. */
  validating: boolean;
  error: ScanError | null;
}

export interface AdoptionPlanner extends AdoptionPlannerState {
  setScope: (next: string[]) => void;
  /** Runs the scan for the current scope and builds the initial plan. */
  runScan: (args: AdoptionPlannerArgs, names: Record<string, string>) => Promise<void>;
  decide: (serviceKey: string, mode: ServiceMode, target?: ServiceTarget) => void;
  /** Reads every adopted resource and attaches its fitness verdict to the plan. */
  validateAdoptions: () => Promise<void>;
  reset: () => void;
}

export function useAdoptionPlanner(): AdoptionPlanner {
  const [scope, setScope] = useState<string[]>([]);
  const [ledger, setLedger] = useState<SubscriptionScanResult[] | null>(null);
  const [rows, setRows] = useState<ServiceScanRow[] | null>(null);
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<ScanError | null>(null);

  const runScan = useCallback(
    async (args: AdoptionPlannerArgs, names: Record<string, string>) => {
      if (scope.length === 0) {
        setError({
          title: 'No subscriptions selected',
          message: 'Go back one step and select at least one subscription for Loom to analyse.',
        });
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await clientFetch(
          '/api/setup/estate-scan',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriptions: scope, subscriptionNames: names }),
          },
          CROSS_SUB_FETCH_TIMEOUT_MS,
        );

        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('application/json')) {
          // An HTML error page is a transport/gateway failure. Saying "no
          // services found" here would be a claim the code never established.
          setError({
            title: 'The analysis did not complete',
            message: describeNonJsonResponse(res.status, 'The estate analysis service'),
          });
          return;
        }
        const j: any = await res.json().catch(() => ({}));
        if (!res.ok || !j?.ok) {
          setError({
            title: 'The analysis did not complete',
            message:
              j?.error ??
              `The estate analysis returned HTTP ${res.status}. Loom has NOT concluded that your estate is empty — it could not read it.`,
          });
          return;
        }

        // The tenant id is the SERVER's answer (from the session), never a
        // client-side guess. An absent one is carried through as empty and
        // `plan-store` refuses the plan rather than partitioning it wrongly.
        const tenantId: string = typeof j.tenantId === 'string' ? j.tenantId : '';
        const nextLedger: SubscriptionScanResult[] = j.ledger ?? [];
        const nextRows: ServiceScanRow[] = j.rows ?? [];
        setLedger(nextLedger);
        setRows(nextRows);
        setPlan(
          buildPlanFromDiscovery({
            planId: newPlanId(),
            createdBy: args.createdBy,
            boundary: args.boundary,
            topology: args.topology,
            installSubscriptionId: args.installSubscriptionId,
            tenantId,
            region: args.region,
            scanScope: { subscriptions: scope, managementGroups: [] },
            ledger: nextLedger,
            rows: nextRows,
          }),
        );

        // A partial answer is still an answer: keep the rows AND say what was
        // missed, rather than discarding the scan or implying it was complete.
        if (j.fatal) {
          setError(null);
        }
      } catch (e) {
        setError({
          title: 'The analysis did not complete',
          message: `${e instanceof Error ? e.message : String(e)} — Loom could not read your estate, which is not the same as finding nothing in it. Retry, or continue with everything deployed new.`,
        });
      } finally {
        setLoading(false);
      }
    },
    [scope],
  );

  const decide = useCallback(
    (serviceKey: string, mode: ServiceMode, target?: ServiceTarget) => {
      setPlan((p) => (p ? applyDecision(p, serviceKey, { mode, target }, p.createdBy) : p));
    },
    [],
  );

  /**
   * THE validation step (#3376).
   *
   * `planBlockers()` blocks every `adopt` decision carrying no fitness verdict
   * with the words "run the validation step". Until this existed there WAS no
   * validation step: `evaluateFitness()` had zero production callers, so the
   * blocker could never clear and a brownfield tenant — where `adopt` is the
   * DEFAULT recommendation — could not reach Deploy at all.
   *
   * Posts the whole plan; the route reads each adopted resource with the
   * operator's own ARM token and returns a verdict per service, which is
   * attached via `applyFitness` (which itself refuses to attach to a non-adopt
   * decision). A verdict of `unknown` is attached too — "I could not verify
   * this" is a result, and it must be shown rather than left looking unrun.
   */
  const validateAdoptions = useCallback(async (): Promise<void> => {
    let current: DeploymentPlan | null = null;
    setPlan((p) => {
      current = p;
      return p;
    });
    if (!current) return;
    const target = current as DeploymentPlan;
    const adoptCount = Object.values(target.services).filter((d) => d.mode === 'adopt').length;
    if (adoptCount === 0) return;

    setValidating(true);
    setError(null);
    try {
      const res = await clientFetch(
        '/api/setup/validate-adoption',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            hubRegion: target.region,
            hubTenantId: target.tenantId,
            plan: { services: target.services },
          }),
        },
        CROSS_SUB_FETCH_TIMEOUT_MS,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError({
          title: 'Could not validate the resources you chose to adopt',
          message:
            body?.error ||
            body?.hint ||
            describeNonJsonResponse(res.status, 'The adoption validation service'),
        });
        return;
      }
      setPlan((p) => {
        if (!p) return p;
        let next = p;
        for (const r of body.results ?? []) {
          if (r?.serviceKey && r?.verdict) {
            next = applyFitness(next, r.serviceKey, { verdict: r.verdict, checks: r.checks ?? [] });
          }
        }
        return next;
      });
    } catch (e: any) {
      setError({
        title: 'Could not validate the resources you chose to adopt',
        message: e?.message ?? String(e),
      });
    } finally {
      setValidating(false);
    }
  }, []);

  const reset = useCallback(() => {
    setLedger(null);
    setRows(null);
    setPlan(null);
    setError(null);
  }, []);

  return { scope, ledger, rows, plan, loading, validating, error, setScope, runScan, decide, validateAdoptions, reset };
}

/** Wizard boundary label → the plan's canonical boundary key. */
export const PLAN_BOUNDARY: Record<'Commercial' | 'GCC' | 'GCC-High' | 'IL5', PlanBoundary> = {
  Commercial: 'commercial',
  GCC: 'gcc',
  'GCC-High': 'gcch',
  IL5: 'il5',
};
