/**
 * Vitest for the ATLAS TYPEDEF NAMESPACE AUTHORITY.
 *
 * The property under test is a security property: an Atlas classification
 * typedef in the classic Purview Data Map is ACCOUNT-GLOBAL and PERMANENT,
 * while a Loom "tenant" is only a Cosmos partition. So no tenant-authored word
 * may become a typedef name without a leading tenant discriminator, and the
 * `MICROSOFT.GOVERNANCE.*` namespace (owned by Purview's MIP integration) may
 * only ever carry a real MIP label GUID.
 *
 * These are the ATTACK cases for the S4 class sweep that missed
 * `purview-autoonboard`, `admin/batch-labeling` and `items/[id]/sensitivity`.
 */
import { describe, it, expect } from 'vitest';
import {
  asAtlasBusinessMetadataName,
  asAtlasClassificationTypedefName,
  assertNamespacedTypedefNames,
  isNamespacedBusinessMetadataName,
  isNamespacedTypedefName,
  loomClassificationTypedefName,
  loomSensitivityLabelTypedefName,
  loomTenantBusinessMetadataName,
  SENSITIVITY_LABEL_TYPEDEF_PREFIX,
  UnnamespacedTypedefError,
} from '../purview-typedef-namespace';
import { MAX_ATLAS_NAME_LENGTH, tenantBusinessMetadataName } from '@/lib/governance/uc-overlay/model';

const TENANT_A = '11111111-2222-3333-4444-555555555555';
const TENANT_B = '99999999-8888-7777-6666-555555555555';
const MIP_GUID = 'defb2ab7-1b58-4e1e-9e88-0dd0a0ab8bbb';

describe('loomClassificationTypedefName', () => {
  it('puts an 8-hex tenant discriminator AHEAD of the tenant-authored word', () => {
    expect(loomClassificationTypedefName(TENANT_A, 'PII')).toMatch(
      /^LOOM\.CLASSIFICATION\.[0-9a-f]{8}\.PII$/,
    );
  });

  it('ATTACK: two tenants using the SAME vocabulary word get DIFFERENT global typedefs', () => {
    const a = loomClassificationTypedefName(TENANT_A, 'Confidential');
    const b = loomClassificationTypedefName(TENANT_B, 'Confidential');
    expect(a).not.toBe(b);
    // …and both still end in the same slug, i.e. the difference is the namespace.
    expect(a.endsWith('.CONFIDENTIAL')).toBe(true);
    expect(b.endsWith('.CONFIDENTIAL')).toBe(true);
  });

  it('is stable for the same tenant + word (idempotent ensure/attach round-trip)', () => {
    expect(loomClassificationTypedefName(TENANT_A, 'pii')).toBe(
      loomClassificationTypedefName(TENANT_A, 'PII'),
    );
  });

  it('slugifies punctuation/spacing into an Atlas-legal segment', () => {
    expect(loomClassificationTypedefName(TENANT_A, ' Highly  Confidential! ')).toMatch(
      /\.HIGHLY_CONFIDENTIAL$/,
    );
  });

  it('never emits an empty trailing segment', () => {
    expect(loomClassificationTypedefName(TENANT_A, '!!!')).toMatch(/\.CLASSIFICATION$/);
  });

  it('length-caps with an injective digest tail (long names cannot collide)', () => {
    const long = 'X'.repeat(400);
    const a = loomClassificationTypedefName(TENANT_A, `${long}A`);
    const b = loomClassificationTypedefName(TENANT_A, `${long}B`);
    expect(a.length).toBeLessThanOrEqual(MAX_ATLAS_NAME_LENGTH);
    expect(b.length).toBeLessThanOrEqual(MAX_ATLAS_NAME_LENGTH);
    expect(a).not.toBe(b);
  });

  it('every emitted name passes its own namespace assertion', () => {
    for (const w of ['PII', 'pii', 'Highly Confidential', '!!!', 'Y'.repeat(300)]) {
      expect(() => assertNamespacedTypedefNames([loomClassificationTypedefName(TENANT_A, w)])).not.toThrow();
    }
  });
});

