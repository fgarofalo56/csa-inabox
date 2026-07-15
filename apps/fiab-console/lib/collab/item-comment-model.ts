/**
 * item-comment-model — the PURE (no-Cosmos) validation/normalization layer for
 * BR-COMMENTS item-level review comments. The item-comment BACKEND already
 * exists (app/api/items/[type]/[id]/comments: list / post w/ mentions→notify /
 * owner-delete, plus a `parentId` threading field). This module owns the two
 * missing pieces — EDIT and RESOLVE — as pure helpers so the route stays thin
 * and the rules are unit-tested without a live account.
 */

/** Max characters in an item-comment body (over-long input is truncated). */
export const MAX_ITEM_COMMENT_LEN = 8000;

/** Trim + cap a comment body. Returns '' when nothing usable was supplied. */
export function normalizeItemCommentBody(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > MAX_ITEM_COMMENT_LEN ? t.slice(0, MAX_ITEM_COMMENT_LEN) : t;
}

/** The fields a PATCH may carry. */
export interface ItemCommentPatchInput {
  body?: unknown;
  resolved?: unknown;
}

/** The normalized subset to write (only present fields). null → invalid input. */
export interface ItemCommentPatchFields {
  body?: string;
  resolved?: boolean;
}

/**
 * Normalize a PATCH input. Returns null when NOTHING actionable was supplied
 * (route → 422) or when a supplied `body` is blank (an edit cannot blank a
 * comment). `resolved` is coerced to a strict boolean when present.
 */
export function normalizeItemCommentPatch(input: ItemCommentPatchInput): ItemCommentPatchFields | null {
  const out: ItemCommentPatchFields = {};
  if (input.body !== undefined) {
    const body = normalizeItemCommentBody(input.body);
    if (!body) return null; // an edit cannot blank the comment
    out.body = body;
  }
  if (input.resolved !== undefined) {
    out.resolved = input.resolved === true;
  }
  if (out.body === undefined && out.resolved === undefined) return null; // nothing to do
  return out;
}

/**
 * Authorization decision for a PATCH, given who authored the comment and who is
 * asking. EDITING the body is author-only; RESOLVING/reopening a thread is a
 * collaborative action any item-accessor may take. Returns the allowed subset
 * (dropping a body edit the caller isn't entitled to) or null when the caller
 * may do NONE of what they asked (route → 403).
 */
export function authorizeItemCommentPatch(
  fields: ItemCommentPatchFields,
  authorOid: string,
  actorOid: string,
): ItemCommentPatchFields | null {
  const isAuthor = authorOid === actorOid;
  const allowed: ItemCommentPatchFields = {};
  if (fields.body !== undefined) {
    if (!isAuthor) return null; // asked to edit someone else's body → forbidden
    allowed.body = fields.body;
  }
  if (fields.resolved !== undefined) {
    allowed.resolved = fields.resolved; // resolve is open to any item-accessor
  }
  return Object.keys(allowed).length ? allowed : null;
}
