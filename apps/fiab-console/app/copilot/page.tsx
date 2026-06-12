'use client';

/**
 * /copilot — modern landing surface for the Loom Copilot orchestrator.
 *
 * This page is the front door: a hero, a live readiness badge, capability
 * cards for the real registered tool services, and recent-session tiles —
 * then a primary CTA that launches the full-screen orchestrator console.
 *
 * The orchestrator console itself is the SHARED `CopilotConsoleView`
 * (also used by the embedded /items/cross-item-copilot/<id> editor); it is
 * imported unchanged. Everything else on this page is owned here.
 *
 * Real wiring (no mocks):
 *   • GET /api/copilot/status   → readiness badge + capability cards (byService)
 *   • GET /api/copilot/sessions → recent-session tiles / table
 *   • Honest infra-gate MessageBar when AOAI isn't reachable (real remediation).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Title1, Body1, Caption1, Badge, Button, Spinner, Text,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  BotSparkle24Filled, Sparkle20Regular, ArrowRight20Regular,
  Open16Regular, Wrench20Regular, History20Regular, Flash20Regular,
} from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { CopilotConsoleView } from '@/lib/editors/cross-item-copilot-editor';

// ── Real data shapes (mirror the API routes) ────────────────────────────────
interface OrchestratorStatus {
  ok: boolean;
  ready?: boolean;
  aoai?: { ok: boolean; endpoint?: string; deployment?: string; error?: string; remediation?: string };
  tools?: { count: number; byService: Record<string, number> };
  sessions?: { recent: number };
}
interface SessionSummary {
  id: string; sessionId: string; prompt: string;
  createdAt: string; updatedAt: string; stepCount: number;
}

/**
 * Map a tool-service display name ("ADF", "Power BI", …) to an item-type
 * slug from the visual registry so each capability card gets a real brand
 * icon + color. Falls back to the neutral glyph for unknown services.
 */
const SERVICE_TO_TYPE: Record<string, string> = {
  adf: 'adf-pipeline',
  adx: 'kql-database',
  apim: 'apim-api',
  activator: 'activator',
  databricks: 'databricks-notebook',
  fabric: 'lakehouse',
  foundry: 'ai-foundry-hub',
  lakehouse: 'lakehouse',
  loom: 'cross-item-copilot',
  'power bi': 'report',
  synapse: 'synapse-pipeline',
};
function serviceType(svc: string): string {
  return SERVICE_TO_TYPE[svc.toLowerCase().trim()] ?? 'cross-item-copilot';
}

