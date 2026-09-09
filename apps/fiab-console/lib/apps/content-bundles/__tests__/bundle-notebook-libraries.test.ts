/**
 * #3530 (systemic arm) — EVERY shipped bundle notebook must declare the
 * packages its own cells import.
 *
 * The original fix closed the defect for ONE bundle. The issue also required
 * auditing the others before treating it as fixed, because the gap is
 * systemic: any bundle whose notebook imports outside the Spark stock image
 * fails the golden path (install → open → Run all) on `ModuleNotFoundError`.
 *
 * That audit cannot be a hand-checked sweep — a literal list goes stale the
 * moment someone adds a bundle. So it is a DERIVATION: `notebook-imports.ts`
 * reads the cells, and the population comes from `listBundleIds()`. The
 * sibling suite (`install/provisioners/__tests__/notebook-required-libraries`)
 * asserts app-rag-builder BY NAME, which is exactly why it stayed green while
 * other bundles were broken — a hardcoded population cannot see a new member.
 *
 * WHAT THE SWEEP FOUND
 *   - 22 undeclared imports across 8 bundles are baselined below, i.e. the SAME
 *     systemic gap the issue suspected, not a one-bundle defect.
 *   - `app-rag-builder` — the issue's OWN subject — still had an undeclared
 *     `langchain_text_splitters`. Its Run-all cleared the reported cell-2
 *     failure and then stopped on the identical error two cells later, so the
 *     issue's primary acceptance criterion was not actually met at head.
 *   - The FIRST version of the detector read one module per line, so Python's
 *     `import a, b` form was truncated to `a`. That made the sweep fail OPEN on
 *     a real shipped bundle: `app-supercharge-guide` has `import struct, pyodbc`
 *     and `pyodbc` was invisible. Measured on the same tree, before/after the
 *     comma fix: 24 findings -> 25, the one addition being
 *     `app-supercharge-guide::pyodbc`. `it('a comma-separated import clause
 *     names every module')` below is the regression arm.
 *   - Three baselined entries were then RESOLVED rather than deferred, because
 *     the "the pool image is unknowable from here" rationale did not survive
 *     this repo's own evidence: `app-rag-builder` declares `openai` and
 *     `azure-search-documents` in this same change, on the ground that the
 *     image does not ship them. `app-azure-realtime-analytics::openai`,
 *     `app-supercharge-gold::openai` and
 *     `app-change-feed-processor::azure.search.documents` are the identical
 *     import, so they now declare it too. 25 -> 22.
 *
 * WHY THERE IS A BASELINE, AND WHAT IT IS NOT
 * Closing the remaining entries requires knowing what the Synapse Spark /
 * Databricks pool images actually ship (is `xgboost` preinstalled? `flaml`?
 * `pyodbc`? `msal` transitively via azure-identity?). That is a fact about a
 * running pool image, and it cannot be established from this repo. Guessing in
 * either direction is harmful: a wrong "declare it" costs a pip round-trip on
 * every Run-all, a wrong "it's provided" re-opens #3530 for that bundle. Per
 * `deploy-integrity.md` R7 the honest move is to record what was MEASURED and
 * not assert what was not established.
 *
 * That rationale only covers a package this repo says NOTHING about. Where the
 * repo already takes a position — as it does for `openai` and
 * `azure-search-documents`, which `app-rag-builder` declares — the baseline may
 * not hide behind it; those entries were resolved, not deferred (see above).
 *
 * So the baseline is an explicit, enumerated debt list, and the assertions are
 * a RATCHET:
 *   1. no undeclared import may appear OUTSIDE the baseline (new work fails
 *      closed — this is the regression guard);
 *   2. the baseline may not contain stale entries (once one is resolved the
 *      entry must be deleted, so the list can only shrink).
 * It is NOT a statement that the baselined bundles are fine. They are not;
 * they are unverified, and the list is the tracked backlog.
 *
 * THE OTHER HALF OF THE SAME UNVERIFIABLE FACT, TRACKED HERE TOO.
 * `RUNTIME_PROVIDED_PREFIXES` in `notebook-imports.ts` is a claim about the
 * same pool image, in the opposite direction — and a wrong entry there is
 * strictly WORSE than a wrong baseline line, because it is SILENT: no finding,
 * no enumerated entry, no red test, just a `ModuleNotFoundError` on the
 * customer's Run-all. That list is therefore split into an EVIDENCED half (the
 * runtime itself, the host-injected `*utils` namespaces, and the two entries
 * with in-repo evidence) and an ASSERTED half, and the asserted half is tracked
 * on #3530 next to the baseline below:
 *
 *   pyarrow numpy pandas scipy sklearn matplotlib seaborn mlflow requests
 *
 * Each needs a `pip list` on a live Synapse 3.4 pool and on the Databricks
 * runtime before it can move. `it('the runtime-provided list declares its own
 * evidence')` keeps the split honest — it cannot check the CLAIMS (nothing
 * here can), only that every entry is classified and that the asserted half is
 * still what this docblock says it is.
 *
 * MEASURED CONTEXT for those claims, from this repo rather than from belief:
 * `platform/fiab/bicep/modules/landing-zone/synapse-spark-pools.bicep` sets
 * `sparkVersion: '3.4'` and declares NO `libraryRequirements`, so the pools run
 * the STOCK image.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) Delete `requiredLibraries` from `app-federal-data-mesh.ts` -> RED:
 *      "no bundle notebook has an undeclared import outside the baseline".
 *   b) Delete `'langchain-text-splitters'` from `app-rag-builder.ts` -> RED:
 *      same test, naming `langchain_text_splitters`.
 *   c) In `notebook-imports.ts` make `undeclaredImports` `return []` -> RED:
 *      "the detector reports an undeclared package" AND "every baseline entry
 *      is still a real finding" — the positive controls that prove the sweep
 *      can fail at all.
 *   d) In `isProvidedByRuntime` match the NORMALISED name instead of the
 *      dotted path -> RED: "runtime and stdlib modules are not demanded",
 *      because the `delta` prefix then swallows `delta_sharing`.
 *   e) In `IMPORT_RE` restore the one-module-per-line capture
 *      (`import[ \t]+([A-Za-z_][\w.]*)`) -> RED: "a comma-separated import
 *      clause names every module" AND "every baseline entry is still a real
 *      finding" (`app-supercharge-guide::pyodbc` goes invisible).
 *   f) Move `seaborn` from `RUNTIME_PROVIDED_ASSERTED` to
 *      `RUNTIME_PROVIDED_EVIDENCED` -> RED: "the runtime-provided list declares
 *      its own evidence" — an unverifiable claim cannot be quietly promoted to
 *      an evidenced one.
 */
