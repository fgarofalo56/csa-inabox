'use client';;
import { use } from "react";

/**
 * Per-item-type editor route. Dispatches to a rich editor from the
 * registry when one exists; falls back to the generic shell (ribbon +
 * EmptyState) for item types that haven't been wired with a focused
 * editor yet.
 *
 * Loads the persisted item from /api/items/[type]/[id] (Cosmos-backed)
 * and primes the React Query cache at key ['item', type, id] so any
 * editor in the registry can pull the live record + state.
 */

import { notFound } from 'next/navigation';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Spinner, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import { getEditor } from '@/lib/editors/registry';
import { ItemEditorChrome } from '@/lib/editors/item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import { getItem, type WorkspaceItem } from '@/lib/api/workspaces';
import type { RibbonTab } from '@/lib/components/ribbon';
import type { PipelineRuntime } from '@/lib/components/pipeline/types';

/** Generic ribbon. The Share group's Share + Permissions actions navigate to
 *  the universal item-permissions page (/items/[type]/[id]/permissions) which
 *  hosts the Share dialog + live Manage-permissions list (F6). */
function genericRibbon(onManagePermissions: () => void): RibbonTab[] {
  return [
    { id: 'home', label: 'Home', groups: [
      { label: 'Item', actions: [{ label: 'Save' }, { label: 'Save as' }, { label: 'Refresh' }] },
      { label: 'Share', actions: [
        { label: 'Share', onClick: onManagePermissions },
        { label: 'Permissions', onClick: onManagePermissions },
        { label: 'Sensitivity' },
        { label: 'Endorse' },
      ] },
      { label: 'Run', actions: [{ label: 'Recent runs' }, { label: 'Schedule' }] },
      { label: 'Source control', actions: [{ label: 'Commit' }, { label: 'Update' }] },
    ]},
  ];
}

interface Props {
  params: Promise<{ type: string; id: string }>;
}

