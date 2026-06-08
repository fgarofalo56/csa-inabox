'use client';

/**
 * onelake-security-tab — F8 "OneLake security" custom row-level-security (RLS)
 * WHERE-predicate editor. Rendered inside the Lakehouse → Permissions → Row
 * tab, beneath the fixed-subject quick form, as the advanced authoring surface.
 *
 * Parity target: the Fabric / Synapse "Row-level security" experience where an
 * author writes a free-form filter predicate. Azure-native, NO Fabric
 * dependency — every action runs real T-SQL against the Synapse Dedicated SQL
 * pool via /api/lakehouse/permissions (save) and /api/lakehouse/permissions/
 * rls-test (preview). No mocks, no dead controls.
 *
 *   - Monaco WHERE editor (T-SQL, 1000-char limit, regex-validated, @cmp-aware
 *     IntelliSense for the identity functions usable in a SCHEMABINDING TVF)
 *   - Test predicate → SELECT TOP n live rows the chosen identity would see
 *   - Save policy → CREATE FUNCTION (inline TVF) + CREATE SECURITY POLICY
 *   - OR-union / owner-bypass explanatory note
 *   - Preview badge (per no-vaporware.md preview tagging)
 *
 * The component is self-contained: it resolves the filter column for the chosen
 * table from the real SQL catalog and reports a save via `onSaved` so the
 * parent's active-policies table refreshes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Play16Regular, ShieldCheckmark20Regular, Info16Regular } from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { validateWhereClause, RLS_WHERE_MAX } from '@/lib/azure/rls-predicate';

// Max predicate length — re-exported from the shared sanitizer.
const MAX_CHARS = RLS_WHERE_MAX;

/** Client-side wrapper over the shared validator — returns an error string or null. */
export function validateRlsPredicate(s: string): string | null {
  const v = validateWhereClause(s);
  return v.ok ? null : v.error || 'Invalid predicate.';
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '10px' },
  header: { display: 'flex', alignItems: 'center', gap: '8px' },
  pickers: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' },
  counter: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
  note: {
    display: 'flex',
    gap: '6px',
    alignItems: 'flex-start',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    padding: '8px 10px',
  },
  resultBox: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'auto',
    maxHeight: '260px',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  th: {
    textAlign: 'left',
    padding: '5px 8px',
    position: 'sticky',
    top: 0,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  td: { padding: '5px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, whiteSpace: 'nowrap' },
});

export interface OnelakeRlsTable {
  objectId: number;
  schema: string;
  name: string;
  type: string;
}

export interface OnelakeRlsPredicateEditorProps {
  /** Tables/views from the parent's catalog list (Synapse Dedicated SQL pool). */
  tables: OnelakeRlsTable[];
  /** Signed-in admin's UPN — seeds the "Test as identity" field. */
  defaultIdentity?: string;
  /** Called after a policy is successfully created so the parent can refresh. */
  onSaved?: () => void;
}

interface SqlColRef {
  columnId: number;
  name: string;
  dataType: string;
}

interface TestResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
  testIdentity: string;
}

// Register the @cmp-aware completion provider once per page (Monaco providers
// are global; a module flag avoids duplicate suggestions across remounts).
let completionRegistered = false;
function registerRlsCompletions(monaco: any) {
  if (completionRegistered) return;
  completionRegistered = true;
  const items = [
    { label: '@cmp', insertText: '@cmp', detail: "The filter column's value for the current row" },
    { label: 'USER_NAME()', insertText: 'USER_NAME()', detail: 'Database user name of the caller (UPN)' },
    { label: 'SUSER_SNAME()', insertText: 'SUSER_SNAME()', detail: 'Login name of the caller' },
    { label: "IS_MEMBER('db_owner')", insertText: "IS_MEMBER('db_owner') = 1", detail: 'True when the caller is a db_owner' },
    { label: 'SESSION_CONTEXT', insertText: "SESSION_CONTEXT(N'key')", detail: 'Session context value (set per connection)' },
  ];
  monaco.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems(model: any, position: any) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: items.map((it) => ({
          label: it.label,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: it.insertText,
          detail: it.detail,
          range,
        })),
      };
    },
  });
}

