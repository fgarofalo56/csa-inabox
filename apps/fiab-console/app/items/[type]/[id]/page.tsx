'use client';

/**
 * Generic per-item-type editor shell. Concrete editors (Lakehouse,
 * Notebook, Pipeline, Eventstream, etc.) will replace this with their
 * own routes in Phases 2-4. Until then, every item type resolves to
 * this page so the + New item dialog lands somewhere meaningful and
 * the e2e h1 check passes.
 */

import { notFound } from 'next/navigation';
import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { Ribbon, type RibbonTab } from '@/lib/components/ribbon';
import { Badge, Body1, makeStyles, tokens } from '@fluentui/react-components';
import { findItemType } from '@/lib/catalog/fabric-item-types';

const HOME_TAB: RibbonTab = {
  id: 'home',
  label: 'Home',
  groups: [
    { label: 'Item', actions: [
      { label: 'Save' }, { label: 'Save as' }, { label: 'Refresh' },
    ]},
    { label: 'Share', actions: [
      { label: 'Share' }, { label: 'Permissions' }, { label: 'Sensitivity' }, { label: 'Endorse' },
    ]},
    { label: 'Run', actions: [
      { label: 'Recent runs' }, { label: 'Schedule' },
    ]},
    { label: 'Source control', actions: [
      { label: 'Commit' }, { label: 'Update' },
    ]},
  ],
};

const useStyles = makeStyles({
  meta: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' },
  body: { display: 'flex', flexDirection: 'column', gap: '16px' },
});

interface Props {
  params: { type: string; id: string };
}

export default function ItemEditorPage({ params }: Props) {
  const { type, id } = params;
  const item = findItemType(type);
  const styles = useStyles();

  if (!item) {
    notFound();
  }

  const isNew = id === 'new';
  const title = isNew ? `New ${item.displayName.toLowerCase()}` : item.displayName;

  return (
    <PageShell
      title={title}
      subtitle={item.description}
      actions={
        <div className={styles.meta}>
          <Badge appearance="outline">{item.category}</Badge>
          {item.preview && <Badge appearance="outline" color="warning">Preview</Badge>}
          {item.noRestApi && <Badge appearance="outline" color="informative">UI only</Badge>}
        </div>
      }
    >
      <div className={styles.body}>
        <Ribbon tabs={[HOME_TAB]} />
        {isNew ? (
          <EmptyState
            icon="✦"
            title={`Create your ${item.displayName.toLowerCase()}`}
            body={`The full create flow (workspace picker, sensitivity label, item-specific options) lands here. Until then, give it a name and a home workspace, and you're off.`}
            primaryAction={{ label: 'Create' }}
            secondaryAction={{ label: 'Cancel', href: '/workspaces' }}
          />
        ) : (
          <EmptyState
            icon="◰"
            title={`${item.displayName} editor (id: ${id})`}
            body={`The item-specific editor for ${item.displayName} (REST type: ${item.restType}) ships in the phase that owns this workload. Routes, BFF stubs, and ribbon actions are wired; the canvas / cells / query pane / etc. is the next layer.`}
          />
        )}
      </div>
    </PageShell>
  );
}
