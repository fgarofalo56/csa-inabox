'use client';

/**
 * IndexerOpsPanel (AIF-10) — the AI Search indexer operations surface, parity
 * with the portal's per-indexer Execution history + Field mappings + reset
 * actions. Mounted inside the AI Search index editor's Indexers tab for a
 * selected indexer.
 *
 * Everything is a real AI Search data-plane call routed through the same POST
 * action endpoint the schedule/run/reset controls use:
 *   - Execution history → POST { action:'status' }  → GET /indexers/{n}/status
 *   - Field mappings     → POST { action:'get' }      → GET /indexers/{n}
 *                          POST { action:'setFieldMappings', ... } → PUT /indexers/{n}
 *   - Reset docs         → POST { action:'resetDocs', documentKeys?, overwrite }
 *   - Reset skills       → POST { action:'resetSkills', skillNames? }
 *
 * No mocks. When the service isn't configured the parent route 503s and the
 * editor renders its honest infra-gate; this panel surfaces per-call errors in
 * a MessageBar.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Button, Caption1, Badge, Spinner, Input, Dropdown, Option, Checkbox, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Subtitle2, MessageBar, MessageBarBody, MessageBarTitle,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync16Regular, Add16Regular, Dismiss16Regular, Play16Regular,
  ArrowCounterclockwise16Regular, ArrowClockwise16Regular,
  History20Regular, ArrowRouting20Regular,
} from '@fluentui/react-icons';
import {
  type FieldMappingRow, type IndexerRun,
  MAPPING_FUNCTIONS, MAPPING_FUNCTION_LABELS, emptyFieldMappingRow,
  functionHasParameters, parseIndexerMappings, parseExecutionHistory, runDuration,
  RESYNC_OPTIONS, RESYNC_OPTION_LABELS,
} from '@/lib/azure/search-indexer-shapes';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    background: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  spacer: { flex: 1 },
  tableWrap: { overflowX: 'auto', width: '100%' },
  mapRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  mapCell: { minWidth: '160px', flex: 1 },
  paramCell: { minWidth: '120px' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  detail: {
    marginTop: tokens.spacingVerticalXS, padding: tokens.spacingHorizontalS,
    background: tokens.colorNeutralBackground2, borderRadius: tokens.borderRadiusSmall,
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
});

function runColor(status: string): 'success' | 'warning' | 'danger' | 'informative' {
  if (status === 'success') return 'success';
  if (status === 'inProgress') return 'informative';
  if (status === 'transientFailure') return 'warning';
  if (status === 'reset') return 'informative';
  return status === 'error' ? 'danger' : 'informative';
}

async function readJson(res: Response): Promise<any> {
  const t = await res.text();
  try { return t ? JSON.parse(t) : {}; } catch { return { ok: false, error: t || `HTTP ${res.status}` }; }
}

export interface IndexerOpsPanelProps {
  /** The POST-action route that owns this indexer (service or item scoped). */
  route: string;
  /** Indexer name. */
  indexer: string;
  /** The indexer's skillset name (enables reset-skills), if any. */
  skillsetName?: string;
}

