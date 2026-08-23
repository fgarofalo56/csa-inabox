'use client';
/**
 * RefTreeChildren — the reference-lakehouse explorer subtree (F8).
 *
 * Extracted verbatim from lakehouse-editor-shell.tsx to keep that file under
 * the 1,200-LOC monolith-creep ceiling with room to spare, so the next comment
 * anyone adds there does not break the gate. Behaviour is unchanged: same keys,
 * same handlers, same states.
 *
 * These are READ-ONLY sibling lakehouses browsed side-by-side, so they have no
 * #3904 binding of their own — `loadRefPaths` already resolves each reference's
 * root server-side via `/api/lakehouse/references/paths`.
 */
import { Fragment } from 'react';
import { Caption1, Spinner, Tree, TreeItem, TreeItemLayout } from '@fluentui/react-components';
import { FileGlyph, leafName } from './shared';
import type { ListingError, PathEntry, ReferenceLakehouse } from './shared';

export interface RefTreeRef {
  id: string;
  displayName: string;
  containers: string[];
  account?: string;
  reachable?: boolean;
}

interface Props {
  ref_: RefTreeRef;
  container: string;
  prefix: string;
  openPrefixes: Record<string, PathEntry[] | 'loading' | ListingError>;
  loadRefPaths: (refId: string, container: string, prefix: string) => Promise<void>;
  selectRefFile: (ref: ReferenceLakehouse, container: string, entry: PathEntry) => Promise<void>;
}

export function RefTreeChildren({
  ref_, container, prefix, openPrefixes, loadRefPaths, selectRefFile,
}: Props) {
  const state = openPrefixes[`ref::${ref_.id}::${container}::${prefix}`];
  const base = `ref-${ref_.id}-${container}-${prefix}`;
  const child = (p: string) => (
    <RefTreeChildren
      ref_={ref_} container={container} prefix={p}
      openPrefixes={openPrefixes} loadRefPaths={loadRefPaths} selectRefFile={selectRefFile}
    />
  );

  if (state === undefined) return (
    <TreeItem itemType="leaf" value={`${base}-unloaded`} onClick={() => loadRefPaths(ref_.id, container, prefix)}>
      <TreeItemLayout>Click to load…</TreeItemLayout>
    </TreeItem>
  );
  if (state === 'loading') return (
    <TreeItem itemType="leaf" value={`${base}-loading`}><TreeItemLayout><Spinner size="tiny" /> Loading…</TreeItemLayout></TreeItem>
  );
  if (!Array.isArray(state)) return (
    <TreeItem itemType="leaf" value={`${base}-err`}>
      <TreeItemLayout title={state.remediation || state.error}>
        <Caption1>{state.kind === 'not-found' ? 'Nothing here yet' : 'Error'}: {state.error}</Caption1>
      </TreeItemLayout>
    </TreeItem>
  );
  if (state.length === 0) return (
    <TreeItem itemType="leaf" value={`${base}-empty`}><TreeItemLayout><Caption1>(empty)</Caption1></TreeItemLayout></TreeItem>
  );

  return (
    <>
      {state.map((entry) => (
        <Fragment key={`ref-${ref_.id}-${entry.name}`}>
          {entry.isDirectory ? (
            <TreeItem itemType="branch" value={`ref-${ref_.id}-${entry.name}`}
              onClick={() => selectRefFile(ref_ as unknown as ReferenceLakehouse, container, entry)}>
              <TreeItemLayout iconBefore={<FileGlyph name={entry.name} isDirectory />}>{leafName(entry.name)}</TreeItemLayout>
              <Tree>{child(entry.name)}</Tree>
            </TreeItem>
          ) : (
            <TreeItem itemType="leaf" value={`ref-${ref_.id}-${entry.name}`}
              onClick={() => selectRefFile(ref_ as unknown as ReferenceLakehouse, container, entry)}>
              <TreeItemLayout iconBefore={<FileGlyph name={entry.name} isDirectory={false} />}>{leafName(entry.name)}</TreeItemLayout>
            </TreeItem>
          )}
        </Fragment>
      ))}
    </>
  );
}
