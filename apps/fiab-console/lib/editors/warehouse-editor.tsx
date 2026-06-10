'use client';

/**
 * warehouse-editor — the Warehouse Copilot bridge for the SQL Warehouse editor.
 *
 * The WarehouseEditor (lib/editors/phase3-editors.tsx) is a large, tab-rich
 * surface that already owns its Monaco editor, result grid, and ribbon. Rather
 * than re-home all of it, this module extracts the *Copilot* concern into a
 * reusable hook + two presentational components so the editor's copilot is a
 * one-for-one match of the shared SqlCopilotEditor, but woven into the existing
 * toolbar/ribbon layout:
 *
 *   - useWarehouseCopilot(id, { sql, resultError, onInsert }) — owns the assist
 *     state machine and POSTs every mode to /api/items/warehouse/<id>/assist
 *     (the real Loom AOAI deployment grounded in the LIVE Synapse Dedicated SQL
 *     pool schema; no Fabric Copilot, no mocks). `onInsert` is the INSERT BRIDGE
 *     — an applied suggestion (generate/fix) replaces the editor's SQL and the
 *     editor runs it against the real warehouse.
 *   - WarehouseCopilotActions — the inline toolbar buttons: Ask Copilot,
 *     Explain, Fix (when a run errored), Optimize (real EXPLAIN
 *     WITH_RECOMMENDATIONS), and a Quick actions menu of NL intents.
 *   - WarehouseCopilotPanels — the NL prompt bar, loading spinner, and the
 *     suggestion / explanation / optimization result + honest config-gate error.
 *
 * Azure-native by default (no-fabric-dependency.md): works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset; the backend is the Synapse Dedicated SQL
 * pool. Every control is wired to a real backend call (no-vaporware.md).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Input,
  Spinner,
  Tooltip,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Switch,
  Badge,
  Caption1,
  Field,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Sparkle16Regular,
  Info16Regular,
  Wrench16Regular,
  Flash16Regular,
  ChevronDown16Regular,
} from '@fluentui/react-icons';
import { WAREHOUSE_PERSONA, type CopilotMode } from '@/lib/azure/copilot-personas-sql';

export type WarehouseCopilotView =
  | 'idle'
  | 'prompt'
  | 'loading'
  | 'suggestion'
  | 'explain-result';

export interface UseWarehouseCopilotOptions {
  /** Current editor SQL — sent to explain/fix/optimize. */
  sql: string;
  /** Last run error (enables Fix + passed to fix mode). */
  resultError?: string | null;
  /** INSERT BRIDGE — replace the editor SQL with an applied generate/fix suggestion. */
  onInsert: (sql: string) => void;
  /** Optional pre-fetched schema grounding (skips the route's DMV round-trip). */
  schemaContext?: string;
}

export interface WarehouseCopilot {
  view: WarehouseCopilotView;
  prompt: string;
  result: string | null;
  error: string | null;
  /** XML execution plan returned by optimize (real EXPLAIN WITH_RECOMMENDATIONS). */
  planXml: string | null;
  lastMode: CopilotMode;
  setPrompt: (v: string) => void;
  openPrompt: () => void;
  cancelPrompt: () => void;
  generate: () => void;
  explain: () => void;
  fix: () => void;
  optimize: () => void;
  runQuickAction: (prompt: string) => void;
  /** Apply the current generate/fix suggestion into the editor (INSERT BRIDGE). */
  apply: () => void;
  dismiss: () => void;
  dismissError: () => void;
}

/**
 * Warehouse Copilot state machine. Callbacks are stable (read live props via a
 * ref) so the consuming editor's ribbon useMemo deps stay small.
 */