/** Indexer execution history + field mappings + reset ops for one indexer. */
export function IndexerOpsPanel({ route, indexer, skillsetName }: IndexerOpsPanelProps) {
  const s = useStyles();

  // Execution history
  const [history, setHistory] = useState<IndexerRun[] | null>(null);
  const [overall, setOverall] = useState<string | undefined>(undefined);
  const [histLoading, setHistLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  // Field mappings
  const [fieldMappings, setFieldMappings] = useState<FieldMappingRow[]>([]);
  const [outputFieldMappings, setOutputFieldMappings] = useState<FieldMappingRow[]>([]);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [mapsDirty, setMapsDirty] = useState(false);
  const [savingMaps, setSavingMaps] = useState(false);

  // Reset controls
  const [docKeys, setDocKeys] = useState('');
  const [skillNames, setSkillNames] = useState('');
  const [resyncOpts, setResyncOpts] = useState<string[]>([...RESYNC_OPTIONS]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    setHistLoading(true);
    const r = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status', indexer }) });
    const j = await readJson(r);
    if (j?.ok) {
      const parsed = parseExecutionHistory(j.status);
      setHistory(parsed.executionHistory);
      setOverall(parsed.overallStatus);
    } else {
      setHistory([]);
      setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` });
    }
    setHistLoading(false);
  }, [route, indexer]);

  const loadMappings = useCallback(async () => {
    const r = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'get', indexer }) });
    const j = await readJson(r);
    if (j?.ok && j.definition) {
      const parsed = parseIndexerMappings(j.definition);
      setFieldMappings(parsed.fieldMappings);
      setOutputFieldMappings(parsed.outputFieldMappings);
      setMapsDirty(false);
    }
    setMapsLoaded(true);
  }, [route, indexer]);

  useEffect(() => { loadStatus(); loadMappings(); }, [loadStatus, loadMappings]);

  // ---- Field-mapping row helpers ----
  const patchRow = (kind: 'field' | 'output', i: number, patch: Partial<FieldMappingRow>) => {
    const setter = kind === 'field' ? setFieldMappings : setOutputFieldMappings;
    setter((rows) => rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
    setMapsDirty(true);
  };
  const addRow = (kind: 'field' | 'output') => {
    const setter = kind === 'field' ? setFieldMappings : setOutputFieldMappings;
    setter((rows) => [...rows, emptyFieldMappingRow()]);
    setMapsDirty(true);
  };
  const removeRow = (kind: 'field' | 'output', i: number) => {
    const setter = kind === 'field' ? setFieldMappings : setOutputFieldMappings;
    setter((rows) => rows.filter((_, n) => n !== i));
    setMapsDirty(true);
  };

  const saveMappings = async () => {
    setSavingMaps(true); setMsg(null);
    const r = await fetch(route, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'setFieldMappings', indexer, fieldMappings, outputFieldMappings }),
    });
    const j = await readJson(r);
    setSavingMaps(false);
    if (!j?.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
    setMsg({ intent: 'success', text: 'Field mappings saved (PUT /indexers).' });
    setMapsDirty(false);
    loadMappings();
  };

  const doReset = async (action: 'resetDocs' | 'resetSkills') => {
    setBusy(true); setMsg(null);
    const payload: any = { action, indexer };
    if (action === 'resetDocs') {
      const keys = docKeys.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
      if (keys.length) { payload.documentKeys = keys; payload.overwrite = true; }
    } else {
      const names = skillNames.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
      if (names.length) payload.skillNames = names;
    }
    const r = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await readJson(r);
    setBusy(false);
    if (!j?.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
    setMsg({
      intent: 'success',
      text: action === 'resetDocs'
        ? (payload.documentKeys ? `Reset ${payload.documentKeys.length} document(s) — re-indexed next run.` : 'Reset-docs list cleared.')
        : (payload.skillNames ? `Reset ${payload.skillNames.length} skill(s) cache — re-runs next run.` : 'All skills cache reset — re-runs next run.'),
    });
  };

  const doResync = async () => {
    setBusy(true); setMsg(null);
    const options = resyncOpts.length ? resyncOpts : [...RESYNC_OPTIONS];
    const r = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resync', indexer, options }) });
    const j = await readJson(r);
    setBusy(false);
    if (!j?.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
    setMsg({ intent: 'success', text: `Resync mode set for [${options.join(', ')}]. Run the indexer to apply it.` });
  };

  const doRun = async () => {
    setBusy(true); setMsg(null);
    const r = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run', indexer }) });
    const j = await readJson(r);
    setBusy(false);
    if (!j?.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
    setMsg({ intent: 'success', text: 'Indexer run started (POST /indexers/run). Refresh execution history for the result.' });
    loadStatus();
  };

  const mappingTable = (kind: 'field' | 'output', rows: FieldMappingRow[], help: string) => (
    <div className={s.card}>
      <div className={s.head}>
        <Subtitle2>{kind === 'field' ? 'Field mappings' : 'Output field mappings'} ({rows.length})</Subtitle2>
        <div className={s.spacer} />
        <Button size="small" icon={<Add16Regular />} onClick={() => addRow(kind)}>Add mapping</Button>
      </div>
      <Caption1>{help}</Caption1>
      {rows.length === 0 ? <Caption1>None — {kind === 'field' ? 'source fields map to same-named index fields' : 'no enrichment outputs are mapped'}.</Caption1> : rows.map((row, i) => (
        <div key={i} className={s.mapRow}>
          <Field label="Source" className={s.mapCell}>
            <Input size="small" value={row.sourceFieldName} placeholder={kind === 'field' ? 'source column' : '/document/…/output'}
              aria-label={`${kind}-${i}-source`} onChange={(_, d) => patchRow(kind, i, { sourceFieldName: d.value })} />
          </Field>
          <Field label="Target index field" className={s.mapCell}>
            <Input size="small" value={row.targetFieldName} placeholder="index field"
              aria-label={`${kind}-${i}-target`} onChange={(_, d) => patchRow(kind, i, { targetFieldName: d.value })} />
          </Field>
          <Field label="Mapping function" className={s.mapCell}>
            <Dropdown size="small" value={MAPPING_FUNCTION_LABELS[row.functionName]} selectedOptions={[row.functionName]}
              aria-label={`${kind}-${i}-fn`}
              onOptionSelect={(_, d) => patchRow(kind, i, { functionName: (d.optionValue as FieldMappingRow['functionName']) ?? '' })}>
              {MAPPING_FUNCTIONS.map((fn) => (<Option key={fn || 'none'} value={fn} text={MAPPING_FUNCTION_LABELS[fn]}>{MAPPING_FUNCTION_LABELS[fn]}</Option>))}
            </Dropdown>
          </Field>
          {row.functionName === 'extractTokenAtPosition' && (
            <>
              <Field label="Delimiter" className={s.paramCell}>
                <Input size="small" value={row.delimiter ?? ' '} aria-label={`${kind}-${i}-delimiter`}
                  onChange={(_, d) => patchRow(kind, i, { delimiter: d.value })} />
              </Field>
              <Field label="Position" className={s.paramCell}>
                <Input size="small" type="number" value={String(row.position ?? 0)} aria-label={`${kind}-${i}-position`}
                  onChange={(_, d) => patchRow(kind, i, { position: Number(d.value) || 0 })} />
              </Field>
            </>
          )}
          {(row.functionName === 'base64Encode' || row.functionName === 'base64Decode') && (
            <Field label="UTF-8 encoding" className={s.paramCell}>
              <Checkbox checked={!!row.useHttpServerUtf8Encoding} label="HTTP-safe"
                aria-label={`${kind}-${i}-utf8`} onChange={(_, d) => patchRow(kind, i, { useHttpServerUtf8Encoding: !!d.checked })} />
            </Field>
          )}
          {functionHasParameters(row.functionName) ? null : <div className={s.paramCell} />}
          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`${kind}-${i}-remove`} onClick={() => removeRow(kind, i)} />
        </div>
      ))}
    </div>
  );

  return (
    <div className={s.root}>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

      <Accordion multiple collapsible defaultOpenItems={['history']}>
        {/* Execution history */}
        <AccordionItem value="history">
          <AccordionHeader icon={<History20Regular />}>
            Execution history — {indexer}{overall ? <Badge size="small" appearance="tint" color={runColor(overall)} style={{ marginLeft: tokens.spacingHorizontalS }}>{overall}</Badge> : null}
          </AccordionHeader>
          <AccordionPanel>
            <div className={s.card}>
              <div className={s.head}>
                <Caption1>Per-run start/end, items processed / failed, and expandable warnings + errors from <code>GET /indexers/{indexer}/status</code>.</Caption1>
                <div className={s.spacer} />
                <Button size="small" icon={<ArrowSync16Regular />} disabled={histLoading} onClick={loadStatus}>Refresh</Button>
              </div>
              {histLoading ? <Spinner size="tiny" label="Loading execution history…" /> : !history || history.length === 0 ? (
                <Caption1>No runs recorded yet. Trigger a run to populate history.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Indexer execution history">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Start (UTC)</TableHeaderCell>
                        <TableHeaderCell>Duration</TableHeaderCell>
                        <TableHeaderCell>Processed</TableHeaderCell>
                        <TableHeaderCell>Failed</TableHeaderCell>
                        <TableHeaderCell>Warn/Err</TableHeaderCell>
                        <TableHeaderCell></TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map((run, i) => {
                        const hasDetail = run.errors.length > 0 || run.warnings.length > 0 || !!run.errorMessage;
                        return (
                          <Fragment key={i}>
                            <TableRow>
                              <TableCell><Badge size="small" appearance="filled" color={runColor(run.status)}>{run.status}</Badge></TableCell>
                              <TableCell>{run.startTime ? new Date(run.startTime).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'}</TableCell>
                              <TableCell>{runDuration(run)}</TableCell>
                              <TableCell>{run.itemsProcessed.toLocaleString()}</TableCell>
                              <TableCell>{run.itemsFailed > 0 ? <span style={{ color: tokens.colorPaletteRedForeground1 }}>{run.itemsFailed.toLocaleString()}</span> : '0'}</TableCell>
                              <TableCell>{run.warnings.length}/{run.errors.length}</TableCell>
                              <TableCell>
                                {hasDetail && (
                                  <Button size="small" appearance="subtle" onClick={() => setExpanded((cur) => (cur === i ? null : i))}>
                                    {expanded === i ? 'Hide' : 'Details'}
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                            {expanded === i && hasDetail && (
                              <TableRow>
                                <TableCell colSpan={7}>
                                  <div className={s.detail}>
                                    {run.errorMessage ? `error: ${run.errorMessage}\n` : ''}
                                    {run.errors.map((e) => `✖ ${e.name || e.key || 'error'}: ${e.errorMessage}${e.details ? ` (${e.details})` : ''}`).join('\n')}
                                    {run.errors.length && run.warnings.length ? '\n' : ''}
                                    {run.warnings.map((w) => `⚠ ${w.name || w.key || 'warning'}: ${w.message}`).join('\n')}
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </AccordionPanel>
        </AccordionItem>

        {/* Field mappings */}
        <AccordionItem value="mappings">
          <AccordionHeader icon={<ArrowRouting20Regular />}>Field mappings — {indexer}</AccordionHeader>
          <AccordionPanel>
            {!mapsLoaded ? <Spinner size="tiny" label="Loading mappings…" /> : (
              <>
                {mappingTable('field', fieldMappings, 'Map a source data-source field to a differently-named index field, optionally through a mapping function (base64, extractTokenAtPosition, urlEncode, …). Saved into PUT /indexers/{name}.fieldMappings.')}
                {mappingTable('output', outputFieldMappings, 'Map a skillset enrichment output (a /document/… node path) to an index field. Saved into outputFieldMappings.')}
                <div className={s.actions}>
                  <Button appearance="primary" disabled={savingMaps || !mapsDirty} onClick={saveMappings}>{savingMaps ? 'Saving…' : 'Save mappings'}</Button>
                  <Button disabled={!mapsDirty} onClick={loadMappings}>Revert</Button>
                  {mapsDirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved changes</Caption1>}
                </div>
              </>
            )}
          </AccordionPanel>
        </AccordionItem>

        {/* Reset operations */}
        <AccordionItem value="reset">
          <AccordionHeader icon={<ArrowCounterclockwise16Regular />}>Reset operations — {indexer}</AccordionHeader>
          <AccordionPanel>
            <div className={s.card}>
              <Subtitle2>Reset documents</Subtitle2>
              <Caption1>Force specific documents to be re-indexed on the next run (leave keys blank to clear the pending reset-docs list). <code>POST /indexers/{indexer}/resetdocs</code>.</Caption1>
              <Field label="Document keys (comma / space separated, optional)">
                <Input value={docKeys} placeholder="doc-1, doc-2" onChange={(_, d) => setDocKeys(d.value)} aria-label="reset-doc-keys" />
              </Field>
              <div className={s.actions}>
                <Button appearance="primary" disabled={busy} icon={<ArrowCounterclockwise16Regular />} onClick={() => doReset('resetDocs')}>Reset docs</Button>
              </div>
            </div>
            <div className={s.card}>
              <Subtitle2>Reset skills{skillsetName ? '' : ' (no skillset attached)'}</Subtitle2>
              <Caption1>Clear cached skill output so the named skills re-run on the next run (blank = all skills). Preview API. <code>POST /indexers/{indexer}/resetskills</code>.</Caption1>
              <Field label="Skill names (comma / space separated, optional)">
                <Input value={skillNames} placeholder="#1, #Microsoft.Skills.Text.SplitSkill" disabled={!skillsetName}
                  onChange={(_, d) => setSkillNames(d.value)} aria-label="reset-skill-names" />
              </Field>
              <div className={s.actions}>
                <Button appearance="primary" disabled={busy || !skillsetName} icon={<ArrowCounterclockwise16Regular />} onClick={() => doReset('resetSkills')}>Reset skills</Button>
              </div>
            </div>
            <div className={s.card}>
              <Subtitle2>Resync (preview)</Subtitle2>
              <Caption1>Place the indexer in resync mode for an efficient partial reindex — used when a change (e.g. an ADLS Gen2 ACL edit) doesn&apos;t bump the source last-modified time, so ordinary change-tracking misses it. Cheaper than a full reset and needs no document keys. <code>POST /indexers/{indexer}/resync</code>, then run.</Caption1>
              <div className={s.actions}>
                {RESYNC_OPTIONS.map((opt) => (
                  <Checkbox key={opt} checked={resyncOpts.includes(opt)} label={RESYNC_OPTION_LABELS[opt] ?? opt} aria-label={`resync-option-${opt}`}
                    onChange={(_, d) => setResyncOpts((cur) => (d.checked ? Array.from(new Set([...cur, opt])) : cur.filter((o) => o !== opt)))} />
                ))}
              </div>
              <div className={s.actions}>
                <Button appearance="primary" disabled={busy || resyncOpts.length === 0} icon={<ArrowClockwise16Regular />} onClick={doResync}>Resync</Button>
                <Button disabled={busy} icon={<Play16Regular />} onClick={doRun}>Run indexer now</Button>
                <Caption1>After a resync (or reset), run the indexer to apply it.</Caption1>
              </div>
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
