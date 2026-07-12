/**
 * lib/items/manifest/registry.ts — EH-P1-MANIFEST (issue #1801).
 *
 * The item-type manifest REGISTRY: one `ItemManifest` per Loom item type,
 * DERIVED from the authoritative catalog (`FABRIC_ITEM_TYPES`) plus the
 * capability source lists in ./item-manifest — never a second hand-maintained
 * copy of the catalog. Duplicate slugs across category slices resolve
 * first-occurrence-wins, exactly matching `findItemType()`'s `.find()`
 * semantics, so `getItemManifest(slug)` always describes the same item
 * `findItemType(slug)` returns.
 *
 * ADDITIVE layer (operator steer on #1801): existing catalog/provisioner
 * wiring is untouched; consumers OPT IN by reading the manifest. First wired
 * consumer: lib/thread/thread-actions.ts derives `PBI_SOURCEABLE` from
 * `pbiSourceableTypes()` (test-asserted set-equal to the prior hard-coded
 * list, so the swap is provably behavior-preserving).
 *
 * Client-safe: imports only catalog data + the pairing rules (both already in
 * client bundles). NEVER import the provisioning engine here.
 */
import { FABRIC_ITEM_TYPES, findItemType } from '@/lib/catalog/fabric-item-types';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { ITEM_PAIRING_RULES } from '@/lib/items/registry';
import {
  AZURE_BACKENDS,
  DATA_AGENT_SOURCEABLE_ITEM_TYPES,
  FAMILY_KIND,
  NOTEBOOK_ATTACHABLE_ITEM_TYPES,
  PBI_SOURCEABLE_ITEM_TYPES,
  POWERBI_MODELABLE_ITEM_TYPES,
  PROVISIONABLE_ITEM_TYPES,
  WEAVE_SOURCEABLE_ITEM_TYPES,
} from './item-manifest';
import type { ItemManifest } from './item-manifest';

function toManifest(t: FabricItemType): ItemManifest {
  const provisionable = PROVISIONABLE_ITEM_TYPES.includes(t.slug);
  const familyKind = FAMILY_KIND[t.category];
  return {
    type: t.slug,
    displayName: t.displayName,
    family: t.category,
    familyKind,
    restType: t.restType,
    fabricEquivalent:
      familyKind === 'fabric-parity' && !t.noRestApi ? t.restType : undefined,
    azureBackend: provisionable ? AZURE_BACKENDS[t.slug] : undefined,
    defaultBackend: provisionable ? 'azure-native' : 'cosmos-only',
    editorSlug: t.aliasOf ?? t.slug,
    pairsWith: (ITEM_PAIRING_RULES[t.slug] ?? []).map((r) => r.pairedType),
    capabilities: {
      provisionable,
      // Exactly the New-item dialog's offer filter (new-item-dialog.tsx):
      // deprecated / coreSurface / hiddenFromGallery are never offered; labs +
      // searchOnly types remain creatable via the Labs toggle / search branch.
      creatable: !t.deprecated && !t.coreSurface && !t.hiddenFromGallery,
      searchOnly: !!t.searchOnly,
      labs: !!t.labs,
      preview: !!t.preview,
      deprecated: !!t.deprecated,
      coreSurface: !!t.coreSurface,
      // Every cataloged slug renders an editor at /items/[slug]/[id] today
      // (aliases resolve via editorSlug; deprecated types render a migration
      // surface). Kept as a flag so a future headless type can declare false.
      hasEditor: true,
      hasRestApi: !t.noRestApi,
      weaveSourceable: WEAVE_SOURCEABLE_ITEM_TYPES.includes(t.slug),
      pbiSourceable: PBI_SOURCEABLE_ITEM_TYPES.includes(t.slug),
      powerBiModelable: POWERBI_MODELABLE_ITEM_TYPES.includes(t.slug),
      notebookAttachable: NOTEBOOK_ATTACHABLE_ITEM_TYPES.includes(t.slug),
      dataAgentSourceable: DATA_AGENT_SOURCEABLE_ITEM_TYPES.includes(t.slug),
    },
  };
}

let cache: Map<string, ItemManifest> | null = null;

/** Slug → manifest, first-occurrence-wins (mirrors findItemType). Lazy-built once. */
function manifestMap(): Map<string, ItemManifest> {
  if (!cache) {
    const m = new Map<string, ItemManifest>();
    for (const t of FABRIC_ITEM_TYPES) {
      if (!m.has(t.slug)) m.set(t.slug, toManifest(t));
    }
    cache = m;
  }
  return cache;
}

/** The manifest for an item-type slug, or undefined for unknown slugs. */
export function getItemManifest(type: string): ItemManifest | undefined {
  return manifestMap().get(type);
}

/** Every item-type manifest, in catalog (first-occurrence) order. */
export function listItemManifests(): ItemManifest[] {
  return Array.from(manifestMap().values());
}

/**
 * Item-type slugs whose manifest declares `capabilities.pbiSourceable` — the
 * canonical source for the Weave → Power BI `fromTypes` gate. Returned in the
 * canonical declaration order so the consumer array is identical to the prior
 * hard-coded list.
 */
