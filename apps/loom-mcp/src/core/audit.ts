/**
 * Audit hook — PRP §5.7. One audit shape for the whole toolkit:
 * `{ts, principal, server, tool, args_hash, decision, count?, duration_ms, outcome, reason?}`.
 *
 * The default sink writes structured JSON to **stderr** (prefixed
 * `LOOM_MCP_AUDIT`). It MUST NOT write to stdout — stdout is the JSON-RPC
 * channel for the stdio transport, and any stray byte there corrupts the
 * protocol stream. In a deployed server this sink is swapped for one that ships
 * to `lib/admin/audit-stream` → `LoomAudit_CL`, unchanged in shape.
 *
 * Args are recorded only as a SHA-256 hash (`args_hash`), never in the clear —
 * a query string or item id may itself be sensitive.
 */
import { createHash } from 'node:crypto';
import type { AuditEvent, AuditSink } from './types.js';

/** SHA-256 (first 16 hex chars) of the tool's arguments. */
export function hashArgs(args: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(args ?? null);
  } catch {
    json = '<unserializable>';
  }
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/** The default audit sink: one JSON line per event on stderr. */
export const stderrAuditSink: AuditSink = (event: AuditEvent): void => {
  try {
    process.stderr.write(`LOOM_MCP_AUDIT ${JSON.stringify(event)}\n`);
  } catch {
    /* never let auditing throw into the caller */
  }
};

/** Emit through the given sink, swallowing sink errors. */
export function emitAudit(sink: AuditSink, event: AuditEvent): void {
  try {
    sink(event);
  } catch {
    /* auditing must never break a tool call */
  }
}
