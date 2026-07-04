'use client';

/**
 * lakehouse/shared.tsx — SHARED module for the Lakehouse editor.
 *
 * useStyles, the module-level types/interfaces, and the pure helper functions
 * (formatBytes / leafName / collectEntries / formatCell / parseJsonOrError)
 * used by the Lakehouse editor shell. Extracted verbatim from
 * lakehouse-editor.tsx (behavior-preserving split — zero logic change).
 */

import { makeStyles, tokens } from '@fluentui/react-components';
import { useSharedEditorStyles } from '../shared-styles';
import { useMemo } from 'react';

const useLocalStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflow: 'auto', maxHeight: '480px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  rowHover: { ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, cursor: 'pointer' } },
  rowSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  editor: {
    width: '100%', minHeight: '160px',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  preview: { width: '100%', minHeight: '240px',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1 },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

interface ContainerInfo { name: string; url: string }
interface PathEntry { name: string; isDirectory: boolean; size: number; lastModified?: string; etag?: string; tier?: string }

/**
 * Reference-Lakehouse federation (F8) — another in-workspace lakehouse added to
 * the explorer for side-by-side, READ-ONLY browsing. `account` is the resolved
 * ADLS account (primary LOOM account unless the lakehouse declares its own);
 * `reachable` reflects the pass-through RBAC probe (Console UAMI must hold
 * Storage Blob Data Reader on the referenced containers).
 */
interface ReferenceLakehouse {
  id: string;
  displayName: string;
  account: string;
  containers: string[];
  reachable: boolean;
}

/** A file selected inside a referenced lakehouse (drives the read-only preview). */
interface RefSelection {
  refId: string;
  displayName: string;
  account: string;
  container: string;
  entry: PathEntry;
}

interface PreviewResponse {
  ok: boolean;
  format?: string;
  bulkUrl?: string;
  sql?: string;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  previewable?: boolean;
  message?: string;
  error?: string;
  code?: string;
}

interface HistoryRow {
  version: number;
  timestamp: string;
  operation: string;
  userName?: string;
  metrics: {
    numOutputRows?: number;
    numFiles?: number;
    numRemovedFiles?: number;
    numDeletedRows?: number;
    numOutputBytes?: number;
  };
  operationParameters?: Record<string, unknown>;
}

function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function leafName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.substring(i + 1) : trimmed;
}

/** A file collected from a folder drag-drop, with its tree-relative path. */
interface UploadItem { relativePath: string; file: File }

/**
 * Recursively walk a drag-dropped FileSystemEntry, preserving the directory
 * tree as a relative path (`folder/sub/file.txt`). Uses the webkit Entries API
 * (the only browser API that exposes a dropped folder's contents). readEntries
 * yields at most 100 entries per call, so we loop until the reader is drained.
 */
async function collectEntries(entry: FileSystemEntry, prefix = ''): Promise<UploadItem[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((res, rej) => fileEntry.file(res, rej));
    return [{ relativePath: prefix + file.name, file }];
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    // Drain the reader (100 entries at a time) until it returns empty.
    await new Promise<void>((resolve, reject) => {
      const readNext = () => {
        reader.readEntries((batch) => {
          if (!batch.length) { resolve(); return; }
          all.push(...batch);
          readNext();
        }, reject);
      };
      readNext();
    });
    const nested = await Promise.all(all.map((e) => collectEntries(e, `${prefix}${entry.name}/`)));
    return nested.flat();
  }
  return [];
}

/** A tenant sensitivity label, as returned by /api/admin/security/mip/labels. */
interface MipLabelOption { id: string; name?: string; displayName?: string; isAppliable?: boolean }

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Defensive response parser. If a gateway / Container App / WAF / 404 returns
 * an HTML error page (`<!DOCTYPE ...`), `r.json()` throws
 * "Unexpected token '<', "<!DOCTYPE "... is not valid JSON". Sniff the
 * content-type and only call `.json()` when the body actually is JSON;
 * otherwise return a structured `{ ok: false, error }` carrying the HTTP
 * status + the first line of the body so the user sees a precise message
 * instead of a raw JSON.parse crash.
 *
 * Every `fetch().json()` in this editor routes through here.
 */
async function parseJsonOrError<T extends { ok?: boolean; error?: string }>(
  r: Response,
  label: string,
): Promise<T> {
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      const j = (await r.json()) as T;
      // Surface an HTTP error even when the body parsed but lacks ok.
      if (!r.ok && j && j.ok === undefined) {
        return { ok: false, error: j.error || `${label} failed (HTTP ${r.status}).` } as T;
      }
      return j;
    } catch {
      /* fall through to text handling */
    }
  }
  let bodyText = '';
  try { bodyText = (await r.text()).trim(); } catch { /* ignore */ }
  const firstLine = bodyText.split(/\r?\n/)[0]?.slice(0, 200) || '';
  const detail =
    r.status === 404 ? 'endpoint not found (404)'
    : r.status === 502 ? 'upstream error (502)'
    : r.status === 503 ? 'service unavailable (503)'
    : r.status === 401 ? 'sign-in expired (401) — reload and re-authenticate'
    : `HTTP ${r.status}`;
  return {
    ok: false,
    error: `${label} failed: ${detail}${firstLine ? ` — server said: ${firstLine}` : ''}`,
  } as T;
}

export {
  useStyles, formatBytes, leafName, collectEntries, formatCell, parseJsonOrError,
};
export type {
  ContainerInfo, PathEntry, ReferenceLakehouse, RefSelection, PreviewResponse,
  HistoryRow, UploadItem, MipLabelOption,
};
