'use client';
import {
  Caption1, Spinner, Body1, Button, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Eye20Regular, Play20Regular } from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { OpenInPbiDesktopButton } from '../components/open-in-pbi-desktop-button';
import { OpenInLoomReportBuilderButton } from '../components/open-in-loom-report-builder-button';
import { useStyles, formatCell } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';

export function SqlPane() {
  const s = useStyles();
  const ctx = useLakehouseCtx();
  const {
    id, item: _item, sqlText, setSqlText, sqlResult, sqlLoading, runSql,
  } = ctx as typeof ctx & { item?: { displayName?: string } };
  const { item } = ctx as any;

  return (
    <>
      <div className={s.toolbar}>
        <Body1>OPENROWSET via Synapse Serverless</Body1>
        <OpenInPbiDesktopButton type="lakehouse" id={id} name={item?.displayName} />
        <OpenInLoomReportBuilderButton type="lakehouse" id={id} name={item?.displayName} />
        <Button
          appearance="primary"
          icon={<Play20Regular />}
          disabled={sqlLoading}
          onClick={runSql}
          style={{ marginLeft: 'auto' }}
        >
          Run
        </Button>
      </div>
      <MonacoTextarea
        value={sqlText}
        onChange={setSqlText}
        language="tsql"
        height={240}
        minHeight={180}
        sizingKey="lakehouse.openrowset-sql"
        ariaLabel="OPENROWSET T-SQL editor"
      />
      {sqlLoading && <Spinner size="small" label="Executing…" labelPosition="after" />}
      {!sqlLoading && sqlResult && !sqlResult.ok && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Query failed</MessageBarTitle>
            {sqlResult.error} {sqlResult.code && <Caption1>· {sqlResult.code}</Caption1>}
          </MessageBarBody>
        </MessageBar>
      )}
      {!sqlLoading && sqlResult?.ok && (
        <div className={s.tableWrap}>
          <Table aria-label="SQL results" size="small">
            <TableHeader>
              <TableRow>
                {(sqlResult.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sqlResult.rows || []).map((row, i) => (
                <TableRow key={i}>
                  {(sqlResult.columns || []).map((_, j) => (
                    <TableCell key={j} className={s.cell}>{formatCell((row as unknown[])[j])}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
