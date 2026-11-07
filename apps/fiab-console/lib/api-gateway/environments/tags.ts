/**
 * Tag suggestions (ADR-008 decision 7): an Azure `environment` / `env` tag on an
 * ARM response becomes a one-click suggestion an administrator confirms. A tag
 * is a hint, never a decision: nothing here writes classification or tags.
 */
import type { ClassifiableResource, EnvironmentDef } from './types';

const TAG_NAMES = new Set(['environment', 'env']);

export interface TagSuggestion {
  resourceKind: ClassifiableResource['kind'];
  resourceId: string;
  displayName: string;
  environmentKey: string;
  tagName: string;
  tagValue: string;
  matchedBy: 'key' | 'displayName' | 'alias';
}

export function matchEnvironmentByTagValue(value: string, envs: readonly EnvironmentDef[]): { env: EnvironmentDef; matchedBy: TagSuggestion['matchedBy'] } | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  for (const env of envs) if (env.key === v) return { env, matchedBy: 'key' };
  for (const env of envs) if (env.displayName.toLowerCase() === v) return { env, matchedBy: 'displayName' };
  for (const env of envs) if (env.aliases.some((a) => a.trim().toLowerCase() === v)) return { env, matchedBy: 'alias' };
  return undefined;
}

/** Suggestions for UNCLASSIFIED resources only; a classified resource is never second-guessed by a tag. */
export function suggestFromTags(resources: readonly ClassifiableResource[], envs: readonly EnvironmentDef[]): TagSuggestion[] {
  const out: TagSuggestion[] = [];
  for (const r of resources) {
    if (r.environmentKey !== null || !r.armTags) continue;
    const tagName = Object.keys(r.armTags).find((k) => TAG_NAMES.has(k.toLowerCase()));
    if (tagName === undefined) continue;
    const tagValue = r.armTags[tagName];
    const hit = matchEnvironmentByTagValue(tagValue, envs);
    if (!hit) continue;
    out.push({ resourceKind: r.kind, resourceId: r.id, displayName: r.displayName, environmentKey: hit.env.key, tagName, tagValue, matchedBy: hit.matchedBy });
  }
  return out;
}
