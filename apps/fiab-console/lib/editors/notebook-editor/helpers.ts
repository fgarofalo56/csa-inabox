// helpers.ts — pure utility functions for the notebook-editor.
// No JSX; no 'use client' needed. Extracted verbatim from notebook-editor.tsx.

import { type NotebookCell, emptyCell } from '@/lib/types/notebook-cell';
import { STARTER_PY, SPARK_MAGICS, COMPUTE_RUNNING, CI_STOPPED } from './constants';

export function cellRoutesToSpark(source: string): boolean {
  const line = source.split('\n').find(l => l.trim() !== '');
  if (!line) return false;
  return SPARK_MAGICS.includes(line.trim().toLowerCase().split(/\s+/)[0]);
}

// Starter cells per cluster type now come from starterCellFor() in
// lib/components/editor/cluster-runtime.ts (Databricks dbutils/display vs
// Synapse mssparkutils vs Azure ML SDK) so a NEW notebook seeds with the
// runtime-correct syntax. STARTER_PY remains the in-editor default seed +
// loadDetail fallback for the historically-validated PySpark path.

export function starterCells(): NotebookCell[] {
  return [
    { ...emptyCell('markdown'), source: '# New notebook\n\nDouble-click to edit. Use **+ Code** between cells to add code cells.' },
    { ...emptyCell('code', 'pyspark'), source: STARTER_PY },
  ];
}

/** Split a cell source into ipynb `source` lines (each keeps its trailing \n). */
export function splitKeep(source: string): string[] {
  const parts = (source || '').split('\n');
  return parts.map((l, i) => (i < parts.length - 1 ? l + '\n' : l));
}

/** Trigger a client-side download of a JSON object as a file. */
export function downloadJson(filename: string, data: unknown): void {
  try {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* download blocked — no-op */ }
}

export function decodePy(b64: string): string {
  try {
    return typeof window === 'undefined' ? Buffer.from(b64, 'base64').toString('utf-8')
      : decodeURIComponent(escape(atob(b64)));
  } catch { return ''; }
}

export function isComputeRunning(state?: string): boolean {
  return COMPUTE_RUNNING.includes(state || '');
}

export function isCiStopped(state?: string): boolean {
  return CI_STOPPED.includes(state || '');
}

/**
 * Heuristic: does this cell run a Structured Streaming query that never
 * completes on its own? (writeStream/readStream + awaitTermination — but NOT
 * trigger(availableNow=...), which is a batch-style run that finishes.) Used to
 * surface "Streaming (live)" instead of an indefinite "running", and to treat
 * the poll-window end as expected rather than a timeout error.
 */
export function looksStreaming(source: string): boolean {
  if (/availableNow\s*=\s*True/i.test(source)) return false;
  return /\bawaitTermination\s*\(/.test(source)
    || (/\bwriteStream\b/.test(source) && !/\btrigger\s*\(\s*once\s*=\s*True/i.test(source));
}
