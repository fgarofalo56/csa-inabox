'use client';

/**
 * Data-Agent Config Copilot panel.
 *
 * Per attached source: a "Generate" button that calls
 *   POST /api/items/data-agent/[id]/copilot { action:'generate', sourceId }
 * which fetches the source's REAL schema and asks the live AOAI deployment for
 * example NL→query pairs + per-field descriptions grounded ONLY on that schema.
 * The author reviews/edits the preview, then "Apply to this source" writes it to
 * the real config doc (and updates local editor state so the Build tab reflects
 * it immediately). Honest gates (unreachable backend / no model deployed) render
 * a Fluent MessageBar with the exact remediation — never a dead control.
 */

import { useCallback, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Input, Spinner,
  Field, MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens,
} from '@fluentui/react-components';
import { Sparkle20Regular, Add20Regular, Database20Regular, Dismiss16Regular } from '@fluentui/react-icons';
import { safeModelJson } from './model-fetch';
import { EmptyState } from '../components/empty-state';
import type { DaSource, DaSourceType } from './_family-utils';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  intro: { display: 'block', color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS },
  headIcon: { verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    maxWidth: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cardHead: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, minWidth: 0 },
  spacer: { flex: 1 },
  preview: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  pairList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  pairRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
  addBtn: { alignSelf: 'flex-start' },
  summary: { cursor: 'pointer', fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground2 },
  summarySmall: { cursor: 'pointer', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  descBlock: { marginTop: tokens.spacingVerticalXS, maxHeight: '300px', overflowY: 'auto', minWidth: 0, maxWidth: '100%' },
  descTable: { marginBottom: tokens.spacingVerticalXS, minWidth: 0 },
  descCol: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  schema: {
    fontSize: tokens.fontSizeBase100,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    color: tokens.colorNeutralForeground3,
    marginTop: tokens.spacingVerticalXS,
    maxHeight: '320px',
    overflowY: 'auto',
    maxWidth: '100%',
  },
  hintRow: { marginTop: tokens.spacingVerticalXS, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  idleText: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground3 },
});

interface Suggestion {
  examples: { question: string; query: string }[];
  descriptions: Record<string, Record<string, string>>;
  schemaUsed: string;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'gate'; message: string }
  | { kind: 'error'; message: string; hint?: string }
  | { kind: 'preview'; suggestion: Suggestion };

const TYPE_LABEL: Partial<Record<DaSourceType, string>> = {
  warehouse: 'Warehouse', lakehouse: 'Lakehouse', kql: 'KQL', 'ai-search': 'AI Search',
  'semantic-model': 'Semantic model', ontology: 'Ontology', graph: 'Graph model',
};

const SUPPORTED: DaSourceType[] = ['warehouse', 'lakehouse', 'kql', 'ai-search'];

export interface DataAgentConfigCopilotPanelProps {
  id: string;
  sources: DaSource[];
  /** Persist any pending Build-tab edits so the server reads the current sources. */
  ensureSaved: () => Promise<void>;
  /** Apply the approved suggestion to local editor state, then persist. */
  onApply: (sourceId: string, suggestion: Suggestion) => Promise<void> | void;
}

