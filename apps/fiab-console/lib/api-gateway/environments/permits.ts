/**
 * permits() — the ONE function that decides whether a gateway in environment A
 * may front a resource in environment B (ADR-008 decision 3). The console and
 * W2 plan enforcement read its output; nobody reimplements the rules.
 */
import type { EnvironmentDef, Verdict } from './types';

export interface PermitsSettings {
  requireClassification: boolean;
  environments: readonly EnvironmentDef[];
}

const allowed = (message: string): Verdict => ({ level: 'allowed', message });
const warning = (message: string): Verdict => ({ level: 'warning', message });
const blocked = (message: string): Verdict => ({ level: 'blocked', message });

/** `null` / `undefined` = Unclassified. */
export function permits(
  gatewayEnv: string | null | undefined,
  resourceEnv: string | null | undefined,
  settings: PermitsSettings,
): Verdict {
  const byKey = new Map(settings.environments.map((env) => [env.key, env]));
  const gKey = gatewayEnv ?? null;
  const rKey = resourceEnv ?? null;
  const g = gKey === null ? undefined : byKey.get(gKey);
  const r = rKey === null ? undefined : byKey.get(rKey);

  if (gKey !== null && !g) return blocked(`The gateway is classified as "${gKey}", which is not in the environment catalog.`);
  if (rKey !== null && !r) return blocked(`The resource is classified as "${rKey}", which is not in the environment catalog.`);

  const gName = g ? g.displayName : 'Unclassified';
  const rName = r ? r.displayName : 'Unclassified';

  if (g?.isProductionClass && !r?.isProductionClass) {
    return blocked(`A ${gName} gateway cannot front ${r ? `a ${rName}` : 'an unclassified'} resource. Production-class gateways only front production-class resources.`);
  }
  if (!g && r?.isProductionClass) {
    return blocked(`An unclassified gateway cannot front a ${rName} resource. Classify the gateway first.`);
  }
  if (gKey !== null && gKey === rKey) return allowed(`Both are ${gName}.`);
  if (g && r && g.exceptions.includes(r.key)) {
    return allowed(`${gName} gateways are allowed to front ${rName} resources by an exception.`);
  }
  if (!g || !r) {
    const who = !g && !r ? 'The gateway and the resource are' : !g ? 'The gateway is' : 'The resource is';
    return settings.requireClassification
      ? blocked(`${who} unclassified and Require classification is on. Classify it to continue.`)
      : warning(`${who} unclassified, so the pairing cannot be checked. Classify it to get a firm answer.`);
  }
  return warning(`A ${gName} gateway is fronting a ${rName} resource. Add an exception to ${gName} if this is intended.`);
}

export interface MatrixCell { gatewayEnv: string | null; resourceEnv: string | null; verdict: Verdict }

/** Derived compatibility matrix: rows = gateway environment, columns = resource environment; Unclassified (null) included. */
export function compatibilityMatrix(settings: PermitsSettings): { keys: Array<string | null>; cells: MatrixCell[] } {
  const keys: Array<string | null> = [null, ...settings.environments.map((env) => env.key)];
  const cells: MatrixCell[] = [];
  for (const gatewayEnv of keys) for (const resourceEnv of keys) {
    cells.push({ gatewayEnv, resourceEnv, verdict: permits(gatewayEnv, resourceEnv, settings) });
  }
  return { keys, cells };
}
