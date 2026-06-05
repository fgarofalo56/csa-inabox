'use client';

/**
 * Dynamic-content / expression builder — the Loom one-for-one of the Azure
 * Data Factory / Synapse / Fabric portal's "Add dynamic content" experience
 * (ui-parity.md). Every pipeline input that accepts an expression renders an
 * <ExpressionField/>: a typed input with an "Add dynamic content" affordance
 * that opens a picker offering
 *   - System variables (@pipeline().*)
 *   - Pipeline parameters / variables (this pipeline's, by name)
 *   - Activity outputs (@activity('name').output)
 *   - The full categorized function reference (String / Collection / Logical /
 *     Conversion / Math / Date) — searchable, click-to-insert
 * over a Monaco editor with IntelliSense (Ctrl-Space) for every function +
 * system variable. So users SELECT + insert instead of hand-writing @{...}.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Button, Input, Textarea, Field, Caption1, Body1Strong,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  SearchBox, Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Flash20Regular, Code16Regular } from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  EXPRESSION_CATEGORIES, SYSTEM_VARIABLES, allFunctionNames,
  type ExprFunction,
} from './expression-functions';
import type { PipelineActivity, PipelineParameter, PipelineVariable } from './types';

const useStyles = makeStyles({
  fieldRow: { display: 'flex', flexDirection: 'column', gap: '2px' },
  addLink: { alignSelf: 'flex-start', marginTop: '2px' },
  exprPreview: {
    fontFamily: 'Consolas, monospace', fontSize: '11px',
    color: tokens.colorBrandForeground1,
    overflowWrap: 'anywhere',
  },
  dialogGrid: { display: 'flex', gap: '12px', minHeight: '380px' },
  palette: {
    width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '8px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`, paddingRight: '8px',
    overflow: 'auto', maxHeight: '440px',
  },
  editorCol: { flex: 1, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
  item: {
    display: 'flex', flexDirection: 'column', gap: '1px',
    padding: '5px 8px', borderRadius: '4px', cursor: 'pointer', textAlign: 'left',
    width: '100%', backgroundColor: 'transparent',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  itemName: { fontFamily: 'Consolas, monospace', fontSize: '12px', color: tokens.colorNeutralForeground1 },
  itemDesc: { color: tokens.colorNeutralForeground3, fontSize: '11px' },
});

export interface ExpressionFieldProps {
  label?: string;
  /** Field hint shown under the control. */
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Render a multiline Textarea instead of a single-line Input. */
  multiline?: boolean;
  required?: boolean;
  /** Pipeline params/vars/activities to offer in the picker. */
  parameters?: PipelineParameter[];
  variables?: PipelineVariable[];
  activities?: PipelineActivity[];
  /** Exclude the current activity from the activity-output list. */
  selfName?: string;
  disabled?: boolean;
}

function isExpression(v: string): boolean {
  return typeof v === 'string' && v.trimStart().startsWith('@');
}

