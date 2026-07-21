/**
 * function-registry — the tenant-scoped registry of versioned functions-on-objects
 * (WS-4.2, Palantir Foundry "functions on objects" parity). Real Cosmos store
 * (per .claude/rules/no-vaporware.md — no mocks): a single doc per tenant
 * (`function-registry` container, id `function-registry:<tenantId>`, partition
 * `/tenantId`) holding the `RegisteredFunction[]`, mirroring the domain-registry
 * doc-per-tenant pattern.
 *
 * A registered function is referenced by a `function`-kind derived property and
 * by an ontology action's `validationFunction`; both resolve a concrete version
 * (pinned or latest) here, then invoke it on the Loom UDF runtime
 * (loom-function-runtime.ts). Azure-native, Gov-safe — no Microsoft Fabric.
 */
import { functionRegistryContainer } from '@/lib/azure/cosmos-client';
import {
  type RegisteredFunction,
  normalizeRegisteredFunction,
  normalizeRegisteredFunctions,
  resolveFunction,
  isFunctionName,
  isFunctionVersion,
} from '@/lib/foundry/function-registry-model';

export interface FunctionRegistryDoc {
  id: string;
  tenantId: string;
  kind: 'function-registry';
  items: RegisteredFunction[];
  updatedAt: string;
}

function docId(tenantId: string): string {
  return `function-registry:${tenantId}`;
}

/** Load the tenant's function-registry doc (empty items on first access — no seed). */
async function loadDoc(tenantId: string): Promise<FunctionRegistryDoc> {
  const c = await functionRegistryContainer();
  try {
    const { resource } = await c.item(docId(tenantId), tenantId).read<FunctionRegistryDoc>();
    if (resource) {
      return { ...resource, items: normalizeRegisteredFunctions(resource.items) };
    }
  } catch (e: unknown) {
    if ((e as { code?: number })?.code !== 404) throw e;
  }
  return { id: docId(tenantId), tenantId, kind: 'function-registry', items: [], updatedAt: new Date().toISOString() };
}

/** Every registered function version in the tenant. */
export async function listRegisteredFunctions(tenantId: string): Promise<RegisteredFunction[]> {
  const doc = await loadDoc(tenantId);
  return doc.items;
}

/**
 * Resolve a concrete registered function version (pinned `version`, else the
 * latest) for `name`, or null when not registered.
 */
export async function getRegisteredFunction(
  tenantId: string,
  name: string,
  version?: string,
): Promise<RegisteredFunction | null> {
  const items = await listRegisteredFunctions(tenantId);
  return resolveFunction(items, name, version);
}

export type RegisterResult =
  | { ok: true; fn: RegisteredFunction }
  | { ok: false; error: string };

/**
 * Register (or replace) a function version. A (name, version) pair is unique —
 * re-registering the same pair REPLACES it (edit); a new version APPENDS
 * (versioning). Validates the shape via the client-safe normalizer so the
 * registry can never hold a malformed entry.
 */
export async function registerFunction(
  tenantId: string,
  who: string,
  input: unknown,
): Promise<RegisterResult> {
  const raw = (input && typeof input === 'object') ? { ...(input as Record<string, unknown>) } : {};
  const name = String(raw.name || '').trim();
  const version = String(raw.version || '').trim();
  if (!isFunctionName(name)) return { ok: false, error: 'name must be a valid identifier (letter/underscore, ≤63 chars).' };
  if (!isFunctionVersion(version)) return { ok: false, error: 'version must be 1–32 chars of letters, digits, dots or dashes.' };

  const now = new Date().toISOString();
  const fn = normalizeRegisteredFunction({ ...raw, name, version, createdAt: raw.createdAt || now, createdBy: raw.createdBy || who });
  if (!fn) return { ok: false, error: 'invalid function definition.' };

  const c = await functionRegistryContainer();
  const doc = await loadDoc(tenantId);
  const idx = doc.items.findIndex((f) => f.name === name && f.version === version);
  if (idx >= 0) {
    // Preserve original createdAt/createdBy on a replace (edit), stamp updater.
    fn.createdAt = doc.items[idx].createdAt || fn.createdAt;
    fn.createdBy = doc.items[idx].createdBy || fn.createdBy;
    doc.items[idx] = fn;
  } else {
    doc.items.push(fn);
  }
  doc.updatedAt = now;
  await c.items.upsert(doc);
  return { ok: true, fn };
}

/** Delete a specific function version. Returns true when a version was removed. */
export async function deleteRegisteredFunction(
  tenantId: string,
  name: string,
  version: string,
): Promise<boolean> {
  const c = await functionRegistryContainer();
  const doc = await loadDoc(tenantId);
  const before = doc.items.length;
  doc.items = doc.items.filter((f) => !(f.name === name && f.version === version));
  if (doc.items.length === before) return false;
  doc.updatedAt = new Date().toISOString();
  await c.items.upsert(doc);
  return true;
}
