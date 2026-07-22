'use client';

// driver-log-pane.tsx — DriverLogPane sub-component for the notebook-editor.
// Extracted verbatim from notebook-editor.tsx.

import { useState, useEffect } from 'react';
import { Caption1, tokens } from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';

/**
 * DriverLogPane — collapsible live tail of the Spark DRIVER LOG for the active
 * Livy session (Databricks/Synapse notebook parity, #63 output fidelity).
 * Polls GET /runs/spark:<pool>:<sessionId>/log every 4s while expanded; shows
 * the last ~200 lines (cold-start progress, stdout, stderr). Collapsing stops
 * the poll — no background traffic while closed.
 */
export function DriverLogPane({ notebookId, workspaceId, pool, sessionId }: {
  notebookId: string; workspaceId: string; pool: string; sessionId: number;
}) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const runId = `spark:${pool}:${sessionId}`;
    const tick = async () => {
      try {
        const r = await clientFetch(
          `/api/items/notebook/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}/log?workspaceId=${encodeURIComponent(workspaceId)}&size=200`,
        );
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!j?.ok) { setLogErr(j?.error || `HTTP ${r.status}`); return; }
        setLogErr(null); setTotal(j.total || 0); setLines(j.lines || []);
      } catch (e: any) {
        if (alive) setLogErr(String(e?.message || e));
      }
    };
    void tick();
    const t = setInterval(() => { void tick(); }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [open, notebookId, workspaceId, pool, sessionId]);

  return (
    <details
      style={{ minWidth: 0, maxWidth: '100%' }}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary style={{ cursor: 'pointer', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, userSelect: 'none' }}>
        Driver log (live tail{total ? ` · ${total} lines` : ''})
      </summary>
      {logErr && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{logErr}</Caption1>}
      <code
        style={{
          display: 'block',
          marginTop: tokens.spacingVerticalXS,
          padding: tokens.spacingHorizontalS,
          borderRadius: tokens.borderRadiusSmall,
          backgroundColor: tokens.colorNeutralBackground3,
          color: tokens.colorNeutralForeground3,
          fontFamily: tokens.fontFamilyMonospace,
          fontSize: tokens.fontSizeBase100,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          maxWidth: '100%',
          minWidth: 0,
          maxHeight: 260,
          overflow: 'auto',
          boxSizing: 'border-box',
        }}
      >{lines.length ? lines.join('\n') : 'No driver output yet — the log fills as the session starts and cells run.'}</code>
    </details>
  );
}