export default function ItemEditorPage(props: Props) {
  const params = use(props.params);
  const { type, id } = params;
  const router = useRouter();
  // [WAVE-C] The unified create-step (new-item-dialog configure step) creates a
  // HEAD instance (e.g. `data-pipeline`) and carries the user's chosen runtime /
  // template forward via the query string — `?runtime=adf&templateId=geo-enrich`.
  // The head catalog entry has no runtimePreset/templateId of its own, so these
  // params are the ONLY carrier of the configure-step choice into the editor.
  // When present they OVERRIDE the catalog-derived values; when absent every
  // existing route (alias/template instances, direct navigations) behaves
  // identically to today (no regression). Azure-native default (adf) per
  // no-fabric-dependency.md; Fabric stays opt-in only.
  const sp = useSearchParams();
  const runtimeOverride = sp.get('runtime') as PipelineRuntime | null;
  const templateOverride = sp.get('templateId');
  const item = findItemType(type);
  if (!item) notFound();

  const isNew = id === 'new';

  // [catalog-merge] Resolve aliases + templates (no-fabric-dependency.md catalog
  // merge): some slugs are presets/aliases of a UNIFIED authoring item. e.g.
  //   adf-pipeline / synapse-pipeline  → aliasOf 'data-pipeline' (runtime locked)
  //   geo-pipeline                     → templateOf 'data-pipeline' (geo-enrich)
  // The `effective` entry selects which EDITOR opens (the unified one), while we
  // keep passing the ORIGINAL `item` for display name + Learn content. Already-
  // created adf-pipeline/synapse-pipeline/geo-pipeline instances still load via
  // their OWN per-item BFF routes (/api/items/<slug>/[id]/*) — the unified editor
  // parameterizes its apiBase by the resolved runtime, so back-compat holds.
  // Resolve BOTH aliasOf (adf-/synapse-pipeline → data-pipeline, runtime-locked)
  // AND templateOf (geo-pipeline → data-pipeline, pre-wired with templateId
  // 'geo-enrich'). Without resolving templateOf, slug 'geo-pipeline' fell through
  // to its own legacy GeoPipelineEditor in the registry, so the unified
  // DataPipelineEditor (and its Contract-F templateId seeding) never opened —
  // the comment above claimed geo-pipeline→data-pipeline(geo-enrich) but routing
  // never did it. `?? item` keeps a self-load fallback if the target is missing.
  // aliasOf (adf-/synapse-pipeline → data-pipeline) resolves UNCONDITIONALLY:
  // the unified editor keys its BFF apiBase by the locked runtime, so existing
  // instances still hit /api/items/<original-slug>/[id]/*. templateOf
  // (geo-pipeline → data-pipeline + 'geo-enrich' seed) resolves ONLY for NEW
  // creation — an ALREADY-CREATED geo-pipeline instance keeps its own native
  // GeoPipelineEditor + load path (back-compat); seeding a template over a saved
  // instance would clobber it.
  const applyTemplate = !!item.templateOf && isNew;
  const effective = item.aliasOf
    ? (findItemType(item.aliasOf) ?? item)
    : applyTemplate
      ? (findItemType(item.templateOf!) ?? item)
      : item;

  // Hydrate the live record into the React Query cache so editors
  // that read ['item', type, id] get the persisted state.
  const q = useQuery<WorkspaceItem>({
    queryKey: ['item', type, id],
    queryFn: () => getItem(type, id),
    enabled: !isNew,
  });

  const Editor = getEditor(effective.slug);

  // A dedicated editor ALWAYS renders its full ribbon + surface IMMEDIATELY
  // (ui-parity.md) — it must NOT be gated behind the page-level getItem query.
  // Many resource-bound editors' getItem does a LIVE Azure probe (getSparkPool,
  // apim, etc.) that is slow or 404s when the backing resource isn't
  // provisioned; gating the page on q.isLoading/q.error meant the editor (and
  // its whole ribbon) didn't mount until that settled — a "Loading item…" /
  // "Failed to load" page that hid every action. The editor reads the SAME
  // ['item', type, id] query and renders its own inline loading/error/gate
  // state with the ribbon present (disabled), exactly as it does for `/new`.
  // The page-level Spinner/error below is only for the generic (no-editor)
  // fallback view.
  if (Editor) {
    // Pass the ORIGINAL `item` (display name / Learn) plus the resolved
    // runtime preset + template id. With all undefined the editor behaves
    // identically to today (no regression). `runtimePreset` locks the unified
    // pipeline editor's runtime selector (adf default per no-fabric-dependency.md);
    // `templateId` pre-wires its spec (e.g. geo-enrich).
    // [WAVE-C] The configure-step query params WIN over the catalog-derived
    // values when present: a head-item create (data-pipeline) has no catalog
    // runtimePreset/templateId, so the URL is the carrier of the chosen
    // preset/template. Absent params fall back to the catalog values, so
    // alias/template instances and direct navigations are unchanged.
    const runtimePreset = runtimeOverride ?? item.runtimePreset;
    const templateId = templateOverride ?? (applyTemplate ? item.templateId : undefined);
    return <Editor item={item} id={id} runtimePreset={runtimePreset} templateId={templateId} />;
  }

  if (!isNew && q.isLoading) {
    return <Spinner label="Loading item…" />;
  }

  if (!isNew && q.error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>Failed to load item: {(q.error as Error).message}</MessageBarBody>
      </MessageBar>
    );
  }

  const persisted = q.data;
  const headline = isNew
    ? `${item.displayName} editor (new)`
    : `${persisted?.displayName ?? item.displayName} (${id.substring(0, 8)})`;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={genericRibbon(() => router.push(`/items/${type}/${id}/permissions`))} main={
      <EmptyState
        icon="◰"
        title={headline}
        body={`${item.displayName} (REST type: ${item.restType}) uses the generic editor shell until its focused editor ships in a follow-on phase. The ribbon, sharing, sensitivity, and source-control affordances are wired and behave identically across every item type.`}
      />
    } />
  );
}
