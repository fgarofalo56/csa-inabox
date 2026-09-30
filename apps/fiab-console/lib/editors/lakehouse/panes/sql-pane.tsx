'use client';
import {
  Caption1, Spinner, Body1, Button, tokens,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Eye20Regular, Play20Regular } from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { OpenInPbiDesktopButton } from '../../components/open-in-pbi-desktop-button';
import { OpenInLoomReportBuilderButton } from '../../components/open-in-loom-report-builder-button';
import { EditorResultsSplit, SplitFillBox } from '../../components/editor-results-split';
import { useStyles, formatCell } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';

/** A failed SQL tab response: the route's `error` and `code`, plus its `remediation` when it sends one. */
export interface SqlFailure {
  ok: false;
  error?: string;
  code?: string;
  remediation?: string;
}

/**
 * Codes for a query the SQL tab chose not to run, or could not confirm, as
 * opposed to one that ran and failed. They are shown as a warning with the
 * route's remediation, because the next step is the user's, not a retry.
 */
const NOT_RUN_CODES = new Set([
  'query_construct_not_accepted',
  'query_location_outside_root',
  'lakehouse_storage_unbound',
]);

/** The failure bar under the SQL editor: the reason, then what to do about it. */
export function SqlRefusalOrError({ result }: { result: SqlFailure }) {
  const notRun = !!result.code && NOT_RUN_CODES.has(result.code);
  return (
    <MessageBar intent={notRun ? 'warning' : 'error'} layout="multiline">
      {/* A refused name can be one long unbroken token; let it wrap rather than widen the bar. */}
      <MessageBarBody style={{ overflowWrap: 'anywhere' }}>
        <MessageBarTitle>{notRun ? 'Query not run' : 'Query failed'}</MessageBarTitle>
        {result.error} {result.code && <Caption1>· {result.code}</Caption1>}
        {result.remediation && (
          <Body1 block style={{ marginTop: tokens.spacingVerticalXS }}>
            <strong>What to do:</strong> {result.remediation}
          </Body1>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}

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
      {/* U6 — query↔results divider (shared EditorResultsSplit). */}
      <EditorResultsSplit
        editorKey="lakehouse-sql"
        active={sqlLoading || !!sqlResult}
        query={
          <MonacoTextarea
            value={sqlText}
            onChange={setSqlText}
            language="tsql"
            height={240}
            minHeight={180}
            sizingKey="lakehouse.openrowset-sql"
            ariaLabel="OPENROWSET T-SQL editor"
          />
        }
        results={
          <>
            {sqlLoading && <Spinner size="small" label="Executing…" labelPosition="after" />}
            {!sqlLoading && sqlResult && !sqlResult.ok && (
              <SqlRefusalOrError result={sqlResult as SqlFailure} />
            )}
            {!sqlLoading && sqlResult?.ok && (
              <SplitFillBox className={s.tableWrap}>
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
              </SplitFillBox>
            )}
          </>
        }
      />
    </>
  );
}
