/**
 * #3530 — an app-installed notebook must be RUNNABLE, which means the packages
 * its cells import have to be installed.
 *
 * At head, installing app-rag-builder produced a notebook whose second code
 * cell does `from azure.search.documents import SearchClient` and
 * `from openai import AzureOpenAI`. Neither distribution is in the Synapse
 * Spark or Databricks stock image, so Run-all stopped on ModuleNotFoundError,
 * and the editor's environment selector said "No environment attached" — which
 * is the only thing the product told the user about why.
 *
 * The mechanism to fix it already existed on BOTH ends and nothing joined them:
 *   - `app/api/items/notebook/[id]/run/route.ts:187` detects an inline
 *     `%pip install` and forces it onto the pyspark Livy session;
 *   - `platform/fiab/bicep/.../synapse-spark-pools.bicep:210` already sets
 *     `sessionLevelPackagesEnabled: true`.
 * The missing piece was a CELL. `requiredLibraries` on the bundle declares the
 * packages; the provisioner prepends the bootstrap.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) In `notebook.ts` make `withRequiredLibraryBootstrap` `return content`
 *      unconditionally -> RED:
 *        "an installed rag-builder notebook's FIRST code cell is the %pip bootstrap"
 *        "the bootstrap names BOTH declared packages"
 *        "the Synapse artifact carries the bootstrap too, not just Loom's copy"
 *   b) Delete the `firstSource.includes(PIP_BOOTSTRAP_MARKER)` early return ->
 *      RED: "re-provisioning does not stack a second bootstrap cell" — the arm
 *      a naive prepend breaks, and install IS re-runnable.
 *   c) Delete the `PIP_SAFE.test(s)` filter in `pipPackagesFor` -> RED:
 *      "a package name carrying a shell metacharacter is dropped, not escaped"
 *      — the string goes to a kernel magic, so this is not cosmetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = {
  upsertSynapseNotebook: vi.fn(async () => ({ id: 'syn-1' })),
  synapseConfigGate: vi.fn(() => null as any),
  databricksConfigGate: vi.fn(() => ({ missing: 'LOOM_DATABRICKS_HOSTNAME' } as any)),
};

vi.mock('@/lib/azure/synapse-artifacts-client', () => ({
  synapseConfigGate: () => h.synapseConfigGate(),
  upsertNotebook: (...a: any[]) => (h.upsertSynapseNotebook as any)(...a),
}));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: () => h.databricksConfigGate(),
  importNotebook: vi.fn(async () => ({})),
  mkdirsWorkspace: vi.fn(async () => ({})),
}));
vi.mock('@/lib/azure/fabric-client', () => ({
  createNotebook: vi.fn(async () => ({ id: 'fab-1' })),
  listNotebooks: vi.fn(async () => []),
  updateNotebookDefinition: vi.fn(async () => ({})),
  FabricError: class extends Error { status = 500; },
  fabricHint: vi.fn(() => 'hint'),
}));

import {
  notebookProvisioner,
  withRequiredLibraryBootstrap,
  pipPackagesFor,
  PIP_BOOTSTRAP_MARKER,
} from '../notebook';
import ragBuilderBundle from '@/lib/apps/content-bundles/app-rag-builder';

/** The rag-builder bundle's notebook item, read from the SHIPPED bundle. */
function ragNotebookContent(): any {
  const item = ragBuilderBundle.items.find((i: any) => i.itemType === 'notebook');
  expect(item, 'app-rag-builder must ship a notebook item').toBeTruthy();
  return item!.content as any;
}

const sourceOf = (cell: any): string =>
  typeof cell?.source === 'string' ? cell.source : (cell?.source || []).join('');

beforeEach(() => {
  vi.clearAllMocks();
  h.synapseConfigGate.mockReturnValue(null);
  h.databricksConfigGate.mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
  h.upsertSynapseNotebook.mockImplementation(async () => ({ id: 'syn-1' }));
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-test';
  delete process.env.LOOM_NOTEBOOK_BACKEND;
});

