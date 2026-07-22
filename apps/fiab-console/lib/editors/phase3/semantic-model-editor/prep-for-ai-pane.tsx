'use client';

// prep-for-ai-pane.tsx — SemanticModelPrepForAiPane (Loom-native Prep-for-AI /
// Verified Answers). Extracted byte-for-byte from ../semantic-model-editor.tsx.

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Card, Textarea, Switch,
  MessageBar, MessageBarBody, MessageBarTitle, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Save20Regular, Add20Regular, Delete20Regular,
  Table20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { PfaState, PfaTableFlag, SmTable } from './types';
import { ColumnTypeIcon, tableExposed, columnExposed } from './helpers';
import { usePrepForAiStyles, useSmVisualStyles } from './styles';

// ============================================================
// Prep for AI (Fabric-parity G5) — the Loom-native equivalent of Power BI's
// Prep-for-AI / Verified Answers. Curates (1) which tables/columns are exposed
// to AI, (2) AI instructions, and (3) Verified Answers (curated NL → DAX pairs,
// each validated by ACTUALLY running the DAX against the Azure-native tabular
// backend). Persists Azure-native on the item (state.prepForAi) and is consumed
// by the Loom data-agent grounding path — NO Power BI / Fabric dependency.
// ============================================================

export function SemanticModelPrepForAiPane({ id, datasetId, workspaceId }: { id: string; datasetId: string; workspaceId: string }) {
  const cs = usePrepForAiStyles();
  const sm = useSmVisualStyles();
  const [prep, setPrep] = useState<PfaState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tables, setTables] = useState<SmTable[] | null>(null);
  const [schemaGate, setSchemaGate] = useState<{ missing: string; detail: string } | null>(null);

  // Local editable drafts (saved explicitly).
  const [instrDraft, setInstrDraft] = useState('');
  const [schemaDraft, setSchemaDraft] = useState<PfaTableFlag[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [savingInstr, setSavingInstr] = useState(false);
  const [savingSchema, setSavingSchema] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // New Verified Answer form + per-answer busy state.
  const [naQuestion, setNaQuestion] = useState('');
  const [naDax, setNaDax] = useState('EVALUATE ');
  const [addingAnswer, setAddingAnswer] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadPrep = useCallback(async () => {
    setLoadErr(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/prep-for-ai`);
      const j = await r.json();
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      const p: PfaState = {
        aiInstructions: String(j.prepForAi?.aiInstructions || ''),
        schema: Array.isArray(j.prepForAi?.schema) ? j.prepForAi.schema : [],
        verifiedAnswers: Array.isArray(j.prepForAi?.verifiedAnswers) ? j.prepForAi.verifiedAnswers : [],
      };
      setPrep(p);
      setInstrDraft(p.aiInstructions);
      setSchemaDraft(p.schema);
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
  }, [id]);

  const loadSchema = useCallback(async () => {
    if (!datasetId) { setSchemaGate({ missing: 'no-dataset', detail: 'Select or build the model to expose its tables/columns to AI. AI instructions and Verified Answers can still be curated below.' }); return; }
    setSchemaGate(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/model?workspaceId=${encodeURIComponent(workspaceId || '')}`);
      const j = await r.json();
      if (!j.ok && j.gate) { setSchemaGate(j.gate); setTables(null); return; }
      if (!j.ok) { setSchemaGate({ missing: 'error', detail: j.error || `HTTP ${r.status}` }); setTables(null); return; }
      setTables(Array.isArray(j.tables) ? j.tables : []);
    } catch (e: any) { setSchemaGate({ missing: 'error', detail: e?.message || String(e) }); }
  }, [datasetId, workspaceId]);

  useEffect(() => { void loadPrep(); void loadSchema(); }, [loadPrep, loadSchema]);

  const saveInstructions = useCallback(async () => {
    setSavingInstr(true); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/prep-for-ai`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'save', aiInstructions: instrDraft }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setPrep((p) => (p ? { ...p, aiInstructions: instrDraft } : p));
      setMsg({ ok: true, text: 'AI instructions saved.' });
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSavingInstr(false); }
  }, [id, instrDraft]);

  const toggleTable = (table: string, exposed: boolean) => {
    setSchemaDraft((prev) => {
      const next = prev.filter((t) => t.table !== table);
      const existing = prev.find((t) => t.table === table);
      next.push({ table, exposed, columns: existing?.columns || [] });
      return next;
    });
  };
  const toggleColumn = (table: string, column: string, exposed: boolean) => {
    setSchemaDraft((prev) => {
      const existing = prev.find((t) => t.table === table);
      const columns = (existing?.columns || []).filter((c) => c.column !== column);
      columns.push({ column, exposed });
      const next = prev.filter((t) => t.table !== table);
      next.push({ table, exposed: existing?.exposed ?? true, columns });
      return next;
    });
  };

  const saveSchema = useCallback(async () => {
    setSavingSchema(true); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/prep-for-ai`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'save', schema: schemaDraft }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setPrep((p) => (p ? { ...p, schema: schemaDraft } : p));
      setMsg({ ok: true, text: 'AI data schema saved.' });
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSavingSchema(false); }
  }, [id, schemaDraft]);

  const addAnswer = useCallback(async () => {
    const question = naQuestion.trim();
    const dax = naDax.trim();
    if (!question || !dax) { setMsg({ ok: false, text: 'A Verified Answer needs a question and DAX.' }); return; }
    setAddingAnswer(true); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/prep-for-ai`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'upsert-answer', answer: { question, dax } }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setPrep((p) => (p ? { ...p, verifiedAnswers: j.prepForAi?.verifiedAnswers || p.verifiedAnswers } : p));
      setNaQuestion(''); setNaDax('EVALUATE ');
      setMsg({ ok: true, text: 'Verified Answer added. Run it to verify against the model.' });
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setAddingAnswer(false); }
  }, [id, naQuestion, naDax]);

  const verifyAnswer = useCallback(async (answerId: string) => {
    setVerifyingId(answerId); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/prep-for-ai`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'verify-answer', id: answerId }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setPrep((p) => (p ? { ...p, verifiedAnswers: j.prepForAi?.verifiedAnswers || p.verifiedAnswers } : p));
      setMsg({ ok: j.verified, text: j.note || (j.verified ? 'Verified.' : 'Not verified.') });
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setVerifyingId(null); }
  }, [id]);

  const deleteAnswer = useCallback(async (answerId: string) => {
    setDeletingId(answerId); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/prep-for-ai`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'delete-answer', id: answerId }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setPrep((p) => (p ? { ...p, verifiedAnswers: j.prepForAi?.verifiedAnswers || [] } : p));
      setMsg({ ok: true, text: 'Verified Answer deleted.' });
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setDeletingId(null); }
  }, [id]);

  if (loadErr) {
    return (
      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
        <MessageBarBody><MessageBarTitle>Could not load Prep for AI</MessageBarTitle>{loadErr}</MessageBarBody>
      </MessageBar>
    );
  }
  if (!prep) {
    return <Spinner size="small" label="Loading Prep for AI…" labelPosition="after" style={{ marginTop: tokens.spacingVerticalL }} />;
  }

  const answers = prep.verifiedAnswers;

  return (
    <div className={cs.root}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Prep for AI — Loom-native, no Power BI required</MessageBarTitle>
          Curate how this model is presented to data agents and Copilot: expose/hide tables &amp; columns to AI,
          add AI instructions, and author Verified Answers (natural-language → DAX). Verified Answers are validated by
          running the DAX read-only against the Azure-native tabular backend (Synapse serverless / opt-in Azure Analysis
          Services). Everything persists Azure-native on the model — no Microsoft Fabric / Power BI workspace needed.
        </MessageBarBody>
      </MessageBar>

      {msg && (
        <MessageBar intent={msg.ok ? 'success' : 'warning'} layout="multiline">
          <MessageBarBody>{msg.text}</MessageBarBody>
        </MessageBar>
      )}

      {/* 1 · AI instructions */}
      <Card className={cs.section}>
        <div className={cs.sectionHead}>
          <div className={cs.headText}>
            <Subtitle2>AI instructions</Subtitle2>
            <Caption1>Guidance the agent applies whenever it grounds on this model (terminology, preferred measures, caveats).</Caption1>
          </div>
        </div>
        <Textarea
          value={instrDraft}
          onChange={(_e, d) => setInstrDraft(d.value)}
          resize="vertical"
          rows={5}
          placeholder="e.g. 'Revenue' always means [Total Revenue] (net of returns). Prefer the Date table for time intelligence. Currency is USD."
          aria-label="AI instructions"
        />
        <div className={cs.actionRow}>
          <Button appearance="primary" icon={savingInstr ? <Spinner size="tiny" /> : <Save20Regular />} disabled={savingInstr || instrDraft === prep.aiInstructions} onClick={() => void saveInstructions()}>
            {savingInstr ? 'Saving…' : 'Save instructions'}
          </Button>
        </div>
      </Card>

      {/* 2 · AI data schema (expose/hide) */}
      <Card className={cs.section}>
        <div className={cs.sectionHead}>
          <div className={cs.headText}>
            <Subtitle2>AI data schema</Subtitle2>
            <Caption1>Choose which tables and columns are visible to AI. Everything is exposed by default; turn a switch off to hide it from agents (distinct from report-view visibility).</Caption1>
          </div>
          <Button appearance="primary" icon={savingSchema ? <Spinner size="tiny" /> : <Save20Regular />} disabled={savingSchema || !tables} onClick={() => void saveSchema()}>
            {savingSchema ? 'Saving…' : 'Save schema'}
          </Button>
        </div>
        {schemaGate && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Model schema unavailable</MessageBarTitle>
              {schemaGate.detail}{schemaGate.missing && schemaGate.missing !== 'no-dataset' && schemaGate.missing !== 'error' ? ` (set ${schemaGate.missing})` : ''}
            </MessageBarBody>
          </MessageBar>
        )}
        {tables && tables.length > 0 && (
          <div className={cs.schemaTable}>
            {tables.map((t) => {
              const tExposed = tableExposed(schemaDraft, t.name);
              const isOpen = !!expanded[t.name];
              return (
                <div key={t.name}>
                  <div className={cs.tableRow}>
                    <span className={cs.actionRow}>
                      <Button size="small" appearance="transparent" onClick={() => setExpanded((e) => ({ ...e, [t.name]: !isOpen }))}>
                        {isOpen ? '▾' : '▸'}
                      </Button>
                      <Table20Regular />
                      <strong>{t.name}</strong>
                      <Caption1>{t.columns.length} column(s)</Caption1>
                    </span>
                    <Switch checked={tExposed} label={tExposed ? 'Exposed' : 'Hidden'} onChange={(_e, d) => toggleTable(t.name, !!d.checked)} />
                  </div>
                  {isOpen && t.columns.map((c) => {
                    const cExposed = tExposed && columnExposed(schemaDraft, t.name, c.name);
                    return (
                      <div key={c.name} className={cs.colRow}>
                        <span className={sm.fieldName}>
                          <ColumnTypeIcon dataType={c.dataType} className={sm.typeIcon} />
                          <Caption1>{c.name}{c.dataType ? ` · ${c.dataType}` : ''}</Caption1>
                        </span>
                        <Switch checked={cExposed} disabled={!tExposed} label={!tExposed ? 'Table hidden' : cExposed ? 'Exposed' : 'Hidden'} onChange={(_e, d) => toggleColumn(t.name, c.name, !!d.checked)} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {tables && tables.length === 0 && !schemaGate && (
          <div className={cs.emptyState}><Caption1>This model has no tables yet — build or ingest tables to curate AI exposure.</Caption1></div>
        )}
      </Card>

      {/* 3 · Verified Answers */}
      <Card className={cs.section}>
        <div className={cs.sectionHead}>
          <div className={cs.headText}>
            <Subtitle2>Verified Answers</Subtitle2>
            <Caption1>Curated natural-language question → DAX pairs. Each is verified by running the DAX read-only against the real backend, then surfaced to data agents as a trusted few-shot example.</Caption1>
          </div>
        </div>

        {/* Add new */}
        <div className={cs.answerCard}>
          <Field label="Question">
            <Input value={naQuestion} onChange={(_e, d) => setNaQuestion(d.value)} placeholder="What was total revenue last quarter?" />
          </Field>
          <Field label="DAX (EVALUATE …)">
            <MonacoTextarea value={naDax} onChange={setNaDax} language="dax" height={110} minHeight={80} ariaLabel="Verified Answer DAX" />
          </Field>
          <div className={cs.actionRow}>
            <Button appearance="primary" icon={addingAnswer ? <Spinner size="tiny" /> : <Add20Regular />} disabled={addingAnswer || !naQuestion.trim() || !naDax.trim()} onClick={() => void addAnswer()}>
              {addingAnswer ? 'Adding…' : 'Add Verified Answer'}
            </Button>
          </div>
        </div>

        {answers.length === 0 ? (
          <div className={cs.emptyState}>
            <Sparkle20Regular />
            <Caption1>No Verified Answers yet. Add trusted question → DAX pairs so agents answer common questions the exact way you intend.</Caption1>
          </div>
        ) : (
          answers.map((a) => (
            <div key={a.id} className={cs.answerCard}>
              <div className={cs.answerHead}>
                <strong>{a.question}</strong>
                <span className={cs.actionRow}>
                  {a.lastVerifiedOk === true && <Badge color="success" appearance="filled">Verified</Badge>}
                  {a.lastVerifiedOk === false && <Badge color="warning" appearance="filled">Not verified</Badge>}
                  {a.lastVerifiedOk === undefined && <Badge color="informative" appearance="outline">Unrun</Badge>}
                  <Button size="small" appearance="secondary" icon={verifyingId === a.id ? <Spinner size="tiny" /> : <Play20Regular />} disabled={verifyingId === a.id} onClick={() => void verifyAnswer(a.id)}>
                    {verifyingId === a.id ? 'Running…' : 'Run to verify'}
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={deletingId === a.id} onClick={() => void deleteAnswer(a.id)} aria-label={`Delete ${a.question}`} />
                </span>
              </div>
              <MonacoTextarea value={a.dax} onChange={() => {}} readOnly language="dax" height={80} minHeight={50} ariaLabel={`DAX for ${a.question}`} />
              {a.lastVerifiedNote && <Caption1>{a.lastVerifiedNote}{a.lastVerifiedAt ? ` · ${new Date(a.lastVerifiedAt).toLocaleString()}` : ''}</Caption1>}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