export function ExpressionField({
  label, hint, value, onChange, placeholder, multiline, required,
  parameters = [], variables = [], activities = [], selfName, disabled,
}: ExpressionFieldProps) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const openBuilder = useCallback(() => { setDraft(value || ''); setSearch(''); setOpen(true); }, [value]);

  // Insert a token at the cursor (or append) in the Monaco draft.
  const insertToken = useCallback((token: string) => {
    const editor = editorRef.current;
    if (editor) {
      const sel = editor.getSelection();
      const id = { major: 1, minor: 1 };
      const op = { identifier: id, range: sel, text: token, forceMoveMarkers: true };
      editor.executeEdits('loom-insert', [op]);
      editor.focus();
      setDraft(editor.getValue());
    } else {
      setDraft((d) => d + token);
    }
  }, []);

  // Inserting any dynamic token implies an expression — ensure a leading '@'.
  const insertDynamic = useCallback((expr: string) => {
    const editor = editorRef.current;
    const cur = editor ? editor.getValue() : draft;
    if (!cur.trim()) { setDraft(`@${expr}`); if (editor) editor.setValue(`@${expr}`); return; }
    insertToken(expr);
  }, [draft, insertToken]);

  const onReady = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    // Register a completion provider once for plaintext expressions.
    if (!(monaco as any).__loomExprCompletions) {
      (monaco as any).__loomExprCompletions = true;
      monaco.languages.registerCompletionItemProvider('plaintext', {
        triggerCharacters: ['@', '.', '('],
        provideCompletionItems: () => {
          const suggestions = [
            ...EXPRESSION_CATEGORIES.flatMap((c) => c.functions.map((fn) => ({
              label: fn.name,
              kind: monaco.languages.CompletionItemKind.Function,
              detail: fn.signature,
              documentation: fn.description,
              insertText: fn.name,
            }))),
            ...SYSTEM_VARIABLES.map((v) => ({
              label: v.name,
              kind: monaco.languages.CompletionItemKind.Variable,
              detail: 'System variable',
              documentation: v.description,
              insertText: v.insert,
            })),
          ];
          return { suggestions };
        },
      });
    }
  }, []);

  const commit = useCallback(() => { onChange(draft); setOpen(false); }, [draft, onChange]);

  // Filtered palette sections.
  const q = search.trim().toLowerCase();
  const match = (s2: string) => !q || s2.toLowerCase().includes(q);
  const filteredFns = useMemo(
    () => EXPRESSION_CATEGORIES.map((c) => ({
      ...c, functions: c.functions.filter((fn) => match(fn.name) || match(fn.description)),
    })).filter((c) => c.functions.length > 0),
    [q],
  );
  const sysVars = SYSTEM_VARIABLES.filter((v) => match(v.name) || match(v.description));
  const paramItems = parameters.filter((p) => match(p.name));
  const varItems = variables.filter((v) => match(v.name));
  const actItems = activities.filter((a) => a.name !== selfName && match(a.name));

  return (
    <div className={s.fieldRow}>
      <Field label={label} required={required} hint={hint}>
        {multiline ? (
          <Textarea
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            rows={3}
            onChange={(_, d) => onChange(d.value)}
          />
        ) : (
          <Input
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(_, d) => onChange(d.value)}
          />
        )}
      </Field>
      <Button
        className={s.addLink}
        size="small"
        appearance="transparent"
        icon={<Flash20Regular />}
        onClick={openBuilder}
        disabled={disabled}
      >
        Add dynamic content
      </Button>
      {isExpression(value) && (
        <Caption1 className={s.exprPreview}><Code16Regular style={{ verticalAlign: 'middle' }} /> {value}</Caption1>
      )}

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface style={{ maxWidth: '860px', width: '92vw' }}>
          <DialogBody>
            <DialogTitle>Add dynamic content{label ? ` — ${label}` : ''}</DialogTitle>
            <DialogContent>
              <div className={s.dialogGrid}>
                <div className={s.palette}>
                  <SearchBox
                    placeholder="Search functions, variables…"
                    value={search}
                    onChange={(_, d) => setSearch(d.value || '')}
                    size="small"
                  />
                  <Accordion multiple collapsible defaultOpenItems={['sys', 'params']}>
                    {sysVars.length > 0 && (
                      <AccordionItem value="sys">
                        <AccordionHeader>System variables</AccordionHeader>
                        <AccordionPanel>
                          {sysVars.map((v) => (
                            <button key={v.name} type="button" className={s.item}
                              onClick={() => insertDynamic(v.insert)} title={v.description}>
                              <span className={s.itemName}>{v.name}</span>
                              <span className={s.itemDesc}>{v.description}</span>
                            </button>
                          ))}
                        </AccordionPanel>
                      </AccordionItem>
                    )}
                    {(paramItems.length > 0 || varItems.length > 0 || actItems.length > 0) && (
                      <AccordionItem value="params">
                        <AccordionHeader>This pipeline</AccordionHeader>
                        <AccordionPanel>
                          {paramItems.map((p) => (
                            <button key={`p-${p.name}`} type="button" className={s.item}
                              onClick={() => insertDynamic(`pipeline().parameters.${p.name}`)}>
                              <span className={s.itemName}>@pipeline().parameters.{p.name}</span>
                              <span className={s.itemDesc}>Parameter · {p.type}</span>
                            </button>
                          ))}
                          {varItems.map((v) => (
                            <button key={`v-${v.name}`} type="button" className={s.item}
                              onClick={() => insertDynamic(`variables('${v.name}')`)}>
                              <span className={s.itemName}>@variables('{v.name}')</span>
                              <span className={s.itemDesc}>Variable · {v.type}</span>
                            </button>
                          ))}
                          {actItems.map((a) => (
                            <button key={`a-${a.name}`} type="button" className={s.item}
                              onClick={() => insertDynamic(`activity('${a.name}').output`)}>
                              <span className={s.itemName}>@activity('{a.name}').output</span>
                              <span className={s.itemDesc}>Activity output · {a.type}</span>
                            </button>
                          ))}
                        </AccordionPanel>
                      </AccordionItem>
                    )}
                    {filteredFns.map((c) => (
                      <AccordionItem key={c.id} value={c.id}>
                        <AccordionHeader>{c.label}</AccordionHeader>
                        <AccordionPanel>
                          {c.functions.map((fn: ExprFunction) => (
                            <button key={fn.name + fn.signature} type="button" className={s.item}
                              onClick={() => insertDynamic(fn.insert)} title={fn.signature}>
                              <span className={s.itemName}>{fn.signature}</span>
                              <span className={s.itemDesc}>{fn.description}</span>
                            </button>
                          ))}
                        </AccordionPanel>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
                <div className={s.editorCol}>
                  <Body1Strong>Expression</Body1Strong>
                  <Caption1>
                    Pick items on the left to insert, or type and press <kbd>Ctrl</kbd>+<kbd>Space</kbd> for
                    IntelliSense. Prefix with <code>@</code> for an expression, or use <code>@{'{ … }'}</code> to
                    interpolate inside a string.
                  </Caption1>
                  <MonacoTextarea
                    value={draft}
                    onChange={setDraft}
                    language="plaintext"
                    height={220}
                    lineNumbers={false}
                    onReady={onReady}
                    ariaLabel="Expression editor"
                  />
                  <Caption1 className={s.exprPreview}>{draft || '(empty)'}</Caption1>
                </div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={commit}>OK</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
