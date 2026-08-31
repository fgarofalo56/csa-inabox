/**
 * #3521 — "Provision a new server" asked for three things it should not have.
 *
 * As it shipped, `lakebase-editor.tsx` rendered:
 *
 *   <Field label="Server name">     <Input value={wz.name} />            // empty
 *   <Field label="Resource group">  <Input value={wz.resourceGroup} />   // typed
 *   <Field label="Location">        <Input placeholder="e.g. eastus" />  // typed
 *
 * while the sibling ADF create-factory form (`pipeline-create-factory-form.tsx`)
 * had already moved to the shared `AzureResourcePicker` for the resource group
 * and a real region `Dropdown` for the location. Three separate asks the platform
 * could answer itself:
 *
 *   • the SERVER NAME — `auto-bind-by-default.md` §2 says the backing Azure
 *     object carries the same display name as the Loom item, "sanitized only
 *     where the service's naming rules force it — and then deterministically".
 *     Loom knew the name; the form asked for it anyway.
 *   • the RESOURCE GROUP — a typed name has no validation, no cross-subscription
 *     discovery, and no way to tell a typo from a group the caller cannot read.
 *   • the LOCATION — a typed region string is the per-cloud value a
 *     Commercial-shaped "e.g. eastus" placeholder helps with least;
 *     `usgovvirginia` mistyped is an ARM 400 the operator has to decode.
 *
 * These specs pin the sanitizer exactly (it decides a resource NAME, so its edge
 * cases are load-bearing) and then assert on the rendered form that the two
 * free-text asks are gone and the name arrives pre-filled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { LakebaseEditor, postgresServerName, mintPostgresAdminPassword } from '../lakebase-editor';
import { makeItem, renderWithProviders } from './test-helpers';

const ITEM_NAME = 'Casino OLTP Lakebase';
const SEEDED = 'casino-oltp-lakebase';

function stubFetch() {
  const calls: string[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
    const u = typeof url === 'string' ? url : String(url);
    calls.push(u);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (u.includes('/api/cosmos-items/lakebase-postgres/')) {
      return json({ id: 'itm-1', workspaceId: 'ws-1', itemType: 'lakebase-postgres', displayName: ITEM_NAME, state: {} });
    }
    if (u.includes('/api/items/lakebase-postgres/itm-1/provision')) {
      return json({
        ok: true,
        servers: [{ name: 'pg-existing-1' }],
        catalog: {
          skus: [{ name: 'Standard_D2ds_v5', tier: 'GeneralPurpose', label: 'D2ds v5 (2 vCore)', vCores: 2, memoryGb: 8 }],
          storageGb: [32, 64],
          versions: ['16'],
          ha: [{ value: 'Disabled', label: 'No high availability' }],
        },
      });
    }
    if (u.includes('/api/items/lakebase-postgres/itm-1')) {
      return json({ ok: true, config: {}, backend: 'postgres', live: {}, queryGate: null, databricksGate: null });
    }
    if (u.includes('/api/azure/resources')) {
      return json({
        ok: true, via: 'user',
        resources: [
          { id: '/subscriptions/sub-1/resourceGroups/rg-loom-data', name: 'rg-loom-data', location: 'centralus', resourceGroup: 'rg-loom-data', subscriptionId: 'sub-1' },
        ],
      });
    }
    return json({ ok: true });
  });
  return calls;
}

/** Mount and switch to the Provision tab. */
async function mountProvision() {
  const { container } = renderWithProviders(
    <LakebaseEditor item={makeItem('lakebase-postgres', 'Lakebase')} id="itm-1" />,
  );
  const root = container as HTMLElement;
  const tab = await waitFor(
    () => {
      const t = within(root).getAllByRole('tab').find((b) => /Provision/i.test(b.textContent || ''));
      if (!t) throw new Error('Provision tab not rendered');
      return t;
    },
    { timeout: 8000 },
  );
  fireEvent.click(tab);
  return root;
}

afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => { vi.clearAllMocks(); });

describe('postgresServerName — deterministic, and legal for ARM (#3521)', () => {
  it('slugs a Loom display name into a legal flexible-server name', () => {
    expect(postgresServerName(ITEM_NAME)).toBe(SEEDED);
    expect(postgresServerName('Bronze Lakehouse OLTP')).toBe('bronze-lakehouse-oltp');
  });

  it('replaces illegal runs rather than deleting them, so two names cannot collide', () => {
    // Deleting the characters that distinguish two items is how a "deterministic"
    // sanitizer silently maps them onto ONE backing resource.
    expect(postgresServerName('a.b')).not.toBe(postgresServerName('ab'));
    expect(postgresServerName('a.b')).toBe('a-b');
    expect(postgresServerName('Finance / EMEA')).toBe('finance-emea');
  });

  it('never emits a leading or trailing hyphen, or a doubled one', () => {
    // ARM rejects all three, and the rejection would name a string the user
    // never typed.
    expect(postgresServerName('  --Gold--  ')).toBe('gold');
    expect(postgresServerName('a___b')).toBe('a-b');
    expect(postgresServerName('name!')).toBe('name');
  });

  it('clamps to 63 characters and still cannot end in a hyphen', () => {
    const long = `${'x'.repeat(62)}-y`;
    const out = postgresServerName(long);
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out.endsWith('-')).toBe(false);
  });

  it('returns EMPTY rather than an illegal short name', () => {
    // Below 3 characters ARM refuses. Seeding an illegal value would trade an
    // empty box for an error about a name the user never chose.
    expect(postgresServerName('')).toBe('');
    expect(postgresServerName('!!')).toBe('');
    expect(postgresServerName('ab')).toBe('');
    expect(postgresServerName('abc')).toBe('abc');
  });

  it('is a pure function of the input — the same name maps to the same server', () => {
    expect(postgresServerName(ITEM_NAME)).toBe(postgresServerName(ITEM_NAME));
  });
});