describe('notebook install — declared libraries become a %pip bootstrap cell (#3530)', () => {
  it("an installed rag-builder notebook's FIRST code cell is the %pip bootstrap", async () => {
    // The bundle really declares packages (this is the assertion that keeps the
    // rest of the file from passing vacuously on an empty declaration).
    expect(pipPackagesFor(ragNotebookContent()).length).toBeGreaterThan(0);

    const out: any = withRequiredLibraryBootstrap(ragNotebookContent());
    expect(sourceOf(out.cells[0])).toContain('%pip install');
    expect(sourceOf(out.cells[0])).toContain(PIP_BOOTSTRAP_MARKER);
    // …and it is a CODE cell in a language the run route routes to pyspark.
    expect(out.cells[0].type).toBe('code');
    expect(out.cells[0].lang).toBe('pyspark');
  });

  it('the bootstrap names BOTH declared packages', () => {
    // The two distributions the cells import and the images do not ship.
    expect(pipPackagesFor(ragNotebookContent())).toEqual(['azure-search-documents', 'openai']);
    const out: any = withRequiredLibraryBootstrap(ragNotebookContent());
    expect(sourceOf(out.cells[0])).toMatch(/%pip install azure-search-documents openai/);
  });

  it('the declared packages match what the cells actually import', () => {
    // Anti-drift: a declaration nobody checks against the code is a comment.
    const cells: any[] = ragNotebookContent().cells;
    const allSource = cells.map(sourceOf).join('\n');
    expect(allSource).toMatch(/from azure\.search\.documents import/);
    expect(allSource).toMatch(/from openai import/);
  });

  it('the Synapse artifact carries the bootstrap too, not just Loom\'s copy', async () => {
    const r = await notebookProvisioner({
      session: { claims: { oid: 'o' } },
      target: { mode: 'shared' },
      cosmosItemId: 'nb-1',
      workspaceId: 'w',
      displayName: 'RAG Builder Walkthrough',
      appId: 'app-rag-builder',
      content: ragNotebookContent(),
    } as any);

    expect(r.status).toBe('created');
    const artifact = (h.upsertSynapseNotebook.mock.calls.at(-1) as unknown as any[] | undefined)?.[1] as any;
    const first = artifact.properties.cells[0];
    expect(first.cell_type).toBe('code');
    expect(first.source.join('')).toMatch(/%pip install azure-search-documents openai/);
    // The receipt names what it arranged, so the outcome is inspectable.
    expect(r.secondaryIds?.sessionPackages).toBe('azure-search-documents openai');
  });

  it('re-provisioning does not stack a second bootstrap cell', () => {
    // Install is re-runnable and the same content is handed to the artifact
    // builders; a non-idempotent prepend grows the notebook every run.
    const once: any = withRequiredLibraryBootstrap(ragNotebookContent());
    const twice: any = withRequiredLibraryBootstrap(once);
    expect(twice.cells.length).toBe(once.cells.length);
    expect(twice.cells.filter((c: any) => sourceOf(c).includes(PIP_BOOTSTRAP_MARKER))).toHaveLength(1);
  });

  it('a notebook that declares nothing is returned untouched', () => {
    const content = { kind: 'notebook', defaultLang: 'pyspark', cells: [{ type: 'code', source: 'print(1)' }] };
    expect(withRequiredLibraryBootstrap(content)).toBe(content);
  });

  it('a package name carrying a shell metacharacter is dropped, not escaped', () => {
    // This string is executed by the kernel as a magic line. Dropping is the
    // only answer that cannot be wrong; escaping for an unknown shell is a
    // claim about the kernel's parser we have not established.
    expect(pipPackagesFor({ requiredLibraries: ['openai', 'evil; rm -rf /', 'pkg && curl x'] }))
      .toEqual(['openai']);
    // …and the legitimate pin / extra syntax still passes.
    expect(pipPackagesFor({ requiredLibraries: ['openai==1.2.3', 'pkg[all]', 'a-b_c.d'] }))
      .toEqual(['openai==1.2.3', 'pkg[all]', 'a-b_c.d']);
    // Duplicates collapse, so the magic line names each package once.
    expect(pipPackagesFor({ requiredLibraries: ['openai', 'openai'] })).toEqual(['openai']);
  });
});