export function DataAgentConfigCopilotPanel({ id, sources, ensureSaved, onApply }: DataAgentConfigCopilotPanelProps) {
  const styles = useStyles();
  // Per-source UI stage keyed by source id.
  const [stages, setStages] = useState<Record<string, Stage>>({});
  // Editable copy of the previewed examples per source.
  const [edited, setEdited] = useState<Record<string, { question: string; query: string }[]>>({});
  const [applying, setApplying] = useState<string | null>(null);

  const setStage = (sid: string, st: Stage) => setStages((p) => ({ ...p, [sid]: st }));

  const generate = useCallback(async (src: DaSource) => {
    setStage(src.id, { kind: 'loading' });
    try {
      // Persist any pending Build edits first — the BFF reads sources from Cosmos.
      await ensureSaved();
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/copilot`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'generate', sourceId: src.id }),
      });
      const res = await safeModelJson<{ ok?: boolean; suggestion?: Suggestion; gate?: string; error?: string; hint?: string }>(r);
      const j = res.data;
      if (res.status === 503) { setStage(src.id, { kind: 'error', message: j?.error || 'No AOAI model deployed.', hint: j?.hint }); return; }
      if (!res.ok || !j) { setStage(src.id, { kind: 'error', message: res.error || j?.error || `HTTP ${res.status}` }); return; }
      if (j.gate) { setStage(src.id, { kind: 'gate', message: j.gate }); return; }
      if (j.suggestion) {
        setEdited((p) => ({ ...p, [src.id]: j.suggestion!.examples.map((e) => ({ ...e })) }));
        setStage(src.id, { kind: 'preview', suggestion: j.suggestion });
      } else {
        setStage(src.id, { kind: 'gate', message: 'The copilot returned nothing usable for this source.' });
      }
    } catch (e: any) {
      setStage(src.id, { kind: 'error', message: e?.message || String(e) });
    }
  }, [id, ensureSaved]);

  const apply = useCallback(async (src: DaSource, suggestion: Suggestion) => {
    setApplying(src.id);
    const approvedExamples = (edited[src.id] || suggestion.examples).filter((e) => e.question.trim() && e.query.trim());
    const approved: Suggestion = { ...suggestion, examples: approvedExamples };
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/copilot`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply', sourceId: src.id, approved }),
      });
      const res = await safeModelJson<{ ok?: boolean; error?: string }>(r);
      if (!res.ok || res.data?.ok === false) { setStage(src.id, { kind: 'error', message: res.error || res.data?.error || `HTTP ${res.status}` }); return; }
      await onApply(src.id, approved);
      setStage(src.id, { kind: 'idle' });
    } catch (e: any) {
      setStage(src.id, { kind: 'error', message: e?.message || String(e) });
    } finally {
      setApplying(null);
    }
  }, [id, edited, onApply]);

  const updateExample = (sid: string, i: number, patch: Partial<{ question: string; query: string }>) =>
    setEdited((p) => ({ ...p, [sid]: (p[sid] || []).map((e, j) => (j === i ? { ...e, ...patch } : e)) }));
  const addExample = (sid: string) =>
    setEdited((p) => ({ ...p, [sid]: [...(p[sid] || []), { question: '', query: '' }] }));
  const removeExample = (sid: string, i: number) =>
    setEdited((p) => ({ ...p, [sid]: (p[sid] || []).filter((_, j) => j !== i) }));

  if (!sources.length) {
    return (
      <EmptyState
        icon={<Sparkle20Regular />}
        title="No sources to ground on yet"
        body="Add at least one source in the Build tab before using Config Copilot. The copilot reads each source's real schema to generate example question → query pairs and per-field descriptions."
      />
    );
  }

  return (
    <div className={styles.root}>
      <div>
        <Subtitle2><Sparkle20Regular className={styles.headIcon} />Config Copilot</Subtitle2>
        <Caption1 className={styles.intro}>
          Generates example question → query pairs and per-field descriptions from each source&apos;s REAL schema, grounded on
          the live Azure-native backend. Review, then apply — generated examples run against the bound source on the next test-chat turn.
        </Caption1>
      </div>

      {sources.map((src) => {
        const stage: Stage = stages[src.id] || { kind: 'idle' };
        const supported = SUPPORTED.includes(src.type);
        return (
          <div key={src.id} className={styles.card}>
            <div className={styles.cardHead}>
              <Database20Regular />
              <strong>{src.name}</strong>
              <Badge appearance="tint" color="brand">{TYPE_LABEL[src.type] || src.type}</Badge>
              <div className={styles.spacer} />
              {supported && (
                <Button appearance="primary" icon={<Sparkle20Regular />} disabled={stage.kind === 'loading'}
                  onClick={() => generate(src)}>
                  {stage.kind === 'loading' ? 'Generating…' : stage.kind === 'preview' ? 'Regenerate' : 'Generate'}
                </Button>
              )}
            </div>

            {!supported && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  {src.type === 'semantic-model'
                    ? 'Semantic-model (DAX) examples come from Power BI “Prep for AI” Verified Answers — Config Copilot covers warehouse, lakehouse, KQL, and AI Search sources.'
                    : 'Ontology / graph sources are queried whole — there is no column schema to generate example queries from.'}
                </MessageBarBody>
              </MessageBar>
            )}

            {stage.kind === 'loading' && <Spinner size="small" label="Reading schema + generating…" labelPosition="after" />}

            {stage.kind === 'gate' && (
              <MessageBar intent="warning"><MessageBarBody>{stage.message}</MessageBarBody></MessageBar>
            )}

            {stage.kind === 'error' && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Generation failed</MessageBarTitle>
                  <div>{stage.message}</div>
                  {stage.hint && <div className={styles.hintRow}><em>Hint:</em> {stage.hint}</div>}
                </MessageBarBody>
              </MessageBar>
            )}

            {stage.kind === 'preview' && (
              <div className={styles.preview}>
                <Field label="Example question → query pairs (editable)">
                  <div className={styles.pairList}>
                    {(edited[src.id] || []).map((ex, i) => (
                      <div key={i} className={styles.pairRow}>
                        <Input value={ex.question} placeholder="question" onChange={(_, d) => updateExample(src.id, i, { question: d.value })} />
                        <Input value={ex.query} placeholder="SQL / KQL / search" onChange={(_, d) => updateExample(src.id, i, { query: d.value })} />
                        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove example ${i + 1}`} title="Remove this example" onClick={() => removeExample(src.id, i)} />
                      </div>
                    ))}
                    <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => addExample(src.id)} className={styles.addBtn}>Example</Button>
                  </div>
                </Field>

                {Object.keys(stage.suggestion.descriptions).length > 0 && (
                  <details>
                    <summary className={styles.summary}>
                      Field descriptions ({Object.values(stage.suggestion.descriptions).reduce((n, c) => n + Object.keys(c).length, 0)})
                    </summary>
                    <div className={styles.descBlock}>
                      {Object.entries(stage.suggestion.descriptions).map(([table, cols]) => (
                        <div key={table} className={styles.descTable}>
                          <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>{table}</Caption1>
                          {Object.entries(cols).map(([col, desc]) => (
                            <div key={col} className={styles.descCol}>
                              <strong>{col}</strong>: {desc}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                <details>
                  <summary className={styles.summarySmall}>Schema used (grounding)</summary>
                  <pre className={styles.schema}>{stage.suggestion.schemaUsed}</pre>
                </details>

                <div>
                  <Button appearance="primary" disabled={applying === src.id} onClick={() => apply(src, stage.suggestion)}>
                    {applying === src.id ? 'Applying…' : 'Apply to this source'}
                  </Button>
                </div>
              </div>
            )}

            {stage.kind === 'idle' && supported && (
              <Body1 className={styles.idleText}>
                Generate examples + descriptions from this source&apos;s real schema.
              </Body1>
            )}
          </div>
        );
      })}
    </div>
  );
}