describe('loomSensitivityLabelTypedefName', () => {
  it('uses the REAL MIP typedef when labelId is a GUID', () => {
    expect(loomSensitivityLabelTypedefName(TENANT_A, { labelId: MIP_GUID, labelName: 'Secret' }))
      .toBe(`${SENSITIVITY_LABEL_TYPEDEF_PREFIX}${MIP_GUID}`);
  });

  it('a MIP GUID is tenant-INdependent (the GUID is issued by MIP, not authored)', () => {
    expect(loomSensitivityLabelTypedefName(TENANT_A, { labelId: MIP_GUID }))
      .toBe(loomSensitivityLabelTypedefName(TENANT_B, { labelId: MIP_GUID }));
  });

  it('ATTACK: a non-GUID labelId does NOT squat MICROSOFT.GOVERNANCE.LABELS.*', () => {
    const n = loomSensitivityLabelTypedefName(TENANT_A, { labelId: '../../MICROSOFT.PERSONAL.EMAIL' });
    expect(n.startsWith(SENSITIVITY_LABEL_TYPEDEF_PREFIX)).toBe(false);
    expect(n).toMatch(/^LOOM\.LABEL\.[0-9a-f]{8}\./);
  });

  it('ATTACK: a free-text label from two tenants yields DIFFERENT global typedefs', () => {
    const a = loomSensitivityLabelTypedefName(TENANT_A, { labelName: 'Internal Only' });
    const b = loomSensitivityLabelTypedefName(TENANT_B, { labelName: 'Internal Only' });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^LOOM\.LABEL\.[0-9a-f]{8}\.INTERNAL_ONLY$/);
  });

  it('every emitted name passes its own namespace assertion', () => {
    for (const o of [{ labelId: MIP_GUID }, { labelName: 'Internal Only' }, { labelId: 'not-a-guid' }, {}]) {
      expect(() => assertNamespacedTypedefNames([loomSensitivityLabelTypedefName(TENANT_A, o)])).not.toThrow();
    }
  });
});

describe('isNamespacedTypedefName / assertNamespacedTypedefNames (the SINK backstop)', () => {
  it('ATTACK: refuses a bare tenant vocabulary word', () => {
    for (const bad of ['PII', 'pii', 'Confidential', 'Highly Confidential', 'SSN', 'tag']) {
      expect(isNamespacedTypedefName(bad)).toBe(false);
      expect(() => assertNamespacedTypedefNames([bad])).toThrow(UnnamespacedTypedefError);
    }
  });

  it('ATTACK: refuses MICROSOFT.GOVERNANCE.LABELS.<not-a-guid> (namespace squatting)', () => {
    expect(isNamespacedTypedefName(`${SENSITIVITY_LABEL_TYPEDEF_PREFIX}Highly Confidential`)).toBe(false);
    expect(isNamespacedTypedefName(`${SENSITIVITY_LABEL_TYPEDEF_PREFIX}my-label`)).toBe(false);
  });

  it('accepts MICROSOFT.GOVERNANCE.LABELS.<guid>', () => {
    expect(isNamespacedTypedefName(`${SENSITIVITY_LABEL_TYPEDEF_PREFIX}${MIP_GUID}`)).toBe(true);
  });

  it('accepts every shape the in-tree producers emit', () => {
    for (const good of [
      'LOOM.CLASSIFICATION.deadbeef.PII',            // items/[id]/classifications + autoonboard
      'LOOM.LABEL.deadbeef.INTERNAL_ONLY',           // batch-labeling + sensitivity fallback
      'LOOM.363EF5D1.PII',                           // purview-classification-sync
      'Loom_deadbeef_pii_yes',                       // LU-5 governance overlay
      'Loom_deadbeef_a_verylongtail_1a2b3c4d',       // LU-5, capped-with-digest variant
      `${SENSITIVITY_LABEL_TYPEDEF_PREFIX}${MIP_GUID}`,
    ]) {
      expect(isNamespacedTypedefName(good)).toBe(true);
    }
  });

  it('names every rejected entry in the error (so the operator can see which)', () => {
    try {
      assertNamespacedTypedefNames(['LOOM.CLASSIFICATION.deadbeef.PII', 'Confidential', 'SSN']);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnnamespacedTypedefError);
      expect((e as UnnamespacedTypedefError).rejected).toEqual(['Confidential', 'SSN']);
      expect((e as Error).message).toContain('Confidential');
    }
  });

  it('ignores blanks rather than rejecting them (the sink filters them first)', () => {
    expect(() => assertNamespacedTypedefNames(['', '   '])).not.toThrow();
  });

  it('asAtlasClassificationTypedefName is the ONLY mint and it validates', () => {
    expect(asAtlasClassificationTypedefName('LOOM.CLASSIFICATION.deadbeef.PII'))
      .toBe('LOOM.CLASSIFICATION.deadbeef.PII');
    expect(() => asAtlasClassificationTypedefName('PII')).toThrow(UnnamespacedTypedefError);
  });
});

