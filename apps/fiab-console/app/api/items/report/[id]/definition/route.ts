/**
 * PUT /api/items/report/[id]/definition
 *
 * Atomically persist the WHOLE Loom-native report definition authored in the
 * report DESIGNER — every page, every visual, every visual's field wells and
 * canvas layout, PLUS the report-designer structured extras: per-visual FORMAT
 * (title/colors/axis/legend/number-format AND the wave-1 effect groups +
 * conditional formatting), per-visual ANALYTICS reference lines, per-visual /
 * per-page / report-level structured FILTERS, and per-PAGE canvas config
 * (type/size/background/hidden + the visual-interactions matrix) — into the
 * report item's `state.content` (Cosmos). This is the designer's "Save" path;
 * the single-visual Copilot append still uses POST …/visual.
 *
 * Azure-native default (no-fabric-dependency.md): the saved definition is what
 * the Loom-native renderer queries against the report's resolved data source
 * (semantic-model over Synapse/lakehouse via SQL, or the advanced AAS tabular
 * binding via DAX) in POST …/query. NO Power BI / Fabric workspace required.
 * We NEVER call api.powerbi.com on this path. The chosen `state.dataSource`
 * is owned by the sibling …/data-source route and is preserved untouched here.
 *
 * The persisted shape stays back-compatible with the read-only viewer and the
 * PBIR provisioner (`ReportContent.pages[].visuals[]` = { type, title, field?,
 * config? }):
 *   - `type`   — renderer vocabulary (table | matrix | card | bar | column |
 *                line | area | pie | donut | scatter | slicer, PLUS the wave-1
 *                visuals: combo | ribbon | waterfall | funnel | gauge | kpi |
 *                treemap | multiRowCard)
 *   - `field`  — derived single-field shortcut (first value/category) so the
 *                legacy viewer + /query single-field path still render
 *   - `config` — { wells, layout, format?, analytics?, filters? } the designer
 *                round-trips. `wells` gains additive wave-1 wells (secondary
 *                values / target / min / max / small multiples / tooltips /
 *                details); `format`, `analytics`, and `filters` are ADDITIVE —
 *                the read-only viewer and PBIR provisioner ignore unknown keys.
 *   - page `config` — { type, size, background, hidden, interactions } is
 *                ADDITIVE on the page (the viewer + provisioner ignore it).
 *   - page `elements` — the wave-7 free-form CANVAS ELEMENTS ({ textBox | image
 *                | shape | button | pageNavigator | bookmarkNavigator }[]) is
 *                ADDITIVE on the page and rides the SAME absolute layout / `z`
 *                space as the page's visuals (a shape can sit behind chart A but
 *                in front of chart B). Every element is structured + whitelisted
 *                server-side (kind/shape/fit/icon/action enums; runs are a fixed
 *                formatting whitelist with NO raw HTML; every URL passes the
 *                strict `clampUrl` https:/mailto:/data:image gate → XSS-safe).
 *                The read-only viewer + PBIR provisioner ignore `page.elements`.
 *
 * The extras are ALL STRUCTURED + whitelisted server-side (no-freeform-
 * config.md): filter operators, format presets, conditional-format modes/ops,
 * analytics line kinds, canvas types, and interaction modes are checked against
 * fixed enum sets; colors are clamped to bounded strings; numbers are clamped to
 * ranges. The user never types DAX / JSON / format strings — the designer emits
 * these shapes from pickers + switches, and the /query compiler turns filters
 * into SQL `WHERE` / DAX `FILTER` while the format / analytics / conditional /
 * interaction layers apply client-side over the same real `/query` rows.
 *
 * Body: {
 *   pages: DesignerPage[]                  // each: { name, filters?, config?, visuals[], elements[] }
 *   reportFilters?: WireFilter[]           // report-scope structured filters
 *   bookmarks?: ReportBookmark[]           // wave-2 captured bookmarks (additive)
 *   filterPaneFormat?: FilterPaneFormat    // wave-2 Filters-pane styling (additive)
 *   theme?: ReportTheme                    // wave-3 palette/typography/structural theme (additive)
 *   dataSource?: ...                       // IGNORED here (owned by …/data-source)
 * }
 * 200 OK → { ok: true, pageCount, visualCount, reportFilterCount, bookmarkCount, themeApplied }
 * 4xx    → { ok: false, error }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import { updateOwnedItem } from '../../../_lib/item-crud';
import {
  num,
  VISUAL_TYPES,
  EXTRA_WELL_NAMES,
  MAX_SCRIPT,
  sanitizeWellList,
  sanitizeFormat,
  sanitizeAnalytics,
  sanitizeFilterList,
  sanitizeVisualFlags,
  deriveField,
  sanitizePageConfig,
  sanitizeElements,
  sanitizeBookmarks,
  sanitizeFilterPaneFormat,
  sanitizeReportTheme,
  sanitizeSyncGroups,
  sanitizeFieldParameters,
  sanitizeWhatIfParams,
  sanitizeReportSettings,
  type PageIn,
  type VisualIn,
  type PersistedPage,
  type ReportContentV2,
} from '@/lib/report/report-definition-sanitizer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  let body: {
    pages?: unknown;
    reportFilters?: unknown;
    bookmarks?: unknown;
    filterPaneFormat?: unknown;
    theme?: unknown;
    syncSlicers?: unknown;
    fieldParameters?: unknown;
    whatIfParams?: unknown;
    settings?: unknown;
  } = {};
  try { body = await req.json(); } catch {}
  if (!Array.isArray(body.pages)) {
    return NextResponse.json({ ok: false, error: 'body.pages[] is required' }, { status: 400 });
  }

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  // Build the persisted ReportContent from the designer model. Always keep at
  // least one page so a saved report is never empty/broken.
  const pagesIn = (body.pages as PageIn[]).length ? (body.pages as PageIn[]) : [{ name: 'Page 1', visuals: [] }];
  let visualCount = 0;
  const pages: PersistedPage[] = pagesIn.map((p, pi) => {
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `Page ${pi + 1}`;
    const visualsRaw = Array.isArray(p.visuals) ? (p.visuals as VisualIn[]) : [];
    const visuals = visualsRaw.map((v) => {
      const vt = String(v.visualType || v.type || 'table');
      const type = VISUAL_TYPES.has(vt) ? vt : 'table';
      const title = typeof v.title === 'string' ? v.title : '';
      const wellsIn = (v.wells || {}) as Record<string, unknown>;
      const category = sanitizeWellList(wellsIn.category);
      const values = sanitizeWellList(wellsIn.values);
      const legend = sanitizeWellList(wellsIn.legend);
      // wave-1 additive wells — persisted only when non-empty (legacy unaffected).
      const extraWells: Record<string, ReturnType<typeof sanitizeWellList>> = {};
      for (const wn of EXTRA_WELL_NAMES) {
        const list = sanitizeWellList(wellsIn[wn]);
        if (list.length) extraWells[wn] = list;
      }
      const layout = {
        x: num(v.layout?.x, 0),
        y: num(v.layout?.y, 0),
        w: Math.max(1, num(v.layout?.w, 6)),
        h: Math.max(1, num(v.layout?.h, 4)),
        // Persist the coordinate-space marker so the free-form canvas reloads
        // absolute px layouts exactly (legacy flow-grid records have no unit and
        // are migrated to absolute on load). Only 'px'/'grid' are accepted.
        ...(v.layout?.unit === 'px' || v.layout?.unit === 'grid' ? { unit: v.layout.unit } : {}),
      };
      // v2 additive extras — structured + whitelisted; omitted when empty so the
      // persisted `config` stays minimal and the legacy viewer is unaffected.
      const format = sanitizeFormat(v.format);
      const analytics = sanitizeAnalytics(v.analytics);
      const visualFilters = sanitizeFilterList(v.filters);
      // wave-2 Selection-pane / canvas flags (hidden/locked/groupId) + z-order.
      // z folds into layout (not in the visual query signature → undo/redo safe);
      // hidden/locked/groupId fold into config additively. All omitted when unset.
      const flags = sanitizeVisualFlags(v);
      // wave-4 script-visual config (R / Python). The code editor IS the script
      // visual's surface — PBI's R/Python visual is itself a code box — so it is
      // EXEMPT from no-freeform-config.md exactly like the ADF expression builder;
      // the language toggle + the Values wells stay structured. Both keys are
      // ADDITIVE + whitelisted (language → 'python'|'r' enum, script → string
      // clamped to MAX_SCRIPT) and persisted ONLY when present, so legacy /
      // non-script visuals are unaffected. They carry the runner's two inputs and
      // the designer reads config.{language,script} back only for type
      // 'scriptVisual', so a saved script survives a reload (no-vaporware).
      const scriptLanguage = v.language === 'python' || v.language === 'r' ? v.language : undefined;
      const scriptText = typeof v.script === 'string' ? v.script.slice(0, MAX_SCRIPT) : undefined;
      visualCount += 1;
      return {
        type,
        title,
        field: deriveField(values, category),
        config: {
          wells: { category, values, legend, ...extraWells },
          layout: { ...layout, ...(flags.z !== undefined ? { z: flags.z } : {}) },
          ...(format ? { format } : {}),
          ...(analytics ? { analytics } : {}),
          ...(visualFilters.length ? { filters: visualFilters } : {}),
          ...(flags.hidden ? { hidden: true } : {}),
          ...(flags.locked ? { locked: true } : {}),
          ...(flags.groupId ? { groupId: flags.groupId } : {}),
          ...(scriptLanguage ? { language: scriptLanguage } : {}),
          ...(scriptText !== undefined ? { script: scriptText } : {}),
        },
      };
    });
    const pageFilters = sanitizeFilterList(p.filters);
    const pageConfig = sanitizePageConfig(p.config);
    // wave-7 free-form canvas elements (additive; share the visuals' layout/z
    // space). Emitted only when non-empty so legacy pages stay byte-for-byte same.
    const elements = sanitizeElements(p.elements);
    return {
      name,
      visuals,
      ...(pageFilters.length ? { filters: pageFilters } : {}),
      ...(pageConfig ? { config: pageConfig } : {}),
      ...(elements.length ? { elements } : {}),
    };
  });

  const reportFilters = sanitizeFilterList(body.reportFilters);
  // wave-2 report-level state: bookmarks (page/filter/selection/visibility/z-order
  // capture) + the Filters-pane format. Both additive + fully sanitized.
  const bookmarks = sanitizeBookmarks(body.bookmarks);
  const filterPaneFormat = sanitizeFilterPaneFormat(body.filterPaneFormat);
  // wave-3 report-level state: the report THEME (palette + typography + structural
  // colors). Additive + fully sanitized through the structured/whitelisted gate.
  const theme = sanitizeReportTheme(body.theme);
  // wave-8 report-level interactivity state: sync-slicers groups, field
  // parameters, and numeric-range what-if parameters. All additive + structured.
  const syncSlicers = sanitizeSyncGroups(body.syncSlicers);
  const fieldParameters = sanitizeFieldParameters(body.fieldParameters);
  const whatIfParams = sanitizeWhatIfParams(body.whatIfParams);
  // wave-9 report-level settings: auto-refresh interval + persistent-filters,
  // export, visual-header, and cross-report-drillthrough toggles. Additive +
  // structured; drives the client auto-refresh + export-gating.
  const settings = sanitizeReportSettings(body.settings);

  const state = (item.state || {}) as Record<string, unknown>;
  // ADDITIVE persist: keep every other state key (incl. `state.dataSource`,
  // owned by the …/data-source route, and the legacy AAS binding) untouched.
  const content: ReportContentV2 = {
    kind: 'report',
    pages,
    ...(reportFilters.length ? { reportFilters } : {}),
    ...(bookmarks.length ? { bookmarks } : {}),
    ...(filterPaneFormat ? { filterPaneFormat } : {}),
    ...(theme ? { theme } : {}),
    ...(syncSlicers.length ? { syncSlicers } : {}),
    ...(fieldParameters.length ? { fieldParameters } : {}),
    ...(whatIfParams.length ? { whatIfParams } : {}),
    ...(settings ? { settings } : {}),
  };
  const newState = { ...state, content };

  const updated = await updateOwnedItem(cosmosId, 'report', session.claims.oid, { state: newState });
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'failed to persist report definition' }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    backend: 'loom-native' as const,
    pageCount: pages.length,
    visualCount,
    reportFilterCount: reportFilters.length,
    bookmarkCount: bookmarks.length,
    themeApplied: !!theme,
  });
}
