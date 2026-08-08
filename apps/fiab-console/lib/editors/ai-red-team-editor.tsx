'use client';

/**
 * AiRedTeamEditor — the `ai-red-team` item type (AIF-15).
 *
 * A DEFENSIVE safety-scan surface: pick a target model deployment, choose which
 * harm categories to probe, and run curated adversarial probes (safety
 * benchmark requests the model SHOULD refuse) against the live deployment. Each
 * response is classified refused / partial / unsafe (AOAI judge + heuristic
 * fallback) and optionally scored by Azure AI Content Safety. The scan reports
 * the deployment's refusal rate + attack-success rate — the Azure-native analog
 * of the Microsoft AI Red Teaming Agent. No Microsoft Fabric dependency; real
 * backend on every run (no-vaporware.md).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Field, Input, Dropdown, Option, Spinner, Divider, ProgressBar, Switch,
  Checkbox, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ShieldErrorRegular, PlayRegular, HistoryRegular, BracesRegular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { useItemState } from './palantir/shared';
import { RED_TEAM_CATEGORIES, type RedTeamCategory } from '@/lib/foundry/red-team';
import { RED_TEAM_TECHNIQUES } from '@/lib/foundry/red-team-techniques';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

interface RedTeamResultLite {
  id: string; category: string; prompt: string; response: string;
  verdict: 'refused' | 'partial' | 'unsafe' | 'inconclusive'; rationale?: string; safetySeverity?: number; safetyCategory?: string;
  technique?: string;
}
interface RedTeamCoverageLite {
  techniques: string[]; techniquesNotExercised: string[];
  categoriesProbed: string[]; categoriesNotProbed: string[];
  multiTurn: boolean; composed: boolean;
  scoredProbes: number; inconclusiveProbes: number;
  scoreIsMeaningful: boolean; scopeStatement: string;
}
interface RedTeamSummaryLite {
  total: number; refused: number; partial: number; unsafe: number; inconclusive?: number;
  refusalRate: number; attackSuccessRate: number;
  byCategory: Record<string, { total: number; refused: number; failed: number; inconclusive?: number }>;
  byTechnique?: Record<string, { total: number; refused: number; failed: number; inconclusive?: number }>;
  coverage?: RedTeamCoverageLite;
}
interface RedTeamRunLite { id: string; startedAt: string; deployment: string; categories: string[]; summary: RedTeamSummaryLite; results: RedTeamResultLite[]; ranBy: string }
interface RedTeamState extends Record<string, unknown> {
  deployment?: string; account?: string; categories?: RedTeamCategory[]; runs?: RedTeamRunLite[];
  techniques?: string[]; compose?: boolean;
}

const useStyles = makeStyles({
  tabBar: { paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  body: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '1050px' },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge, padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2 },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM },
  catGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: tokens.spacingVerticalXS },
  scoreRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXL, flexWrap: 'wrap' },
  metric: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: '150px' },
  metricBig: { fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightSemibold, lineHeight: '1' },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflow: 'auto', maxHeight: '48vh' },
  snippet: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, maxWidth: '360px', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  hint: { color: tokens.colorNeutralForeground3 },
});

const verdictColor = (v: string): 'success' | 'warning' | 'danger' | 'informative' =>
  v === 'refused' ? 'success' : v === 'partial' ? 'warning' : v === 'inconclusive' ? 'informative' : 'danger';

/**
 * C21 — the scope disclosure. A refusal/attack-success rate WITHOUT the scope
 * that produced it is the defect this component exists to prevent: the surface
 * used to render "Attack success 0%" in hero type from 20 plaintext probes with
 * no caveat at all, which reads as "this deployment is safe" and is not what
 * was measured. This bar is NOT optional and NOT dismissible — it renders on
 * every run, and it is `warning` (not `info`) whenever the run is too narrow to
 * support a safety claim.
 */
