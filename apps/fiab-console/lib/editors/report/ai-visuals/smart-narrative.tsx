'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * smart-narrative — the Power BI "Smart narrative" AI visual for the Loom-native
 * Report Designer (report-designer wave 3, the "AI" gallery section).
 *
 * Power BI parity (ui-parity.md):
 * learn.microsoft.com/power-bi/visuals/power-bi-narratives — Smart narrative reads
 * the data behind the visuals on the active page and writes a natural-language
 * summary of it (headline takeaways, notable highs/lows, trends), refreshing as
 * the underlying data / filters change. This file is the one-for-one Loom build of
 * that surface, Azure-native by construction:
 *
 *   • The host (report-designer) already runs each visual's REAL `/query`
 *     (Path-3 wells→SQL over the bound Loom semantic model). It hands this visual
 *     the page's live result rows via {@link SmartNarrativeProps.pageRows}.
 *   • {@link SmartNarrative} serializes those rows + visual titles and POSTs them to
 *     the wave-3 `/ai-visual` route (`mode:'narrative'`), which calls the shared
 *     `copilot-orchestrator` `aoaiCompleteJson` against the deployment's Azure
 *     OpenAI chat model and returns a STRUCTURED `{ narrative, bullets[] }`.
 *   • It renders that as a Body1 paragraph + a bullet list, with a Sparkle header,
 *     a manual Refresh, and a Spinner while loading. It re-summarizes automatically
 *     whenever the page's rows-signature changes (new data / filter / cross-filter)
 *     or the host bumps `refreshKey`.
 *
 * Rules compliance:
 *  - no-vaporware.md: the narrative is REAL Azure OpenAI output over the page's REAL
 *    `/query` rows — never a canned / mock summary. When no AOAI chat model is
 *    deployed the route returns 503 (NoAoaiDeploymentError) and this visual shows the
 *    SAME honest Fluent warning MessageBar the report Copilot uses, naming the exact
 *    remediation (deploy a gpt-4o / gpt-4.1-class model). No dead buttons: Refresh
 *    always re-issues a real request.
 *  - no-fabric-dependency.md: Azure-native by construction — AOAI + Synapse `/query`.
 *    Nothing here reaches api.fabric.microsoft.com / api.powerbi.com. The visual
 *    self-renders from rows the host already fetched; it adds no Fabric coupling.
 *  - no-freeform-config.md: there is no config surface here — it is an output visual.
 *    The only input is a Refresh action.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded px/hex); a
 *    card with elevation + a Sparkle accent header, matching the sibling
 *    report-powerbi-copilot pane.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Body1, Subtitle2, Caption1, Spinner, Button, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Sparkle20Regular, ArrowClockwise16Regular, Lightbulb16Regular,
  DataLine20Regular,
} from '@fluentui/react-icons';

// ── Props ─────────────────────────────────────────────────────────────────────

/** One page visual's title/type + its REAL `/query` result rows (host-supplied). */
export interface SmartNarrativeVisualRows {
  /** The visual's title (or a fallback the host assigns). */
  visualTitle?: string;
  /** The visual's type id (table / bar / line / …) — context for the model. */
  type?: string;
  /** The visual's live `/query` result rows (already aggregated by the route). */
  rows: Array<Record<string, unknown>>;
}

export interface SmartNarrativeProps {
  /** The report's Loom item id (the `/ai-visual` route shares it on the path). */
  reportId: string;
  /**
   * The active page's visuals + their REAL `/query` rows. The host (report-designer)
   * passes the same result sets it already fetched to render the page's charts —
   * this visual NEVER fetches the page data itself, it only summarizes it.
   */
  pageRows: SmartNarrativeVisualRows[];
  /**
   * Optional host-controlled refresh signal. Bumping it (e.g. on a global filter /
   * data refresh that doesn't change row identity) forces a re-summary.
   */
  refreshKey?: number | string;
}

// ── narrative context (bounded serialization of the page's rows) ──────────────

/** Cap how much page data we serialize to the model (keep the prompt bounded). */
const MAX_VISUALS = 12;
const MAX_ROWS_PER_VISUAL = 50;

interface NarrativeContextVisual {
  title: string;
  type: string;
  rowCount: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}
interface NarrativeContext {
  visuals: NarrativeContextVisual[];
}

/** Build the bounded `{ visuals: [...] }` context POSTed to the `/ai-visual` route. */
function buildNarrativeContext(pageRows: SmartNarrativeVisualRows[]): NarrativeContext {
  const visuals: NarrativeContextVisual[] = (pageRows || [])
    .slice(0, MAX_VISUALS)
    .map((pv, i) => {
      const all = Array.isArray(pv.rows) ? pv.rows : [];
      const rows = all.slice(0, MAX_ROWS_PER_VISUAL);
      const columns = rows.length && rows[0] && typeof rows[0] === 'object'
        ? Object.keys(rows[0] as Record<string, unknown>)
        : [];
      return {
        title: (pv.visualTitle && pv.visualTitle.trim()) || `Visual ${i + 1}`,
        type: pv.type || 'table',
        rowCount: all.length,
        columns,
        rows,
      };
    })
    // Only summarize visuals that actually returned data.
    .filter((v) => v.rows.length > 0);
  return { visuals };
}

/** djb2 hash — a short, stable fingerprint of the serialized context. */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

interface NarrativeResult {
  narrative: string;
  bullets: string[];
}