/**
 * typedefSlug's edge-trim moved from `.replace(/^_+|_+$/g,'')` to the linear
 * `trimChar(...,'_')` (CodeQL js/polynomial-redos #728). The slug feeds an
 * ACCOUNT-GLOBAL, PERMANENT Atlas typedef name, so a behaviour change here
 * would silently fork one tenant's vocabulary into two typedefs. These pin the
 * two properties that matter: the output is unchanged, and the trim stays
 * linear no matter what the collapse in front of it does.
 */
describe('typedefSlug — linear edge-trim is output-identical to the regex it replaced', () => {
  const legacy = (s: string) =>
    (s || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  const cases = [
    '', '   ', 'PII', 'pii', ' Highly Confidential ', '__leading', 'trailing__',
    '__both__', 'a-b.c d', '___', 'A__B', 'ünïcodé', '123', '_1_2_', 'A' + '_'.repeat(500) + 'B',
  ];

  it('produces the SAME slug as the old regex for every shape', () => {
    for (const c of cases) {
      expect(loomClassificationTypedefName('t'.repeat(32), c))
        .toBe(loomClassificationTypedefName('t'.repeat(32), c));
    }
    // Direct parity on the slug rule itself, via the exported builder's output.
    for (const c of cases) {
      const viaBuilder = loomClassificationTypedefName('t'.repeat(32), c);
      expect(viaBuilder.endsWith(legacy(c)) || legacy(c) === '').toBe(true);
    }
  });

  it('stays fast on the shape that made the regex quadratic', () => {
    // 'A' + many '_' + 'B' — the head defeats `^_+`, the tail defeats `_+$`.
    // The old regex measured ~24s at N=200_000; the linear trim is flat.
    const evil = 'A' + '_'.repeat(200_000) + 'B';
    const t0 = Date.now();
    loomClassificationTypedefName('t'.repeat(32), evil);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

// ── BUSINESS METADATA — the same class, one API surface over (#2633) ────────
// An Atlas business-metadata typedef is ACCOUNT-GLOBAL too, and
// `setBusinessMetadata` writes it with isOverwrite=true (a WHOLE-BAG replace),
// so the bare `LoomCustomTags` bag has both a leak/clobber and a permanent
// vocabulary-growth failure mode on a shared Purview account.
describe('business-metadata bag namespace', () => {
  it('mints `LoomCustomTags_<t8>` and gives two tenants two different bags', () => {
    expect(loomTenantBusinessMetadataName(TENANT_A)).toMatch(/^LoomCustomTags_[0-9a-f]{8}$/);
    expect(loomTenantBusinessMetadataName(TENANT_A)).not.toBe(loomTenantBusinessMetadataName(TENANT_B));
  });

  it('is the SAME name the LU-5 overlay projects, so one tenant has ONE bag', () => {
    expect(loomTenantBusinessMetadataName(TENANT_A)).toBe(tenantBusinessMetadataName(TENANT_A));
  });

  it('ATTACK: the account-global `LoomCustomTags` bag is NOT mintable', () => {
    expect(() => asAtlasBusinessMetadataName('LoomCustomTags')).toThrow(UnnamespacedTypedefError);
    expect(isNamespacedBusinessMetadataName('LoomCustomTags')).toBe(false);
  });

  it('ATTACK: a look-alike suffix that is not an 8-hex discriminator is refused', () => {
    const bad = [
      'LoomCustomTags_', 'LoomCustomTags_tenantA', 'LoomCustomTags_DEADBEEF',
      'LoomCustomTags_deadbee', 'LoomCustomTags_deadbeef1', 'CustomTags_deadbeef', '',
    ];
    for (const n of bad) {
      expect(isNamespacedBusinessMetadataName(n)).toBe(false);
      expect(() => asAtlasBusinessMetadataName(n)).toThrow(UnnamespacedTypedefError);
    }
  });

  it('names the business-metadata builder in the refusal, not the classification one', () => {
    try {
      asAtlasBusinessMetadataName('LoomCustomTags');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toContain('loomTenantBusinessMetadataName');
      expect((e as Error).message).toContain('business metadata');
    }
  });

  it('CONTROL: the classification refusal message is unchanged', () => {
    try {
      asAtlasClassificationTypedefName('PII');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toContain('classification typedef(s)');
      expect((e as Error).message).toContain('loomClassificationTypedefName');
    }
  });
});
