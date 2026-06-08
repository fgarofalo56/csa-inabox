'use client';

/**
 * SqlCopilotEditor — Warehouse Copilot surface shared by the SQL warehouse
 * family editors (Synapse Dedicated / Serverless / Databricks SQL warehouse).
 *
 * Bundles the MonacoTextarea code surface with an inline NL→SQL / explain / fix
 * assist bar, identical in behaviour to the KqlQuerysetEditor assist edge. Every
 * mode POSTs to /api/items/<engine>/<id>/assist, which calls the real Loom AOAI
 * deployment (AI Foundry project `chat`) grounded in the LIVE warehouse schema —
 * no Fabric Copilot, no mocks (per no-vaporware.md + no-fabric-dependency.md).
 *
 *   - Ask Copilot → NL prompt bar → generated SQL → Apply (replaces the editor)
 *   - Explain     → grounded plain-language description of the current query
 *   - Fix         → corrected SQL for the current query + its last run error
 *
 * When AOAI is not configured the assist returns an honest 503 `code:'no_aoai'`
 * gate, surfaced in a Fluent MessageBar naming the env vars to set; the editor
 * itself stays fully functional for manual authoring + Run.
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
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Sparkle16Regular, Info16Regular, Wrench16Regular } from '@fluentui/react-icons';
import { MonacoTextarea, type MonacoTextareaProps } from './monaco-textarea';

export type SqlCopilotEngine =
  | 'warehouse'
  | 'synapse-dedicated-sql-pool'
  | 'synapse-serverless-sql-pool'
  | 'databricks-sql-warehouse';

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

type AssistView = 'idle' | 'prompt' | 'loading' | 'suggestion' | 'explain-result';

export interface SqlCopilotEditorProps {
  engine: SqlCopilotEngine;
  id: string;
  value: string;
  onChange: (next: string) => void;
  language?: MonacoTextareaProps['language'];
  ariaLabel: string;
  height?: number;
  minHeight?: number;
  /** Human dialect label used in UI copy (e.g. 'T-SQL', 'Spark SQL'). */
  dialectLabel?: string;
  /** Current run error (enables the Fix action when present). */
  resultError?: string | null;
  /** Extra body fields merged into the assist POST (db / warehouseId / catalog / schema / schemaContext). */
  extraBody?: Record<string, unknown>;
  /** Called after a generated suggestion is applied (e.g. to clear the result panel). */
  onApply?: () => void;
}

export function SqlCopilotEditor({
  engine,
  id,
  value,
  onChange,
  language = 'tsql',
  ariaLabel,
  height = 240,
  minHeight = 200,
  dialectLabel = 'SQL',
  resultError,
  extraBody,
  onApply,
}: SqlCopilotEditorProps) {
  const s = useStyles();
  const [assistView, setAssistView] = useState<AssistView>('idle');
  const [assistPrompt, setAssistPrompt] = useState('');
  const [assistResult, setAssistResult] = useState<string | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const lastModeRef = useRef<'generate' | 'explain' | 'fix'>('generate');

  const callAssist = useCallback(
    async (mode: 'generate' | 'explain' | 'fix') => {
      lastModeRef.current = mode;
      setAssistView('loading');
      setAssistError(null);
      try {
        const r = await fetch(`/api/items/${engine}/${encodeURIComponent(id)}/assist`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode,
            sql: value,
            prompt: mode === 'generate' ? assistPrompt : undefined,
            errorText: mode === 'fix' ? resultError || '' : undefined,
            ...(extraBody || {}),
          }),
        });
        const j = await r.json();
        if (!j.ok) {
          setAssistView('idle');
          setAssistError(
            j?.code === 'no_aoai'
              ? `Copilot not configured: ${j?.hint || 'Set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT.'}`
              : j?.error || 'AI assist failed',
          );
          return;
        }
        setAssistResult(j.result);
        setAssistView(mode === 'explain' ? 'explain-result' : 'suggestion');
      } catch (e: any) {
        setAssistView('idle');
        setAssistError(e?.message || String(e));
      }
    },
    [engine, id, value, assistPrompt, resultError, extraBody],
  );

  return (
    <>
      {/* Copilot action bar */}
      <div className={s.assistBar}>
        <Tooltip content={`Generate ${dialectLabel} from a description`} relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={<Sparkle16Regular />}
            disabled={assistView === 'loading'}
            onClick={() => {
              setAssistResult(null);
              setAssistError(null);
              setAssistView('prompt');
            }}
            aria-label="Ask Copilot to generate SQL"
          >
            Ask Copilot
          </Button>
        </Tooltip>
        <Tooltip content="Explain this query" relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={<Info16Regular />}
            disabled={!value.trim() || assistView === 'loading'}
            onClick={() => callAssist('explain')}
            aria-label="Explain SQL"
          >
            Explain
          </Button>
        </Tooltip>
        {resultError && (
          <Tooltip content="Fix the SQL error" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Wrench16Regular />}
              disabled={assistView === 'loading'}
              onClick={() => callAssist('fix')}
              aria-label="Fix SQL error"
            >
              {assistView === 'loading' && lastModeRef.current === 'fix' ? 'Fixing…' : 'Fix'}
            </Button>
          </Tooltip>
        )}
      </div>

      {/* NL prompt input — generate mode */}
      {assistView === 'prompt' && (
        <div className={s.assistBar}>
          <Input
            size="small"
            autoFocus
            style={{ flex: 1 }}
            placeholder="Describe the query (e.g. 'top 10 customers by revenue last quarter')…"
            value={assistPrompt}
            onChange={(_: unknown, d: any) => setAssistPrompt(d.value)}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter' && assistPrompt.trim()) callAssist('generate');
              if (e.key === 'Escape') setAssistView('idle');
            }}
            aria-label="AI SQL generation prompt"
          />
          <Button size="small" appearance="primary" disabled={!assistPrompt.trim()} onClick={() => callAssist('generate')}>
            Generate
          </Button>
          <Button
            size="small"
            onClick={() => {
              setAssistView('idle');
              setAssistPrompt('');
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {assistView === 'loading' && (
        <div className={s.assistBar}>
          <Spinner
            size="tiny"
            labelPosition="after"
            label={
              lastModeRef.current === 'generate'
                ? `Generating ${dialectLabel}…`
                : lastModeRef.current === 'explain'
                  ? 'Explaining…'
                  : 'Fixing…'
            }
          />
        </div>
      )}

      <MonacoTextarea
        value={value}
        onChange={onChange}
        language={language}
        height={height}
        minHeight={minHeight}
        ariaLabel={ariaLabel}
      />

      {/* Suggestion / explanation result */}
      {(assistView === 'suggestion' || assistView === 'explain-result') && assistResult && (
        <MessageBar intent={assistView === 'explain-result' ? 'info' : 'success'} style={{ margin: '4px 0 0' }}>
          <MessageBarBody>
            <pre className={s.assistResult}>{assistResult}</pre>
          </MessageBarBody>
          <MessageBarActions>
            {assistView === 'suggestion' && (
              <Button
                size="small"
                appearance="primary"
                onClick={() => {
                  onChange(assistResult);
                  onApply?.();
                  setAssistView('idle');
                  setAssistResult(null);
                  setAssistPrompt('');
                }}
              >
                Apply
              </Button>
            )}
            <Button
              size="small"
              onClick={() => {
                setAssistView('idle');
                setAssistResult(null);
              }}
            >
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {/* Honest config gate / error */}
      {assistError && (
        <MessageBar intent="error" style={{ margin: '4px 0 0' }}>
          <MessageBarBody>{assistError}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => setAssistError(null)}>
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
    </>
  );
}
