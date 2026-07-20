/**
 * dab-merge — merge multiple per-item DAB configs into ONE runtime config for the
 * shared Data API Builder preview runtime (task #19).
 *
 * The shared runtime (LOOM_DAB_PREVIEW_URL) boots from a single dab-config.json,
 * so to give every DAB item live preview at once we merge all their entity sets
 * into one config and apply it. This module is PURE (no I/O) so the merge +
 * collision rules are unit-testable.
 *
 * COLLISION RULE (deterministic, never a silent drop):
 *   - Items are processed in a STABLE order: ascending by `itemId`.
 *   - Within an item, entity order is preserved.
 *   - The FIRST occurrence of an entity NAME wins and is applied.
 *   - Any later item defining the SAME entity name is SKIPPED and recorded in
 *     `collisions` ({ name, keptFrom, skippedFrom }) — surfaced to the caller so
 *     it is never a silent last-writer-wins.
 *   - The merged config's `sourceRef` + `runtime` come from the first (sorted)
 *     item that carries a `sourceRef`; otherwise a healthy empty default.
 */
import { emptyDabConfig, type DabConfig, type DabEntity } from './dab-config-model';

export interface DabItemConfig {
  itemId: string;
  displayName?: string;
  config: DabConfig | null | undefined;
}

export interface DabMergeCollision {
  /** The exposed entity name that two items both defined. */
  name: string;
  /** itemId whose entity was KEPT (won the name). */
  keptFrom: string;
  /** itemId whose duplicate entity was SKIPPED. */
  skippedFrom: string;
}

export interface DabMergeResult {
  config: DabConfig;
  /** Exposed entity names actually applied to the merged config (in order). */
  entitiesApplied: string[];
  /** Duplicate entity names skipped to avoid a silent overwrite. */
  collisions: DabMergeCollision[];
  /** itemIds that contributed at least one entity, sorted. */
  sourceItemIds: string[];
}

/** Merge per-item DAB configs into one runtime config. Pure + deterministic. */
export function mergeDabConfigs(inputs: DabItemConfig[]): DabMergeResult {
  const sorted = [...(inputs || [])]
    .filter((i) => i && typeof i.itemId === 'string')
    .sort((a, b) => a.itemId.localeCompare(b.itemId));

  // Base sourceRef/runtime: first sorted item that actually carries a sourceRef,
  // else a healthy empty config (empty entities is a valid, servable DAB config).
  const base = sorted.find((i) => i.config && i.config.sourceRef)?.config;
  const merged: DabConfig = base
    ? { sourceRef: base.sourceRef, runtime: base.runtime, entities: [] }
    : emptyDabConfig();
  merged.entities = [];

  const owner = new Map<string, string>();   // entityName -> itemId that won it
  const collisions: DabMergeCollision[] = [];
  const entitiesApplied: string[] = [];
  const contributors = new Set<string>();

  for (const { itemId, config } of sorted) {
    const entities: DabEntity[] = Array.isArray(config?.entities) ? config!.entities : [];
    for (const e of entities) {
      const name = String(e?.name || '').trim();
      if (!name) continue;
      if (owner.has(name)) {
        collisions.push({ name, keptFrom: owner.get(name)!, skippedFrom: itemId });
        continue;
      }
      owner.set(name, itemId);
      merged.entities.push(e);
      entitiesApplied.push(name);
      contributors.add(itemId);
    }
  }

  return { config: merged, entitiesApplied, collisions, sourceItemIds: Array.from(contributors).sort() };
}
