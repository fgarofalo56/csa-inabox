/**
 * Pure browse logic for the ShortcutWizard's step 2 (split out of
 * shortcut-wizard.tsx so the component stays under its size ceiling).
 *
 * With a source lakehouse, the listing is scoped to that item (`lakehouseId`).
 * The paths route answers with the container and root it resolved, and the
 * wizard adopts both. Without one, the wizard lists the picked container
 * directly, and the route limits that to tenant admins.
 */

export interface ShortcutBrowseEntry { name: string; isDirectory: boolean; size: number }

/** The paths-route URL for one listing level. */
export function shortcutBrowseUrl(lakehouse: string, container: string, prefix: string): string {
  const scope = lakehouse ? `lakehouseId=${encodeURIComponent(lakehouse)}` : `container=${encodeURIComponent(container)}`;
  return `/api/lakehouse/paths?${scope}&prefix=${encodeURIComponent(prefix)}`;
}

export type ShortcutBrowseOutcome =
  | { kind: 'entries'; paths: ShortcutBrowseEntry[]; resolved?: { container: string; root: string } }
  | { kind: 'error'; message: string };

/**
 * What the wizard says when a container listing is refused. The route's own
 * text ends with an instruction for the lakehouse editor ("Open the lakehouse
 * and browse from its editor."), which is the wrong next step inside this
 * wizard, so the wizard gives its own instruction in place of the route's.
 */
export const SHORTCUT_CONTAINER_REFUSED =
  'Browsing a storage container directly is limited to tenant admins. '
  + 'Go back and pick a source lakehouse to browse its files instead.';

/** Turn one paths-route answer into the rows to show, or the message to show instead. */
export function shortcutBrowseOutcome(
  status: number, body: any, lakehouse: string, container: string, prefix: string,
): ShortcutBrowseOutcome {
  if (body?.ok && lakehouse && !body.container) {
    return { kind: 'error', message: body.gate || 'This lakehouse has no storage to browse yet.' };
  }
  if (body?.ok) {
    return {
      kind: 'entries',
      paths: body.paths || [],
      ...(lakehouse ? { resolved: { container: body.container, root: body.root ?? '' } } : {}),
    };
  }
  if (status === 403 && !lakehouse) return { kind: 'error', message: SHORTCUT_CONTAINER_REFUSED };
  const where = lakehouse ? 'this lakehouse' : `${container}/${prefix}`;
  return { kind: 'error', message: body?.error || `Could not list ${where} (HTTP ${status}).` };
}

/**
 * Breadcrumbs for the folder shown. A lakehouse listing starts at the
 * lakehouse's root (`root`, non-null once the first listing answered); a
 * container listing starts at the container.
 */
export function shortcutBrowseCrumbs(
  shownPrefix: string, root: string | null, isLakehouse: boolean, rootLabel: string,
): { label: string; prefix: string }[] {
  const base = isLakehouse && root !== null ? root : '';
  const rel = base && shownPrefix.startsWith(base) ? shownPrefix.slice(base.length) : shownPrefix;
  const acc = [{ label: rootLabel || 'root', prefix: base }];
  let cur = base;
  for (const s of rel.split('/').filter(Boolean)) {
    cur = cur ? `${cur}/${s}` : s;
    acc.push({ label: s, prefix: cur });
  }
  return acc;
}
