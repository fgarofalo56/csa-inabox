'use client';
import {
  Caption1, Spinner, Badge, Button, Subtitle2, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Eye20Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { DeltaPreviewGrid } from '../components/delta-preview-grid';
import { useStyles, leafName, formatBytes } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';

export function PreviewPane() {
  const s = useStyles();
  const ctx = useLakehouseCtx();
  const {
    activePath, preview, previewLoading, previewMode, setPreviewMode, setTab,
    columnStats, statsLoading, statsError, activeContainer, settings,
  } = ctx;

  return (
    <>
      {!activePath && (
        <EmptyState
          icon={<Eye20Regular />}
          title="No file selected"
          body="Pick a Parquet, CSV, or JSON file in the Files tab to preview its first rows via OPENROWSET."
          primaryAction={{ label: 'Go to Files', appearance: 'primary', onClick: () => setTab('files') }}
        />
      )}
      {activePath?.isDirectory && (
        <EmptyState
          icon={<Eye20Regular />}
          title={`${leafName(activePath.name)} is a folder`}
          body="Folders can't be previewed. Select a file inside this folder to see its rows."
          primaryAction={{ label: 'Go to Files', appearance: 'primary', onClick: () => setTab('files') }}
        />
      )}
      {activePath && !activePath.isDirectory && (
        <>
          <div className={s.toolbar}>
            <Subtitle2>{leafName(activePath.name)}</Subtitle2>
            <Badge appearance="outline">{formatBytes(activePath.size)}</Badge>
            {preview?.format && <Badge appearance="filled" color="brand">{preview.format}</Badge>}
            {preview?.executionMs !== undefined && <Caption1>· {preview.executionMs} ms</Caption1>}
            {preview?.rowCount !== undefined && (
              <Badge appearance="filled" color="success">{preview.rowCount} rows</Badge>
            )}
          </div>
          {previewLoading && <Spinner size="small" label="Running OPENROWSET…" labelPosition="after" />}
          {!previewLoading && preview && !preview.ok && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Preview failed</MessageBarTitle>
                {preview.error} {preview.code && <Caption1>· {preview.code}</Caption1>}
              </MessageBarBody>
            </MessageBar>
          )}
          {!previewLoading && preview?.ok && preview.previewable === false && (
            <MessageBar intent="info">
              <MessageBarBody>{preview.message || 'This file type is not tabular — use Download to view it.'}</MessageBarBody>
            </MessageBar>
          )}
          {!previewLoading && preview?.ok && preview.previewable !== false && (
            (preview.columns?.length ?? 0) === 0 ? (
              <Caption1>Query returned no rows.</Caption1>
            ) : (
              <DeltaPreviewGrid
                columns={preview.columns || []}
                rows={(preview.rows as unknown[][]) || []}
                rowCount={preview.rowCount ?? (preview.rows?.length ?? 0)}
                executionMs={preview.executionMs}
                truncated={preview.truncated}
                columnStats={columnStats}
                statsLoading={statsLoading}
                statsError={statsError}
                previewSource={activeContainer ? {
                  container: activeContainer,
                  path: activePath.name,
                  pool: settings.defaultSparkPool || undefined,
                } : null}
                mode={previewMode}
                onModeChange={(m) => {
                  setPreviewMode(m);
                  setTab(m === 'table' ? 'tables' : 'files');
                }}
              />
            )
          )}
        </>
      )}
    </>
  );
}
