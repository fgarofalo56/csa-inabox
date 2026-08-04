/**
 * Structured errors — PRP §5.2: "Raw stack traces or upstream Azure error
 * bodies — normalized to `{ok:false, error, hint}`."
 *
 * Every failure a tool surfaces is turned into a `{ ok:false, error, code?, hint? }`
 * envelope, with the message run through {@link scrubString} so an upstream body
 * that echoes a token cannot leak through the error path. Stack traces are never
 * included.
 */
import { isLoomApiError } from '@csa-loom/sdk';
import { scrubString } from './scrub.js';
import type { ToolResult } from './types.js';

export interface NormalizedError {
  ok: false;
  error: string;
  code?: string;
  hint?: string;
}

/** Normalize any thrown value into a safe, scrubbed error envelope. */
export function normalizeError(e: unknown): NormalizedError {
  if (isLoomApiError(e)) {
    return {
      ok: false,
      error: scrubString(e.message),
      code: e.code,
      hint: e.hint ? scrubString(e.hint) : undefined,
    };
  }
  if (e instanceof Error) {
    return { ok: false, error: scrubString(e.message) };
  }
  return { ok: false, error: scrubString(String(e)) };
}

/** Build an MCP tool-error result from an arbitrary thrown value. */
export function toErrorResult(e: unknown): ToolResult {
  const norm = normalizeError(e);
  return {
    content: [{ type: 'text', text: JSON.stringify(norm, null, 2) }],
    isError: true,
    structuredContent: norm as unknown as Record<string, unknown>,
  };
}

/** Build an MCP tool-error result from an explicit message/code/hint. */
export function errorResult(error: string, code?: string, hint?: string): ToolResult {
  const norm: NormalizedError = { ok: false, error: scrubString(error), code, hint: hint ? scrubString(hint) : undefined };
  return {
    content: [{ type: 'text', text: JSON.stringify(norm, null, 2) }],
    isError: true,
    structuredContent: norm as unknown as Record<string, unknown>,
  };
}
