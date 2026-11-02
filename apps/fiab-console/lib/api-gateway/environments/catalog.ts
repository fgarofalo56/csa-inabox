/**
 * Pure catalog edits (ADR-008 decision 1). Each returns the next catalog or a
 * plain-language error; none touches storage. The invariant (decision 4) is
 * checked by the service, which sees the registered resources.
 */
import type { ClassifiableResource, EnvironmentCatalogDoc, EnvironmentDef, FluentBadgeColor } from './types';
import { slugifyEnvironmentKey } from './seed';

export type CatalogEdit = { ok: true; doc: EnvironmentCatalogDoc } | { ok: false; error: string };

const KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Names of sibling routes under /environments; a key equal to one would be unreachable. */
export const RESERVED_KEYS: readonly string[] = ['matrix', 'reclassify', 'suggestions', 'findings'];
const COLORS: readonly FluentBadgeColor[] = ['brand', 'danger', 'important', 'informative', 'severe', 'subtle', 'success', 'warning'];

export interface EnvironmentInput {
  displayName?: string;
  description?: string;
  badgeColor?: FluentBadgeColor;
  isProductionClass?: boolean;
  aliases?: string[];
  exceptions?: string[];
}

/** Cross-field rules that hold for the whole catalog. Returns every violation. */
export function validateEnvironments(envs: readonly EnvironmentDef[]): string[] {
  const errors: string[] = [];
  const byKey = new Map(envs.map((env) => [env.key, env]));
  if (byKey.size !== envs.length) errors.push('Environment keys must be unique.');
  const names = new Set<string>();
  for (const env of envs) {
    if (!KEY_RE.test(env.key)) errors.push(`"${env.key}" is not a valid key (lowercase letters, digits and dashes).`);
    if (!env.displayName.trim()) errors.push(`Environment "${env.key}" needs a display name.`);
    const lower = env.displayName.trim().toLowerCase();
    if (names.has(lower)) errors.push(`Display name "${env.displayName}" is used twice.`);
    names.add(lower);
    if (!COLORS.includes(env.badgeColor)) errors.push(`"${env.badgeColor}" is not a badge color.`);
    for (const x of env.exceptions) {
      const target = byKey.get(x);
      if (!target) errors.push(`${env.displayName}: exception "${x}" is not in the catalog.`);
      else if (x === env.key) errors.push(`${env.displayName} cannot list itself as an exception.`);
      else if (env.isProductionClass && !target.isProductionClass) {
        errors.push(`${env.displayName} is production-class, so it may list only production-class exceptions ("${target.displayName}" is not).`);
      }
    }
  }
  return errors;
}

function finish(doc: EnvironmentCatalogDoc, environments: EnvironmentDef[]): CatalogEdit {
  const errors = validateEnvironments(environments);
  return errors.length ? { ok: false, error: errors.join(' ') } : { ok: true, doc: { ...doc, environments } };
}

export function createEnvironment(doc: EnvironmentCatalogDoc, displayName: string, input: EnvironmentInput = {}): CatalogEdit {
  const key = slugifyEnvironmentKey(displayName);
  if (!key) return { ok: false, error: 'A display name is required.' };
  if (RESERVED_KEYS.includes(key)) return { ok: false, error: `"${key}" is reserved. Pick another name.` };
  if (doc.environments.some((env) => env.key === key)) return { ok: false, error: `An environment with key "${key}" already exists.` };
  const next: EnvironmentDef = {
    key,
    displayName: displayName.trim(),
    description: input.description ?? '',
    badgeColor: input.badgeColor ?? 'informative',
    isProductionClass: input.isProductionClass ?? false,
    aliases: input.aliases ?? [],
    exceptions: input.exceptions ?? [],
    builtIn: false,
  };
  return finish(doc, [...doc.environments, next]);
}

/** The key is immutable; everything else may change. */
export function updateEnvironment(doc: EnvironmentCatalogDoc, key: string, patch: EnvironmentInput): CatalogEdit {
  const cur = doc.environments.find((env) => env.key === key);
  if (!cur) return { ok: false, error: `No environment with key "${key}".` };
  const merged: EnvironmentDef = {
    ...cur,
    displayName: patch.displayName ?? cur.displayName,
    description: patch.description ?? cur.description,
    badgeColor: patch.badgeColor ?? cur.badgeColor,
    isProductionClass: patch.isProductionClass ?? cur.isProductionClass,
    aliases: patch.aliases ?? cur.aliases,
    exceptions: patch.exceptions ?? cur.exceptions,
  };
  return finish(doc, doc.environments.map((env) => (env.key === key ? merged : env)));
}

/** Built-ins are undeletable; an environment in use is refused (the caller passes the users). */
export function deleteEnvironment(doc: EnvironmentCatalogDoc, key: string, usedBy: readonly ClassifiableResource[]): CatalogEdit {
  const cur = doc.environments.find((env) => env.key === key);
  if (!cur) return { ok: false, error: `No environment with key "${key}".` };
  if (cur.builtIn) return { ok: false, error: `${cur.displayName} is built in and cannot be deleted.` };
  if (usedBy.length > 0) {
    return { ok: false, error: `${cur.displayName} is in use by ${usedBy.map((r) => r.displayName).join(', ')}. Re-classify them first.` };
  }
  // Remove dangling exceptions that pointed at it.
  const rest = doc.environments.filter((env) => env.key !== key).map((env) => ({ ...env, exceptions: env.exceptions.filter((x) => x !== key) }));
  return finish(doc, rest);
}