import { describe, it, expect } from 'vitest';
import { listBundleIds, getBundle, NOTEBOOK_ITEM_TYPES } from '../index';
import {
  extractPythonImports,
  isProvidedByRuntime,
  distributionCovers,
  undeclaredImports,
  normalizeDistName,
  RUNTIME_PROVIDED_PREFIXES,
  RUNTIME_PROVIDED_ASSERTED_PREFIXES,
  RUNTIME_PROVIDED_EVIDENCED_PREFIXES,
} from '../notebook-imports';

/**
 * The unverifiable half of `RUNTIME_PROVIDED_PREFIXES`, restated here so a
 * silent promotion out of it reds. Kept in the SAME file as the baseline
 * because it is the same class of debt pointing the other way.
 */
const ASSERTED_AT_HEAD: readonly string[] = [
  'pyarrow',
  'numpy', 'pandas', 'scipy', 'sklearn', 'matplotlib', 'seaborn', 'mlflow',
  'requests',
];

/**
 * Undeclared imports measured at head, keyed `<appId>::<dotted module>`.
 *
 * Each entry needs the pool image checked before it can be declared or
 * classified as runtime-provided. Keyed per-BUNDLE (not per-module) so the
 * same package appearing in a NEW bundle still fails closed.
 *
 * To resolve one: confirm against the image, then either add the distribution
 * to that bundle's `requiredLibraries` or add the module to
 * `RUNTIME_PROVIDED_PREFIXES` — and DELETE the line here.
 */
