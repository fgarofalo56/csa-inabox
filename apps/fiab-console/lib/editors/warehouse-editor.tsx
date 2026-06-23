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

import { useCallback, useRef, useState } from 'react';
import {
  Button,
  Input,
  Spinner,
  Tooltip,
  MessageBar,
  MessageBarBody,
  MessageBarActions,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
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
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    alignItems: 'center',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  assistResult: {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: tokens.fontSizeBase200,
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
          style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}
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
        <MessageBar intent="error" style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}>
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