export function OnelakeRlsPredicateEditor({ tables, defaultIdentity, onSaved }: OnelakeRlsPredicateEditorProps) {
  const styles = useStyles();
  // Only base tables (type 'U') can carry an RLS policy — match the fixed form.
  const rlsTables = useMemo(() => tables.filter((t) => t.type === 'U'), [tables]);

  const [objectId, setObjectId] = useState<number | null>(null);
  const [cols, setCols] = useState<SqlColRef[]>([]);
  const [colsLoading, setColsLoading] = useState(false);
  const [filterColumnId, setFilterColumnId] = useState<number | null>(null);
  const [whereClause, setWhereClause] = useState('@cmp = USER_NAME()');
  const [testIdentity, setTestIdentity] = useState(defaultIdentity || '');

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveReceipt, setSaveReceipt] = useState<{ policyName: string; functionName: string } | null>(null);

  useEffect(() => {
    setTestIdentity((cur) => cur || defaultIdentity || '');
  }, [defaultIdentity]);

  const validationError = validateRlsPredicate(whereClause);
  const charCount = whereClause.length;
  const overLimit = charCount > MAX_CHARS;

  const loadColumns = useCallback(async (oid: number) => {
    setColsLoading(true);
    try {
      const r = await fetch(`/api/lakehouse/permissions?tab=column&list=columns&objectId=${oid}`);
      const j = await r.json();
      setCols(j.ok ? j.columns || [] : []);
    } catch {
      setCols([]);
    } finally {
      setColsLoading(false);
    }
  }, []);

  const onPickTable = useCallback(
    (oid: number | null) => {
      setObjectId(oid);
      setFilterColumnId(null);
      setCols([]);
      setTestResult(null);
      setTestError(null);
      setSaveReceipt(null);
      setSaveError(null);
      if (oid != null) loadColumns(oid);
    },
    [loadColumns],
  );

  const monacoReady = useRef(false);
  const onMonacoReady = useCallback((_editor: any, monaco: any) => {
    if (monacoReady.current) return;
    monacoReady.current = true;
    registerRlsCompletions(monaco);
  }, []);

  const canRun = objectId != null && filterColumnId != null && !validationError;

  const runTest = useCallback(async () => {
    if (!canRun) return;
    setTestLoading(true);
    setTestError(null);
    setTestResult(null);
    try {
      const r = await fetch('/api/lakehouse/permissions/rls-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objectId, filterColumnId, whereClause, testIdentity: testIdentity.trim() }),
      });
      const j = await r.json();
      if (!j.ok) {
        setTestError(j.gate ? `Synapse Dedicated SQL pool not configured (${j.missing}).` : j.error || `HTTP ${r.status}`);
        return;
      }
      setTestResult({
        columns: j.columns || [],
        rows: j.rows || [],
        rowCount: j.rowCount || 0,
        executionMs: j.executionMs || 0,
        truncated: !!j.truncated,
        testIdentity: j.testIdentity || testIdentity.trim(),
      });
    } catch (e: any) {
      setTestError(e?.message || String(e));
    } finally {
      setTestLoading(false);
    }
  }, [canRun, objectId, filterColumnId, whereClause, testIdentity]);

  const savePolicy = useCallback(async () => {
    if (!canRun) return;
    setSaveLoading(true);
    setSaveError(null);
    setSaveReceipt(null);
    try {
      const r = await fetch('/api/lakehouse/permissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'row', objectId, filterColumnId, whereClause }),
      });
      const j = await r.json();
      if (!j.ok) {
        setSaveError(j.gate ? `Synapse Dedicated SQL pool not configured (${j.missing}).` : j.error || `HTTP ${r.status}`);
        return;
      }
      setSaveReceipt({ policyName: j.policyName, functionName: j.functionName });
      onSaved?.();
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaveLoading(false);
    }
  }, [canRun, objectId, filterColumnId, whereClause, onSaved]);

  const selectedTableLabel =
    objectId != null && rlsTables.find((t) => t.objectId === objectId)
      ? `${rlsTables.find((t) => t.objectId === objectId)!.schema}.${rlsTables.find((t) => t.objectId === objectId)!.name}`
      : '';

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <ShieldCheckmark20Regular />
        <Subtitle2>Custom WHERE predicate</Subtitle2>
        <Badge appearance="tint" color="brand">Preview</Badge>
      </div>
      <Caption1>
        Author a free-form filter predicate. <code>@cmp</code> is the chosen filter column&apos;s value for each row; a
        row is visible when the predicate is true. The policy is a real inline table-valued function +{' '}
        <code>SECURITY POLICY</code> on the Synapse Dedicated SQL pool.
      </Caption1>

      <div className={styles.pickers}>
        <Field label="Table" required>
          <Dropdown
            placeholder="Select a table"
            selectedOptions={objectId != null ? [String(objectId)] : []}
            value={selectedTableLabel}
            onOptionSelect={(_, d) => onPickTable(d.optionValue ? Number(d.optionValue) : null)}
          >
            {rlsTables.map((t) => (
              <Option key={t.objectId} value={String(t.objectId)} text={`${t.schema}.${t.name}`}>
                {t.schema}.{t.name}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Filter column" required hint={colsLoading ? 'Loading…' : undefined}>
          <Dropdown
            placeholder="Select a column"
            disabled={objectId == null || colsLoading}
            selectedOptions={filterColumnId != null ? [String(filterColumnId)] : []}
            value={filterColumnId != null && cols.find((c) => c.columnId === filterColumnId) ? cols.find((c) => c.columnId === filterColumnId)!.name : ''}
            onOptionSelect={(_, d) => setFilterColumnId(d.optionValue ? Number(d.optionValue) : null)}
          >
            {cols.map((c) => (
              <Option key={c.columnId} value={String(c.columnId)} text={c.name}>
                {c.name} ({c.dataType})
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Test as identity" hint="Substitutes USER_NAME()/SUSER_SNAME() in the preview">
          <Input
            value={testIdentity}
            onChange={(_, d) => setTestIdentity(d.value)}
            placeholder="user@contoso.com"
          />
        </Field>
      </div>

      <Field
        label="WHERE predicate"
        required
        validationState={validationError ? 'error' : 'none'}
        validationMessage={validationError || undefined}
      >
        <MonacoTextarea
          value={whereClause}
          onChange={setWhereClause}
          language="tsql"
          height={84}
          lineNumbers={false}
          minimap={false}
          ariaLabel="Row-level security WHERE predicate"
          onReady={onMonacoReady}
        />
      </Field>
      <div className={styles.counter}>
        <Caption1 style={{ color: overLimit ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>
          {charCount} / {MAX_CHARS} characters
        </Caption1>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Compare <code>@cmp</code> to <code>USER_NAME()</code>, <code>SUSER_SNAME()</code>, or another column.
        </Caption1>
      </div>

      <div className={styles.note}>
        <Info16Regular style={{ marginTop: 2, flexShrink: 0 }} />
        <Caption1>
          The saved policy applies as <code>(your predicate) OR IS_MEMBER(&apos;db_owner&apos;) = 1</code>, so database
          owners always see every row. When multiple security policies target the same table their predicates are{' '}
          <strong>AND-combined</strong> at row evaluation; to OR several conditions, combine them with <code>OR</code>{' '}
          inside this one predicate.
        </Caption1>
      </div>

      <div className={styles.actions}>
        <Button appearance="secondary" icon={<Play16Regular />} onClick={runTest} disabled={!canRun || testLoading}>
          {testLoading ? 'Testing…' : 'Test predicate'}
        </Button>
        <Button appearance="primary" onClick={savePolicy} disabled={!canRun || saveLoading}>
          {saveLoading ? 'Saving…' : 'Save policy'}
        </Button>
      </div>

      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not save policy</MessageBarTitle>
            {saveError}
          </MessageBarBody>
        </MessageBar>
      )}
      {saveReceipt && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Security policy created</MessageBarTitle>
            <code>{saveReceipt.policyName}</code> over <code>{saveReceipt.functionName}</code> is enabled on{' '}
            <code>{selectedTableLabel}</code>.
          </MessageBarBody>
        </MessageBar>
      )}

      {testError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Test failed</MessageBarTitle>
            {testError}
          </MessageBarBody>
        </MessageBar>
      )}
      {testLoading && <Spinner size="tiny" label="Running preview against live rows…" labelPosition="after" />}
      {testResult && (
        <div>
          <Body1 block style={{ marginBottom: 4 }}>
            {testResult.rowCount.toLocaleString()} row{testResult.rowCount === 1 ? '' : 's'} visible to{' '}
            <code>{testResult.testIdentity || '(connection identity)'}</code> · {testResult.executionMs} ms
            {testResult.truncated ? ' · truncated' : ''}
          </Body1>
          <div className={styles.resultBox}>
            {testResult.columns.length === 0 ? (
              <Caption1 style={{ display: 'block', padding: 8 }}>No rows match this predicate for that identity.</Caption1>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    {testResult.columns.map((c) => (
                      <th key={c} className={styles.th}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {testResult.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j} className={styles.td}>{v == null ? 'NULL' : String(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default OnelakeRlsPredicateEditor;
