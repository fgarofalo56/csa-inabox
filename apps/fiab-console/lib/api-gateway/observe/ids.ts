import { createHash } from 'node:crypto';
import type { ObservedType } from './types';

/** Deterministic: the same gateway + type + APIM name always yields the same id (case-insensitive name). */
export function observedId(gatewayId: string, type: ObservedType, key: string): string {
  const h = createHash('sha256').update(`${type}\u0000${key.toLowerCase()}`).digest('hex').slice(0, 20);
  return `obs:${gatewayId}:${type}:${h}`;
}
