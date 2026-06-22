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
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Spinner, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import { getEditor } from '@/lib/editors/registry';
import { ItemEditorChrome } from '@/lib/editors/item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import { getItem, type WorkspaceItem } from '@/lib/api/workspaces';
import type { RibbonTab } from '@/lib/components/ribbon';

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
  const item = findItemType(type);
  if (!item) notFound();

  const isNew = id === 'new';

  // Hydrate the live record into the React Query cache so editors
  // that read ['item', type, id] get the persisted state.
  const q = useQuery<WorkspaceItem>({
    queryKey: ['item', type, id],
    queryFn: () => getItem(type, id),
    enabled: !isNew,
  });

  const Editor = getEditor(type);

  if (!isNew && q.isLoading) {
    return <Spinner label="Loading item…" />;
  }

  // A dedicated editor ALWAYS renders its full ribbon + surface (ui-parity.md):
  // even when the live-backend load errors (e.g. a resource-bound item whose
  // Azure resource isn't provisioned yet — getSparkPool 404, apim 404), the
  // editor must render with its actions present (disabled + an honest inline
  // gate), NOT be replaced by a page-level error that hides the whole ribbon.
  // The editor reads the same ['item', type, id] query and handles the error
  // state itself. Only fall back to a bare error bar when there's no editor.
  if (Editor) {
    return <Editor item={item} id={id} />;
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