export function pbiSourceableTypes(): string[] {
  return PBI_SOURCEABLE_ITEM_TYPES.filter((s) => {
    const m = getItemManifest(s);
    return !!m && m.capabilities.pbiSourceable;
  });
}

export interface ManifestConsistencyReport {
  ok: boolean;
  problems: string[];
}

/**
 * Dev-time consistency check — callable from tests (and safe to call anywhere;
 * touches no network, no Azure SDK). Verifies:
 *   1. every catalog item type has a manifest and vice-versa (no orphans),
 *   2. first-wins parity with findItemType (manifest describes the same entry),
 *   3. every slug in every capability source list exists in the catalog,
 *   4. AZURE_BACKENDS keys are exactly PROVISIONABLE_ITEM_TYPES,
 *   5. pairsWith / editorSlug targets resolve in the catalog,
 *   6. flag coherence (deprecated/coreSurface/hiddenFromGallery ⇒ not creatable;
 *      provisionable ⇔ azureBackend + defaultBackend 'azure-native').
 *
 * Cross-registry drift (PROVISIONERS keys, PBI_RESOLVABLE_TYPES, THREAD_ACTIONS
 * fromTypes) is asserted in the manifest test suite, which may import the
 * heavier server-side modules this client-safe module must not.
 */
export function checkManifestConsistency(): ManifestConsistencyReport {
  const problems: string[] = [];
  const map = manifestMap();
  const catalogSlugs = new Set(FABRIC_ITEM_TYPES.map((t) => t.slug));

  // 1+2 — bijection with the deduped catalog + first-wins parity.
  for (const slug of catalogSlugs) {
    const m = map.get(slug);
    const c = findItemType(slug);
    if (!m) {
      problems.push(`catalog type '${slug}' has no manifest`);
      continue;
    }
    if (!c) continue; // unreachable: slug came from the catalog
    if (m.displayName !== c.displayName || m.family !== c.category || m.restType !== c.restType) {
      problems.push(`manifest '${slug}' does not match findItemType('${slug}') (first-wins violation)`);
    }
  }
  for (const slug of map.keys()) {
    if (!catalogSlugs.has(slug)) problems.push(`manifest '${slug}' has no catalog entry (orphan)`);
  }

  // 3 — capability source lists only reference real catalog slugs.
  const lists: Array<[string, readonly string[]]> = [
    ['PROVISIONABLE_ITEM_TYPES', PROVISIONABLE_ITEM_TYPES],
    ['PBI_SOURCEABLE_ITEM_TYPES', PBI_SOURCEABLE_ITEM_TYPES],
    ['NOTEBOOK_ATTACHABLE_ITEM_TYPES', NOTEBOOK_ATTACHABLE_ITEM_TYPES],
    ['DATA_AGENT_SOURCEABLE_ITEM_TYPES', DATA_AGENT_SOURCEABLE_ITEM_TYPES],
    ['POWERBI_MODELABLE_ITEM_TYPES', POWERBI_MODELABLE_ITEM_TYPES],
    ['WEAVE_SOURCEABLE_ITEM_TYPES', WEAVE_SOURCEABLE_ITEM_TYPES],
  ];
  for (const [name, list] of lists) {
    for (const slug of list) {
      if (!catalogSlugs.has(slug)) problems.push(`${name} references unknown item type '${slug}'`);
    }
    if (new Set(list).size !== list.length) problems.push(`${name} contains duplicate slugs`);
  }

  // 4 — backend overlay covers exactly the provisionable set.
  for (const slug of PROVISIONABLE_ITEM_TYPES) {
    if (!AZURE_BACKENDS[slug]) problems.push(`AZURE_BACKENDS is missing provisionable type '${slug}'`);
  }
  for (const slug of Object.keys(AZURE_BACKENDS)) {
    if (!PROVISIONABLE_ITEM_TYPES.includes(slug)) {
      problems.push(`AZURE_BACKENDS declares non-provisionable type '${slug}'`);
    }
  }

  // 5+6 — per-manifest referential integrity + flag coherence.
  for (const m of map.values()) {
    if (!catalogSlugs.has(m.editorSlug)) {
      problems.push(`manifest '${m.type}' editorSlug '${m.editorSlug}' is not a catalog type`);
    }
    for (const p of m.pairsWith) {
      if (!catalogSlugs.has(p)) problems.push(`manifest '${m.type}' pairsWith unknown type '${p}'`);
    }
    const cap = m.capabilities;
    if ((cap.deprecated || cap.coreSurface) && cap.creatable) {
      problems.push(`manifest '${m.type}' is deprecated/coreSurface but flagged creatable`);
    }
    if (cap.provisionable !== (m.defaultBackend === 'azure-native')) {
      problems.push(`manifest '${m.type}' provisionable/defaultBackend mismatch`);
    }
    if (cap.provisionable !== !!m.azureBackend) {
      problems.push(`manifest '${m.type}' provisionable/azureBackend mismatch`);
    }
    if (cap.powerBiModelable && !cap.weaveSourceable) {
      problems.push(`manifest '${m.type}' powerBiModelable but not weaveSourceable`);
    }
    if (cap.pbiSourceable && !cap.weaveSourceable) {
      problems.push(`manifest '${m.type}' pbiSourceable but not weaveSourceable`);
    }
  }

  return { ok: problems.length === 0, problems };
}