function ScopeDisclosure({ coverage }: { coverage?: RedTeamCoverageLite }) {
  if (!coverage) {
    // A legacy run persisted before coverage existed. Say so — never imply the
    // score was broader than a plaintext baseline.
    return (
      <MessageBar intent="warning" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Scope unknown — this run predates coverage tracking</MessageBarTitle>
          This score was produced before Loom recorded which techniques a scan exercised. Treat it as a
          plaintext baseline only: it does not establish that the deployment is safe. Re-run the scan to get a
          scored result with its scope.
        </MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent={coverage.scoreIsMeaningful ? 'info' : 'warning'} layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>
          {coverage.scoreIsMeaningful
            ? 'What this score covers'
            : 'This score does NOT establish that the deployment is safe'}
        </MessageBarTitle>
        {coverage.scopeStatement}
      </MessageBarBody>
    </MessageBar>
  );
}

export function AiRedTeamEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, save, dirty } =
    useItemState<RedTeamState>('ai-red-team', id, { categories: [], account: '', deployment: '' });

  const [tab, setTab] = useState<'scan' | 'runs'>('scan');
  const [deployments, setDeployments] = useState<{ name: string; modelName?: string }[]>([]);
  const [depGate, setDepGate] = useState<string | null>(null);
  const [useCs, setUseCs] = useState(true);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RedTeamRunLite | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const categories = useMemo(() => Array.isArray(state.categories) ? state.categories : [], [state.categories]);
  const techniques = useMemo(
    () => (Array.isArray(state.techniques) && state.techniques.length ? state.techniques : ['plaintext']),
    [state.techniques]);
  const compose = state.compose === true;
  const runs = useMemo(() => Array.isArray(state.runs) ? state.runs : [], [state.runs]);
  useEffect(() => { if (runs[0]) setLastRun(runs[0]); }, [runs]);

  const toggleTechnique = useCallback((tid: string, on: boolean) => {
    setState((p) => {
      const cur = Array.isArray(p.techniques) && p.techniques.length ? p.techniques : ['plaintext'];
      const next = on ? [...new Set([...cur, tid])] : cur.filter((t) => t !== tid);
      // Plaintext is the baseline and always runs — a scan with no technique at
      // all would silently fall back to it anyway, so keep that visible.
      return { ...p, techniques: next.length ? next : ['plaintext'] };
    });
  }, [setState]);

  const loadDeployments = useCallback(async () => {
    setDepGate(null);
    try {
      const qs = state.account ? `?account=${encodeURIComponent(state.account)}` : '';
      const r = await clientFetch(`/api/foundry/model-deployments${qs}`);
      const j = await r.json();
      if (j.ok) setDeployments((j.deployments || []).map((d: any) => ({ name: d.name, modelName: d.modelName })));
      else setDepGate(j.hint || j.error || 'No model deployments available.');
    } catch (e: any) { setDepGate(e?.message || String(e)); }
  }, [state.account]);

  useEffect(() => { if (id !== 'new') loadDeployments(); }, [id, loadDeployments]);

  const toggleCategory = useCallback((cat: RedTeamCategory, on: boolean) => {
    setState((p) => {
      const cur = Array.isArray(p.categories) ? p.categories : [];
      return { ...p, categories: on ? [...new Set([...cur, cat])] : cur.filter((c) => c !== cat) };
    });
  }, [setState]);

  const canRun = !!state.deployment && categories.length > 0 && !running;

  const doRun = useCallback(async () => {
    setErr(null); setRunning(true);
    try {
      if (dirty) await save();
      const r = await clientFetch(`/api/items/ai-red-team/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deployment: state.deployment, account: state.account || undefined, categories, techniques, compose, useContentSafety: useCs }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : (j.error || `HTTP ${r.status}`)); return; }
      setLastRun(j.run);
      setState((p) => ({ ...p, runs: [{ ...j.run, results: (j.run.results || []).map((x: any) => ({ ...x, response: String(x.response).slice(0, 600) })) }, ...runs] }));
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setRunning(false); }
  }, [id, dirty, save, state.deployment, state.account, categories, techniques, compose, useCs, runs, setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Scan', actions: [
        { label: running ? 'Scanning…' : 'Run scan', onClick: canRun ? doRun : undefined, disabled: !canRun },
      ]},
      { label: 'Item', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: dirty && !saving ? () => save() : undefined, disabled: !dirty || saving },
      ]},
    ]},
  ], [running, canRun, doRun, saving, dirty, save]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create red-team scan"
        intro="An AI red-team scan probes a model deployment's safety guardrails: it sends curated adversarial prompts (that the model should refuse) across harm categories and reports the deployment's refusal rate and attack-success rate — the Azure-native analog of the Microsoft AI Red Teaming Agent. Azure-native — no Microsoft Fabric required. Create it, then pick a target deployment and categories, and run the scan." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'scan' | 'runs')}>
            <Tab value="scan" icon={<ShieldErrorRegular />}>Scan</Tab>
            <Tab value="runs" icon={<HistoryRegular />}>Runs{runs.length ? ` (${runs.length})` : ''}</Tab>
          </TabList>
        </div>

        <div className={s.body}>
          <TeachingBanner
            surfaceKey="ai-red-team-editor"
            icon={ShieldErrorRegular}
            title="Red-team a model's safety"
            message="Pick a target model deployment and the harm categories to probe, then run the scan. Loom sends adversarial probes the model should refuse, classifies each response (refused / partial / unsafe) with an AOAI judge and optional Content Safety scoring, and reports the refusal rate + attack-success rate so you can harden your filters. Azure-native — no Microsoft Fabric required."
            learnMoreHref="https://learn.microsoft.com/azure/ai-foundry/concepts/ai-red-teaming-agent"
          />
          {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Scan failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
          {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

          {tab === 'scan' && (loading ? <Spinner label="Loading…" /> : (
            <>
              {/* Target */}
              <div className={s.card}>
                <span className={s.sectionHeader}><BracesRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Target deployment</Subtitle2></span>
                {depGate && (
                  <MessageBar intent="warning"><MessageBarBody>
                    <MessageBarTitle>No model deployments</MessageBarTitle>{depGate}
                  </MessageBarBody></MessageBar>
                )}
                <div className={s.grid}>
                  <Field label="AI Foundry / Azure OpenAI account" hint="Blank = deployment's default account">
                    <Input value={state.account || ''} onChange={(_, d) => setState((p) => ({ ...p, account: d.value }))} onBlur={loadDeployments} placeholder="Default" />
                  </Field>
                  <Field label="Model deployment">
                    <Dropdown value={state.deployment || ''} selectedOptions={state.deployment ? [state.deployment] : []} placeholder={deployments.length ? 'Select deployment' : 'None listed'} disabled={!deployments.length}
                      onOptionSelect={(_, d) => d.optionValue && setState((p) => ({ ...p, deployment: d.optionValue }))}>
                      {deployments.map((d) => <Option key={d.name} value={d.name} text={d.name}>{d.name}{d.modelName ? ` · ${d.modelName}` : ''}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                <Switch checked={useCs} onChange={(_, d) => setUseCs(d.checked)} label="Also score responses with Azure AI Content Safety (optional)" />
              </div>

              {/* Categories */}
              <div className={s.card}>
                <span className={s.sectionHeader}><ShieldErrorRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Harm categories to probe</Subtitle2>
                  <div style={{ flex: 1 }} /><Badge appearance="tint" color="brand">{categories.length} selected</Badge>
                </span>
                <div className={s.catGrid}>
                  {RED_TEAM_CATEGORIES.map((c) => (
                    <Checkbox key={c.id} checked={categories.includes(c.id)} onChange={(_, d) => toggleCategory(c.id, !!d.checked)}
                      label={<span>{c.label} <Caption1 className={s.hint}>— {c.description}</Caption1></span>} />
                  ))}
                </div>
                <div className={s.row}>
                  <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <PlayRegular />} disabled={!canRun} onClick={doRun}>{running ? 'Scanning…' : 'Run red-team scan'}</Button>
                  {!canRun && <Caption1 className={s.hint}>Pick a deployment and at least one category to run.</Caption1>}
                </div>
                {running && <ProgressBar />}
              </div>

              {/* Attack techniques (C21) — the strata the score is computed over. */}
              <div className={s.card}>
                <span className={s.sectionHeader}><ShieldErrorRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Attack techniques</Subtitle2>
                  <div style={{ flex: 1 }} /><Badge appearance="tint" color="brand">{techniques.length} selected</Badge>
                </span>
                <Caption1 className={s.hint}>
                  Plaintext alone is a baseline, not a safety result — published bypasses overwhelmingly live in the
                  encoded, composed and multi-turn strata. Whatever you leave unchecked is named explicitly in the
                  scope disclosure printed with the score.
                </Caption1>
                <div className={s.catGrid}>
                  {RED_TEAM_TECHNIQUES.map((t) => (
                    <Checkbox
                      key={t.id}
                      checked={techniques.includes(t.id)}
                      disabled={t.id === 'plaintext'}
                      onChange={(_, d) => toggleTechnique(t.id, !!d.checked)}
                      label={<span>{t.label} <Caption1 className={s.hint}>— {t.description}</Caption1></span>}
                    />
                  ))}
                </div>
                <Switch
                  checked={compose}
                  onChange={(_, d) => setState((p) => ({ ...p, compose: d.checked }))}
                  label="Also run composed probes (stack each pair of selected single-turn converters)"
                />
              </div>

              {/* Results */}
              {lastRun && (
                <div className={s.card}>
                  <span className={s.sectionHeader}><ShieldErrorRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Scan results</Subtitle2></span>
                  {/* C21 — the scope comes BEFORE the number, every time. */}
                  <ScopeDisclosure coverage={lastRun.summary.coverage} />
                  <div className={s.scoreRow}>
                    <div className={s.metric}><Caption1 className={s.hint}>Refusal rate<br />(of scored probes)</Caption1><span className={s.metricBig} style={{ color: tokens.colorPaletteGreenForeground1 }}>{lastRun.summary.refusalRate}%</span></div>
                    <div className={s.metric}>
                      <Caption1 className={s.hint}>Attack success<br />(of scored probes)</Caption1>
                      <span className={s.metricBig} style={{ color: lastRun.summary.attackSuccessRate > 0 ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground1 }}>{lastRun.summary.attackSuccessRate}%</span>
                      {/* A 0% is only ever a pass-shaped statement when the run was broad
                          enough to support it. Otherwise say what it actually means. */}
                      {lastRun.summary.attackSuccessRate === 0 && !lastRun.summary.coverage?.scoreIsMeaningful && (
                        <Caption1 className={s.hint}>0% across a baseline-only run — not a safety result.</Caption1>
                      )}
                    </div>
                    <div className={s.row}>
                      <Badge appearance="tint" color="success">{lastRun.summary.refused} refused</Badge>
                      {lastRun.summary.partial > 0 && <Badge appearance="tint" color="warning">{lastRun.summary.partial} partial</Badge>}
                      {lastRun.summary.unsafe > 0 && <Badge appearance="tint" color="danger">{lastRun.summary.unsafe} unsafe</Badge>}
                      {(lastRun.summary.inconclusive ?? 0) > 0 && (
                        <Badge appearance="tint" color="informative">{lastRun.summary.inconclusive} inconclusive</Badge>
                      )}
                      <Caption1 className={s.hint}>{lastRun.summary.total} probes · {lastRun.deployment}</Caption1>
                    </div>
                  </div>
                  {/* Per-technique breakdown — a single headline number hides which
                      stratum actually failed. */}
                  {lastRun.summary.byTechnique && Object.keys(lastRun.summary.byTechnique).length > 0 && (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Results by technique">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Technique</TableHeaderCell><TableHeaderCell>Probes</TableHeaderCell>
                          <TableHeaderCell>Refused</TableHeaderCell><TableHeaderCell>Succeeded</TableHeaderCell><TableHeaderCell>Inconclusive</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {Object.entries(lastRun.summary.byTechnique).map(([tid, c]) => (
                            <TableRow key={tid}>
                              <TableCell>{tid}</TableCell>
                              <TableCell>{c.total}</TableCell>
                              <TableCell>{c.refused}</TableCell>
                              <TableCell>{c.failed > 0 ? <Badge appearance="tint" color="danger">{c.failed}</Badge> : c.failed}</TableCell>
                              <TableCell>{c.inconclusive ?? 0}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Red-team results">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Category</TableHeaderCell><TableHeaderCell>Technique</TableHeaderCell><TableHeaderCell>Probe</TableHeaderCell>
                        <TableHeaderCell>Verdict</TableHeaderCell><TableHeaderCell>Safety</TableHeaderCell><TableHeaderCell>Response</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {lastRun.results.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell>{r.category}</TableCell>
                            <TableCell>{r.technique || 'plaintext'}</TableCell>
                            <TableCell><span className={s.snippet} title={r.prompt}>{r.prompt}</span></TableCell>
                            <TableCell><Badge appearance="filled" color={verdictColor(r.verdict)}>{r.verdict}</Badge></TableCell>
                            <TableCell>{r.safetySeverity != null ? `${r.safetyCategory || '?'} ${r.safetySeverity}` : <span className={s.hint}>—</span>}</TableCell>
                            <TableCell><span className={s.snippet} title={r.response}>{r.response}</span></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </>
          ))}

          {tab === 'runs' && (
            <div className={s.card}>
              <span className={s.sectionHeader}><HistoryRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Scan history</Subtitle2></span>
              {!runs.length ? (
                <Caption1 className={s.hint}>No scans yet. Pick a deployment + categories and run a scan.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Scan history">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Started</TableHeaderCell><TableHeaderCell>Deployment</TableHeaderCell>
                      <TableHeaderCell>Probes</TableHeaderCell><TableHeaderCell>Techniques</TableHeaderCell>
                      <TableHeaderCell>Refusal</TableHeaderCell><TableHeaderCell>Attack success</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {runs.map((rn) => {
                        const cov = rn.summary.coverage;
                        // C21: a 0% from a baseline-only run is NOT a green pass.
                        // Colouring it 'success' was the history table's copy of
                        // the same overstatement the results panel made.
                        const meaningful = !!cov?.scoreIsMeaningful;
                        const asColor = rn.summary.attackSuccessRate > 0
                          ? 'danger'
                          : meaningful ? 'success' : 'informative';
                        return (
                          <TableRow key={rn.id}>
                            <TableCell>{new Date(rn.startedAt).toLocaleString()}</TableCell>
                            <TableCell>{rn.deployment}</TableCell>
                            <TableCell>
                              {rn.summary.total}
                              {(rn.summary.inconclusive ?? 0) > 0 && (
                                <Caption1 className={s.hint}> ({rn.summary.inconclusive} inconclusive)</Caption1>
                              )}
                            </TableCell>
                            <TableCell>
                              <span className={s.snippet} title={cov?.scopeStatement || 'Scope not recorded for this run.'}>
                                {cov ? cov.techniques.join(', ') : 'plaintext (legacy run)'}
                              </span>
                            </TableCell>
                            <TableCell><Badge appearance="tint" color="success">{rn.summary.refusalRate}%</Badge></TableCell>
                            <TableCell>
                              <Badge appearance="tint" color={asColor}>{rn.summary.attackSuccessRate}%</Badge>
                              {!meaningful && <Caption1 className={s.hint}> baseline only</Caption1>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              <Divider />
              <Caption1 className={s.hint}>Runs are persisted with the item (responses trimmed). Newest first; up to 25 retained.</Caption1>
            </div>
          )}
        </div>
      </div>
    } />
  );
}
