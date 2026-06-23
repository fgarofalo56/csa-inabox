'use client';

/**
 * TsqlMonaco — the Fabric-parity T-SQL **query editor** surface.
 *
 * Wraps {@link MonacoTextarea} and adds the capabilities the Microsoft Fabric
 * SQL database query editor exposes
 * (https://learn.microsoft.com/fabric/database/sql/query-editor), one-for-one,
 * with the Loom (Fluent v9) theme applied:
 *
 *   1. **New SQL query split-button + template menu** — CREATE TABLE / VIEW /
 *      PROCEDURE / INDEX / FUNCTION, from {@link CREATE_TEMPLATES}.
 *   2. **Inline SQL snippet catalog** — typing `sql` opens the snippet picker
 *      ({@link SQL_SNIPPETS}), exactly like the Fabric editor body.
 *   3. **Schema IntelliSense** — a Monaco completion provider fed from the
 *      LIVE connected database via the existing `/api/sqldb/*` routes
 *      (sql-objects-client over TDS): real table / view / procedure / function
 *      names, and real column names after `schema.table.`.
 *   4. **Run selection** — Ctrl/Cmd+Enter or the Run button executes the
 *      highlighted text only; with no selection it runs the whole script.
 *   5. **Find / Replace / Command palette** — Ctrl+F, Ctrl+H, F1 (Monaco
 *      built-ins, surfaced as toolbar buttons for discoverability).
 *
 * No Fabric dependency: schema + execution route through Azure SQL TDS. When
 * the database is unreachable the editor still renders fully; IntelliSense just
 * has no schema and an honest inline note names the missing connection — per
 * .claude/rules/no-vaporware.md + no-fabric-dependency.md + ui-parity.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Caption1, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  MenuButtonProps, SplitButton, Tooltip, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, DocumentAdd20Regular, Search20Regular, ArrowSwap20Regular,
  Keyboard20Regular, Table20Regular, ContentView20Regular, DocumentText20Regular,
  MathFormula20Regular, BranchRequest20Regular, DatabaseSearch20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  CREATE_TEMPLATES, SQL_SNIPPETS, chooseRunText, shouldOfferSnippets,
  parseDottedReference, type CreatableGroup,
} from '@/lib/azure/sql-templates';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
  note: { color: tokens.colorNeutralForeground3 },
});

// ───────────────────────── Monaco provider registries ─────────────────────────
// registerCompletionItemProvider registers GLOBALLY per language on the monaco
// instance (not per editor). We register each provider exactly once (guarded by
// a module-level Set) and route per-model schema through `schemaByModel`, keyed
// by the model URI — mirroring lib/components/editor/inline-completion.ts.

const LANG_ID = 'sql';

interface TableEntry { schema: string; name: string; fullName: string; objectId: number }
interface ObjEntry { schema: string; name: string; fullName: string }

interface SchemaAccessor {
  getTables: () => TableEntry[];
  getViews: () => TableEntry[];
  getProcs: () => ObjEntry[];
  getFuncs: () => ObjEntry[];
  /** Lazily fetch + cache real column names for a table/view by object_id. */
  fetchColumns: (objectId: number) => Promise<string[]>;
}

const schemaByModel = new Map<string, SchemaAccessor>();
const snippetProviderRegistered = new Set<string>();
const schemaProviderRegistered = new Set<string>();

