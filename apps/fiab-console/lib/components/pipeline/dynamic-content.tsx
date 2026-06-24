'use client';

/**
 * Dynamic-content / expression builder — the Loom one-for-one of the Azure
 * Data Factory / Synapse / Fabric portal's "Add dynamic content" experience
 * (ui-parity.md). Every pipeline input that accepts an expression renders an
 * <ExpressionField/>: a typed input with an "Add dynamic content" affordance
 * that opens a flyout/drawer offering the SAME insertable sections the portal
 * lists, each click-to-insert with a signature tooltip:
 *
 *   - System variables    (@pipeline().* / @trigger().*)
 *   - Pipeline parameters  (@pipeline().parameters.X)
 *   - Variables            (@variables('X'))
 *   - Activity outputs      (@activity('name').output)
 *   - Iterator             (@item() / @iterationItem()) — shown only when the
 *                          field sits inside a ForEach (driven by the wrapper's
 *                          `hideIterationVars` flag)
 *   - Functions            the full categorized reference (String / Collection /
 *                          Logical / Conversion / Math / Date / Binary / URI /
 *                          Workflow) — grouped + searchable
 *
 * over a Monaco editor with IntelliSense (Ctrl-Space) for every function +
 * system variable. So users SELECT + insert instead of hand-writing @{...}.
 *
 * A live validity/preview line under the editor evaluates the draft against the
 * design-time + sample context on every keystroke (debounced) via
 * evaluate-expression — exactly like the portal's inline validation — and the
 * explicit Evaluate (F9) action additionally pre-fills run-time-only tokens
 * from the LAST real ADF run.
 *
 * Expressions are stored verbatim as ADF interpolated strings (`@…` / `@{…}`)
 * in the pipeline / dataset / linked-service JSON and round-trip on the real
 * PUT via adf-client / synapse-artifacts-client. This component only drives the
 * authoring UX — the strings it inserts are exactly what the portal would
 * write, so they execute identically on the real ADF / Synapse runtime.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Input, Textarea, Field, Caption1, Body1Strong, Tooltip, Divider,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  SearchBox, Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  Spinner, MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Flash20Regular, Code16Regular, Play20Regular,
  CheckmarkCircle16Filled, ErrorCircle16Filled, Warning16Filled,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  EXPRESSION_CATEGORIES, SYSTEM_VARIABLES,
  type ExprFunction, type SystemVariable,
} from './expression-functions';
import {
  detectSampleInputs, evaluateExpression,
  type EvalContext, type EvalResult,
} from './evaluate-expression';
import type { PipelineActivity, PipelineParameter, PipelineVariable } from './types';

const useStyles = makeStyles({
  fieldRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  addLink: { alignSelf: 'flex-start', marginTop: tokens.spacingVerticalXXS },
  exprPreview: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    overflowWrap: 'anywhere',
  },
  dialogGrid: { display: 'flex', gap: tokens.spacingHorizontalM, minHeight: '380px' },
  palette: {
    width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    borderRight: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    paddingRight: tokens.spacingHorizontalS,
    overflow: 'auto', maxHeight: '440px',
  },
  editorCol: {
    flex: 1, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalXS, minWidth: 0,
  },
  item: {
    display: 'flex', flexDirection: 'column', gap: '1px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall, cursor: 'pointer', textAlign: 'left',
    width: '100%', backgroundColor: 'transparent',
    border: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}` },
  },
  itemName: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
  },
  itemDesc: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase100 },
  tip: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    maxWidth: '320px',
  },
  tipSig: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
  },
  sampleSection: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
  },
  evalPanel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
  },
  evalResult: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    margin: 0, maxHeight: '160px', overflow: 'auto',
  },
  // Live validity / preview line under the editor.
  liveHint: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalXS,
    minHeight: '20px',
  },
  liveOk: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0, marginTop: '2px' },
  liveWarn: { color: tokens.colorPaletteYellowForeground1, flexShrink: 0, marginTop: '2px' },
  liveErr: { color: tokens.colorPaletteRedForeground1, flexShrink: 0, marginTop: '2px' },
  livePreview: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    flex: 1, minWidth: 0,
  },
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
  /** Pipeline item id — lets Evaluate pre-fill sample values from the last run. */
  pipelineId?: string;
  /** Workspace id — used by the Evaluate pre-fill API call. */
  workspaceId?: string;
  /**
   * Hide the ForEach iteration accessors (`@item()` / `@iterationItem()`) from
   * the picker. The reusable `<ExpressionField/>` wrapper sets this when a field
   * is NOT inside a ForEach activity, so those run-time-only tokens aren't
   * offered where they would never resolve. Defaults to false (shown).
   */
  hideIterationVars?: boolean;
}