// ── styles (Loom tokens only) ─────────────────────────────────────────────────

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    height: '100%',
    minHeight: 0,
    boxSizing: 'border-box',
    padding: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flexShrink: 0,
  },
  headTitle: { flexGrow: 1, minWidth: 0 },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minHeight: 0,
    overflowY: 'auto',
    flexGrow: 1,
  },
  narrative: { whiteSpace: 'pre-wrap', color: tokens.colorNeutralForeground1 },
  bullets: {
    listStyleType: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  bullet: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground2,
  },
  bulletIcon: { color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: '2px' },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalXS,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    flexGrow: 1,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalL,
  },
  emptyIcon: { color: tokens.colorBrandForeground2 },
  foot: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
});

// ── component ─────────────────────────────────────────────────────────────────

/**
 * Smart narrative — an AOAI-generated natural-language summary of the active page's
 * REAL `/query` data, rendered as a text visual. Auto-refreshes on a rows-signature
 * change (or a `refreshKey` bump) and offers a manual Refresh. Honest 503 gate when
 * no Azure OpenAI chat model is deployed. Never renders a canned summary.
 */
export function SmartNarrative(props: SmartNarrativeProps): ReactElement {
  const { reportId, pageRows, refreshKey } = props;
  const styles = useStyles();

  const context = useMemo(() => buildNarrativeContext(pageRows), [pageRows]);
  const signature = useMemo(() => hashStr(JSON.stringify(context)), [context]);
  const hasData = context.visuals.length > 0;

  // Read the latest context inside the effect without making the effect re-run on
  // every new array identity — `signature` is the real change driver.
  const contextRef = useRef(context);
  contextRef.current = context;

  const [result, setResult] = useState<NarrativeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0); // manual Refresh

  useEffect(() => {
    if (!reportId || !hasData) {
      setResult(null);
      setError(null);
      setGate(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      setGate(null);
      try {
        const res = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/ai-visual`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'narrative', context: contextRef.current }),
          signal: ctrl.signal,
        });
        if (!alive) return;

        // Honest gate — no AOAI chat model deployed (NoAoaiDeploymentError → 503).
        if (res.status === 503) {
          const j = await res.json().catch(() => ({} as { error?: string }));
          setGate(j?.error || 'AOAI deployment not wired');
          setResult(null);
          return;
        }
        if (!res.ok) {
          const j = await res.json().catch(() => ({} as { error?: string }));
          setError(j?.error || `Couldn’t generate the narrative (HTTP ${res.status}).`);
          setResult(null);
          return;
        }

        // BFF envelope is `{ ok, data:{ narrative, bullets } }`; accept a flat shape too.
        const j = await res.json().catch(() => ({} as Record<string, unknown>));
        const data = (j && typeof j === 'object' && 'data' in j && j.data && typeof j.data === 'object')
          ? (j.data as Record<string, unknown>)
          : (j as Record<string, unknown>);
        const narrative = typeof data?.narrative === 'string' ? data.narrative : '';
        const bullets = Array.isArray(data?.bullets)
          ? (data.bullets as unknown[]).filter((b): b is string => typeof b === 'string')
          : [];
        if (!narrative && bullets.length === 0) {
          setError('The model returned an empty narrative — try Refresh.');
          setResult(null);
          return;
        }
        setResult({ narrative, bullets });
      } catch (e: unknown) {
        if (!alive || ctrl.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(`Network error: ${msg}`);
        setResult(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; ctrl.abort(); };
    // `signature` stands in for `context`; `nonce`/`refreshKey` force a re-summary.
  }, [reportId, signature, refreshKey, nonce, hasData]);

  return (
    <section className={styles.card} aria-label="Smart narrative">
      <div className={styles.head}>
        <Sparkle20Regular style={{ color: tokens.colorBrandForeground1 }} aria-hidden />
        <Subtitle2 className={styles.headTitle}>Smart narrative</Subtitle2>
        {loading && <Spinner size="tiny" aria-label="Generating narrative" />}
        <Tooltip content="Regenerate narrative" relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowClockwise16Regular />}
            disabled={loading || !hasData}
            onClick={() => setNonce((n) => n + 1)}
            aria-label="Refresh smart narrative"
          >
            Refresh
          </Button>
        </Tooltip>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>AOAI deployment not wired</MessageBarTitle>
            {gate} — open the AI Foundry editor and deploy a gpt-4o / gpt-4.1-class chat model.
          </MessageBarBody>
        </MessageBar>
      )}

      {!gate && error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Couldn’t generate narrative</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {!hasData ? (
        <div className={styles.empty}>
          <DataLine20Regular className={styles.emptyIcon} aria-hidden />
          <Body1>No data to summarize yet</Body1>
          <Caption1>
            Add one or more visuals with data to this page — Smart narrative will write a
            natural-language summary of what the numbers say.
          </Caption1>
        </div>
      ) : (
        <div className={styles.body} aria-live="polite">
          {loading && !result && (
            <div className={styles.loading}>
              <Spinner size="tiny" />
              <Caption1>Analyzing this page’s data with Azure OpenAI…</Caption1>
            </div>
          )}

          {result && (
            <>
              {result.narrative && (
                <Body1 className={styles.narrative}>{result.narrative}</Body1>
              )}
              {result.bullets.length > 0 && (
                <ul className={styles.bullets}>
                  {result.bullets.map((b, i) => (
                    <li key={i} className={styles.bullet}>
                      <Lightbulb16Regular className={styles.bulletIcon} aria-hidden />
                      <Body1>{b}</Body1>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {hasData && (
        <Caption1 className={styles.foot}>
          Generated by Azure OpenAI from this page’s live query results.
        </Caption1>
      )}
    </section>
  );
}

export default SmartNarrative;
