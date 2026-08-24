/**
 * mounted-adf — the "Mount an existing ADF" dialog no longer asks the user to
 * hand-type an address (#3514), and does not dead-end when discovery is denied.
 *
 * THE DEFECT. The dialog demanded three hand-typed values — a subscription
 * GUID, a resource group and a factory name — for a resource Azure Resource
 * Graph can enumerate under the caller's own RBAC. `auto-bind-by-default.md`
 * names this exact scenario ("Mount ADF") as its worked example, and the
 * no-freeform-config ratchet baselined the subscription-id box as a violation.
 *
 * THE SECOND DEFECT, FOUND WHILE FIXING THE FIRST, and the reason this spec
 * exists rather than leaning on the ratchet alone. `AzureResourcePicker`'s
 * manual-entry escape hatch returns ONLY `id`: `commitManual()` deliberately
 * leaves `name`, `subscriptionId` and `resourceGroup` EMPTY rather than
 * fabricating them. That hatch is what renders when Resource Graph discovery is
 * denied — a routine state in Azure Government, where the Loom UAMI frequently
 * lacks tenant-root Reader (`cloud-parity.md`). A consumer that simply reads
 * `r.resourceGroup` therefore gets "" on precisely the path the hatch exists to
 * serve, its Mount button never enables, and the surface becomes the "dead end"
 * `auto-bind-by-default.md` forbids. So the editor parses the coordinates out
 * of the ARM id, and that parse is what is pinned here.
 *
 * This is a landmine for the ~40 surfaces slated to adopt this picker: adopting
 * it with `matchBy="id"` and reading the sibling fields is a Gov-only dead end
 * that Commercial discovery hides.
 *
 * MUTATION CONTROL. Making the parser lenient (dropping the provider segment,
 * or returning a partially-filled object on a non-matching string) turns the
 * rejection tests red; deleting it turns the manual-entry test red.
 */
import { describe, it, expect } from 'vitest';
import { armFactoryCoords } from '../mounted-adf-editor';

/** Shape only — no real tenant/subscription identifiers in a public repo. */
const SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ARM_ID = `/subscriptions/${SUB}/resourceGroups/rg-data/providers/Microsoft.DataFactory/factories/adf-prod`;

describe('armFactoryCoords (#3514)', () => {
  it('recovers all three mount coordinates from an ARM id', () => {
    expect(armFactoryCoords(ARM_ID)).toEqual({
      subscriptionId: SUB, resourceGroup: 'rg-data', name: 'adf-prod',
    });
  });

  it('is case-insensitive on the ARM segment names, as ARM ids are', () => {
    const mixed = `/Subscriptions/${SUB}/resourcegroups/rg-data/Providers/microsoft.datafactory/Factories/adf-prod`;
    expect(armFactoryCoords(mixed)?.name).toBe('adf-prod');
  });

  it('tolerates a trailing slash and surrounding whitespace from a paste', () => {
    expect(armFactoryCoords(`  ${ARM_ID}/  `)?.resourceGroup).toBe('rg-data');
  });

  it('REJECTS an id for a different provider rather than mounting the wrong thing', () => {
    const storage = `/subscriptions/${SUB}/resourceGroups/rg-data/providers/Microsoft.Storage/storageAccounts/sa1`;
    expect(armFactoryCoords(storage)).toBeNull();
  });

  it('REJECTS a child resource id (a pipeline inside a factory is not a factory)', () => {
    expect(armFactoryCoords(`${ARM_ID}/pipelines/copy-orders`)).toBeNull();
  });

  it('REJECTS malformed / empty input instead of returning blank coordinates', () => {
    for (const bad of ['', '   ', 'adf-prod', '/subscriptions/only', `/resourceGroups/rg/providers/Microsoft.DataFactory/factories/adf`]) {
      expect(armFactoryCoords(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("recovers coordinates from the picker's manual-entry payload, which carries ONLY the id", () => {
    // Verbatim shape of AzureResourcePicker.commitManual() for matchBy="id":
    // every field except `id` is intentionally empty.
    const manualSelection = {
      id: ARM_ID, name: '', subscriptionId: '', resourceGroup: '', location: '',
    };
    const parsed = armFactoryCoords(manualSelection.id);
    // Without the parse, all three would be '' and the Mount button could never
    // enable — the discovery-denied dead end.
    expect(manualSelection.resourceGroup).toBe('');
    expect(parsed?.subscriptionId).toBe(SUB);
    expect(parsed?.resourceGroup).toBe('rg-data');
    expect(parsed?.name).toBe('adf-prod');
  });
});
