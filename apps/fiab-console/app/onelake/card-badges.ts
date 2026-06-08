/**
 * Pure, DOM-free helpers for the OneLake catalog item-card badges
 * (endorsement chip + owner avatar initials + domain chip).
 *
 * Kept out of the `'use client'` page module so they can be unit-tested on the
 * node vitest environment without jsdom — the rendering (tileFooter) stays in
 * page.tsx and consumes these.
 */

/** Derive two-letter initials from a UPN, email, or display name. Fluent's
 *  Avatar auto-initials algorithm splits on whitespace only, so a UPN like
 *  "jane.doe@contoso.com" would collapse to one letter — pre-process here so
 *  the owner avatar shows a stable two-letter monogram. */
export function initials(who: string): string {
  if (!who || who.length < 1) return '?';
  const local = who.includes('@') ? who.split('@')[0] : who;
  const parts = local.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return local.slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Resolve the effective endorsement label for an item, honoring the legacy
 *  `state.certified` boolean for items that predate `state.endorsement`.
 *  Returns null when the item is not endorsed (→ the card renders no chip). */
export function endorsementOf(it: {
  endorsement?: string;
  state?: Record<string, unknown>;
}): string | null {
  return it.endorsement || (it.state?.['certified'] ? 'Certified' : null) || null;
}