function isExpression(v: string): boolean {
  return typeof v === 'string' && v.trimStart().startsWith('@');
}

/** One-line truncated preview for the live validity hint. */
function previewLine(v: string, max = 120): string {
  const flat = v.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function ExpressionField({
  label, hint, value, onChange, placeholder, multiline, required,
  parameters = [], variables = [], activities = [], selfName, disabled,
  pipelineId, workspaceId, hideIterationVars = false,
}: ExpressionFieldProps) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);
  const [sampleValues, setSampleValues] = useState<Record<string, string>>({});
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const openBuilder = useCallback(() => {
    setDraft(value || ''); setSearch(''); setEvalResult(null); setOpen(true);
  }, [value]);

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

  // Which run-time-only tokens in the draft need a manual sample value.
  const sampleInputs = useMemo(
    () => detectSampleInputs(draft, parameters.map((p) => p.name), variables.map((v) => v.name)),
    [draft, parameters, variables],
  );

  // Build the design-time + user-sample EvalContext (shared by the live hint and
  // the explicit Evaluate). Does NOT call any backend — pure resolver context.
  const buildLocalContext = useCallback((): EvalContext => {
    const paramCtx: Record<string, unknown> = {};
    for (const p of parameters) {
      paramCtx[p.name] = sampleValues[`param__${p.name}`] !== undefined
        ? sampleValues[`param__${p.name}`] : p.defaultValue;
    }
    const varCtx: Record<string, unknown> = {};
    for (const v of variables) {
      varCtx[v.name] = sampleValues[`var__${v.name}`] !== undefined
        ? sampleValues[`var__${v.name}`] : v.defaultValue;
    }
    // Unknown params/vars detected in the expression (not on the pipeline).
    for (const si of sampleInputs) {
      const raw = sampleValues[si.key];
      if (raw === undefined) continue;
      if (si.kind === 'parameter') paramCtx[si.name] = raw;
      if (si.kind === 'variable') varCtx[si.name] = raw;
    }
    const actCtx: Record<string, unknown> = {};
    for (const si of sampleInputs) {
      if (si.kind !== 'activityOutput') continue;
      const raw = sampleValues[si.key];
      if (raw === undefined || raw === '') continue;
      try { actCtx[si.name] = JSON.parse(raw); } catch { actCtx[si.name] = raw; }
    }
    const sysVarsCtx: EvalContext['systemVars'] = {};
    for (const f of ['RunId', 'Pipeline', 'DataFactory', 'TriggerTime', 'TriggerName', 'TriggerId', 'TriggerType', 'GroupId'] as const) {
      const raw = sampleValues[`sysvar__${f}`];
      if (raw) sysVarsCtx[f] = raw;
    }
    return { parameters: paramCtx, variables: varCtx, systemVars: sysVarsCtx, activityOutputs: actCtx };
  }, [parameters, variables, sampleInputs, sampleValues]);

  // ---- Live validity / preview (debounced, client-only) ----
  // Mirrors the portal's inline validation: as you type, we parse + evaluate the
  // draft against the design-time context. Unresolved run-time tokens are
  // reported as "needs sample value" (not an error). Never calls a backend.
  const [live, setLive] = useState<EvalResult | null>(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const trimmed = draft.trim();
      if (!trimmed || !trimmed.startsWith('@')) { setLive(null); return; }
      setLive(evaluateExpression(draft, buildLocalContext()));
    }, 250);
    return () => clearTimeout(t);
  }, [draft, open, buildLocalContext]);

  // Evaluate the draft expression (F9). Client-side resolver for params / vars /
  // functions / system vars; optionally pre-fills activity outputs + run
  // system vars from the LAST real ADF run via the /evaluate route.
  const handleEvaluate = useCallback(async () => {
    setEvalBusy(true);
    setEvalResult(null);

    const ctx = buildLocalContext();

    // Optional enhancement: pull the last real run's outputs to fill any blanks.
    if (pipelineId && workspaceId) {
      try {
        const r = await fetch(
          `/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/evaluate?workspaceId=${encodeURIComponent(workspaceId)}`,
          { method: 'POST' },
        );
        const j = await r.json().catch(() => ({}));
        if (j?.ok && j.suggestedSampleValues) {
          const { activityOutputs = {}, systemVars = {} } = j.suggestedSampleValues;
          for (const [name, output] of Object.entries(activityOutputs)) {
            if (ctx.activityOutputs[name] === undefined && !sampleValues[`activity__${name}__output`]) {
              ctx.activityOutputs[name] = output;
            }
          }
          for (const [k, v] of Object.entries(systemVars)) {
            if (!ctx.systemVars[k as keyof typeof ctx.systemVars]) (ctx.systemVars as any)[k] = v;
          }
        }
      } catch { /* network error — fall through to user-provided values only */ }
    }

    setEvalResult(evaluateExpression(draft, ctx));
    setEvalBusy(false);
  }, [draft, buildLocalContext, sampleValues, pipelineId, workspaceId]);


  // Filtered palette sections.
  const q = search.trim().toLowerCase();
  const match = (s2: string) => !q || s2.toLowerCase().includes(q);
  const filteredFns = useMemo(
    () => EXPRESSION_CATEGORIES.map((c) => ({
      ...c, functions: c.functions.filter((fn) => match(fn.name) || match(fn.description)),
    })).filter((c) => c.functions.length > 0),
    [q],
  );
  // System variables minus the ForEach iteration ones (those get their own
  // Iterator section, gated on `hideIterationVars`).
  const sysVars = SYSTEM_VARIABLES.filter(
    (v) => v.scope !== 'iteration' && (match(v.name) || match(v.description)),
  );
  // Iterator tokens — only offered when the field is inside a ForEach.
  const iterVars: SystemVariable[] = hideIterationVars
    ? []
    : SYSTEM_VARIABLES.filter((v) => v.scope === 'iteration' && (match(v.name) || match(v.description)));
  const paramItems = parameters.filter((p) => match(p.name));
  const varItems = variables.filter((v) => match(v.name));
  const actItems = activities.filter((a) => a.name !== selfName && match(a.name));

  // One palette row — a click-to-insert button wrapped in a signature tooltip,
  // matching the portal's hover help on each function / token.
  const renderItem = (
    key: string, name: string, desc: string, onInsert: () => void,
    tip: { signature: string; description: string },
  ) => (
    <Tooltip
      key={key}
      relationship="description"
      withArrow
      positioning="after"
      content={
        <div className={s.tip}>
          <span className={s.tipSig}>{tip.signature}</span>
          <Caption1>{tip.description}</Caption1>
        </div>
      }
    >
      <button type="button" className={s.item} onClick={onInsert}>
        <span className={s.itemName}>{name}</span>
        <span className={s.itemDesc}>{desc}</span>
      </button>
    </Tooltip>
  );

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
                  <Accordion multiple collapsible defaultOpenItems={['sys', 'params', 'vars']}>
                    {sysVars.length > 0 && (
                      <AccordionItem value="sys">
                        <AccordionHeader>System variables</AccordionHeader>
                        <AccordionPanel>
                          {sysVars.map((v) => renderItem(
                            `sv-${v.name}`, v.name, v.description,
                            () => insertDynamic(v.insert),
                            { signature: v.name, description: v.description },
                          ))}
                        </AccordionPanel>
                      </AccordionItem>
                    )}
                    {paramItems.length > 0 && (
                      <AccordionItem value="params">
                        <AccordionHeader>Pipeline parameters</AccordionHeader>
                        <AccordionPanel>
                          {paramItems.map((p) => renderItem(
                            `p-${p.name}`,
                            `@pipeline().parameters.${p.name}`,
                            `Parameter · ${p.type}`,
                            () => insertDynamic(`pipeline().parameters.${p.name}`),
                            {
                              signature: `@pipeline().parameters.${p.name}`,
                              description: `Pipeline parameter '${p.name}' (${p.type}).`,
                            },
                          ))}
                        </AccordionPanel>
                      </AccordionItem>
                    )}
                    {varItems.length > 0 && (
                      <AccordionItem value="vars">
                        <AccordionHeader>Variables</AccordionHeader>
                        <AccordionPanel>
                          {varItems.map((v) => renderItem(
                            `v-${v.name}`,
                            `@variables('${v.name}')`,
                            `Variable · ${v.type}`,
                            () => insertDynamic(`variables('${v.name}')`),
                            {
                              signature: `@variables('${v.name}')`,
                              description: `Pipeline variable '${v.name}' (${v.type}).`,
                            },
                          ))}
                        </AccordionPanel>
                      </AccordionItem>
                    )}
                    {actItems.length > 0 && (
                      <AccordionItem value="activities">
                        <AccordionHeader>Activity outputs</AccordionHeader>
                        <AccordionPanel>
                          {actItems.map((a) => renderItem(
                            `a-${a.name}`,
                            `@activity('${a.name}').output`,
                            `Activity output · ${a.type ?? 'activity'}`,
                            () => insertDynamic(`activity('${a.name}').output`),
                            {
                              signature: `@activity('${a.name}').output`,
                              description: `Output of the '${a.name}' activity. Drill into fields, e.g. @activity('${a.name}').output.firstRow.`,
                            },
                          ))}
                        </AccordionPanel>
                      </AccordionItem>
                    )}
                    {iterVars.length > 0 && (
                      <AccordionItem value="iterator">
                        <AccordionHeader>Iterator (ForEach)</AccordionHeader>
                        <AccordionPanel>
                          {iterVars.map((v) => renderItem(
                            `it-${v.name}`, v.name, v.description,
                            () => insertDynamic(v.insert),
                            { signature: v.name, description: v.description },
                          ))}
                        </AccordionPanel>
                      </AccordionItem>
                    )}
                    {filteredFns.map((c) => (
                      <AccordionItem key={c.id} value={c.id}>
                        <AccordionHeader>{c.label}</AccordionHeader>
                        <AccordionPanel>
                          {c.functions.map((fn: ExprFunction) => renderItem(
                            fn.name + fn.signature, fn.signature, fn.description,
                            () => insertDynamic(fn.insert),
                            { signature: fn.signature, description: fn.description },
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

                  {/* Live validity / preview — updates as you type (no backend). */}
                  <div className={s.liveHint} aria-live="polite">
                    {live === null ? (
                      <Caption1 className={s.exprPreview}>{draft || '(empty)'}</Caption1>
                    ) : live.error ? (
                      <>
                        <ErrorCircle16Filled className={s.liveErr} />
                        <Caption1 className={s.livePreview} title={live.error}>
                          Invalid expression: {live.error}
                        </Caption1>
                      </>
                    ) : live.unresolvedTokens.length > 0 ? (
                      <>
                        <Warning16Filled className={s.liveWarn} />
                        <Caption1 className={s.livePreview} title={`Needs sample values: ${live.unresolvedTokens.join(', ')}`}>
                          Valid · needs sample values for {live.unresolvedTokens.join(', ')}
                        </Caption1>
                      </>
                    ) : (
                      <>
                        <CheckmarkCircle16Filled className={s.liveOk} />
                        <Caption1 className={s.livePreview} title={live.valueStr}>
                          Preview: {previewLine(live.valueStr) || '(empty string)'}
                        </Caption1>
                      </>
                    )}
                  </div>

                  {sampleInputs.length > 0 && (
                    <div className={s.sampleSection}>
                      <Caption1><strong>Sample values</strong> — provide values for run-time-only tokens (Fabric F9 parity).</Caption1>
                      {sampleInputs.map((si) => (
                        <Field key={si.key} label={si.label} size="small">
                          <Input
                            size="small"
                            value={sampleValues[si.key] ?? ''}
                            placeholder={si.kind === 'activityOutput' ? '{"rowsCopied": 42}' : '(sample value)'}
                            onChange={(_, d) => setSampleValues((prev) => ({ ...prev, [si.key]: d.value }))}
                          />
                        </Field>
                      ))}
                    </div>
                  )}

                  {evalResult && (
                    <>
                      <Divider />
                      <div className={s.evalPanel}>
                        {evalResult.error ? (
                          <MessageBar intent="error">
                            <MessageBarBody>Could not evaluate: {evalResult.error}</MessageBarBody>
                          </MessageBar>
                        ) : (
                          <>
                            <Caption1><strong>Result</strong> (last-run sample pre-fill applied where available)</Caption1>
                            <pre className={s.evalResult}>{evalResult.valueStr}</pre>
                            {evalResult.unresolvedTokens.length > 0 && (
                              <MessageBar intent="warning">
                                <MessageBarBody>
                                  No value supplied for: {evalResult.unresolvedTokens.join(', ')}. Enter sample values above and Evaluate again.
                                </MessageBarBody>
                              </MessageBar>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                appearance="secondary"
                icon={evalBusy ? <Spinner size="tiny" /> : <Play20Regular />}
                disabled={evalBusy || !draft.trim()}
                onClick={handleEvaluate}
              >
                Evaluate
              </Button>
              <Button appearance="primary" onClick={commit}>OK</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
