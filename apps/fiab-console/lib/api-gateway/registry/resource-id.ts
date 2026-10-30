/**
 * Strict parse of an API Management service ARM resource id. Pure.
 * Anything with extra segments (e.g. `/apis/x`) or another provider is rejected:
 * a registered gateway is the service scope, never a child.
 */
import type { ParsedApimResourceId } from './types';

const RE =
  /^\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourceGroups\/([A-Za-z0-9_().-]{1,90})\/providers\/Microsoft\.ApiManagement\/service\/([A-Za-z][A-Za-z0-9-]{0,48})$/i;

export function parseApimResourceId(input: unknown): ParsedApimResourceId | null {
  if (typeof input !== 'string') return null;
  const m = RE.exec(input.trim());
  if (!m) return null;
  const [, subscriptionId, resourceGroup, name] = m;
  return {
    subscriptionId: subscriptionId.toLowerCase(),
    resourceGroup,
    name,
    resourceId: `/subscriptions/${subscriptionId.toLowerCase()}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${name}`,
  };
}