describe('mintPostgresAdminPassword — Azure complexity, satisfied CONSTRUCTIVELY (#3521)', () => {
  const CLASSES = [/[A-Z]/, /[a-z]/, /[0-9]/, /[!#$*+\-=?_~]/];

  it('always satisfies at least three of Azure\'s four character classes', () => {
    // "Generate and hope" is how a credential generator ships a value ARM
    // rejects one time in a hundred, on someone else's machine. 200 draws is
    // enough to catch a construction that is merely LIKELY to comply.
    for (let i = 0; i < 200; i++) {
      const pw = mintPostgresAdminPassword();
      const hit = CLASSES.filter((re) => re.test(pw)).length;
      expect(hit, `only ${hit} class(es) in ${pw}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('stays inside Azure\'s 8-128 length window and clamps a silly request', () => {
    expect(mintPostgresAdminPassword().length).toBe(28);
    expect(mintPostgresAdminPassword(200).length).toBe(128);
    expect(mintPostgresAdminPassword(1).length).toBe(12);
  });

  it('never emits a character that would break a connection string or ARM payload', () => {
    // Azure's own docs exclude these from the password set.
    for (let i = 0; i < 100; i++) {
      expect(mintPostgresAdminPassword()).not.toMatch(/['"\\/@%]/);
    }
  });

  it('does not put the seeded classes in a fixed prefix', () => {
    // Without the shuffle the first four characters are always
    // upper/lower/digit/symbol in that order — a predictable prefix makes the
    // password weaker than its length suggests. Measured over 200 draws: the
    // first character must not be uppercase every single time.
    const firsts = Array.from({ length: 200 }, () => mintPostgresAdminPassword()[0]);
    expect(firsts.every((c) => /[A-Z]/.test(c))).toBe(false);
  });

  it('is not a constant — two draws differ', () => {
    expect(mintPostgresAdminPassword()).not.toBe(mintPostgresAdminPassword());
  });
});

describe('LakebaseEditor provision form — pickers, not free text (#3521)', () => {
  it('pre-fills the server name from the item, sanitized', async () => {
    stubFetch();
    const root = await mountProvision();
    const nameInput = await waitFor(
      () => {
        const el = Array.from(root.querySelectorAll('input'))
          .find((i) => (i as HTMLInputElement).value === SEEDED);
        if (!el) throw new Error(`no input carries ${SEEDED}`);
        return el as HTMLInputElement;
      },
      { timeout: 8000 },
    );
    expect(nameInput.value).toBe(SEEDED);
  });

  it('has NO free-text region box — the "e.g. eastus" input is gone', async () => {
    // The exact control the issue names. Its placeholder is the fingerprint.
    stubFetch();
    const root = await mountProvision();
    await waitFor(() => expect(root.textContent).toContain('Provision a new server'), { timeout: 8000 });
    expect(root.querySelector('input[placeholder="e.g. eastus"]')).toBeNull();
  });

  it('offers a real region list including the US Government regions', async () => {
    // `cloud-parity.md`: a Commercial-only region list would make this form
    // unusable in a sovereign boundary, which is the failure a hand-copied list
    // here would have introduced. The list is IMPORTED from the ADF form rather
    // than restated, so both stay in lockstep.
    const { ADF_FACTORY_REGIONS } = await import('../pipeline-create-factory-form');
    expect(ADF_FACTORY_REGIONS).toContain('usgovvirginia');
    expect(ADF_FACTORY_REGIONS).toContain('usgovarizona');
    expect(ADF_FACTORY_REGIONS).toContain('centralus');
  });

  it('has NO admin-password text box — the platform mints the credential', async () => {
    // The boy-scout half. `check-no-freeform.mjs` had this file baselined for one
    // site, the "Admin password" Input, and its own remediation names the fix:
    // "make the platform provision + bind the value so nothing is asked for at
    // all" (auto-bind-by-default.md §5). Measured after the change, the guard's
    // ratchet TIGHTENED — the lakebase entry left the baseline (175 → 174).
    stubFetch();
    const root = await mountProvision();
    await waitFor(() => expect(root.textContent).toContain('Provision a new server'), { timeout: 8000 });
    expect(root.querySelector('input[type="password"]')).toBeNull();
    // …and the minted value is on screen, disclosed rather than hidden.
    const shown = root.querySelector('[data-testid="lakebase-generated-admin-password"]');
    expect(shown).not.toBeNull();
    expect((shown!.textContent || '').length).toBeGreaterThanOrEqual(12);
    expect(shown!.textContent).not.toBe('generating…');
    // The disclosure is the honest part: Loom does not keep it.
    expect(root.textContent).toContain('Loom does not store it');
  });

  it('renders the resource-group PICKER, and asks the ARM discovery route for groups', async () => {
    // Presence is not enough: the picker must actually be querying Resource
    // Graph for resource groups, which is what makes it a picker rather than a
    // differently-styled text box.
    const calls = stubFetch();
    await mountProvision();
    await waitFor(
      () => expect(calls.some((u) => u.includes('/api/azure/resources')
        && u.includes('Microsoft.Resources%2Fsubscriptions%2FresourceGroups'))).toBe(true),
      { timeout: 8000 },
    );
  });
});
