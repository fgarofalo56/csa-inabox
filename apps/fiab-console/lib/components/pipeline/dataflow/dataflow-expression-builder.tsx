'use client';

/**
 * DataflowExpressionBuilder — the Loom one-for-one of the ADF / Synapse MAPPING
 * DATA FLOW "Visual Expression Builder" (ui-parity.md). This is the SPARK-based
 * mapping-data-flow expression surface, which is a DISTINCT language from the
 * pipeline (control-flow) expression builder in `../dynamic-content.tsx`:
 *   - no `@` prefix; references columns by bare name, parameters by `$name`,
 *     locals by `:name`;
 *   - a large Spark-backed function library (Aggregate / Array / Conversion /
 *     Date-time / Expression / Map / Metafunction / Window / Cached-lookup).
 * It does NOT touch the Power Query / Dataflow Gen2 surface
 * (`./power-query-host`, `./m-script`) — that is the M-script language.
 *
 * LAYOUT (matches the real ADF Expression Builder, three panes):
 *   ┌──────────────┬─────────────────────────────┬───────────────────────────┐
 *   │ Input schema │   Expression editor (Monaco) │  Function catalog          │
 *   │  + Parameters│   + Insert + validity hint   │  grouped by category, with │
 *   │  + Locals    │   + honest Debug/Preview gate │  search + signatures        │
 *   └──────────────┴─────────────────────────────┴───────────────────────────┘
 *
 * Every left-pane column / parameter / local and every right-pane function is
 * CLICK-TO-INSERT at the cursor (no freeform JSON, per loom-no-freeform-config).
 * Monaco IntelliSense (Ctrl-Space) is fed the same catalog so authoring matches
 * ADF. The edited string IS the data-flow `script` fragment for the column /
 * condition — it round-trips verbatim on the real data-flow PUT
 * (adf-client.upsertDataFlow / synapse-artifacts-client), so it executes
 * identically on the Spark IR. No mocks.
 *
 * DATA PREVIEW is HONEST-GATED (no-vaporware.md): inline row preview requires a
 * live Spark debug cluster (Data flow debug session). We never fabricate sample
 * rows — when no debug session is attached we render a Fluent MessageBar naming
 * exactly what to do (turn on Data flow debug), and the host can wire `onDebug`
 * to the real debug-session BFF route when a session exists.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Body1Strong, Subtitle2, Caption1, Button, Badge, Tab, TabList,
  SearchBox, Tooltip, Divider, Accordion, AccordionItem, AccordionHeader,
  AccordionPanel, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Table16Regular, NumberSymbol16Regular,
  Tag16Regular, CheckmarkCircle16Filled, ErrorCircle16Filled, Warning16Filled,
  Play16Regular, Code16Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  DATAFLOW_FN_CATEGORIES, functionsByCategory, searchFunctions,
  checkDataflowExpression, columnToken, parameterToken, localToken,
  type DataflowFn, type DataflowColumn, type DataflowParameter, type DataflowLocal,
} from './dataflow-expression-functions';

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    flex: 1, minHeight: 0,
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
  },
  body: {
    display: 'flex', gap: tokens.spacingHorizontalM, flex: 1, minHeight: '360px',
  },
  // Left + right reference panes.
  pane: {
    width: '260px', flexShrink: 0, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'auto',
    boxShadow: tokens.shadow4,
  },
  center: {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4,
  },
  paneHeaderRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalXS,
  },
  refItem: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall, cursor: 'pointer', width: '100%',
    textAlign: 'left', border: 'none', background: 'transparent',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  refName: {
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
  },
  refType: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  catSearch: { marginBottom: tokens.spacingVerticalXS },
  fnRow: {
    display: 'flex', flexDirection: 'column', gap: '1px',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall, cursor: 'pointer', width: '100%',
    textAlign: 'left', border: 'none', background: 'transparent',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  fnName: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorBrandForeground1 },
  fnSig: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  fnDesc: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  editorWrap: { flex: 1, minHeight: '200px', display: 'flex', flexDirection: 'column' },
  validity: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  validityOk: { color: tokens.colorPaletteGreenForeground1 },
  validityWarn: { color: tokens.colorPaletteYellowForeground1 },
  validityErr: { color: tokens.colorPaletteRedForeground1 },
  emptyRef: { color: tokens.colorNeutralForeground3, padding: tokens.spacingHorizontalXS },
});

type RefTab = 'columns' | 'parameters' | 'locals';

export interface DataflowExpressionBuilderProps {
  /** The data-flow expression script fragment (single source of truth). */
  value: string;
  /** Emit the next expression on any edit / insert. */
  onChange: (next: string) => void;
  /** Field label shown above the editor (e.g. the derived-column name). */
  label?: string;
  readOnly?: boolean;

  /** Input-schema columns offered in the left pane (insert as bare name / {escaped}). */
  columns?: DataflowColumn[];
  /** Data-flow parameters offered in the left pane (insert as `$name`). */
  parameters?: DataflowParameter[];
  /** Derived-column "Locals" offered in the left pane (insert as `:name`). */
  locals?: DataflowLocal[];

  /**
   * When the expression is used inside a Window/Aggregate transform, the host
   * can pass `transform` so the catalog defaults to that category's tab and the
   * window/aggregate functions read as primary. Cosmetic only.
   */
  transform?: 'derive' | 'filter' | 'aggregate' | 'window' | 'join' | 'alterRow' | 'select' | string;

  /**
   * Honest data-preview gate. When a live Data-flow debug session is attached,
   * the host passes `onDebug` (wired to the real debug-session BFF route) and we
   * render a "Debug" button. With no session we render a MessageBar telling the
   * user to turn on Data flow debug — never fabricated rows (no-vaporware.md).
   */
  debugSessionId?: string | null;
  onDebug?: () => void;
}