const UNVERIFIED_AT_HEAD: ReadonlySet<string> = new Set([
  // Azure SDK sub-distributions — plausible transitively, unconfirmed.
  'app-azure-realtime-analytics::azure.keyvault.secrets',
  'app-casino-analytics::azure.keyvault.secrets',
  'app-change-feed-processor::azure.keyvault.secrets',
  'app-ml-pipeline::azure.keyvault.secrets',
  'app-change-feed-processor::azure.cosmos.aio',
  'app-change-feed-processor::azure.functions',
  'app-change-feed-processor::redis.asyncio',
  'app-supercharge-streaming::azure.eventhub',
  'app-supercharge-streaming::azure.eventhub.exceptions',
  // Databricks runtime namespaces — provided ON Databricks, not on Synapse
  // Spark; these notebooks target Databricks, so this needs the per-backend
  // answer rather than a single global one.
  'app-ml-pipeline::databricks.feature_engineering',
  'app-ml-pipeline::databricks.sdk',
  'app-ml-pipeline::databricks.sdk.service',
  'app-ml-pipeline::databricks.sdk.service.catalog',
  // ML stack — several of these DO ship in the Synapse ML runtime; which ones
  // differs by runtime version, so it is a per-image fact.
  'app-ml-pipeline::xgboost',
  'app-supercharge-ml::fairlearn.postprocessing',
  'app-supercharge-ml::flaml',
  'app-supercharge-ml::sentence_transformers',
  'app-supercharge-ml::shap',
  'app-supercharge-gold::rapidfuzz',
  // Auth / driver helpers — `jwt` and `msal` are likely present transitively via
  // azure-identity; `pyodbc` needs a system ODBC driver as well as the wheel, so
  // whether the pool image carries it is exactly the per-image fact this repo
  // cannot answer. `pyodbc` became visible only once the detector learned the
  // `import struct, pyodbc` comma form.
  'app-supercharge-guide::jwt',
  'app-supercharge-guide::msal',
  'app-supercharge-guide::pyodbc',
]);

type NotebookRow = { appId: string; displayName: string; content: any };

/** Every notebook item across every registered bundle — a DERIVED population. */
async function allBundleNotebooks(): Promise<NotebookRow[]> {
  const rows: NotebookRow[] = [];
  for (const appId of listBundleIds()) {
    const bundle = await getBundle(appId);
    for (const item of bundle?.items || []) {
      if (!(NOTEBOOK_ITEM_TYPES as readonly string[]).includes(item.itemType)) continue;
      const content: any = item.content;
      if (content?.kind !== 'notebook') continue;
      rows.push({ appId, displayName: item.displayName, content });
    }
  }
  return rows;
}

/** `<appId>::<module>` for every undeclared import in the live registry. */
async function currentFindings(): Promise<Map<string, NotebookRow>> {
  const out = new Map<string, NotebookRow>();
  for (const r of await allBundleNotebooks()) {
    for (const u of undeclaredImports(r.content)) out.set(`${r.appId}::${u.module}`, r);
  }
  return out;
}

