'use client';
import {
  Caption1, Spinner, Badge, Button, Subtitle2, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Eye20Regular } from '@fluentui/react-icons';
import { useStyles, leafName, formatBytes, formatCell } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';

export function HistoryPane() {
  const s = useStyles();
  const ctx = useLakehouseCtx();
  const {
    activeContainer,
    historyTable, historyRows, historyLoading, historyError,
    historyRestoring, historyRestoreMsg,
    historyPreviewVersion, historyPreviewResult, historyPreviewLoading,
    loadHistory, restoreToVersion, previewAsOf,
  } = ctx;

  return (
    <>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand">{activeContainer || 'no container'}</Badge>
        {historyTable ? (
          <>
            <Caption1>Delta version history — <strong>{leafName(historyTable)}</strong> <code style={{ fontSize: tokens.fontSizeBase100 }}>/{historyTable}</code></Caption1>
            <Button appearance="outline" icon={<ArrowSync20Regular />}
              disabled={historyLoading || !activeContainer}
              onClick={() => historyTable && loadHistory(historyTable)}>
              Refresh
            </Button>
          </>
        ) : (
          <Caption1>Open the <strong>Tables</strong> tab and choose <strong>… → History (time travel)</strong> on a Delta table to view its version log, preview any version, or restore.</Caption1>
        )}
      </div>

      {historyLoading && <Spinner size="small" label="Reading _delta_log…" labelPosition="after" />}

      {historyError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>History error</MessageBarTitle>
            {historyError}
          </MessageBarBody>
        </MessageBar>
      )}

      {historyRestoreMsg && (
        <MessageBar intent={historyRestoreMsg.ok ? 'success' : 'warning'}>
          <MessageBarBody>{historyRestoreMsg.text}</MessageBarBody>
        </MessageBar>
      )}

      {!historyLoading && historyRows !== null && historyRows.length === 0 && !historyError && (
        <MessageBar intent="info">
          <MessageBarBody>
            No committed versions found under <code>{historyTable}/_delta_log/</code>. The table may not have been materialized yet, or the path is not a Delta table.
          </MessageBarBody>
        </MessageBar>
      )}

      {!historyLoading && historyRows !== null && historyRows.length > 0 && (
        <div className={s.tableWrap}>
          <Table aria-label="Delta version history" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Timestamp</TableHeaderCell>
                <TableHeaderCell>Operation</TableHeaderCell>
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell>Metrics</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {historyRows.map((row) => (
                <TableRow key={row.version}>
                  <TableCell className={s.cell}>{row.version}</TableCell>
                  <TableCell className={s.cell}>{row.timestamp ? new Date(row.timestamp).toLocaleString() : '—'}</TableCell>
                  <TableCell><Badge appearance="outline">{row.operation}</Badge></TableCell>
                  <TableCell className={s.cell}>{row.userName || '—'}</TableCell>
                  <TableCell className={s.cell}>
                    {[
                      row.metrics.numOutputRows != null && `${row.metrics.numOutputRows.toLocaleString()} rows`,
                      row.metrics.numFiles != null && `${row.metrics.numFiles} files`,
                      row.metrics.numRemovedFiles != null && `${row.metrics.numRemovedFiles} removed`,
                      row.metrics.numDeletedRows != null && `${row.metrics.numDeletedRows.toLocaleString()} deleted`,
                      row.metrics.numOutputBytes != null && formatBytes(row.metrics.numOutputBytes),
                    ].filter(Boolean).join(' · ') || '—'}
                  </TableCell>
                  <TableCell>
                    <Button size="small" appearance="outline" icon={<Eye20Regular />}
                      disabled={historyPreviewLoading}
                      style={{ marginRight: tokens.spacingHorizontalXS }}
                      onClick={() => historyTable && previewAsOf(historyTable, row.version)}>
                      Preview
                    </Button>
                    <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />}
                      disabled={historyRestoring === row.version}
                      onClick={() => historyTable && restoreToVersion(historyTable, row.version)}>
                      {historyRestoring === row.version ? 'Restoring…' : 'Restore'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {historyPreviewLoading && (
        <Spinner size="small" label={`Querying version ${historyPreviewVersion}…`} labelPosition="after" />
      )}
      {!historyPreviewLoading && historyPreviewResult && (
        <>
          <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>
            Preview — {leafName(historyTable || '')} @ version {historyPreviewVersion}
          </Subtitle2>
          {!historyPreviewResult.ok ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Preview unavailable</MessageBarTitle>
                {historyPreviewResult.error}
              </MessageBarBody>
            </MessageBar>
          ) : (historyPreviewResult.columns?.length ?? 0) === 0 ? (
            <Caption1>Query returned no columns.</Caption1>
          ) : (
            <div className={s.tableWrap}>
              <Table aria-label="Preview as of version" size="small">
                <TableHeader>
                  <TableRow>
                    {(historyPreviewResult.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(historyPreviewResult.rows || []).map((row, i) => (
                    <TableRow key={i}>
                      {(historyPreviewResult.columns || []).map((_, j) => (
                        <TableCell key={j} className={s.cell}>{formatCell((row as unknown[])[j])}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </>
  );
}
