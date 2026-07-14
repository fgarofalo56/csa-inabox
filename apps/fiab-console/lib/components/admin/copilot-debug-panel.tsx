'use client';

/**
 * CTS-03 — Copilot deep-trace debug panel (Tier 3, admin-only).
 *
 * Loads the per-turn deep trace for a Copilot session and renders it across
 * tabs: Timeline (per-phase ms bar chart), Tools (per-tool table with via-server),
 * Knowledge (grounding citations), Routing (model/tier/agent), and JSON (raw,
 * secret-redacted step payloads with a raw-override toggle). Fluent v9 + Loom
 * tokens, EmptyState primitive, no raw px. Real backend:
 * GET /api/copilot/sessions/[id]/trace (tenant-admin gated).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useState } from 'react';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Input, Switch, Spinner, Field,
  TabList, Tab, MessageBar, MessageBarBody,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  BugRegular, Search20Regular, Timeline20Regular, Wrench16Regular,
  BookInformationRegular, Flow16Regular, Code16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

interface PhaseTiming { phase: string; ms: number }
interface TraceTool { name: string; serverName?: string; durationMs: number; ok: boolean; error?: string }
interface Turn {
  index: number; prompt: string; model?: string; provider?: string;
  usage?: Record<string, number>; latencyMs?: number; costUsd?: number; routedTier?: string;
  routedAgentName?: string; routedReason?: string; phaseTimings: PhaseTiming[];
  tools: TraceTool[]; citations: Array<Record<string, unknown>>; contextUsage?: Record<string, unknown>;
  steps: Array<Record<string, unknown>>; error?: string;
}

const PHASE_LABEL: Record<string, string> = {
  classify: 'Classify', 'prompt-build': 'Prompt build', llm: 'LLM streaming', tools: 'Tool execution',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  headIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', height: '32px', flexShrink: 0, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  toolbar: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '260px' },
  turnBar: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  metaRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  timelineRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  timelineLabel: { width: '120px', flexShrink: 0 },
  barTrack: {
    flex: 1, height: '18px', borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3, overflow: 'hidden',
  },
  barFill: { height: '100%', backgroundColor: tokens.colorBrandBackground, borderRadius: tokens.borderRadiusSmall },
  barMs: { width: '72px', textAlign: 'right', flexShrink: 0 },
  tableWrap: { overflowX: 'auto' },
  json: {
    margin: 0, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    overflowX: 'auto', maxHeight: '460px',
  },
});

export function CopilotDebugPanel() {
  const styles = useStyles();
  const [sessionId, setSessionId] = useState('');
  const [raw, setRaw] = useState(false);
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState<'timeline' | 'tools' | 'knowledge' | 'routing' | 'json'>('timeline');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);

  const load = useCallback(() => {
    const id = sessionId.trim();
    if (!id) return;
    setLoading(true); setError(null); setGate(null); setTurns(null);
    clientFetch(`/api/copilot/sessions/${encodeURIComponent(id)}/trace${raw ? '?raw=1' : ''}`, { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) {
          const j = await r.json().catch(() => ({}));
          setGate(j?.remediation || 'The deep-trace panel is a tenant-admin surface.');
          return null;
        }
        return r.json();
      })
      .then((j: any) => {
        if (!j) return;
        if (j.ok) { setTurns(j.turns || []); setActive(0); }
        else setError(j.error || 'Failed to load trace');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [sessionId, raw]);

  const turn = turns && turns.length > 0 ? turns[Math.min(active, turns.length - 1)] : null;
  const maxPhaseMs = turn ? Math.max(1, ...turn.phaseTimings.map((p) => p.ms)) : 1;

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.headIcon} aria-hidden><BugRegular /></span>
        <Subtitle2>Copilot deep trace</Subtitle2>
        <Badge appearance="tint" color="warning">Admin</Badge>
      </div>
      <Body1 className={styles.intro}>
        Operator-only introspection for a single Copilot turn — per-phase timing, the tool roll-up, grounding
        sources, routing, and the raw step payloads (secrets redacted by default). Paste a session id from the
        Copilot session list to load its trace.
      </Body1>

      <div className={styles.toolbar}>
        <Field label="Session id" className={styles.grow}>
          <Input value={sessionId} placeholder="e.g. 8f3c…" contentBefore={<Search20Regular />}
                 onChange={(_, d) => setSessionId(d.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
        </Field>
        <Switch checked={raw} label="Raw (un-redacted)" onChange={(_, d) => setRaw(d.checked)} />
        <Button appearance="primary" icon={<Search20Regular />} onClick={load} disabled={loading || !sessionId.trim()}>
          {loading ? 'Loading…' : 'Load trace'}
        </Button>
      </div>

      {gate && <MessageBar intent="warning"><MessageBarBody>{gate}</MessageBarBody></MessageBar>}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      {turns && turns.length === 0 && (
        <EmptyState icon={<BugRegular />} title="No turns in this session"
                    body="The session has no completed turns to trace, or the id was not found." />
      )}

      {turn && (
        <div className={styles.card}>
          {turns!.length > 1 && (
            <div className={styles.turnBar}>
              {turns!.map((t) => (
                <Button key={t.index} size="small" appearance={t.index === active ? 'primary' : 'secondary'}
                        onClick={() => setActive(t.index)}>Turn {t.index + 1}</Button>
              ))}
            </div>
          )}

          <div className={styles.metaRow}>
            {turn.model && <Badge appearance="tint" color="brand">{turn.model}</Badge>}
            {turn.provider && <Caption1 className={styles.muted}>{turn.provider}</Caption1>}
            {typeof turn.latencyMs === 'number' && <Badge appearance="outline">{turn.latencyMs} ms</Badge>}
            {typeof turn.costUsd === 'number' && <Badge appearance="outline">${turn.costUsd.toFixed(4)}</Badge>}
            {turn.usage?.totalTokens != null && <Caption1 className={styles.muted}>{turn.usage.totalTokens} tok</Caption1>}
            {turn.error && <Badge appearance="tint" color="danger">error</Badge>}
          </div>
          <Caption1 className={styles.muted}>{turn.prompt || '(no prompt captured)'}</Caption1>

          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="timeline" icon={<Timeline20Regular />}>Timeline</Tab>
            <Tab value="tools" icon={<Wrench16Regular />}>Tools ({turn.tools.length})</Tab>
            <Tab value="knowledge" icon={<BookInformationRegular />}>Knowledge ({turn.citations.length})</Tab>
            <Tab value="routing" icon={<Flow16Regular />}>Routing</Tab>
            <Tab value="json" icon={<Code16Regular />}>JSON</Tab>
          </TabList>

          {tab === 'timeline' && (
            turn.phaseTimings.length === 0
              ? <Caption1 className={styles.muted}>No phase timings recorded for this turn.</Caption1>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                  {turn.phaseTimings.map((p) => (
                    <div key={p.phase} className={styles.timelineRow}>
                      <Caption1 className={styles.timelineLabel}>{PHASE_LABEL[p.phase] || p.phase}</Caption1>
                      <div className={styles.barTrack}>
                        <div className={styles.barFill} style={{ width: `${Math.round((p.ms / maxPhaseMs) * 100)}%` }} />
                      </div>
                      <Caption1 className={styles.barMs}>{p.ms} ms</Caption1>
                    </div>
                  ))}
                </div>
              )
          )}

          {tab === 'tools' && (
            turn.tools.length === 0
              ? <Caption1 className={styles.muted}>No tools were called this turn.</Caption1>
              : (
                <div className={styles.tableWrap}>
                  <Table aria-label="Tools">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Tool</TableHeaderCell>
                        <TableHeaderCell>Via</TableHeaderCell>
                        <TableHeaderCell>Duration</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {turn.tools.map((t, i) => (
                        <TableRow key={`${t.name}-${i}`}>
                          <TableCell>{t.name}</TableCell>
                          <TableCell><Caption1 className={styles.muted}>{t.serverName ? `via ${t.serverName}` : 'built-in'}</Caption1></TableCell>
                          <TableCell>{t.durationMs} ms</TableCell>
                          <TableCell>
                            <Badge appearance="tint" color={t.ok ? 'success' : 'danger'}>{t.ok ? 'ok' : 'error'}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )
          )}

          {tab === 'knowledge' && (
            turn.citations.length === 0
              ? <Caption1 className={styles.muted}>No grounding sources this turn.</Caption1>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                  {turn.citations.map((c, i) => (
                    <div key={i} className={styles.metaRow}>
                      <Badge appearance="outline">{String(c.kind ?? 'source')}</Badge>
                      <Caption1>{String(c.heading ?? c.path ?? c.id ?? '')}</Caption1>
                      <Caption1 className={styles.muted}>{String(c.preview ?? '').slice(0, 120)}</Caption1>
                    </div>
                  ))}
                </div>
              )
          )}

          {tab === 'routing' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <Caption1><strong>Model:</strong> {turn.model || '—'} ({turn.provider || '—'})</Caption1>
              <Caption1><strong>Tier:</strong> {turn.routedTier || 'default'}</Caption1>
              <Caption1><strong>Routed agent:</strong> {turn.routedAgentName || '— (single-agent turn)'}</Caption1>
              {turn.routedReason && <Caption1 className={styles.muted}>{turn.routedReason}</Caption1>}
              {turn.contextUsage && (
                <Caption1 className={styles.muted}>
                  Context: {String((turn.contextUsage as any).utilizationPct ?? '?')}% of {String((turn.contextUsage as any).contextWindow ?? '?')} tokens
                </Caption1>
              )}
            </div>
          )}

          {tab === 'json' && (
            <pre className={styles.json}>{JSON.stringify(turn.steps, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}