/**
 * The mapping-data-flow visual expression builder. Embed it in a dialog/drawer
 * from a derived-column / filter / aggregate / window transform editor.
 */
export function DataflowExpressionBuilder({
  value, onChange, label, readOnly = false,
  columns = [], parameters = [], locals = [],
  transform,
  debugSessionId, onDebug,
}: DataflowExpressionBuilderProps) {
  const s = useStyles();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const [refTab, setRefTab] = useState<RefTab>('columns');
  const [query, setQuery] = useState('');

  const validity = useMemo(() => checkDataflowExpression(value), [value]);
  const grouped = useMemo(() => functionsByCategory(), []);
  const filtered = useMemo(() => (query.trim() ? searchFunctions(query) : null), [query]);

  // The category the active transform implies — open it first in the catalog.
  const defaultCategory = useMemo(() => {
    if (transform === 'window') return 'window';
    if (transform === 'aggregate') return 'aggregate';
    return 'expression';
  }, [transform]);

  // ---- Cursor-aware insertion (falls back to append when editor not mounted) ----
  const insertText = useCallback((snippet: string, caretBack = 0) => {
    if (readOnly) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (editor && monaco) {
      const sel = editor.getSelection();
      const id = { major: 1, minor: 1 };
      const op = { identifier: id, range: sel, text: snippet, forceMoveMarkers: true };
      editor.executeEdits('loom-df-insert', [op]);
      // Place caret inside the inserted parens when requested (snippet like `fn()`).
      if (caretBack > 0) {
        const pos = editor.getPosition();
        if (pos) {
          editor.setPosition({ lineNumber: pos.lineNumber, column: pos.column - caretBack });
        }
      }
      editor.focus();
      onChange(editor.getValue());
    } else {
      // No editor yet: append with a separating space when needed.
      const needsSpace = value && !/\s$/.test(value);
      onChange(`${value}${needsSpace ? ' ' : ''}${snippet}`);
    }
  }, [readOnly, onChange, value]);

  const insertFunction = useCallback((fn: DataflowFn) => {
    // For `name()` snippets, leave the caret between the parens.
    const caretBack = fn.insert.endsWith('()') ? 1 : 0;
    insertText(fn.insert, caretBack);
  }, [insertText]);

  // ---- Register Monaco IntelliSense from the catalog (once per mount) ----
  const onReady = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    const lang = editor.getModel()?.getLanguageId?.() || 'sql';
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['(', '$', ':', '.'],
      provideCompletionItems: () => {
        const kind = monaco.languages.CompletionItemKind;
        const fnItems = (functionsByCategory()
          .flatMap((g) => g.fns))
          .map((f) => ({
            label: f.name,
            kind: kind.Function,
            insertText: f.insert.endsWith('()') ? `${f.name}($0)` : f.insert,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: f.signature,
            documentation: { value: `${f.description}${f.example ? `\n\n\`${f.example}\`` : ''}` },
          }));
        const colItems = columns.map((c) => ({
          label: c.name, kind: kind.Field, insertText: columnToken(c),
          detail: `column${c.type ? ` : ${c.type}` : ''}${c.stream ? ` (${c.stream})` : ''}`,
        }));
        const paramItems = parameters.map((p) => ({
          label: `$${p.name}`, kind: kind.Variable, insertText: parameterToken(p),
          detail: `parameter${p.type ? ` : ${p.type}` : ''}`,
        }));
        const localItems = locals.map((l) => ({
          label: `:${l.name}`, kind: kind.Constant, insertText: localToken(l),
          detail: l.expression ? `local = ${l.expression}` : 'local',
        }));
        return { suggestions: [...fnItems, ...colItems, ...paramItems, ...localItems] };
      },
    });
  }, [columns, parameters, locals]);

  const refList = (() => {
    if (refTab === 'columns') {
      if (columns.length === 0) {
        return <Caption1 className={s.emptyRef}>No input columns — connect a source upstream of this transform.</Caption1>;
      }
      return columns.map((c) => (
        <Tooltip key={`${c.stream || ''}.${c.name}`} content={`Insert column ${columnToken(c)}`} relationship="label">
          <button type="button" className={s.refItem} disabled={readOnly} onClick={() => insertText(columnToken(c))}>
            <Table16Regular />
            <span className={s.refName}>{c.name}</span>
            {c.type && <Caption1 className={s.refType}>{c.type}</Caption1>}
          </button>
        </Tooltip>
      ));
    }
    if (refTab === 'parameters') {
      if (parameters.length === 0) {
        return <Caption1 className={s.emptyRef}>No data-flow parameters. Add them in the data flow&apos;s Parameters tab.</Caption1>;
      }
      return parameters.map((p) => (
        <Tooltip key={p.name} content={`Insert parameter $${p.name}`} relationship="label">
          <button type="button" className={s.refItem} disabled={readOnly} onClick={() => insertText(parameterToken(p))}>
            <NumberSymbol16Regular />
            <span className={s.refName}>${p.name}</span>
            {p.type && <Caption1 className={s.refType}>{p.type}</Caption1>}
          </button>
        </Tooltip>
      ));
    }
    if (locals.length === 0) {
      return <Caption1 className={s.emptyRef}>No locals. Locals are reusable sub-expressions defined in the Derived Column transform.</Caption1>;
    }
    return locals.map((l) => (
      <Tooltip key={l.name} content={`Insert local :${l.name}`} relationship="label">
        <button type="button" className={s.refItem} disabled={readOnly} onClick={() => insertText(localToken(l))}>
          <Tag16Regular />
          <span className={s.refName}>:{l.name}</span>
        </button>
      </Tooltip>
    ));
  })();

  const ValidityIcon = validity.level === 'ok'
    ? CheckmarkCircle16Filled
    : validity.level === 'warning' ? Warning16Filled : ErrorCircle16Filled;
  const validityClass = validity.level === 'ok'
    ? s.validityOk
    : validity.level === 'warning' ? s.validityWarn : s.validityErr;

  return (
    <div className={s.root}>
      <div className={s.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Code16Regular />
          <Subtitle2>{label ? `Expression — ${label}` : 'Visual expression builder'}</Subtitle2>
          <Badge appearance="tint" color="brand" size="small">Data flow</Badge>
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Spark mapping-data-flow language — references columns by name, <code>$param</code>, <code>:local</code>.
        </Caption1>
      </div>

      <div className={s.body}>
        {/* LEFT: input schema + parameters + locals */}
        <div className={s.pane} aria-label="Input schema, parameters and locals">
          <TabList selectedValue={refTab} onTabSelect={(_, d) => setRefTab(d.value as RefTab)} size="small">
            <Tab value="columns" icon={<Table16Regular />}>Input schema</Tab>
            <Tab value="parameters" icon={<NumberSymbol16Regular />}>Parameters</Tab>
            <Tab value="locals" icon={<Tag16Regular />}>Locals</Tab>
          </TabList>
          <Divider />
          {refList}
        </div>

        {/* CENTER: editor + insert helpers + validity + honest debug gate */}
        <div className={s.center}>
          <div className={s.editorWrap}>
            <MonacoTextarea
              value={value}
              onChange={onChange}
              language="sql"
              readOnly={readOnly}
              autoHeight
              minHeight={180}
              maxHeight={420}
              ariaLabel="Data flow expression"
              lineNumbers={false}
              onReady={onReady}
            />
          </div>

          {/* Validity hint (design-time syntactic check — NOT a data preview). */}
          <div className={s.validity}>
            <ValidityIcon className={validityClass} />
            <Caption1 className={validityClass}>{validity.message}</Caption1>
          </div>

          {/* Honest data-preview / debug gate. */}
          {debugSessionId ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Button
                appearance="primary"
                icon={<Play16Regular />}
                disabled={readOnly || !validity.ok}
                onClick={() => onDebug?.()}
              >
                Debug — preview output
              </Button>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Runs this expression on the attached data-flow debug session (Spark).
              </Caption1>
            </div>
          ) : (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Data preview needs a Spark debug session</MessageBarTitle>
                Live row preview runs on a data-flow debug cluster, so Loom does not fabricate
                sample rows. Turn on <strong>Data flow debug</strong> for this data flow to attach a
                Spark debug session, then re-open the builder to preview output. The expression you
                author here is still saved and executes on the data flow&apos;s Spark integration
                runtime when the pipeline runs it.
              </MessageBarBody>
            </MessageBar>
          )}
        </div>

        {/* RIGHT: function catalog grouped by category, searchable */}
        <div className={s.pane} aria-label="Expression functions">
          <div className={s.paneHeaderRow}>
            <Subtitle2>Functions</Subtitle2>
            <Badge appearance="tint" size="small">{DATAFLOW_FN_CATEGORIES.length} categories</Badge>
          </div>
          <SearchBox
            className={s.catSearch}
            placeholder="Search functions"
            value={query}
            onChange={(_, d) => setQuery(d.value)}
            size="small"
          />
          {filtered ? (
            // Flat search results.
            filtered.length === 0 ? (
              <Caption1 className={s.emptyRef}>No functions match &quot;{query}&quot;.</Caption1>
            ) : (
              filtered.map((f) => <FnButton key={f.name} fn={f} disabled={readOnly} onInsert={insertFunction} styles={s} />)
            )
          ) : (
            // Grouped accordion by category.
            <Accordion multiple collapsible defaultOpenItems={[defaultCategory]}>
              {grouped.map((g) => (
                <AccordionItem key={g.meta.id} value={g.meta.id}>
                  <AccordionHeader>
                    <Body1Strong>{g.meta.label}</Body1Strong>
                    <Badge appearance="ghost" size="small" style={{ marginLeft: tokens.spacingHorizontalXS }}>
                      {g.fns.length}
                    </Badge>
                  </AccordionHeader>
                  <AccordionPanel>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalXS }}>
                      {g.meta.blurb}
                    </Caption1>
                    {g.fns.map((f) => <FnButton key={f.name} fn={f} disabled={readOnly} onInsert={insertFunction} styles={s} />)}
                  </AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// One catalog function row — click to insert, hover for signature + example.
// -----------------------------------------------------------------------------
function FnButton({
  fn, disabled, onInsert, styles,
}: {
  fn: DataflowFn;
  disabled: boolean;
  onInsert: (fn: DataflowFn) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <Tooltip
      relationship="description"
      content={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 320 }}>
          <code>{fn.signature}</code>
          <span>{fn.description}</span>
          {fn.example && <code style={{ color: tokens.colorBrandForeground1 }}>{fn.example}</code>}
        </div>
      }
    >
      <button type="button" className={styles.fnRow} disabled={disabled} onClick={() => onInsert(fn)}>
        <span>
          <Add16Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
          <Body1Strong className={styles.fnName}>{fn.name}</Body1Strong>
        </span>
        <span className={styles.fnSig}>{fn.signature}</span>
        <span className={styles.fnDesc}>{fn.description}</span>
      </button>
    </Tooltip>
  );
}

export default DataflowExpressionBuilder;
