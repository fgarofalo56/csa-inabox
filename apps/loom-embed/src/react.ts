/**
 * `@csa-loom/embed/react` — the React wrapper over the `<loom-report>` web
 * component, plus a `useLoomReport` hook for callers that want the raw governed
 * result and to render it themselves.
 *
 *   import { LoomReport } from '@csa-loom/embed/react';
 *
 *   <LoomReport
 *     baseUrl="https://csa-loom.limitlessdata.ai"
 *     token={embedToken}          // from POST /api/embed/token
 *     metric="net_revenue"
 *     dimensions={['region']}
 *     grain="month"
 *   />
 *
 * The wrapper ensures the custom element is registered, then renders it with the
 * mapped attributes. Row-level security is applied SERVER-SIDE from the token
 * identity (N15 metric compiler) — this component never filters rows itself.
 *
 * Uses `createElement` (no JSX) so the package has no JSX build coupling. React
 * is an OPTIONAL peer dependency — import this entry only in a React app.
 */

import { createElement, useEffect, useMemo, useRef, useState, type ReactElement, type CSSProperties } from 'react';
import { defineLoomReport } from './loom-report.js';
import { LoomEmbedClient, type EmbedQueryInput, type EmbedMetricResult, type MetricEngine } from './embed-client.js';

export interface LoomReportProps {
  /** Base URL of the Loom deployment. */
  baseUrl: string;
  /** A short-lived embed token (`loom_embed_…`). */
  token: string;
  /** The governed metric name. */
  metric: string;
  /** Group-by dimensions. */
  dimensions?: string[];
  /** Time-grain override for the first time dimension. */
  grain?: string;
  /** Target engine (default `synapse`). */
  engine?: MetricEngine;
  className?: string;
  style?: CSSProperties;
}

/**
 * Render the `<loom-report>` web component. Attributes are strings, so arrays
 * are comma-joined and undefined props are omitted.
 */
export function LoomReport(props: LoomReportProps): ReactElement {
  const ref = useRef<HTMLElement | null>(null);

  // Register the custom element on mount (idempotent).
  useEffect(() => {
    defineLoomReport();
  }, []);

  const attrs: Record<string, unknown> = {
    ref,
    'base-url': props.baseUrl,
    token: props.token,
    metric: props.metric,
    class: props.className,
    style: props.style,
  };
  if (props.dimensions && props.dimensions.length) attrs.dimensions = props.dimensions.join(',');
  if (props.grain) attrs.grain = props.grain;
  if (props.engine) attrs.engine = props.engine;

  return createElement('loom-report', attrs);
}

export interface UseLoomReportState {
  data?: EmbedMetricResult;
  error?: string;
  loading: boolean;
  /** Re-run the query (e.g. after a token refresh). */
  reload: () => void;
}

export interface UseLoomReportArgs extends EmbedQueryInput {
  baseUrl: string;
  token: string;
}

/**
 * Fetch a governed metric with an embed token and expose `{ data, error,
 * loading, reload }` — for callers that render the grid themselves. RLS is
 * enforced server-side from the token identity.
 */
export function useLoomReport(args: UseLoomReportArgs): UseLoomReportState {
  const { baseUrl, token, metric, dimensions, filters, grain, engine } = args;
  const [state, setState] = useState<{ data?: EmbedMetricResult; error?: string; loading: boolean }>({
    loading: true,
  });
  const [nonce, setNonce] = useState(0);

  // Stable primitive key so an inline dimensions/filters array doesn't loop.
  const key = useMemo(
    () => JSON.stringify({ baseUrl, token, metric, dimensions, filters, grain, engine, nonce }),
    [baseUrl, token, metric, dimensions, filters, grain, engine, nonce],
  );

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    if (!baseUrl || !token || !metric) {
      setState({ loading: false, error: 'baseUrl, token, and metric are required' });
      return;
    }
    const client = new LoomEmbedClient({ baseUrl, token });
    client
      .query({ metric, dimensions, filters, grain, engine })
      .then((data) => {
        if (!cancelled) setState({ loading: false, data });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
    // key encodes every input; intentionally the only dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}
