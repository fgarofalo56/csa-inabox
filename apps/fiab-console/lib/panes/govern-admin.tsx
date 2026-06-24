'use client';

/**
 * GovernAdminPane — the Govern → Admin view (F2), one-for-one with the
 * Microsoft Purview / Fabric admin "Govern" monitoring experience, Loom-themed.
 *
 * Three real sub-tabs, each backed by live aggregates from
 * GET /api/governance/govern/posture (Cosmos + Graph + Monitor + Purview):
 *
 *   1. Manage estate          — workspace / item / capacity / domain counts +
 *                               Log Analytics KQL feature usage.
 *   2. Protect, secure, comply — Graph IP (MIP) coverage %, DLP violations +
 *                               last violation, Purview last-scan + a real
 *                               trigger-scan control.
 *   3. Discover, trust, reuse — freshness / description / endorsement coverage +
 *                               30-day sharing + recommended-action cards.
 *
 * A Governance Copilot bar (Azure OpenAI GPT-4o, grounded on the live posture
 * JSON) floats above all tabs; each tab has a "View more" → embedded Power BI
 * (Commercial) / Managed Grafana (Gov) report.
 *
 * Every metric whose backend isn't provisioned renders a NotConfiguredBar
 * naming the exact env var (per no-vaporware.md). No mock data.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Tab, TabList, Spinner, Text, Caption1, Badge, Button, Dropdown, Option,
  Textarea, Spinner as FluentSpinner, makeStyles, tokens, type SelectionEvents, type OptionOnSelectData,
} from '@fluentui/react-components';
import {
  Box20Regular, DataTrending20Regular, Shield20Regular,
  Branch20Regular, Server20Regular, Globe20Regular, Sparkle20Regular,
  ShieldCheckmark20Regular, History20Regular, Open16Regular, ArrowSync16Regular,
  DocumentText20Regular, Share20Regular, ChartMultiple20Regular, Warning20Regular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { NotConfiguredBar, type NotConfiguredHint } from '@/lib/components/admin-security/not-configured-bar';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';

// ---------------------------------------------------------------------------
// API shapes (mirrors lib/azure/posture-client.ts)
// ---------------------------------------------------------------------------

interface PostureDoc {
  id: string; tenantId: string; updatedAt: string;
  workspaceCount: number; totalItems: number; capacityCount: number; domainCount: number;
  mipCoveragePct: number | null; mipLabelCount: number | null;
  dlpViolations30d: number | null; dlpLastViolationAt: string | null;
  purviewLastScanAt: string | null;
  freshItemsPct: number; describedItemsPct: number; endorsedItemsPct: number; sharedItems30d: number;
}
type PostureGates = Partial<Record<'mip' | 'dlp' | 'purview' | 'featureUsage', NotConfiguredHint>>;
interface FeatureUsageRow { feature: string; hits: number }
interface PostureResponse {
  ok: boolean;
  posture?: PostureDoc;
  gates?: PostureGates;
  featureUsage?: FeatureUsageRow[] | null;
  precomputedAt?: string | null;
  source?: string;
  code?: string;
  hint?: NotConfiguredHint;
  reason?: string;
  remediation?: string;
}
interface RecommendedAction {
  id: string; title: string; description?: string;
  priority?: 'high' | 'medium' | 'low'; ctaLabel?: string; ctaHref?: string;
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  tabBar: { marginBottom: tokens.spacingVerticalL },
  tilesRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2, minWidth: 0,
  },
  tileHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  chip: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '36px', height: '36px', borderRadius: tokens.borderRadiusLarge,
  },
  tileVal: {
    fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: 1.1,
    color: tokens.colorNeutralForeground1,
  },
  tileLabel: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  tileFoot: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  bar: {
    height: '6px', backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusCircular,
    overflow: 'hidden', marginTop: tokens.spacingVerticalXS,
  },
  barFill: { height: '100%', borderRadius: tokens.borderRadiusCircular },
  copilotBar: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: `linear-gradient(120deg, ${tokens.colorNeutralBackground1}, ${tokens.colorBrandBackground2})`,
    boxShadow: tokens.shadow2, marginBottom: tokens.spacingVerticalL,
  },
  copilotRow: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  copilotInput: { flex: 1, minWidth: '260px' },
  copilotAnswer: {
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300, lineHeight: 1.5,
    maxHeight: '420px', overflowY: 'auto',
  },
  actionCards: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacingHorizontalL,
  },
  actionCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  embedShell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  empty: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase300 },
  scanRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
});

type AdminTab = 'estate' | 'protect' | 'discover';

// ---------------------------------------------------------------------------
// Tile primitive
// ---------------------------------------------------------------------------

function MetricTile({
  icon: Icon, color, label, value, source, pctValue,
}: {
  icon: FluentIcon; color: string; label: string; value: string;
  source?: string; pctValue?: number | null;
}) {
  const s = useStyles();
  return (
    <div className={s.tile}>
      <div className={s.tileHead}>
        <span className={s.chip} style={{ backgroundColor: `${color}1f` }} aria-hidden>
          <Icon style={{ width: 20, height: 20, color }} />
        </span>
        <Text className={s.tileVal}>{value}</Text>
      </div>
      <div className={s.tileFoot}>
        <Text className={s.tileLabel}>{label}</Text>
        {source && <Badge appearance="tint" color="informative" size="small">{source}</Badge>}
      </div>
      {typeof pctValue === 'number' && (
        <div className={s.bar}>
          <div className={s.barFill} style={{ width: `${Math.max(0, Math.min(100, pctValue))}%`, backgroundColor: color }} />
        </div>
      )}
    </div>
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleString();
}

// ---------------------------------------------------------------------------
// Governance Copilot bar (AOAI GPT-4o, grounded on live posture JSON)
// ---------------------------------------------------------------------------

function PostureCopilotBar({ chartData }: { chartData: unknown }) {
  const s = useStyles();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<NotConfiguredHint | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true); setAnswer(''); setGate(null); setError(null);
    try {
      const res = await fetch('/api/governance/govern/copilot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, chartData }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j?.code === 'no_aoai' && j?.hint) setGate(j.hint);
        else setError(j?.error || `Copilot failed (${res.status})`);
        return;
      }
      if (!res.body) { setError('No response stream'); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      // Parse OpenAI-compatible SSE chunks: lines beginning "data: {json}".
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') { acc += delta; setAnswer(acc); }
          } catch { /* partial json across chunks — ignore */ }
        }
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [question, chartData, busy]);

  return (
    <div className={s.copilotBar}>
      <div className={s.copilotRow}>
        <span className={s.chip} style={{ backgroundColor: 'var(--loom-accent-violet, #8b5cf6)1f' }} aria-hidden>
          <Sparkle20Regular style={{ width: 20, height: 20, color: 'var(--loom-accent-violet, #8b5cf6)' }} />
        </span>
        <Textarea
          className={s.copilotInput}
          value={question}
          placeholder="Ask the Governance Copilot about this posture — e.g. “Which dimension has the lowest coverage and why?”"
          onChange={(_e, d) => setQuestion(d.value)}
          resize="vertical"
          rows={1}
        />
        <Button appearance="primary" disabled={busy || !question.trim()} onClick={ask} icon={busy ? <FluentSpinner size="tiny" /> : <Sparkle20Regular />}>
          {busy ? 'Asking…' : 'Ask Copilot'}
        </Button>
      </div>
      {gate && <NotConfiguredBar surface="Governance Copilot" hint={gate} />}
      {error && (
        <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Caption1>
      )}
      {answer && <div className={s.copilotAnswer}>{answer}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "View more" embedded report (Power BI Embedded / Managed Grafana)
// ---------------------------------------------------------------------------

interface EmbedResponse {
  ok: boolean; kind?: 'powerbi' | 'grafana';
  reportId?: string; embedUrl?: string; accessToken?: string; iframeUrl?: string;
  code?: string; hint?: NotConfiguredHint; error?: string;
}

function ViewMorePanel() {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<EmbedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/governance/govern/embed');
      const j: EmbedResponse = await res.json();
      setData(j);
      if (!j.ok && !j.hint) setError(j.error || `Embed failed (${res.status})`);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data) void load();
  };

  return (
    <div className={s.embedShell}>
      <div>
        <Button appearance="secondary" icon={<ChartMultiple20Regular />} onClick={toggle}>
          {open ? 'Hide report' : 'View more'}
        </Button>
      </div>
      {open && (
        <>
          {loading && <Spinner size="small" label="Loading embedded report…" labelPosition="after" />}
          {error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Caption1>}
          {data?.hint && (
            <NotConfiguredBar surface="Embedded governance report" hint={data.hint} />
          )}
          {data?.ok && data.kind === 'powerbi' && data.reportId && data.embedUrl && data.accessToken && (
            <PowerBIEmbedFrame
              embedType="report"
              id={data.reportId}
              embedUrl={data.embedUrl}
              accessToken={data.accessToken}
              height={600}
            />
          )}
          {data?.ok && data.kind === 'grafana' && data.iframeUrl && (
            <iframe
              title="Managed Grafana governance dashboard"
              src={data.iframeUrl}
              style={{ width: '100%', height: 600, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-tab: Manage estate
// ---------------------------------------------------------------------------

function ManageEstateTab({ posture, gates, featureUsage }: { posture: PostureDoc; gates: PostureGates; featureUsage: FeatureUsageRow[] | null }) {
  const s = useStyles();
  const cols = useMemo<LoomColumn<FeatureUsageRow>[]>(() => [
    { key: 'feature', label: 'Feature / API', sortable: true, filterable: true, width: 360, getValue: (r) => r.feature, render: (r) => <Text weight="semibold">{r.feature}</Text> },
    { key: 'hits', label: 'Requests (30d)', sortable: true, filterable: false, width: 160, getValue: (r) => r.hits },
  ], []);
  return (
    <>
      <Section title="Estate inventory" actions={<Badge appearance="tint" color="informative">live · Cosmos</Badge>}>
        <div className={s.tilesRow}>
          <MetricTile icon={Server20Regular} color="var(--loom-accent-teal, #14b8a6)" label="Workspaces" value={String(posture.workspaceCount)} source="Cosmos" />
          <MetricTile icon={Box20Regular} color="var(--loom-accent-blue, #3b82f6)" label="Governed items" value={String(posture.totalItems)} source="Cosmos" />
          <MetricTile icon={DataTrending20Regular} color="var(--loom-accent-amber, #f59e0b)" label="Capacities referenced" value={String(posture.capacityCount)} source="Cosmos" />
          <MetricTile icon={Globe20Regular} color="var(--loom-accent-indigo, #6366f1)" label="Domains referenced" value={String(posture.domainCount)} source="Cosmos" />
        </div>
      </Section>
      <Section title="Feature usage" actions={featureUsage ? <Badge appearance="tint" color="informative">live · Log Analytics</Badge> : undefined}>
        {gates.featureUsage ? (
          <NotConfiguredBar surface="Feature usage" hint={gates.featureUsage} />
        ) : (
          <LoomDataTable
            columns={cols}
            rows={featureUsage || []}
            getRowId={(r) => r.feature}
            ariaLabel="Feature usage from Log Analytics"
            empty="No request telemetry in the last 30 days yet."
          />
        )}
      </Section>
      <Section title="Explore estate analytics">
        <ViewMorePanel />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-tab: Protect, secure, comply
// ---------------------------------------------------------------------------

function ProtectSecureComplyTab({ posture, gates }: { posture: PostureDoc; gates: PostureGates }) {
  const s = useStyles();
  const [sources, setSources] = useState<{ name: string }[] | null>(null);
  const [scans, setScans] = useState<{ name: string }[]>([]);
  const [selSource, setSelSource] = useState<string>('');
  const [selScan, setSelScan] = useState<string>('');
  const [scanGate, setScanGate] = useState<NotConfiguredHint | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);

  // Load registered Purview sources for the trigger-scan dropdown.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/governance/govern/trigger-scan');
        const j = await res.json();
        if (j.ok && Array.isArray(j.sources)) setSources(j.sources.map((x: any) => ({ name: x.name })));
        else if (j.code === 'purview_not_configured' && j.hint) setScanGate(j.hint);
        else setSources([]);
      } catch { setSources([]); }
    })();
  }, []);

  const onPickSource = useCallback(async (name: string) => {
    setSelSource(name); setSelScan(''); setScans([]);
    try {
      const res = await fetch(`/api/governance/govern/trigger-scan?source=${encodeURIComponent(name)}`);
      const j = await res.json();
      if (j.ok && Array.isArray(j.scans)) setScans(j.scans.map((x: any) => ({ name: x.name })));
    } catch { /* leave empty */ }
  }, []);

  const runScan = useCallback(async () => {
    if (!selSource || !selScan || scanBusy) return;
    setScanBusy(true); setScanMsg(null);
    try {
      const res = await fetch('/api/governance/govern/trigger-scan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: selSource, scan: selScan }),
      });
      const j = await res.json();
      if (res.status === 202 && j.ok) setScanMsg(`Scan started — run id ${j.runId}. Track it in the Purview portal under Data Map → Sources → Scans.`);
      else if (j.hint) setScanGate(j.hint);
      else setScanMsg(j.error || `Scan failed (${res.status})`);
    } catch (e: any) {
      setScanMsg(e?.message || String(e));
    } finally {
      setScanBusy(false);
    }
  }, [selSource, selScan, scanBusy]);

  return (
    <>
      <Section title="Protection posture" actions={<Badge appearance="tint" color="informative">live</Badge>}>
        <div className={s.tilesRow}>
          {gates.mip ? (
            <div style={{ gridColumn: '1 / -1' }}><NotConfiguredBar surface="Graph IP (sensitivity) coverage" hint={gates.mip} /></div>
          ) : (
            <MetricTile icon={Shield20Regular} color="var(--loom-accent-violet, #8b5cf6)" label={`Sensitivity coverage${posture.mipLabelCount != null ? ` · ${posture.mipLabelCount} labels` : ''}`} value={`${posture.mipCoveragePct ?? 0}%`} source="Graph" pctValue={posture.mipCoveragePct ?? 0} />
          )}
          {gates.dlp ? (
            <div style={{ gridColumn: '1 / -1' }}><NotConfiguredBar surface="DLP violations" hint={gates.dlp} /></div>
          ) : (
            <MetricTile icon={Warning20Regular} color="var(--loom-accent-orange, #f97316)" label={`DLP violations (30d) · last ${fmtDate(posture.dlpLastViolationAt)}`} value={String(posture.dlpViolations30d ?? 0)} source="Graph" />
          )}
          {gates.purview ? (
            <div style={{ gridColumn: '1 / -1' }}><NotConfiguredBar surface="Purview scan history" hint={gates.purview} /></div>
          ) : (
            <MetricTile icon={History20Regular} color="var(--loom-accent-teal, #14b8a6)" label="Last Purview scan" value={fmtDate(posture.purviewLastScanAt)} source="Purview" />
          )}
        </div>
      </Section>

      <Section title="Trigger a scan" actions={<Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Runs a real classic Purview Data Map scan.</Caption1>}>
        {scanGate ? (
          <NotConfiguredBar surface="Purview scan" hint={scanGate} />
        ) : (
          <>
            <div className={s.scanRow}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 220 }}>
                <Caption1>Registered source</Caption1>
                <Dropdown
                  placeholder={sources === null ? 'Loading sources…' : 'Select a source'}
                  disabled={!sources || sources.length === 0}
                  value={selSource}
                  selectedOptions={selSource ? [selSource] : []}
                  onOptionSelect={(_e: SelectionEvents, d: OptionOnSelectData) => { if (d.optionValue) void onPickSource(d.optionValue); }}
                >
                  {(sources || []).map((src) => <Option key={src.name} value={src.name}>{src.name}</Option>)}
                </Dropdown>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 220 }}>
                <Caption1>Scan</Caption1>
                <Dropdown
                  placeholder={selSource ? 'Select a scan' : 'Pick a source first'}
                  disabled={!selSource || scans.length === 0}
                  value={selScan}
                  selectedOptions={selScan ? [selScan] : []}
                  onOptionSelect={(_e: SelectionEvents, d: OptionOnSelectData) => setSelScan(d.optionValue || '')}
                >
                  {scans.map((sc) => <Option key={sc.name} value={sc.name}>{sc.name}</Option>)}
                </Dropdown>
              </div>
              <Button appearance="primary" icon={scanBusy ? <FluentSpinner size="tiny" /> : <ArrowSync16Regular />} disabled={!selSource || !selScan || scanBusy} onClick={runScan}>
                {scanBusy ? 'Starting…' : 'Run scan'}
              </Button>
            </div>
            {scanMsg && <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground2 }}>{scanMsg}</Caption1>}
            {sources && sources.length === 0 && (
              <Caption1 style={{ display: 'block', marginTop: 8 }} className={s.empty}>No registered Purview sources — register one under Governance → Scans &amp; sources.</Caption1>
            )}
          </>
        )}
      </Section>

      <Section title="Explore compliance analytics">
        <ViewMorePanel />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-tab: Discover, trust, reuse