// Static capability copy keyed by service — describes what the orchestrator
// can DO with that service's tools. Counts/availability stay 100% live.
const SERVICE_BLURB: Record<string, string> = {
  ADF: 'Trigger and monitor Azure Data Factory pipeline runs.',
  ADX: 'Run KQL against Azure Data Explorer / Eventhouse clusters.',
  APIM: 'Inspect APIs, products, and policies in API Management.',
  Activator: 'Wire and fire Real-Time Intelligence triggers.',
  Databricks: 'Submit notebooks and jobs to Databricks workspaces.',
  Fabric: 'Create and operate Fabric workspace items.',
  Foundry: 'Call deployed models and evaluations on the AI Foundry hub.',
  Lakehouse: 'Query and write Lakehouse tables and files.',
  Loom: 'Cross-item orchestration and Loom platform actions.',
  'Power BI': 'Refresh semantic models and read report metadata.',
  Synapse: 'Run SQL and pipelines on Synapse pools.',
};

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    padding: tokens.spacingVerticalXXL,
    paddingTop: tokens.spacingVerticalXL,
    maxWidth: '1280px',
    width: '100%',
    margin: '0 auto',
    boxSizing: 'border-box',
  },
  // ── Hero ──────────────────────────────────────────────────────────────
  hero: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusXLarge,
    padding: tokens.spacingVerticalXXXL,
    marginBottom: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForegroundOnBrand,
    background:
      'radial-gradient(1200px 400px at 12% -20%, #7c3aed 0%, transparent 55%),' +
      'radial-gradient(900px 500px at 95% 120%, #0078d4 0%, transparent 55%),' +
      'linear-gradient(135deg, #2a1458 0%, #1a1342 55%, #0b1e3f 100%)',
    boxShadow: tokens.shadow16,
    minHeight: '0',
  },
  heroGlow: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    background:
      'radial-gradient(600px 220px at 50% 0%, rgba(255,255,255,0.10) 0%, transparent 70%)',
  },
  heroRow: {
    position: 'relative',
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalXXL,
    flexWrap: 'wrap',
  },
  heroIcon: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '72px',
    height: '72px',
    borderRadius: tokens.borderRadiusXLarge,
    background: 'linear-gradient(135deg, rgba(255,255,255,0.25), rgba(255,255,255,0.08))',
    border: '1px solid rgba(255,255,255,0.25)',
    boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
  },
  heroText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, flex: 1, minWidth: '260px' },
  heroTitle: { color: tokens.colorNeutralForegroundOnBrand, margin: 0, lineHeight: 1.1 },
  heroLead: { color: 'rgba(255,255,255,0.82)', maxWidth: '620px' },
  heroBadges: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS },
  heroChip: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '4px 10px', borderRadius: tokens.borderRadiusCircular,
    background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.22)',
    fontSize: tokens.fontSizeBase200, color: 'rgba(255,255,255,0.95)',
  },
  heroActions: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', marginTop: tokens.spacingVerticalM },
  // ── Section heads with icon ───────────────────────────────────────────
  headWithIcon: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  // ── Examples ──────────────────────────────────────────────────────────
  exampleGrid: {
    display: 'grid',
    gap: tokens.spacingHorizontalL,
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  },
  example: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-start',
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    cursor: 'pointer',
    transitionDuration: tokens.durationNormal,
    transitionProperty: 'box-shadow, transform, border-color',
    ':hover': { boxShadow: tokens.shadow8, transform: 'translateY(-2px)', border: `1px solid ${tokens.colorBrandStroke1}` },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  exampleIcon: { color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: '2px' },
  loadingRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalM },
  // ── Console wrapper (when launched) ───────────────────────────────────
  consoleWrap: {
    display: 'flex', flexDirection: 'column',
    height: 'calc(100vh - 52px)', minHeight: 0, overflow: 'hidden',
    boxSizing: 'border-box',
  },
  consoleBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, padding: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
  },
  consoleTitle: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  // ── Residual inline-style extractions ─────────────────────────────────
  brandIcon: { color: tokens.colorBrandForeground1 },
  flushTitle: { margin: 0 },
  // Hero glyph: on the brand gradient, so foreground-on-brand (was '#fff').
  heroIconGlyph: { width: '38px', height: '38px', color: tokens.colorNeutralForegroundOnBrand },
  // Outline CTA over the always-dark hero gradient — on-brand text (was inline
  // color:'#fff'). The translucent border is a literal white-alpha to match the
  // hero's fixed gradient (a theme token would flip in light mode). griffel
  // rejects the `borderColor` shorthand, so the four longhand sides are set.
  heroOutlineBtn: {
    color: tokens.colorNeutralForegroundOnBrand,
    borderTopColor: 'rgba(255,255,255,0.4)',
    borderRightColor: 'rgba(255,255,255,0.4)',
    borderBottomColor: 'rgba(255,255,255,0.4)',
    borderLeftColor: 'rgba(255,255,255,0.4)',
  },
  gatedBar: { marginBottom: tokens.spacingVerticalXXL },
  remediationNote: { marginTop: tokens.spacingVerticalS },
});

const EXAMPLES = [
  'Find the top 10 revenue customers from gold.fact_sales last quarter and write the result to gold/snapshots/customer_top10.parquet.',
  'Refresh the Sales semantic model, then tell me when it last completed.',
  'Run a KQL query for the 5 slowest requests in the last hour on the prod Eventhouse.',
  'Trigger the nightly ADF ingestion pipeline and report its run status.',
];