/** Register the inline SQL snippet provider — fires when the word starts `sql`. */
function ensureSnippetProvider(monaco: any) {
  if (snippetProviderRegistered.has(LANG_ID)) return;
  snippetProviderRegistered.add(LANG_ID);
  monaco.languages.registerCompletionItemProvider(LANG_ID, {
    // Fire on the `l` of `sql` so the picker opens as the prefix completes.
    triggerCharacters: ['l', 'L'],
    provideCompletionItems(model: any, position: any) {
      const word = model.getWordUntilPosition(position);
      if (!shouldOfferSnippets(word.word)) return { suggestions: [] };
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: SQL_SNIPPETS.map((sn) => ({
          label: sn.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          documentation: sn.documentation,
          detail: 'SQL snippet',
          insertText: sn.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  });
}

/** Register the live-schema IntelliSense provider (tables/columns/procs/funcs). */
function ensureSchemaProvider(monaco: any) {
  if (schemaProviderRegistered.has(LANG_ID)) return;
  schemaProviderRegistered.add(LANG_ID);
  const KindClass = monaco.languages.CompletionItemKind.Class;
  const KindField = monaco.languages.CompletionItemKind.Field;
  const KindFunction = monaco.languages.CompletionItemKind.Function;
  monaco.languages.registerCompletionItemProvider(LANG_ID, {
    triggerCharacters: ['.', ' '],
    async provideCompletionItems(model: any, position: any) {
      const accessor = schemaByModel.get(model.uri.toString());
      if (!accessor) return { suggestions: [] };

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const lineUpToCursor: string = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      // After `schema.table.` → suggest that object's real columns.
      const dotted = parseDottedReference(lineUpToCursor);
      if (dotted) {
        const match = [...accessor.getTables(), ...accessor.getViews()].find(
          (t) => t.schema.toLowerCase() === dotted.schema.toLowerCase()
            && t.name.toLowerCase() === dotted.table.toLowerCase(),
        );
        if (match) {
          const cols = await accessor.fetchColumns(match.objectId);
          return {
            suggestions: cols.map((c) => ({
              label: c,
              kind: KindField,
              insertText: `[${c}]`,
              detail: `column of ${match.fullName}`,
              range,
            })),
          };
        }
        // Recognised a dotted ref but not a known object — offer nothing rather
        // than the full table list (keeps column-context suggestions clean).
        return { suggestions: [] };
      }

      // Otherwise: tables, views, procedures, functions from the live catalog.
      const suggestions: any[] = [];
      for (const t of accessor.getTables()) {
        suggestions.push({
          label: t.fullName, kind: KindClass, detail: 'table',
          insertText: `[${t.schema}].[${t.name}]`, sortText: `1_${t.fullName}`, range,
        });
      }
      for (const v of accessor.getViews()) {
        suggestions.push({
          label: v.fullName, kind: KindClass, detail: 'view',
          insertText: `[${v.schema}].[${v.name}]`, sortText: `2_${v.fullName}`, range,
        });
      }
      for (const p of accessor.getProcs()) {
        suggestions.push({
          label: p.fullName, kind: KindFunction, detail: 'procedure',
          insertText: `EXEC [${p.schema}].[${p.name}]`, sortText: `3_${p.fullName}`, range,
        });
      }
      for (const f of accessor.getFuncs()) {
        suggestions.push({
          label: f.fullName, kind: KindFunction, detail: 'function',
          insertText: `[${f.schema}].[${f.name}]`, sortText: `4_${f.fullName}`, range,
        });
      }
      return { suggestions };
    },
  });
}

// ───────────────────────────────── Component ─────────────────────────────────

export interface TsqlMonacoProps {
  value: string;
  onChange: (next: string) => void;
  /** Execute SQL — receives the selection if highlighted, else the full script. */
  onRun: (sql: string) => void;
  /**
   * Azure SQL server FQDN/name for IntelliSense (passed straight to
   * `/api/sqldb/*?server=`). Empty → the routes resolve via itemId/workspaceId
   * (Fabric SQL item) or env defaults; IntelliSense degrades honestly if none.
   */
  server?: string;
  /** Database name for IntelliSense (paired with {@link server}). */
  database?: string;
  /** Loom item id — forwarded to `/api/sqldb/*?id=`. */
  itemId?: string;
  /** Loom workspace id — forwarded to `/api/sqldb/*?workspaceId=`. */
  workspaceId?: string;
  height?: number | string;
  readOnly?: boolean;
  /** Show the New-query template split button (default true). */
  showNewQuery?: boolean;
  busy?: boolean;
  /**
   * Optional chained editor-ready callback. Fires AFTER TsqlMonaco wires its
   * own IntelliSense/snippet providers, so a consumer (e.g. the SQL Copilot
   * ghost-text + selection capture) can attach to the SAME Monaco editor.
   */
  onReady?: (editor: any, monaco: any) => void;
}

export function TsqlMonaco({
  value, onChange, onRun,
  server = '', database = '', itemId = '', workspaceId = '',
  height = 240, readOnly = false, showNewQuery = true, busy = false,
  onReady: onReadyExternal,
}: TsqlMonacoProps) {
  const s = useStyles();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const modelUriRef = useRef<string | null>(null);

  // Live schema, read by the (module-level) completion provider via a ref so it
  // always sees the latest fetch without re-registering the provider.
  const schemaRef = useRef<{ tables: TableEntry[]; views: TableEntry[]; procs: ObjEntry[]; funcs: ObjEntry[] }>(
    { tables: [], views: [], procs: [], funcs: [] },
  );
  const columnsCacheRef = useRef<Map<number, string[]>>(new Map());
  const [schemaNote, setSchemaNote] = useState<string | null>(null);
  const [schemaCount, setSchemaCount] = useState(0);

  const q = useMemo(() => {
    const p = new URLSearchParams();
    if (itemId) p.set('id', itemId);
    if (workspaceId) p.set('workspaceId', workspaceId);
    if (server) p.set('server', server);
    if (database) p.set('database', database);
    return p.toString();
  }, [itemId, workspaceId, server, database]);
  const qRef = useRef(q);
  useEffect(() => { qRef.current = q; }, [q]);

  const fetchColumns = useCallback(async (objectId: number): Promise<string[]> => {
    const cached = columnsCacheRef.current.get(objectId);
    if (cached) return cached;
    try {
      const res = await fetch(`/api/sqldb/columns?${qRef.current}&objectId=${objectId}`);
      const j = await res.json().catch(() => null);
      const cols: string[] = j?.ok ? (j.columns || []).map((c: any) => String(c.name)) : [];
      columnsCacheRef.current.set(objectId, cols);
      return cols;
    } catch {
      return [];
    }
  }, []);

  // Fetch the live object catalog (tables/views/procs/funcs) for IntelliSense.
  useEffect(() => {
    let cancelled = false;
    columnsCacheRef.current.clear();
    setSchemaNote(null);
    (async () => {
      try {
        const [tr, vr, pr, fr] = await Promise.all([
          fetch(`/api/sqldb/tables?${q}`).then((r) => r.json()).catch(() => null),
          fetch(`/api/sqldb/views?${q}`).then((r) => r.json()).catch(() => null),
          fetch(`/api/sqldb/procedures?${q}`).then((r) => r.json()).catch(() => null),
          fetch(`/api/sqldb/functions?${q}`).then((r) => r.json()).catch(() => null),
        ]);
        if (cancelled) return;
        const gate = [tr, vr, pr, fr].find((b) => b?.code === 'not_configured');
        const toEntries = (rows: any[]): TableEntry[] => (rows || []).map((o) => ({
          schema: String(o.schema), name: String(o.name),
          fullName: String(o.fullName || `${o.schema}.${o.name}`), objectId: Number(o.objectId),
        }));
        schemaRef.current = {
          tables: tr?.ok ? toEntries(tr.tables) : [],
          views: vr?.ok ? toEntries(vr.views) : [],
          procs: pr?.ok ? toEntries(pr.procedures) : [],
          funcs: fr?.ok ? toEntries(fr.functions) : [],
        };
        const count = schemaRef.current.tables.length + schemaRef.current.views.length
          + schemaRef.current.procs.length + schemaRef.current.funcs.length;
        setSchemaCount(count);
        if (gate?.missing) {
          setSchemaNote(`IntelliSense schema unavailable — set ${gate.missing} (or bind a connection). The editor, snippets, and Run still work.`);
        } else if (count === 0 && (tr?.error || vr?.error || pr?.error || fr?.error)) {
          setSchemaNote(`IntelliSense schema unavailable: ${tr?.error || vr?.error || pr?.error || fr?.error}`);
        }
      } catch (e: any) {
        if (!cancelled) setSchemaNote(`IntelliSense schema unavailable: ${e?.message || String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [q]);

  // Clean up the per-model accessor on unmount.
  useEffect(() => () => {
    if (modelUriRef.current) schemaByModel.delete(modelUriRef.current);
  }, []);

  const doRun = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    if (!editor || !model) { onRun(value); return; }
    const sel = editor.getSelection?.();
    const selText = sel ? String(model.getValueInRange(sel)) : '';
    onRun(chooseRunText(String(model.getValue()), selText));
  }, [onRun, value]);
  const doRunRef = useRef(doRun);
  useEffect(() => { doRunRef.current = doRun; }, [doRun]);

  const onReady = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    ensureSnippetProvider(monaco);
    ensureSchemaProvider(monaco);

    const model = editor.getModel?.();
    if (model) {
      const uri = model.uri.toString();
      modelUriRef.current = uri;
      schemaByModel.set(uri, {
        getTables: () => schemaRef.current.tables,
        getViews: () => schemaRef.current.views,
        getProcs: () => schemaRef.current.procs,
        getFuncs: () => schemaRef.current.funcs,
        fetchColumns,
      });
    }

    // Run selection (Fabric: Ctrl/Cmd+Enter runs the highlighted text only).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => doRunRef.current());
    // F1 command palette (built-in; wired explicitly so it works inside the cell).
    editor.addCommand(monaco.KeyCode.F1, () => editor.getAction('editor.action.quickCommand')?.run());

    // Let a consumer (SQL Copilot ghost-text + selection capture) attach to the
    // same editor after our own providers are wired.
    onReadyExternal?.(editor, monaco);
  }, [fetchColumns, onReadyExternal]);

  const insertTemplate = useCallback((group: CreatableGroup) => {
    onChange(CREATE_TEMPLATES[group]);
    setTimeout(() => editorRef.current?.focus?.(), 0);
  }, [onChange]);

  const newBlankQuery = useCallback(() => {
    onChange('-- New SQL query\nSELECT TOP 100 *\nFROM dbo.NewTable;');
    setTimeout(() => editorRef.current?.focus?.(), 0);
  }, [onChange]);

  const runAction = (id: string) => editorRef.current?.getAction?.(id)?.run();

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        {showNewQuery && (
          <Menu positioning="below-start">
            <MenuTrigger disableButtonEnhancement>
              {(triggerProps: MenuButtonProps) => (
                <SplitButton
                  menuButton={triggerProps}
                  primaryActionButton={{ onClick: newBlankQuery, disabled: readOnly }}
                  appearance="primary"
                  icon={<DocumentAdd20Regular />}
                >
                  New SQL query
                </SplitButton>
              )}
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Table20Regular />} onClick={() => insertTemplate('table')}>CREATE TABLE</MenuItem>
                <MenuItem icon={<DocumentText20Regular />} onClick={() => insertTemplate('procedure')}>CREATE PROCEDURE</MenuItem>
                <MenuItem icon={<ContentView20Regular />} onClick={() => insertTemplate('view')}>CREATE VIEW</MenuItem>
                <MenuItem icon={<BranchRequest20Regular />} onClick={() => insertTemplate('index')}>CREATE INDEX</MenuItem>
                <MenuItem icon={<MathFormula20Regular />} onClick={() => insertTemplate('function')}>CREATE FUNCTION</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        )}

        <Button appearance="primary" icon={<Play20Regular />} onClick={doRun} disabled={readOnly || busy}>
          {busy ? 'Running…' : 'Run'}
        </Button>

        <div className={s.spacer}>
          {schemaCount > 0 && (
            <Tooltip content={`${schemaCount} objects available for IntelliSense`} relationship="label">
              <Badge appearance="tint" color="brand" icon={<DatabaseSearch20Regular />}>{schemaCount} objects</Badge>
            </Tooltip>
          )}
          <Tooltip content="Find (Ctrl+F)" relationship="label">
            <Button size="small" appearance="subtle" icon={<Search20Regular />} aria-label="Find" onClick={() => runAction('actions.find')} />
          </Tooltip>
          <Tooltip content="Replace (Ctrl+H)" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSwap20Regular />} aria-label="Replace" onClick={() => runAction('editor.action.startFindReplaceAction')} />
          </Tooltip>
          <Tooltip content="Command palette (F1)" relationship="label">
            <Button size="small" appearance="subtle" icon={<Keyboard20Regular />} aria-label="Command palette" onClick={() => runAction('editor.action.quickCommand')} />
          </Tooltip>
        </div>
      </div>

      <MonacoTextarea
        value={value}
        onChange={onChange}
        language="tsql"
        height={height}
        readOnly={readOnly}
        ariaLabel="T-SQL editor"
        onReady={onReady}
      />

      {schemaNote && <Caption1 className={s.note}>{schemaNote}</Caption1>}
    </div>
  );
}

export default TsqlMonaco;