// ---------------------------------------------------------------------------

function DiscoverTrustReuseTab({ posture }: { posture: PostureDoc }) {
  const s = useStyles();
  const [actions, setActions] = useState<RecommendedAction[] | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/governance/govern/actions');
        const j = await res.json();
        setActions(j.ok && Array.isArray(j.actions) ? j.actions : []);
      } catch { setActions([]); }
    })();
  }, []);

  const priorityColor = (p?: string) => p === 'high' ? 'danger' : p === 'medium' ? 'warning' : 'informative';

  return (
    <>
      <Section title="Trust & reuse posture" actions={<Badge appearance="tint" color="informative">live · Cosmos</Badge>}>
        <div className={s.tilesRow}>
          <MetricTile icon={History20Regular} color="var(--loom-accent-teal, #14b8a6)" label="Fresh items (updated 30d)" value={`${posture.freshItemsPct}%`} source="Cosmos" pctValue={posture.freshItemsPct} />
          <MetricTile icon={DocumentText20Regular} color="var(--loom-accent-blue, #3b82f6)" label="Described items" value={`${posture.describedItemsPct}%`} source="Cosmos" pctValue={posture.describedItemsPct} />
          <MetricTile icon={ShieldCheckmark20Regular} color="var(--loom-accent-green, #22c55e)" label="Endorsed items" value={`${posture.endorsedItemsPct}%`} source="Cosmos" pctValue={posture.endorsedItemsPct} />
          <MetricTile icon={Share20Regular} color="var(--loom-accent-violet, #8b5cf6)" label="Shares (30d)" value={String(posture.sharedItems30d)} source="Audit" />
        </div>
      </Section>

      <Section title="Recommended actions" actions={<Caption1 style={{ color: tokens.colorNeutralForeground3 }}>From the governance remediation engine.</Caption1>}>
        {actions === null && <Spinner size="small" label="Loading…" labelPosition="after" />}
        {actions !== null && actions.length === 0 && (
          <Caption1 className={s.empty}>No recommended actions for this tenant. Coverage looks healthy — re-check after the next posture refresh.</Caption1>
        )}
        {actions !== null && actions.length > 0 && (
          <div className={s.actionCards}>
            {actions.slice(0, 6).map((a) => (
              <div key={a.id} className={s.actionCard}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Text weight="semibold">{a.title}</Text>
                  <Badge appearance="tint" color={priorityColor(a.priority) as any} size="small">{a.priority || 'low'}</Badge>
                </div>
                {a.description && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{a.description}</Caption1>}
                {a.ctaHref && (
                  <Button as="a" href={a.ctaHref} appearance="secondary" size="small" icon={<Open16Regular />} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                    {a.ctaLabel || 'Open'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Explore catalog analytics">
        <ViewMorePanel />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pane root
// ---------------------------------------------------------------------------

export function GovernAdminPane() {
  const s = useStyles();
  const [tab, setTab] = useState<AdminTab>('estate');
  const [resp, setResp] = useState<PostureResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const reqOnce = useRef(false);

  useEffect(() => {
    if (reqOnce.current) return;
    reqOnce.current = true;
    (async () => {
      try {
        const res = await fetch('/api/governance/govern/posture');
        const j: PostureResponse = await res.json();
        setResp(j);
      } catch (e: any) {
        setResp({ ok: false, error: e?.message || String(e) });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return <Spinner label="Computing estate posture…" style={{ justifyContent: 'flex-start' }} />;
  }

  // Hard gate (Cosmos unset) or admin-only / error states.
  if (!resp?.ok || !resp.posture) {
    if (resp?.code === 'posture_not_configured' && resp.hint) {
      return <NotConfiguredBar surface="Govern admin posture" hint={resp.hint} />;
    }
    if (resp?.code === 'admin_only') {
      return (
        <NotConfiguredBar
          surface="Govern Admin view"
          hint={{
            missingEnvVar: 'LOOM_TENANT_ADMIN_OID',
            bicepStatus: resp.reason || 'The Govern Admin view is restricted to tenant admins.',
            followUp: resp.remediation || 'Set LOOM_TENANT_ADMIN_OID to your user OID or add yourself to LOOM_TENANT_ADMIN_GROUP_ID.',
          }}
        />
      );
    }
    return (
      <NotConfiguredBar
        surface="Govern admin posture"
        rawError={resp?.error || 'Failed to load posture.'}
        hint={{ followUp: 'Confirm the Console is authenticated and Cosmos is reachable, then retry.' }}
      />
    );
  }

  const posture = resp.posture;
  const gates = resp.gates || {};
  const featureUsage = resp.featureUsage ?? null;

  return (
    <div>
      <div className={s.tabBar}>
        <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as AdminTab)} size="large">
          <Tab value="estate" icon={<Server20Regular />}>Manage estate</Tab>
          <Tab value="protect" icon={<Shield20Regular />}>Protect, secure, comply</Tab>
          <Tab value="discover" icon={<Branch20Regular />}>Discover, trust, reuse</Tab>
        </TabList>
        {resp.precomputedAt && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: 4 }}>
            Background refresh last ran {fmtDate(resp.precomputedAt)} · live values shown above.
          </Caption1>
        )}
      </div>

      <PostureCopilotBar chartData={posture} />

      {tab === 'estate' && <ManageEstateTab posture={posture} gates={gates} featureUsage={featureUsage} />}
      {tab === 'protect' && <ProtectSecureComplyTab posture={posture} gates={gates} />}
      {tab === 'discover' && <DiscoverTrustReuseTab posture={posture} />}
    </div>
  );
}

export default GovernAdminPane;