export default function CopilotPage() {
  const styles = useStyles();
  const [launched, setLaunched] = useState(false);
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionView, setSessionView] = useState<LoomView>('tile');
  const [sessionQuery, setSessionQuery] = useState('');

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const r = await clientFetch('/api/copilot/status');
      const j = await r.json();
      setStatus(j);
    } catch {
      setStatus({ ok: false });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const r = await clientFetch('/api/copilot/sessions');
      const j = await r.json();
      setSessions(j.ok ? (j.sessions ?? []) : []);
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); loadSessions(); }, [loadStatus, loadSessions]);

  const ready = !!status?.ready;
  const toolCount = status?.tools?.count ?? 0;
  const byService = status?.tools?.byService ?? {};
  const services = useMemo(
    () => Object.keys(byService).sort((a, b) => byService[b] - byService[a]),
    [byService],
  );

  const filteredSessions = useMemo(() => {
    const q = sessionQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.prompt || '').toLowerCase().includes(q));
  }, [sessions, sessionQuery]);

  const sessionColumns = useMemo<LoomColumn<SessionSummary>[]>(() => [
    {
      key: 'prompt', label: 'Prompt', width: 420,
      getValue: (r) => r.prompt || '(no prompt)',
      render: (r) => <Text weight="semibold">{(r.prompt || '(no prompt)').slice(0, 120)}</Text>,
    },
    { key: 'stepCount', label: 'Steps', width: 90, filterable: false, getValue: (r) => r.stepCount },
    {
      key: 'updatedAt', label: 'Updated', width: 200, filterable: false,
      getValue: (r) => r.updatedAt,
      render: (r) => <Caption1>{new Date(r.updatedAt).toLocaleString()}</Caption1>,
    },
  ], []);

  // ── Launched: full-screen shared console (owns its own hero + Back CTA) ──
  if (launched) {
    return <CopilotConsoleView onBack={() => { setLaunched(false); loadSessions(); }} />;
  }

  // ── Landing surface ─────────────────────────────────────────────────────
  return (
    <div className={styles.page}>
      {/* Hero */}
      <div className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden />
        <div className={styles.heroRow}>
          <span className={styles.heroIcon} aria-hidden>
            <BotSparkle24Filled className={styles.heroIconGlyph} />
          </span>
          <div className={styles.heroText}>
            <Title1 className={styles.heroTitle}>Loom Copilot</Title1>
            <Body1 className={styles.heroLead}>
              One natural-language prompt, orchestrated across every wired service —
              Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, and
              the AI Foundry hub. Copilot picks the right tools, runs them against
              real backends, and streams every step.
            </Body1>
            <div className={styles.heroBadges}>
              {statusLoading ? (
                <span className={styles.heroChip}><Spinner size="extra-tiny" /> Checking orchestrator…</span>
              ) : ready ? (
                <>
                  <span className={styles.heroChip}><Sparkle20Regular fontSize={16} /> Ready</span>
                  <span className={styles.heroChip}><Wrench20Regular fontSize={16} /> {toolCount} tools</span>
                  {status?.aoai?.deployment && (
                    <span className={styles.heroChip}><Flash20Regular fontSize={16} /> {status.aoai.deployment}</span>
                  )}
                  <span className={styles.heroChip}><History20Regular fontSize={16} /> {status?.sessions?.recent ?? 0} sessions</span>
                </>
              ) : (
                <>
                  <span className={styles.heroChip}><Wrench20Regular fontSize={16} /> {toolCount} tools callable</span>
                  <span className={styles.heroChip}>AOAI not reachable — direct tool calls only</span>
                </>
              )}
            </div>
            <div className={styles.heroActions}>
              <Button
                appearance="primary"
                size="large"
                icon={<ArrowRight20Regular />}
                iconPosition="after"
                onClick={() => setLaunched(true)}
              >
                Launch Copilot
              </Button>
              <Button
                appearance="outline"
                size="large"
                className={styles.heroOutlineBtn}
                icon={<Open16Regular />}
                as="a"
                href="/items/cross-item-copilot/default"
              >
                Open in workspace
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Honest infra-gate when AOAI isn't reachable */}
      {!statusLoading && status && !ready && (
        <MessageBar intent={status.aoai?.ok ? 'warning' : 'info'} className={styles.gatedBar}>
          <MessageBarBody>
            <MessageBarTitle>Orchestrator not fully ready</MessageBarTitle>
            {status.aoai?.ok
              ? `AOAI reachable (${status.aoai.deployment}) but no tools are registered yet.`
              : `Azure OpenAI is not reachable — ${status.aoai?.error || 'unknown error'}. ` +
                `The ${toolCount} registered tools can still be invoked directly inside the console.`}
            {status.aoai?.remediation && (
              <div className={styles.remediationNote}>{status.aoai.remediation}</div>
            )}
          </MessageBarBody>
          <MessageBarActions>
            <Button appearance="subtle" onClick={loadStatus}>Recheck</Button>
            {!status.aoai?.ok && (
              <Button as="a" href="https://ai.azure.com" target="_blank" rel="noopener noreferrer">
                Go to AI Foundry
              </Button>
            )}
          </MessageBarActions>
        </MessageBar>
      )}

      {/* Capabilities — real registered services */}
      <Section title={<span className={styles.headWithIcon}><Wrench20Regular /> What Copilot can orchestrate</span>}>
        {statusLoading ? (
          <div className={styles.loadingRow}><Spinner size="tiny" /> <Caption1>Loading registered tools…</Caption1></div>
        ) : services.length === 0 ? (
          <Caption1>No tools are registered in this deployment yet.</Caption1>
        ) : (
          <TileGrid minTileWidth={280}>
            {services.map((svc) => (
              <ItemTile
                key={svc}
                type={serviceType(svc)}
                title={svc}
                subtitle={SERVICE_BLURB[svc] ?? `${itemVisual(serviceType(svc)).label} tools`}
                meta={`${byService[svc]} tool${byService[svc] === 1 ? '' : 's'}`}
                badge={<Badge appearance="tint" color="brand">{byService[svc]}</Badge>}
                onClick={() => setLaunched(true)}
              />
            ))}
          </TileGrid>
        )}
      </Section>

      {/* Example prompts — clicking launches the console */}
      <Section title={<span className={styles.headWithIcon}><Sparkle20Regular /> Try a prompt</span>}>
        <div className={styles.exampleGrid}>
          {EXAMPLES.map((ex, i) => (
            <div
              key={i}
              className={styles.example}
              role="button"
              tabIndex={0}
              onClick={() => setLaunched(true)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLaunched(true); } }}
            >
              <Sparkle20Regular className={styles.exampleIcon} />
              <Body1>{ex}</Body1>
            </div>
          ))}
        </div>
      </Section>

      {/* Recent sessions — real /api/copilot/sessions */}
      <Section
        title={<span className={styles.headWithIcon}><History20Regular /> Recent sessions</span>}
        actions={sessions.length > 0 ? <ViewToggle value={sessionView} onChange={setSessionView} /> : undefined}
      >
        {sessions.length > 0 && (
          <Toolbar
            search={sessionQuery}
            onSearch={setSessionQuery}
            searchPlaceholder="Search sessions by prompt…"
          />
        )}
        {sessionsLoading ? (
          <div className={styles.loadingRow}><Spinner size="tiny" /> <Caption1>Loading sessions…</Caption1></div>
        ) : sessions.length === 0 ? (
          <Caption1>No Copilot sessions yet. Launch Copilot and run your first prompt.</Caption1>
        ) : filteredSessions.length === 0 ? (
          <Caption1>No sessions match “{sessionQuery}”.</Caption1>
        ) : sessionView === 'tile' ? (
          <TileGrid minTileWidth={300}>
            {filteredSessions.map((sess) => (
              <ItemTile
                key={sess.id}
                type="cross-item-copilot"
                title={(sess.prompt || '(no prompt)').slice(0, 80)}
                subtitle={`${sess.stepCount} step${sess.stepCount === 1 ? '' : 's'}`}
                meta={`Updated ${new Date(sess.updatedAt).toLocaleString()}`}
                onClick={() => setLaunched(true)}
              />
            ))}
          </TileGrid>
        ) : (
          <LoomDataTable
            columns={sessionColumns}
            rows={filteredSessions}
            getRowId={(r) => r.id}
            onRowClick={() => setLaunched(true)}
            empty="No sessions match your search."
            ariaLabel="Recent Copilot sessions"
          />
        )}
      </Section>
    </div>
  );
}
