'use client';
/**
 * Lakehouse → ADLS Gen2 binding, resolved for the EDITOR (client side).
 *
 * WHY THIS EXISTS (#3904 — operator-reported P0, live).
 *
 * The installer materialises a lakehouse at `<container>/lakehouses/<Name>/…`
 * and STAMPS the exact container + root it chose onto the item
 * (`state.provisioning.secondaryIds.{adlsRoot | container, rootPath}` —
 * lib/install/provisioners/lakehouse.ts). The editor ignored that record: it
 * opened on `containers[0]` (which is `bronze`, because `listContainers()`
 * walks `KNOWN_CONTAINERS` in order) and listed the CONTAINER ROOT (`''`).
 * `bronze/` is not where the lakehouse lives, and `bronze/Tables` does not
 * exist, so the Files browser 404'd on first open with a raw SDK message.
 *
 * The authority for this mapping is `resolveLakehouseAbfss`
 * (lib/azure/lakehouse-abfss.ts) — the same resolver `/api/lakehouse/tables`
 * uses, which is why Tables looked in the right place while Files did not.
 * That resolver is server-only (it reads Cosmos), so this module is its
 * client-side FAST PATH and nothing more: it reads the SAME stamped record the
 * resolver prefers (its steps 1 and 2) off the item the editor has already
 * fetched, and it NEVER guesses. When the record is absent, the caller asks the
 * server (`/api/lakehouse/paths?lakehouseId=…&workspaceId=…`), which runs
 * `resolveLakehouseAbfss` itself — including its env-derived step 3. One
 * decision function, one answer; this is a cache of it, not a second opinion.
 */
import { trimSlashes } from '@/lib/util/trim';

export interface LakehouseBinding {
  /** DLZ container the lakehouse was materialised in (e.g. `landing`). */
  container: string;
  /** Root path INSIDE that container (e.g. `lakehouses/Contoso Sales`). */
  root: string;
  /** Which record answered — for diagnosis, never for control flow. */
  source: 'adlsRoot' | 'secondaryIds' | 'server';
}

/** `abfss://<container>@<account>.dfs.<suffix>/<root>` — same shape lakehouse-abfss.ts parses. */
const ABFSS_RE = /^abfss:\/\/([^@]+)@[^/]+\/(.*)$/i;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Resolve the binding from the item record the editor already holds.
 *
 * Mirrors `resolveLakehouseAbfss` steps 1 → 2 EXACTLY:
 *   1. `secondaryIds.adlsRoot` — the full abfss URI the provisioner built.
 *   2. `secondaryIds.{container, rootPath}` — the container + root it recorded.
 *
 * Returns null when neither is stamped. It deliberately does NOT implement the
 * resolver's step-3 convention fallback: that one reads `LOOM_*_URL` env, which
 * the browser cannot see, and guessing it here would be a second, divergent
 * method for one decision (exactly the defect #3904 describes).
 */
export function bindingFromItemState(item: unknown): LakehouseBinding | null {
  const state = (item as { state?: Record<string, unknown> } | undefined)?.state;
  const provisioning = (state as { provisioning?: Record<string, unknown> } | undefined)?.provisioning;
  const sec = (provisioning?.secondaryIds ?? {}) as Record<string, unknown>;

  // 1. Full abfss root stamped at create time (most accurate, cloud-correct).
  const stamped = str(sec.adlsRoot);
  if (stamped.toLowerCase().startsWith('abfss://')) {
    const m = ABFSS_RE.exec(stamped);
    const container = m?.[1] ?? '';
    if (container) {
      return { container, root: trimSlashes(m?.[2] ?? ''), source: 'adlsRoot' };
    }
  }

  // 2. Recorded container + root.
  const container = str(sec.container);
  const rootPath = str(sec.rootPath);
  if (container && rootPath) {
    return { container, root: trimSlashes(rootPath), source: 'secondaryIds' };
  }

  return null;
}

/**
 * Join the lakehouse root with a path relative to it.
 * `('lakehouses/Foo', 'Tables')` → `'lakehouses/Foo/Tables'`;
 * `('', 'Tables')` → `'Tables'` (unbound lakehouse — container root, as before).
 */
export function joinPrefix(root: string, relative: string): string {
  const r = trimSlashes(root || '');
  const rel = trimSlashes(relative || '');
  if (!r) return rel;
  if (!rel) return r;
  return `${r}/${rel}`;
}

/**
 * Express a container-absolute path relative to the lakehouse root, for
 * DISPLAY (breadcrumbs, empty-state copy). Anything outside the root is
 * returned unchanged — the UI must never claim a path is inside the lakehouse
 * when it is not.
 */
export function relativeToRoot(root: string, absolute: string): string {
  const r = trimSlashes(root || '');
  const abs = trimSlashes(absolute || '');
  if (!r) return abs;
  if (abs === r) return '';
  return abs.startsWith(`${r}/`) ? abs.slice(r.length + 1) : abs;
}

/**
 * Strip a leading `<container>/` from a catalog path.
 *
 * `scanLakehouseTables` returns `adlsPath` as `<container>/<root>/Tables/<name>`
 * (synapse-catalog-client.ts), while `/api/lakehouse/{preview,history}` take a
 * container plus a CONTAINER-RELATIVE path. Passing `adlsPath` straight through
 * produced `landing/landing/lakehouses/…` — the same class of path defect as
 * #3904 and, until the root fix landed, hidden behind the 404 that came first.
 */
export function containerRelativePath(container: string | null | undefined, adlsPath: string): string {
  const c = trimSlashes(container || '');
  const p = trimSlashes(adlsPath || '');
  if (!c) return p;
  return p === c ? '' : p.startsWith(`${c}/`) ? p.slice(c.length + 1) : p;
}
