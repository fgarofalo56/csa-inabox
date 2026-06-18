/**
 * Deploy-plan graph validation — pure logic shared by the canvas (inline
 * warnings) and the server sanitizer (so persisted edges always reference real
 * nodes). No render, so it runs in the default node vitest env.
 */
import { serviceByKey, configStatus } from './service-catalog';
import type { PlanSubscription, PlanEdge } from './types';

export interface PlanIssue {
  level: 'error' | 'warning';
  message: string;
}

/** Build the set of valid service node ids (svc:<si>:<di>:<key>) in the plan. */
export function serviceNodeIds(subs: PlanSubscription[]): Set<string> {
  const ids = new Set<string>();
  subs.forEach((sub, si) =>
    sub.domains.forEach((dom, di) =>
      dom.services.forEach((key) => ids.add(`svc:${si}:${di}:${key}`)),
    ),
  );
  return ids;
}

/** Parse a service node id into its parts, or null if malformed. */
export function parseServiceNodeId(id: string): { si: number; di: number; key: string } | null {
  const [kind, si, di, ...rest] = id.split(':');
  if (kind !== 'svc' || rest.length === 0) return null;
  const sin = Number(si), din = Number(di);
  if (!Number.isInteger(sin) || !Number.isInteger(din)) return null;
  return { si: sin, di: din, key: rest.join(':') };
}

/** Keep only edges whose endpoints both reference live, distinct service nodes. */
export function pruneEdges(subs: PlanSubscription[], edges: PlanEdge[] | undefined): PlanEdge[] {
  if (!Array.isArray(edges)) return [];
  const ids = serviceNodeIds(subs);
  const seen = new Set<string>();
  const out: PlanEdge[] = [];
  for (const e of edges) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') continue;
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
    const sig = `${e.from}->${e.to}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ from: e.from, to: e.to });
  }
  return out;
}

/** Validate the whole plan, returning a flat list of issues for the UI. */
export function validatePlan(subs: PlanSubscription[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const ids = serviceNodeIds(subs);

  if (subs.length === 0) {
    issues.push({ level: 'warning', message: 'Plan is empty — add a subscription and at least one service.' });
    return issues;
  }

  subs.forEach((sub, si) => {
    const totalServices = sub.domains.reduce((n, d) => n + d.services.length, 0);
    if (sub.domains.length === 0) {
      issues.push({ level: 'warning', message: `“${sub.name}” has no domains.` });
    } else if (totalServices === 0) {
      issues.push({ level: 'warning', message: `“${sub.name}” has no services planned yet.` });
    }
    // plan-only services are not auto-provisioned by main.bicep; configurable
    // services with invalid stored values (or never reviewed) are flagged so a
    // complete, intentional deployment is the explicit goal.
    for (const dom of sub.domains) {
      for (const key of dom.services) {
        const def = serviceByKey(key);
        if (def?.planOnly) {
          issues.push({
            level: 'warning',
            message: `“${def.label}” in ${sub.name}/${dom.name} is plan-only — it is not deployed by the exported bicepparam (provision it separately).`,
          });
          continue;
        }
        const status = configStatus(key, sub.serviceConfigs?.[key]);
        if (status === 'invalid') {
          issues.push({
            level: 'error',
            message: `“${def?.label || key}” in ${sub.name}/${dom.name} has an invalid configuration value — open it and fix the flagged field before export.`,
          });
        } else if (status === 'default') {
          issues.push({
            level: 'warning',
            message: `“${def?.label || key}” in ${sub.name}/${dom.name} still uses default SKU/tier — select it to review its configuration.`,
          });
        }
      }
    }

    for (const e of sub.edges || []) {
      if (!ids.has(e.from) || !ids.has(e.to)) {
        issues.push({ level: 'error', message: `A dependency in “${sub.name}” points at a service that is no longer in the plan.` });
        continue;
      }
      const from = parseServiceNodeId(e.from);
      const to = parseServiceNodeId(e.to);
      if (from && to && from.si !== to.si) {
        issues.push({
          level: 'warning',
          message: `Dependency ${serviceByKey(from.key)?.label || from.key} → ${serviceByKey(to.key)?.label || to.key} crosses subscription boundaries — they deploy independently.`,
        });
      }
    }
  });

  return issues;
}
