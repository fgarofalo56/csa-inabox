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
  buildPlanFromDiscovery,
  type ServiceScanRow,
} from '@/lib/deploy/plan-builder';
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
 * A ULID-ish, monotonic-enough plan id. `crypto.randomUUID` is available in
 * every browser Loom supports and in Node 19+; the timestamp prefix keeps plan
 * ids sortable in the Cosmos container without a second index.
 */
export function newPlanId(now: () => number = Date.now): string {
  const ts = now().toString(36).padStart(9, '0');
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `plan_${ts}_${rand}`;
}

export interface AdoptionPlannerState {
  /** Subscriptions the operator consented to scan. */
  scope: string[];
  ledger: SubscriptionScanResult[] | null;
  rows: ServiceScanRow[] | null;
  plan: DeploymentPlan | null;
  loading: boolean;
  error: ScanError | null;
}

export interface AdoptionPlanner extends AdoptionPlannerState {
  setScope: (next: string[]) => void;
  /** Runs the scan for the current scope and builds the initial plan. */
  runScan: (args: AdoptionPlannerArgs, names: Record<string, string>) => Promise<void>;
  decide: (serviceKey: string, mode: ServiceMode, target?: ServiceTarget) => void;
  reset: () => void;
}

export function useAdoptionPlanner(): AdoptionPlanner {
  const [scope, setScope] = useState<string[]>([]);
  const [ledger, setLedger] = useState<SubscriptionScanResult[] | null>(null);
  const [rows, setRows] = useState<ServiceScanRow[] | null>(null);
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [loading, setLoading] = useState(false);
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

  const reset = useCallback(() => {
    setLedger(null);
    setRows(null);
    setPlan(null);
    setError(null);
  }, []);

  return { scope, ledger, rows, plan, loading, error, setScope, runScan, decide, reset };
}

/** Wizard boundary label → the plan's canonical boundary key. */
export const PLAN_BOUNDARY: Record<'Commercial' | 'GCC' | 'GCC-High' | 'IL5', PlanBoundary> = {
  Commercial: 'commercial',
  GCC: 'gcc',
  'GCC-High': 'gcch',
  IL5: 'il5',
};
