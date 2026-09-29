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
  const where = lakehouse ? 'this lakehouse' : `${container}/${prefix}`;
  const base = body?.error || `Could not list ${where} (HTTP ${status}).`;
  return {
    kind: 'error',
    message: status === 403 && !lakehouse ? `${base} Go back and pick a source lakehouse to browse its files instead.` : base,
  };
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
