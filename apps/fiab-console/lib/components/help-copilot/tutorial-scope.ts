/**
 * tutorial-scope — pure helper shared by the Help Copilot widget.
 *
 * Editor tutorials dispatched by the Learn side panel encode the open item in
 * their id as "editor:<type>#<id>". When the route hasn't placed the item id
 * in the path (e.g. the Learn panel opened over a listing page), the widget
 * falls back to this parse so the agent's readReceipts tool still resolves to a
 * concrete item for auto-error detection. Returns undefined for tutorial ids
 * that don't reference a concrete, already-created item.
 *
 * Kept dependency-free (no React/Fluent imports) so it is unit-testable in
 * isolation and reused without pulling the client component into a test.
 */
export interface TutorialReceiptScope {
  itemType: string;
  itemId: string;
}

export function receiptScopeFromTutorialId(
  id: string | undefined,
): TutorialReceiptScope | undefined {
  if (!id) return undefined;
  const m = /^editor:([^#]+)#(.+)$/.exec(id.trim());
  if (!m) return undefined;
  const itemType = m[1].trim();
  const itemId = m[2].trim();
  // A "new"/unsaved item has no receipts yet — don't fabricate a scope for it.
  if (!itemType || !itemId || itemId === 'new') return undefined;
  return { itemType, itemId };
}
