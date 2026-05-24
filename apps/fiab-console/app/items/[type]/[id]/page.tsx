'use client';

/**
 * Per-item-type editor route. Dispatches to a rich editor from the
 * registry when one exists; falls back to the generic shell (ribbon +
 * EmptyState) for item types that haven't been wired with a focused
 * editor yet.
 */

import { notFound } from 'next/navigation';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import { getEditor } from '@/lib/editors/registry';
import { ItemEditorChrome } from '@/lib/editors/item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import type { RibbonTab } from '@/lib/components/ribbon';

const GENERIC_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Item', actions: [{ label: 'Save' }, { label: 'Save as' }, { label: 'Refresh' }] },
    { label: 'Share', actions: [{ label: 'Share' }, { label: 'Permissions' }, { label: 'Sensitivity' }, { label: 'Endorse' }] },
    { label: 'Run', actions: [{ label: 'Recent runs' }, { label: 'Schedule' }] },
    { label: 'Source control', actions: [{ label: 'Commit' }, { label: 'Update' }] },
  ]},
];

interface Props {
  params: { type: string; id: string };
}

export default function ItemEditorPage({ params }: Props) {
  const { type, id } = params;
  const item = findItemType(type);
  if (!item) notFound();

  const Editor = getEditor(type);
  if (Editor) {
    return <Editor item={item} id={id} />;
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={GENERIC_RIBBON} main={
      <EmptyState
        icon="◰"
        title={`${item.displayName} editor (${id === 'new' ? 'new' : `id ${id.substring(0, 8)}`})`}
        body={`${item.displayName} (REST type: ${item.restType}) uses the generic editor shell until its focused editor ships in a follow-on phase. The ribbon, sharing, sensitivity, and source-control affordances are wired and behave identically across every item type.`}
      />
    } />
  );
}