describe('bundle notebooks declare the packages they import (#3530)', () => {
  it('the sweep actually reads a non-trivial population', async () => {
    // Guards against the whole file passing vacuously: if the registry stopped
    // resolving payloads, every assertion below would trivially hold.
    const rows = await allBundleNotebooks();
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => extractPythonImports(r.content).length > 0).length).toBeGreaterThan(0);
  });

  it('no bundle notebook has an undeclared import outside the baseline', async () => {
    const findings = await currentFindings();
    const novel = [...findings.keys()].filter((k) => !UNVERIFIED_AT_HEAD.has(k)).sort();
    const detail = novel
      .map((k) => {
        const [appId, mod] = k.split('::');
        return `${appId} imports \`${mod}\` without declaring it — add ` +
          `'${normalizeDistName(mod)}' to that notebook's requiredLibraries, or ` +
          `classify the module in notebook-imports.ts.`;
      })
      .join('\n');
    expect(novel, detail).toEqual([]);
  });

  it('every baseline entry is still a real finding (the list only shrinks)', async () => {
    // Without this the baseline would silently become a permanent allowlist,
    // which is the shape that lets a guard go quiet while looking green.
    const findings = await currentFindings();
    const stale = [...UNVERIFIED_AT_HEAD].filter((k) => !findings.has(k)).sort();
    expect(
      stale,
      `resolved — delete these from UNVERIFIED_AT_HEAD:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('the three bundles fixed for this issue declare their packages', async () => {
    // Named so a regression that silently DROPS a declaration reports as
    // itself, not just as a generic sweep failure.
    const rows = await allBundleNotebooks();
    const byId = (id: string) => rows.find((r) => r.appId === id);

    const rag = byId('app-rag-builder');
    expect(rag, 'app-rag-builder must ship a notebook').toBeTruthy();
    // The import this issue's own acceptance criterion missed.
    expect(extractPythonImports(rag!.content)).toContain('langchain_text_splitters');
    expect(rag!.content.requiredLibraries).toContain('langchain-text-splitters');

    const mesh = byId('app-federal-data-mesh');
    expect(mesh, 'app-federal-data-mesh must ship a notebook').toBeTruthy();
    expect(extractPythonImports(mesh!.content)).toContain('delta_sharing');
    expect(mesh!.content.requiredLibraries).toContain('delta-sharing');

    const agents = byId('app-sovereign-ai-agents');
    expect(agents, 'app-sovereign-ai-agents must ship a notebook').toBeTruthy();
    expect(agents!.content.requiredLibraries).toEqual(
      expect.arrayContaining(['azure-ai-projects', 'azure-ai-agents']),
    );
    // …and none of them re-installs the runtime's own azure-identity, which
    // all three import.
    for (const r of [rag!, mesh!, agents!]) {
      expect(r.content.requiredLibraries).not.toContain('azure-identity');
    }
  });

  it('a comma-separated import clause names every module', () => {
    // REGRESSION ARM. The first detector captured one module per line, so
    // `import a, b` read as `[a]` and the sweep reported the bundle clean —
    // failing OPEN, which is the shape this guard exists to prevent. A real
    // shipped bundle (`app-supercharge-guide`) carries `import struct, pyodbc`.
    const nb = (source: string, requiredLibraries: string[] = []) => ({
      kind: 'notebook',
      defaultLang: 'pyspark',
      requiredLibraries,
      cells: [{ id: 'c', type: 'code', lang: 'pyspark', source }],
    });

    // The exact line that ships, and the module the truncating regex lost.
    expect(extractPythonImports(nb('import struct, pyodbc'))).toEqual(['pyodbc', 'struct']);
    expect(undeclaredImports(nb('import struct, pyodbc')).map((u) => u.module)).toEqual(['pyodbc']);

    // An `as` alias does not hide the module that follows it on the same line.
    expect(extractPythonImports(nb('import numpy as np, xgboost'))).toEqual(['numpy', 'xgboost']);
    // …and a leading stdlib module does not shield a later third-party one.
    expect(undeclaredImports(nb('import os, polars')).map((u) => u.module)).toEqual(['polars']);
    // Declaring it still clears the finding through the comma path.
    expect(undeclaredImports(nb('import os, polars', ['polars']))).toEqual([]);

    // `from X import a, b` names ONE module, X — the comma split must not turn
    // the imported NAMES into modules.
    expect(extractPythonImports(nb('from delta_sharing import SharingClient, load_as_pandas')))
      .toEqual(['delta_sharing']);

    // A trailing comment is not a module source: `import os  # see also, sys`
    // must not manufacture a `sys` finding.
    expect(extractPythonImports(nb('import os  # see also, polars'))).toEqual(['os']);
    expect(undeclaredImports(nb('import os  # see also, polars'))).toEqual([]);
  });

  it('the detector reports an undeclared package', () => {
    // POSITIVE CONTROL. Without it the sweep could pass because the detector
    // is dead rather than because the bundles are clean.
    const broken = {
      kind: 'notebook',
      defaultLang: 'pyspark',
      cells: [{ id: 'c', type: 'code', source: 'from delta_sharing import SharingClient\n' }],
    };
    expect(undeclaredImports(broken)).toEqual([
      { module: 'delta_sharing', suggestedDistribution: 'delta-sharing' },
    ]);
    // Declaring it clears the finding, via PEP 503 `_` / `-` equivalence.
    expect(undeclaredImports({ ...broken, requiredLibraries: ['delta-sharing'] })).toEqual([]);
  });

  it('only PYTHON code cells count — markdown prose and SQL are not imports', () => {
    // The prerequisites markdown in these bundles literally contains an import
    // line; reading it as code would make the guard fire on documentation.
    const content = {
      kind: 'notebook',
      defaultLang: 'pyspark',
      cells: [
        { id: 'm', type: 'markdown', source: 'Run `from openai import AzureOpenAI` first.' },
        { id: 's', type: 'code', lang: 'sparksql', source: 'SELECT 1' },
        { id: 'c', type: 'code', lang: 'python', source: '# import openai\nprint(1)\n' },
      ],
    };
    expect(extractPythonImports(content)).toEqual([]);
    expect(undeclaredImports(content)).toEqual([]);
  });

  it('a submodule import is covered by its parent distribution', () => {
    expect(distributionCovers('azure-search-documents', 'azure.search.documents.indexes.models')).toBe(true);
    expect(distributionCovers('azure-ai-agents', 'azure.ai.agents.models')).toBe(true);
    // …but a DIFFERENT azure distribution does not cover it. This is the arm a
    // bare `startsWith` on the undelimited string would get wrong.
    expect(distributionCovers('azure-ai-agents', 'azure.ai.projects')).toBe(false);
    expect(distributionCovers('azure-identity', 'azure.ai.projects')).toBe(false);
    // A pin or extra on the declaration still matches.
    expect(distributionCovers('openai==1.2.3', 'openai')).toBe(true);
    expect(distributionCovers('pkg[all]', 'pkg')).toBe(true);
  });

  it('runtime and stdlib modules are not demanded as declarations', () => {
    expect(isProvidedByRuntime('json')).toBe(true);
    expect(isProvidedByRuntime('urllib.request')).toBe(true);
    expect(isProvidedByRuntime('__future__')).toBe(true);
    expect(isProvidedByRuntime('codecs')).toBe(true);
    expect(isProvidedByRuntime('pyspark.sql.functions')).toBe(true);
    expect(isProvidedByRuntime('sklearn.ensemble')).toBe(true);
    expect(isProvidedByRuntime('azure.identity')).toBe(true);
    // …and the prefix match is DOTTED, so `delta` does not swallow
    // `delta_sharing` (which normalises to `delta-sharing`).
    expect(isProvidedByRuntime('delta.tables')).toBe(true);
    expect(isProvidedByRuntime('delta_sharing')).toBe(false);
    expect(isProvidedByRuntime('openai')).toBe(false);
    expect(isProvidedByRuntime('azure.ai.projects')).toBe(false);
  });

  it('normalizes distribution names per PEP 503', () => {
    expect(normalizeDistName('Delta_Sharing')).toBe('delta-sharing');
    expect(normalizeDistName('azure.ai.projects')).toBe('azure-ai-projects');
  });

  it('the runtime-provided list declares its own evidence', () => {
    // A wrong `RUNTIME_PROVIDED_PREFIXES` entry is the SILENT failure: unlike a
    // baseline line it produces no finding and no red test, only a customer's
    // `ModuleNotFoundError`. This arm cannot verify the CLAIMS — no code in this
    // repo can reach a pool image, which is the whole premise of the baseline —
    // so it asserts the only thing that IS checkable from here: that every entry
    // is classified, that the two halves are disjoint and exhaustive, and that
    // the asserted half is still exactly the list the docblock tracks on #3530.
    // Promoting an entry to "evidenced" then becomes a deliberate edit in two
    // places rather than a quiet one-line move.
    const evidenced = [...RUNTIME_PROVIDED_EVIDENCED_PREFIXES];
    const asserted = [...RUNTIME_PROVIDED_ASSERTED_PREFIXES];

    // Exhaustive and disjoint: no entry escapes classification, none is counted
    // twice, and nothing reaches the matcher that is in neither half.
    expect([...evidenced, ...asserted].sort()).toEqual([...RUNTIME_PROVIDED_PREFIXES].sort());
    expect(evidenced.filter((p) => asserted.includes(p))).toEqual([]);
    expect(new Set(RUNTIME_PROVIDED_PREFIXES).size).toBe(RUNTIME_PROVIDED_PREFIXES.length);

    // …and the tracked debt is what it says it is.
    expect(asserted.sort()).toEqual([...ASSERTED_AT_HEAD].sort());

    // The evidenced half is not empty and really does carry the two entries
    // whose evidence is named in `notebook-imports.ts` — `app-rag-builder`
    // imports `azure.identity` and deliberately does NOT declare it.
    expect(evidenced).toContain('azure.identity');
    expect(evidenced).toContain('pyspark');
  });
});
