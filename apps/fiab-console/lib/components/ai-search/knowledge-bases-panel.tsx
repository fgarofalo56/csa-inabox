'use client';
/**
 * KnowledgeBasesPanel — the "Knowledge Bases" surface for the AI Search editor
 * (agentic retrieval / Foundry IQ). One-for-one with the portal Import/preview
 * agentic-retrieval UI, Loom-themed (Fluent v9 + Loom tokens).
 *
 * Three tabs, all real AI Search REST via the /api/ai-search/knowledge-* routes:
 *   1. Knowledge sources — list + typed create wizard (pick an EXISTING index
 *      from the live estate; optional semantic config + source fields) + delete.
 *   2. Knowledge bases   — list + typed create wizard (compose sources +
 *      reasoning-effort dropdown) + delete.
 *   3. Retrieve test     — pick a base, ask a multi-part question, run agentic
 *      retrieval, and see the SUBQUERIES + CITATIONS + grounding/answer.
 *
 * No JSON textarea in the primary path (per no-freeform-config): every input is
 * a picker / dropdown / typed field. Honest MessageBar gates when AI Search is
 * unconfigured or the sovereign cloud hasn't confirmed the api-version.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Button, Spinner, Badge, Switch,
  MessageBar, MessageBarBody, MessageBarTitle,
  Field, Input, Dropdown, Option, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  TabList, Tab, Card, Caption1, Body1, Body1Strong, Title3, Text,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
} from '@fluentui/react-components';
import {
  BrainCircuit20Regular, DatabaseSearch20Regular, Search20Regular,
  Add16Regular, Delete16Regular, Play16Regular, DocumentSearch20Regular,
  Edit16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  isChatCompletionModel, composeKnowledgeBaseModels, describeKbOutputMode,
  type AoaiModelChoice,
} from '@/lib/azure/knowledge-base-model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalL, height: '100%', overflowY: 'auto' },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  headText: { display: 'flex', flexDirection: 'column' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  tableWrap: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, overflow: 'hidden' },
  empty: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalXXL, color: tokens.colorNeutralForeground3, textAlign: 'center' },
  formGrid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '420px' },
  retrieveLayout: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalM },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  answer: { whiteSpace: 'pre-wrap', fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, background: tokens.colorNeutralBackground2, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingHorizontalM, maxHeight: '320px', overflowY: 'auto' },
  subqRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: `${tokens.spacingVerticalXS} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  errorText: { color: tokens.colorPaletteRedForeground1 },
});

type GovGate = { cloud: string; reason: string } | null;
interface KnowledgeSourceRow { name: string; kind: string; searchIndexName?: string; description?: string }
interface KnowledgeBaseRow { name: string; knowledgeSources: string[]; outputMode?: string; reasoningEffort?: string }
interface IndexRow { name: string }
interface AoaiDeploymentRow { name: string; modelName?: string }
interface Subquery { source?: string; search?: string; count?: number; elapsedMs?: number }
interface Citation { id?: string; docKey?: string; source?: string }
interface RetrieveResult { answer: string; answerIsExtractive: boolean; subqueries: Subquery[]; citations: Citation[]; partial: boolean; apiVersion: string }

const R = {
  sources: '/api/ai-search/knowledge-sources',
  bases: '/api/ai-search/knowledge-bases',
  base: (name: string) => `/api/ai-search/knowledge-bases/${encodeURIComponent(name)}`,
  indexes: '/api/ai-search/indexes',
  deployments: '/api/foundry/model-deployments',
  retrieve: (name: string) => `/api/ai-search/knowledge-bases/${encodeURIComponent(name)}/retrieve`,
};

async function readJson(res: Response): Promise<any> {
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : { ok: false, error: `HTTP ${res.status}` };
}

export function KnowledgeBasesPanel() {
  const s = useStyles();
  const [tab, setTab] = useState<'sources' | 'bases' | 'retrieve'>('sources');

  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [govGate, setGovGate] = useState<GovGate>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [sources, setSources] = useState<KnowledgeSourceRow[]>([]);
  const [bases, setBases] = useState<KnowledgeBaseRow[]>([]);
  const [indexes, setIndexes] = useState<IndexRow[]>([]);
  // AOAI chat deployments for the query-planning / synthesis model picker.
  const [aoaiEndpoint, setAoaiEndpoint] = useState('');
  const [aoaiDeployments, setAoaiDeployments] = useState<AoaiDeploymentRow[]>([]);
  const [aoaiGate, setAoaiGate] = useState<string | null>(null);

  // ---- create-source wizard ----
  const [sDialog, setSDialog] = useState(false);
  const [sName, setSName] = useState('');
  const [sIndex, setSIndex] = useState('');
  const [sSemantic, setSSemantic] = useState('');
  const [sDesc, setSDesc] = useState('');
  const [sErr, setSErr] = useState<string | null>(null);

  // ---- create/edit-base wizard ----
  const [bDialog, setBDialog] = useState(false);
  const [bEditing, setBEditing] = useState(false); // true → PUT-updating an existing base
  const [bName, setBName] = useState('');
  const [bSources, setBSources] = useState<string[]>([]);
  const [bEffort, setBEffort] = useState<'default' | 'minimal' | 'low' | 'medium'>('default');
  const [bMode, setBMode] = useState<'extractive' | 'synthesis'>('extractive');
  const [bModel, setBModel] = useState(''); // AOAI deployment name for query planning / synthesis
  const [bDesc, setBDesc] = useState('');
  const [bErr, setBErr] = useState<string | null>(null);

  // ---- retrieve test ----
  const [rBase, setRBase] = useState('');
  const [rQuery, setRQuery] = useState('');
  const [rSynth, setRSynth] = useState(false);
  const [rRunning, setRRunning] = useState(false);
  const [rResult, setRResult] = useState<RetrieveResult | null>(null);
  const [rErr, setRErr] = useState<string | null>(null);

  const applyGate = (body: any): boolean => {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  };

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ks, kb, ix] = await Promise.all([
        clientFetch(R.sources).then(readJson),
        clientFetch(R.bases).then(readJson),
        clientFetch(R.indexes).then(readJson),
      ]);
      for (const b of [ks, kb, ix]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      setGovGate(ks.govGate || kb.govGate || null);
      if (ks.ok) setSources(ks.knowledgeSources || []); else setError(ks.error || 'failed to list knowledge sources');
      if (kb.ok) setBases(kb.knowledgeBases || []);
      if (ix.ok) setIndexes((ix.indexes || []).map((i: any) => ({ name: i.name })));
      // AOAI chat deployments for the synthesis / query-planning model picker.
      // A 503/notDeployed here is NOT a hard failure — extractive retrieval works
      // without a model; we honest-gate only the synthesis option (never block).
      try {
        const dep = await clientFetch(R.deployments).then(readJson);
        if (dep?.ok) {
          setAoaiEndpoint(dep.account?.endpoint || '');
          setAoaiDeployments(((dep.deployments || []) as any[])
            .filter((d) => isChatCompletionModel(d?.modelName || d?.name))
            .map((d) => ({ name: d.name, modelName: d.modelName })));
          setAoaiGate(null);
        } else {
          setAoaiDeployments([]);
          setAoaiGate(dep?.error || 'Azure OpenAI is not configured — synthesized answers are unavailable until an AOAI account with a chat deployment is bound (LOOM_AOAI_ENDPOINT / Foundry account).');
        }
      } catch {
        setAoaiDeployments([]);
        setAoaiGate('Azure OpenAI is not configured — synthesized answers are unavailable until an AOAI account with a chat deployment is bound (LOOM_AOAI_ENDPOINT / Foundry account).');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const createSource = async () => {
    setSErr(null);
    if (!sName.trim() || !sIndex) { setSErr('Name and a source index are required.'); return; }
    setBusy(true);
    try {
      const res = await clientFetch(R.sources, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: sName.trim(), searchIndexName: sIndex, semanticConfigurationName: sSemantic.trim() || undefined, description: sDesc.trim() || undefined }),
      });
      const body = await readJson(res);
      if (!body.ok) { setSErr(body.error || `HTTP ${res.status}`); setBusy(false); return; }
      setSDialog(false); setSName(''); setSIndex(''); setSSemantic(''); setSDesc('');
      await loadAll();
    } catch (e: any) { setSErr(e?.message || String(e)); }
    setBusy(false);
  };

  const openNewBase = () => {
    setBErr(null); setBEditing(false);
    setBName(''); setBSources([]); setBEffort('default'); setBMode('extractive'); setBModel(''); setBDesc('');
    setBDialog(true);
  };

  const openEditBase = async (name: string) => {
    setBErr(null); setBEditing(true); setBName(name);
    setBSources([]); setBEffort('default'); setBMode('extractive'); setBModel(''); setBDesc('');
    setBDialog(true);
    // Prefill from the live definition (PUT is create-or-update, so edit re-PUTs).
    try {
      const body = await clientFetch(R.base(name)).then(readJson);
      const kb = body?.knowledgeBase;
      if (body?.ok && kb) {
        setBSources((kb.knowledgeSources || []).map((k: any) => (typeof k === 'string' ? k : k?.name)).filter(Boolean));
        setBEffort((kb.retrievalReasoningEffort?.kind as any) || 'default');
        const synth = (kb.outputMode?.kind || kb.outputMode) === 'answerSynthesis';
        setBMode(synth ? 'synthesis' : 'extractive');
        const dep = kb.models?.[0]?.azureOpenAIParameters?.deploymentId;
        if (dep) setBModel(dep);
        setBDesc(kb.description || '');
      }
    } catch { /* keep the blank prefill; the operator can re-enter */ }
  };

  // Build the AOAI model choice from the picked deployment (or null).
  const buildModelChoice = (): AoaiModelChoice | null => {
    if (!bModel) return null;
    const d = aoaiDeployments.find((x) => x.name === bModel);
    return { resourceUri: aoaiEndpoint, deploymentId: bModel, modelName: d?.modelName };
  };

  const submitBase = async () => {
    setBErr(null);
    if (!bName.trim() || bSources.length === 0) { setBErr('Name and at least one knowledge source are required.'); return; }
    const composed = composeKnowledgeBaseModels({
      synthesize: bMode === 'synthesis',
      model: buildModelChoice(),
      reasoningEffort: bEffort,
    });
    if (composed.error) { setBErr(composed.error); return; }
    setBusy(true);
    try {
      const res = await clientFetch(R.bases, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: bName.trim(),
          knowledgeSources: bSources,
          reasoningEffort: bEffort === 'default' ? undefined : bEffort,
          outputMode: composed.outputMode,
          models: composed.models.length ? composed.models : undefined,
          description: bDesc.trim() || undefined,
        }),
      });
      const body = await readJson(res);
      if (!body.ok) { setBErr(body.error || `HTTP ${res.status}`); setBusy(false); return; }
      setBDialog(false); setBName(''); setBSources([]); setBEffort('default'); setBMode('extractive'); setBModel(''); setBDesc('');
      await loadAll();
    } catch (e: any) { setBErr(e?.message || String(e)); }
    setBusy(false);
  };

  const deleteSource = async (name: string) => {
    setBusy(true);
    try {
      const res = await clientFetch(`${R.sources}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (!body.ok) setError(body.error || `HTTP ${res.status}`);
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    setBusy(false);
  };

  const deleteBase = async (name: string) => {
    setBusy(true);
    try {
      const res = await clientFetch(`${R.bases}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (!body.ok) setError(body.error || `HTTP ${res.status}`);
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    setBusy(false);
  };

  const runRetrieve = async () => {
    setRErr(null); setRResult(null);
    if (!rBase || !rQuery.trim()) { setRErr('Pick a knowledge base and enter a question.'); return; }
    setRRunning(true);
    try {
      const res = await clientFetch(R.retrieve(rBase), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: rQuery.trim(), synthesize: rSynth }),
      }, 30000);
      const body = await readJson(res);
      if (!body.ok) { setRErr(body.error || `HTTP ${res.status}`); setRRunning(false); return; }
      setRResult(body.result as RetrieveResult);
    } catch (e: any) { setRErr(e?.message || String(e)); }
    setRRunning(false);
  };

  const baseNames = useMemo(() => bases.map((b) => b.name), [bases]);

  // ---- honest gates ----
  if (gate) {
    return (
      <div className={s.root}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure AI Search not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> to a deployed Microsoft.Search/searchServices name and grant the Loom UAMI
            the &quot;Search Service Contributor&quot; + &quot;Search Index Data Contributor&quot; roles
            (bicep: platform/fiab/bicep/modules/admin-plane/ai-search.bicep). Knowledge Bases (agentic retrieval) then light up.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.head}>
        <BrainCircuit20Regular />
        <div className={s.headText}>
          <Title3>Knowledge Bases</Title3>
          <Caption1>Agentic retrieval (Foundry IQ) — compose indexed content into knowledge bases your Copilot and agents query with query decomposition + semantic rerank.</Caption1>
        </div>
      </div>

      {govGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Preview in {govGate.cloud}</MessageBarTitle>
            {govGate.reason}
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="sources" icon={<DatabaseSearch20Regular />}>Knowledge sources ({sources.length})</Tab>
        <Tab value="bases" icon={<BrainCircuit20Regular />}>Knowledge bases ({bases.length})</Tab>
        <Tab value="retrieve" icon={<DocumentSearch20Regular />}>Retrieve test</Tab>
      </TabList>

      {loading ? <Spinner label="Loading agentic-retrieval objects…" /> : (
        <>
          {tab === 'sources' && (
            <>
              <div className={s.toolbar}>
                <Body1>A knowledge source wraps an existing AI Search index for agentic retrieval.</Body1>
                <div className={s.spacer} />
                <Button appearance="primary" icon={<Add16Regular />} disabled={busy} onClick={() => { setSErr(null); setSDialog(true); }}>New knowledge source</Button>
              </div>
              {sources.length === 0 ? (
                <div className={s.empty}>
                  <DatabaseSearch20Regular />
                  <Body1Strong>No knowledge sources yet</Body1Strong>
                  <Caption1>Create one over an existing index, then compose sources into a knowledge base.</Caption1>
                </div>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small">
                    <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Kind</TableHeaderCell><TableHeaderCell>Index</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
                    <TableBody>
                      {sources.map((k) => (
                        <TableRow key={k.name}>
                          <TableCell><Body1Strong>{k.name}</Body1Strong></TableCell>
                          <TableCell><Badge appearance="tint" color="brand">{k.kind}</Badge></TableCell>
                          <TableCell>{k.searchIndexName || '—'}</TableCell>
                          <TableCell><Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Delete ${k.name}`} disabled={busy} onClick={() => deleteSource(k.name)} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {tab === 'bases' && (
            <>
              <div className={s.toolbar}>
                <Body1>A knowledge base composes one or more sources and is what your Copilot / agents retrieve from.</Body1>
                <div className={s.spacer} />
                <Button appearance="primary" icon={<Add16Regular />} disabled={busy || sources.length === 0} onClick={openNewBase}>New knowledge base</Button>
              </div>
              {sources.length === 0 && <Caption1>Create a knowledge source first — a base must reference at least one.</Caption1>}
              {bases.length === 0 ? (
                <div className={s.empty}>
                  <BrainCircuit20Regular />
                  <Body1Strong>No knowledge bases yet</Body1Strong>
                  <Caption1>Compose your sources into a base, then test it on the Retrieve tab.</Caption1>
                </div>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small">
                    <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Sources</TableHeaderCell><TableHeaderCell>Output</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
                    <TableBody>
                      {bases.map((b) => (
                        <TableRow key={b.name}>
                          <TableCell><Body1Strong>{b.name}</Body1Strong></TableCell>
                          <TableCell><div className={s.chips}>{b.knowledgeSources.map((n) => <Badge key={n} appearance="tint">{n}</Badge>)}</div></TableCell>
                          <TableCell>{describeKbOutputMode(b.outputMode, false)}</TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" icon={<Play16Regular />} aria-label={`Test ${b.name}`} onClick={() => { setRBase(b.name); setTab('retrieve'); }} />
                            <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label={`Edit ${b.name}`} disabled={busy} onClick={() => openEditBase(b.name)} />
                            <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Delete ${b.name}`} disabled={busy} onClick={() => deleteBase(b.name)} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {tab === 'retrieve' && (
            <div className={s.retrieveLayout}>
              <Field label="Knowledge base">
                <Dropdown
                  placeholder={baseNames.length ? 'Select a knowledge base' : 'No knowledge bases yet'}
                  selectedOptions={rBase ? [rBase] : []}
                  value={rBase}
                  disabled={baseNames.length === 0}
                  onOptionSelect={(_, d) => setRBase(d.optionValue || '')}
                >
                  {baseNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Question (multi-part questions are decomposed into subqueries)">
                <Textarea value={rQuery} onChange={(_, d) => setRQuery(d.value)} rows={3} placeholder="e.g. Which of our indexed policies cover remote work, and how do they differ on equipment reimbursement?" />
              </Field>
              <div className={s.toolbar}>
                <Switch checked={rSynth} onChange={(_, d) => setRSynth(d.checked)} label="Synthesize a single answer (preview — requires a base configured for answer synthesis)" />
                <div className={s.spacer} />
                <Button appearance="primary" icon={rRunning ? <Spinner size="tiny" /> : <Search20Regular />} disabled={rRunning || !rBase || !rQuery.trim()} onClick={runRetrieve}>Retrieve</Button>
              </div>
              {rErr && <MessageBar intent="error"><MessageBarBody>{rErr}</MessageBarBody></MessageBar>}
              {rResult && (
                <>
                  {rResult.partial && <MessageBar intent="warning"><MessageBarBody>Partial result — one or more knowledge sources failed. Showing what succeeded.</MessageBarBody></MessageBar>}
                  <Card className={s.card}>
                    <div className={s.cardHead}>
                      <Body1Strong>{rResult.answerIsExtractive ? 'Grounding data (extractive)' : 'Synthesized answer'}</Body1Strong>
                      <Badge appearance="outline" size="small">api {rResult.apiVersion}</Badge>
                    </div>
                    <div className={s.answer}>{rResult.answer || '(empty response — try increasing the question specificity)'}</div>
                  </Card>
                  <Card className={s.card}>
                    <Body1Strong>Subqueries ({rResult.subqueries.length})</Body1Strong>
                    {rResult.subqueries.length === 0 ? <Caption1>No subqueries reported.</Caption1> : rResult.subqueries.map((q, i) => (
                      <div key={i} className={s.subqRow}>
                        {q.source && <Badge appearance="tint" size="small">{q.source}</Badge>}
                        <Text>{q.search || '—'}</Text>
                        <div className={s.spacer} />
                        {typeof q.count === 'number' && <Caption1>{q.count} hits</Caption1>}
                        {typeof q.elapsedMs === 'number' && <Caption1>{q.elapsedMs} ms</Caption1>}
                      </div>
                    ))}
                  </Card>
                  <Card className={s.card}>
                    <Body1Strong>Citations ({rResult.citations.length})</Body1Strong>
                    {rResult.citations.length === 0 ? <Caption1>No citations returned.</Caption1> : (
                      <div className={s.chips}>
                        {rResult.citations.map((c, i) => <Badge key={i} appearance="outline" color="informative">{c.docKey || c.id || `ref ${i}`}</Badge>)}
                      </div>
                    )}
                  </Card>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* ---- Create knowledge source wizard ---- */}
      <Dialog open={sDialog} onOpenChange={(_, d) => { if (!d.open) setSDialog(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New knowledge source</DialogTitle>
            <DialogContent>
              <div className={s.formGrid}>
                <Field label="Name" required>
                  <Input value={sName} onChange={(_, d) => setSName(d.value)} placeholder="e.g. policies-ks" />
                </Field>
                <Field label="Source index" required hint="Wraps an existing AI Search index (must have a semantic configuration for agentic retrieval).">
                  <Dropdown placeholder={indexes.length ? 'Select an index' : 'No indexes on this service'} selectedOptions={sIndex ? [sIndex] : []} value={sIndex} disabled={indexes.length === 0} onOptionSelect={(_, d) => setSIndex(d.optionValue || '')}>
                    {indexes.map((i) => <Option key={i.name} value={i.name}>{i.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Semantic configuration name" hint="Required by GA when the index defines one; leave blank to use the index default.">
                  <Input value={sSemantic} onChange={(_, d) => setSSemantic(d.value)} placeholder="e.g. default-semantic-config" />
                </Field>
                <Field label="Description">
                  <Input value={sDesc} onChange={(_, d) => setSDesc(d.value)} />
                </Field>
                {sErr && <Caption1 className={s.errorText}>{sErr}</Caption1>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSDialog(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={createSource} disabled={busy || !sName.trim() || !sIndex}>Create</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ---- Create knowledge base wizard ---- */}
      <Dialog open={bDialog} onOpenChange={(_, d) => { if (!d.open) setBDialog(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{bEditing ? `Edit knowledge base — ${bName}` : 'New knowledge base'}</DialogTitle>
            <DialogContent>
              <div className={s.formGrid}>
                <Field label="Name" required>
                  <Input value={bName} onChange={(_, d) => setBName(d.value)} placeholder="e.g. hr-knowledge-base" disabled={bEditing} />
                </Field>
                <Field label="Knowledge sources" required hint="Compose one or more sources. The base queries them all and reranks across them.">
                  <Dropdown multiselect placeholder="Select sources" selectedOptions={bSources} value={bSources.join(', ')} onOptionSelect={(_, d) => setBSources(d.selectedOptions)}>
                    {sources.map((k) => <Option key={k.name} value={k.name}>{k.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Answer mode" hint="Extractive returns grounding chunks (GA, no model). Synthesized formulates one natural-language answer (requires an Azure OpenAI chat model).">
                  <Dropdown selectedOptions={[bMode]} value={bMode === 'synthesis' ? 'Synthesized answer' : 'Extractive grounding'} onOptionSelect={(_, d) => setBMode((d.optionValue as typeof bMode) || 'extractive')}>
                    <Option value="extractive">Extractive grounding</Option>
                    <Option value="synthesis">Synthesized answer (LLM)</Option>
                  </Dropdown>
                </Field>
                <Field
                  label={bMode === 'synthesis' ? 'Query-planning / synthesis model' : 'Query-planning model (optional)'}
                  required={bMode === 'synthesis'}
                  hint={bMode === 'synthesis'
                    ? 'The Azure OpenAI chat deployment that decomposes the query and writes the answer.'
                    : 'Bind a chat model to enable model-based query planning at higher reasoning effort. Leave as “None” for pure extractive.'}
                >
                  <Dropdown
                    placeholder={aoaiDeployments.length ? 'Select a chat deployment' : 'No Azure OpenAI chat deployments'}
                    selectedOptions={bModel ? [bModel] : ['']}
                    value={bModel || 'None'}
                    disabled={aoaiDeployments.length === 0}
                    onOptionSelect={(_, d) => setBModel(d.optionValue === '__none' ? '' : (d.optionValue || ''))}
                  >
                    <Option value="__none" text="None">None (extractive only)</Option>
                    {aoaiDeployments.map((m) => (
                      <Option key={m.name} value={m.name} text={m.name}>{m.name}{m.modelName ? ` — ${m.modelName}` : ''}</Option>
                    ))}
                  </Dropdown>
                </Field>
                {aoaiGate && bMode === 'synthesis' && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Azure OpenAI required for synthesis</MessageBarTitle>
                      {aoaiGate}
                    </MessageBarBody>
                  </MessageBar>
                )}
                <Field label="Reasoning effort" hint="Higher effort spends more model reasoning on query planning. Default = service default.">
                  <Dropdown selectedOptions={[bEffort]} value={bEffort} onOptionSelect={(_, d) => setBEffort((d.optionValue as typeof bEffort) || 'default')}>
                    <Option value="default">Service default</Option>
                    <Option value="minimal">Minimal</Option>
                    <Option value="low">Low</Option>
                    <Option value="medium">Medium</Option>
                  </Dropdown>
                </Field>
                <Field label="Description">
                  <Input value={bDesc} onChange={(_, d) => setBDesc(d.value)} />
                </Field>
                {bErr && <Caption1 className={s.errorText}>{bErr}</Caption1>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setBDialog(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitBase} disabled={busy || !bName.trim() || bSources.length === 0 || (bMode === 'synthesis' && !bModel)}>{bEditing ? 'Save' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