export function useWarehouseCopilot(
  id: string,
  opts: UseWarehouseCopilotOptions,
): WarehouseCopilot {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [view, setView] = useState<WarehouseCopilotView>('idle');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [planXml, setPlanXml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastModeRef = useRef<CopilotMode>('generate');
  // Mirror lastMode into state so the spinner label re-renders.
  const [lastMode, setLastMode] = useState<CopilotMode>('generate');

  const callAssist = useCallback(
    async (mode: CopilotMode, promptOverride?: string) => {
      lastModeRef.current = mode;
      setLastMode(mode);
      const { sql, resultError, schemaContext } = optsRef.current;
      const effectivePrompt = promptOverride ?? prompt;
      setView('loading');
      setError(null);
      try {
        const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/assist`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode,
            sql,
            prompt: mode === 'generate' ? effectivePrompt : undefined,
            errorText: mode === 'fix' ? resultError || '' : undefined,
            ...(schemaContext ? { schemaContext } : {}),
          }),
        });
        const j = await r.json();
        if (!j.ok) {
          setView('idle');
          setError(
            j?.code === 'no_aoai'
              ? `Warehouse Copilot not configured: ${j?.hint || 'Set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT.'}`
              : j?.error || 'AI assist failed',
          );
          return;
        }
        setResult(j.result);
        setPlanXml(typeof j.planXml === 'string' ? j.planXml : null);
        // explain/optimize are read-only prose; generate/fix offer Apply.
        setView(mode === 'explain' || mode === 'optimize' ? 'explain-result' : 'suggestion');
      } catch (e: any) {
        setView('idle');
        setError(e?.message || String(e));
      }
    },
    [id, prompt],
  );

  const openPrompt = useCallback(() => {
    setResult(null);
    setError(null);
    setPlanXml(null);
    setView('prompt');
  }, []);
  const cancelPrompt = useCallback(() => {
    setView('idle');
    setPrompt('');
  }, []);
  const generate = useCallback(() => callAssist('generate'), [callAssist]);
  const explain = useCallback(() => callAssist('explain'), [callAssist]);
  const fix = useCallback(() => callAssist('fix'), [callAssist]);
  const optimize = useCallback(() => callAssist('optimize'), [callAssist]);
  const runQuickAction = useCallback(
    (qaPrompt: string) => {
      setPrompt(qaPrompt);
      setResult(null);
      setError(null);
      setPlanXml(null);
      callAssist('generate', qaPrompt);
    },
    [callAssist],
  );
  const apply = useCallback(() => {
    if (result) optsRef.current.onInsert(result);
    setView('idle');
    setResult(null);
    setPlanXml(null);
    setPrompt('');
  }, [result]);
  const dismiss = useCallback(() => {
    setView('idle');
    setResult(null);
    setPlanXml(null);
  }, []);
  const dismissError = useCallback(() => setError(null), []);

  return {
    view,
    prompt,
    result,
    error,
    planXml,
    lastMode,
    setPrompt,
    openPrompt,
    cancelPrompt,
    generate,
    explain,
    fix,
    optimize,
    runQuickAction,
    apply,
    dismiss,
    dismissError,
  };
}

const useStyles = makeStyles({
  assistBar: {
    display: 'flex',
    gap: '6px',
    padding: '4px 8px',
    alignItems: 'center',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  assistResult: {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    margin: 0,
    overflowX: 'auto',
  },
});

export interface WarehouseCopilotActionsProps {
  copilot: WarehouseCopilot;
  /** Current editor SQL — gates Explain/Optimize on non-empty content. */
  sql: string;
  /** Whether the warehouse compute is ready (gates Optimize, which runs EXPLAIN). */
  canOptimize: boolean;
  /** Whether the last run errored (shows the Fix button). */
  hasError: boolean;
}

/** Inline copilot toolbar buttons — drop into the editor's query toolbar. */
export function WarehouseCopilotActions({
  copilot,
  sql,
  canOptimize,
  hasError,
}: WarehouseCopilotActionsProps) {
  const loading = copilot.view === 'loading';
  return (
    <>
      <Tooltip content="Generate T-SQL from a description" relationship="label">
        <Button
          size="small"
          appearance="subtle"
          icon={<Sparkle16Regular />}
          disabled={loading}
          onClick={copilot.openPrompt}
          aria-label="Ask Copilot to generate T-SQL"
        >
          Ask Copilot
        </Button>
      </Tooltip>
      <Tooltip content="Explain this query" relationship="label">
        <Button
          size="small"
          appearance="subtle"
          icon={<Info16Regular />}
          disabled={!sql.trim() || loading}
          onClick={copilot.explain}
          aria-label="Explain T-SQL"
        >
          Explain
        </Button>
      </Tooltip>
      {hasError && (
        <Tooltip content="Fix the T-SQL error" relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={<Wrench16Regular />}
            disabled={loading}
            onClick={copilot.fix}
            aria-label="Fix T-SQL error"
          >
            {loading && copilot.lastMode === 'fix' ? 'Fixing…' : 'Fix'}
          </Button>
        </Tooltip>
      )}
      <Tooltip
        content="Analyze the query plan (EXPLAIN WITH_RECOMMENDATIONS) and suggest optimizations"
        relationship="label"
      >
        <Button
          size="small"
          appearance="subtle"
          icon={<Flash16Regular />}
          disabled={!sql.trim() || !canOptimize || loading}
          onClick={copilot.optimize}
          aria-label="Optimize T-SQL query"
        >
          {loading && copilot.lastMode === 'optimize' ? 'Analyzing…' : 'Optimize'}
        </Button>
      </Tooltip>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            size="small"
            appearance="subtle"
            icon={<ChevronDown16Regular />}
            iconPosition="after"
            disabled={loading}
            aria-label="Quick Copilot actions"
          >
            Quick actions
          </Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {WAREHOUSE_PERSONA.quickActions.map((qa) => (
              <MenuItem key={qa.label} onClick={() => copilot.runQuickAction(qa.prompt)}>
                {qa.label}
              </MenuItem>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>
    </>
  );
}

/** NL prompt bar + loading + result/error panels — render below the toolbar. */
export function WarehouseCopilotPanels({ copilot }: { copilot: WarehouseCopilot }) {
  const s = useStyles();
  return (
    <>
      {copilot.view === 'prompt' && (
        <div className={s.assistBar}>
          <Input
            size="small"
            autoFocus
            style={{ flex: 1 }}
            placeholder="Describe the query (e.g. 'top 10 customers by revenue last quarter')…"
            value={copilot.prompt}
            onChange={(_: unknown, d: any) => copilot.setPrompt(d.value)}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter' && copilot.prompt.trim()) copilot.generate();
              if (e.key === 'Escape') copilot.cancelPrompt();
            }}
            aria-label="AI T-SQL generation prompt"
          />
          <Button
            size="small"
            appearance="primary"
            disabled={!copilot.prompt.trim()}
            onClick={copilot.generate}
          >
            Generate
          </Button>
          <Button size="small" onClick={copilot.cancelPrompt}>
            Cancel
          </Button>
        </div>
      )}
      {copilot.view === 'loading' && (
        <div className={s.assistBar}>
          <Spinner
            size="tiny"
            labelPosition="after"
            label={
              copilot.lastMode === 'generate'
                ? 'Generating T-SQL…'
                : copilot.lastMode === 'explain'
                  ? 'Explaining…'
                  : copilot.lastMode === 'optimize'
                    ? 'Analyzing query plan…'
                    : 'Fixing…'
            }
          />
        </div>
      )}
      {(copilot.view === 'suggestion' || copilot.view === 'explain-result') && copilot.result && (
        <MessageBar
          intent={copilot.view === 'explain-result' ? 'info' : 'success'}
          style={{ margin: '4px 0 0' }}
        >
          <MessageBarBody>
            <pre className={s.assistResult}>{copilot.result}</pre>
          </MessageBarBody>
          <MessageBarActions>
            {copilot.view === 'suggestion' && (
              <Button size="small" appearance="primary" onClick={copilot.apply}>
                Apply
              </Button>
            )}
            <Button size="small" onClick={copilot.dismiss}>
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {copilot.error && (
        <MessageBar intent="error" style={{ margin: '4px 0 0' }}>
          <MessageBarBody>{copilot.error}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={copilot.dismissError}>
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
    </>
  );
}

// ============================================================
// Warehouse Settings — query acceleration (GPU) honest-gate
// ============================================================

/** Backend capability matrix shape returned by GET /settings. */
interface WarehouseCapabilities {
  backend: 'synapse' | 'fabric';
  backendLabel: string;
  engine: string;
  queryAccelerationAvailable: boolean;
  queryAccelerationGate?: string;
}

interface WarehouseSettingsResponse {
  ok: boolean;
  error?: string;
  settings: { queryAcceleration?: boolean };
  capabilities: WarehouseCapabilities;
  effective: { queryAcceleration: boolean };
}

/**
 * Warehouse Settings dialog — Fabric Warehouse "Settings" parity, focused on
 * the GPU-accelerated **query acceleration** toggle (Fabric Build 2026 #7).
 *
 * Honest-gate (no-vaporware.md / no-fabric-dependency.md): the Azure-native
 * DEFAULT backend (Synapse Dedicated SQL pool) has NO GPU, so the toggle is
 * disabled with a precise MessageBar naming the exact env vars to set to opt
 * into the Fabric backend. The user's intent is still PERSISTED to the item's
 * Cosmos state via PUT /settings (saved now, effective once Fabric is bound) —
 * a real backend call, no mock. When the Fabric backend is opted into
 * (LOOM_WAREHOUSE_BACKEND=fabric + bound workspace) the toggle is live and
 * applies the acceleration setting.
 */
export function WarehouseSettingsDialog({
  id,
  open,
  onOpenChange,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<WarehouseSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [desired, setDesired] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/settings`);
      const j = (await r.json()) as WarehouseSettingsResponse;
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      setDesired(j.settings.queryAcceleration === true);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queryAcceleration: desired }),
      });
      const j = (await r.json()) as WarehouseSettingsResponse;
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      onOpenChange(false);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [id, desired, onOpenChange]);

  const caps = data?.capabilities;
  const available = caps?.queryAccelerationAvailable === true;
  const effective = data?.effective.queryAcceleration === true;
  const isNew = id === 'new';

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 620 }}>
        <DialogBody>
          <DialogTitle>Warehouse settings — query acceleration</DialogTitle>
          <DialogContent>
            {loading && <Spinner size="tiny" label="Loading settings…" labelPosition="after" />}
            {caps && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge appearance="outline" color={caps.backend === 'fabric' ? 'brand' : 'informative'}>
                    Backend: {caps.backendLabel}
                  </Badge>
                  {effective && <Badge appearance="filled" color="success">Acceleration active</Badge>}
                </div>
                <Caption1>{caps.engine}</Caption1>

                <Field
                  label="GPU-accelerated query acceleration"
                  hint={
                    available
                      ? 'Route eligible scans through the Fabric distributed query-execution engine with GPU acceleration.'
                      : 'Saved now; takes effect automatically once the Fabric backend is bound.'
                  }
                >
                  <Switch
                    checked={desired}
                    disabled={isNew || saving}
                    onChange={(_, d) => setDesired(d.checked)}
                    label={desired ? 'On' : 'Off'}
                  />
                </Field>

                {!available && caps.queryAccelerationGate && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>GPU acceleration is not available on this backend</MessageBarTitle>
                      {caps.queryAccelerationGate}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {available && desired && (
                  <MessageBar intent="success">
                    <MessageBarBody>
                      <MessageBarTitle>Fabric backend bound</MessageBarTitle>
                      Query acceleration will be applied to eligible queries on this warehouse.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {isNew && (
                  <MessageBar intent="info">
                    <MessageBarBody>Save the warehouse first to persist its settings.</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            )}
            {error && (
              <MessageBar intent="error" style={{ marginTop: 12 }}>
                <MessageBarBody>
                  <MessageBarTitle>Could not load / save settings</MessageBarTitle>
                  {error}
                </MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={save}
              disabled={isNew || saving || loading || !data}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
