'use client';;
import { use, useState } from "react";

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
import { isAppTemplate } from '@/lib/catalog/app-templates';
import { getEditor } from '@/lib/editors/registry';
import { ItemEditorChrome } from '@/lib/editors/item-editor-chrome';
import { getItem, type WorkspaceItem } from '@/lib/api/workspaces';
import { ShareItemDialog } from '@/lib/dialogs/share-item-dialog';
import {
  ArrowSync16Regular, Share16Regular, People16Regular,
  ArrowSync24Regular, Share24Regular, People24Regular, Open24Regular, Cube24Regular,
} from '@fluentui/react-icons';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { GuidedEmptyState, type GuidedPath } from '@/lib/components/shared/guided-empty-state';
import { LOOM_ACCENT } from '@/lib/components/shared/accent-tokens';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import type { RibbonTab, RibbonGroup } from '@/lib/components/ribbon';
import type { PipelineRuntime } from '@/lib/components/pipeline/types';

/** Generic ribbon for item types without a focused editor yet. Only REAL,
 *  wired actions ship here (no-vaporware.md / ui-parity.md — no dead disabled
 *  buttons):
 *    • Refresh    → refetches the persisted item query (['item', type, id]).
 *    • Share      → opens the fully-wired ShareItemDialog (Fabric "Grant people
 *                   access") for this item.
 *    • Permissions→ navigates to the universal item-permissions page
 *                   (/items/[type]/[id]/permissions) — the live Manage-permissions
 *                   list (F6).
 *  These only apply to a persisted item, so on `/new` (nothing saved yet) the
 *  ribbon renders with no action groups rather than dead buttons. Save/Sensitivity/
 *  Endorse/Run/Source-control were dropped from the generic shell: they had no
 *  generic backend and the chrome header already exposes Copilot, Share,
 *  Endorsement, Lineage, and Thread for every item. */
function genericRibbon(
  isNew: boolean,
  handlers: { onRefresh: () => void; onShare: () => void; onManagePermissions: () => void },
): RibbonTab[] {
  const groups: RibbonGroup[] = [];
  if (!isNew) {
    groups.push({ label: 'Item', actions: [
      { label: 'Refresh', icon: <ArrowSync16Regular />, onClick: handlers.onRefresh },
    ] });
    groups.push({ label: 'Share', actions: [
      { label: 'Share', icon: <Share16Regular />, onClick: handlers.onShare },
      { label: 'Permissions', icon: <People16Regular />, onClick: handlers.onManagePermissions },
    ] });
  }
  return [{ id: 'home', label: 'Home', groups }];
}

interface Props {
  params: Promise<{ type: string; id: string }>;
}

export default function ItemEditorPage(props: Props) {
  const params = use(props.params);
  const { type, id } = params;
  const router = useRouter();
  // Generic-fallback Share dialog (rel-T104) — the generic ribbon's Share action
  // opens this fully-wired ShareItemDialog for the persisted item.
  const [shareOpen, setShareOpen] = useState(false);
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
  // [DEMOTE-TO-TEMPLATE carve-out] App templates (slate-workshop-app /
  // rayfin-azure-stack) carry a `templateId` that is NOT a pipeline-style head
  // seed — they are materialized SERVER-SIDE by the instantiation route, which
  // creates SEVERAL real Azure-native backing items and wires them together,
  // then routes the user to the scaffolded primary item's real id. They are
  // therefore never seeded by a head editor on `/new`. Excluding app-templates
  // here means a DIRECT navigation to /items/slate-app/new (or /rayfin-app/new)
  // still resolves to that slug's OWN create editor (SlateAppEditor /
  // RayfinAppEditor) — preserving exact pre-demote behavior — while the
  // pipeline-family template path (geo-pipeline → data-pipeline seed) is
  // untouched (its templateId is not an app-template id, so isAppTemplate=false).
  const applyTemplate = !!item.templateOf && isNew && !isAppTemplate(item.templateId);
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

  // Real, wired launcher paths — mirror the generic ribbon so the fallback shell
  // is a guided surface, not a dead pane (UX-1004, SC-4). On `/new` nothing is
  // persisted yet, so only navigation paths are offered.
  const heroIcon = itemVisual(type).icon ?? Cube24Regular;
  const genericPaths: GuidedPath[] = isNew
    ? [
        {
          key: 'browse', title: 'Browse existing items',
          body: 'See what already exists across your workspaces.',
          icon: Open24Regular, accent: LOOM_ACCENT.blue,
          href: '/browse', onClick: () => router.push('/browse'),
        },
      ]
    : [
        {
          key: 'refresh', title: 'Refresh',
          body: 'Reload the latest saved state for this item.',
          icon: ArrowSync24Regular, accent: LOOM_ACCENT.blue,
          onClick: () => { void q.refetch(); },
        },
        {
          key: 'share', title: 'Share',
          body: 'Grant a person or group access to this item.',
          icon: Share24Regular, accent: LOOM_ACCENT.teal,
          onClick: () => setShareOpen(true),
        },
        {
          key: 'permissions', title: 'Manage permissions',
          body: 'View and revoke who has access.',
          icon: People24Regular, accent: LOOM_ACCENT.amber,
          href: `/items/${type}/${id}/permissions`,
          onClick: () => router.push(`/items/${type}/${id}/permissions`),
        },
      ];

  return (
    <>
      <ItemEditorChrome
        item={item}
        id={id}
        displayName={persisted?.displayName}
        ribbon={genericRibbon(isNew, {
          onRefresh: () => { void q.refetch(); },
          onShare: () => setShareOpen(true),
          onManagePermissions: () => router.push(`/items/${type}/${id}/permissions`),
        })}
        main={
          <>
            <TeachingBanner
              surfaceKey="generic-item-shell"
              title={headline}
              message={`${item.displayName} (REST type: ${item.restType}) uses the generic editor shell until its focused editor ships. The Refresh, Share and Permissions actions below — and in the ribbon — are fully wired and behave identically across every item type.`}
              icon={heroIcon}
              accent={LOOM_ACCENT.violet}
            />
            <GuidedEmptyState
              title={`${item.displayName} shell`}
              intro="This item type doesn't have a focused editor yet, but every governance action still works. Pick one below."
              heroIcon={heroIcon}
              paths={genericPaths}
              ariaLabel={`${item.displayName} actions`}
            />
          </>
        }
      />
      {!isNew && (
        <ShareItemDialog
          open={shareOpen}
          itemId={id}
          itemType={type}
          onClose={() => setShareOpen(false)}
          onGranted={() => setShareOpen(false)}
        />
      )}
    </>
  );
}
