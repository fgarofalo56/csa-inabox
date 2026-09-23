/**
 * `provision` fix-kind integrity.
 *
 * The centre of this file is one fact: **`workflow_dispatch` accepts an unknown
 * input name silently.** A `provision` button wired to an input the workflow
 * does not declare would dispatch cleanly, run the deploy with the bicep
 * parameter at its DEFAULT, and finish green having provisioned nothing. That
 * is strictly worse than the dead-end picker it replaces, because it looks like
 * it worked — so the wiring is checked against the real workflow text rather
 * than trusted.
 *
 * Every assertion below names the value that breaks it (assertion-design.md).
 */
import { describe, it, expect } from 'vitest';
import {
  checkProvisionShape,
  checkProvisionWiring,
  type ProvisionDefect,
} from '../registry/provision-check';
import type { GateFixit, GateProvision } from '../registry/types';

const GOOD: GateProvision = {
  service: 'servicebus',
  workflowInput: 'service_bus_enabled',
  bicepParam: 'serviceBusEnabled',
  module: 'platform/fiab/bicep/modules/deploy-planner/service-bus.bicep',
  costNote: 'Creates a Service Bus namespace (Standard). Billed hourly.',
};

/** A workflow that declares the input AND threads it to --parameters. */
const WIRED = [
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      purview_enabled:',
  '        type: boolean',
  '      service_bus_enabled:',
  '        type: boolean',
  'jobs:',
  '  deploy:',
  '    steps:',
  '      - run: add --parameters "serviceBusEnabled=$SERVICE_BUS_ENABLED"',
].join('\n');

function ids(d: ProvisionDefect[]): string[] {
  return d.map((x) => x.field);
}

describe('checkProvisionShape', () => {
  it('accepts a fully-declared provision gate', () => {
    // Breaks if: any of the five required fields stops being recognised.
    expect(checkProvisionShape('svc-servicebus', { kind: 'provision', provision: GOOD })).toEqual([]);
  });

  it('is silent for the four pre-existing kinds', () => {
    // Breaks if: the new check starts firing on env-picker/resource-picker/
    // role-grant/wizard — 134 gates use those and a false flag here would
    // block every one of them.
    for (const kind of ['env-picker', 'resource-picker', 'role-grant', 'wizard'] as const) {
      expect(checkProvisionShape('g', { kind }), kind).toEqual([]);
    }
  });

  it('REFUSES kind=provision with no descriptor', () => {
    // The shape that would render a Deploy button with nothing behind it.
    // Breaks if: the missing-descriptor branch is removed.
    const d = checkProvisionShape('g', { kind: 'provision' });
    expect(ids(d)).toEqual(['provision']);
    expect(d[0].detail).toMatch(/no descriptor/);
  });

  it('REFUSES a descriptor left behind on a non-provision kind', () => {
    // Dead data: an edit changed the kind and not the payload. A later reader
    // finds a provision bag and concludes the button exists.
    // Breaks if: the leftover branch is removed.
    const d = checkProvisionShape('g', { kind: 'env-picker', provision: GOOD });
    expect(ids(d)).toEqual(['provision']);
  });

  it.each([
    ['service', { ...GOOD, service: '' }],
    ['workflowInput', { ...GOOD, workflowInput: '' }],
    ['bicepParam', { ...GOOD, bicepParam: '' }],
    ['module', { ...GOOD, module: '' }],
    ['costNote', { ...GOOD, costNote: '' }],
  ])('REFUSES an empty %s', (field, provision) => {
    // costNote is in this list deliberately: auto-bind-by-default.md permits a
    // cost-material opt-in only when the registry states the reason, so an
    // unpriced Deploy button is a rule violation and not a style nit.
    // Breaks if: that field drops out of the required list.
    const d = checkProvisionShape('g', { kind: 'provision', provision: provision as GateProvision });
    expect(ids(d)).toContain(field);
  });
});

describe('checkProvisionWiring — the silent-drop guard', () => {
  it('accepts an input that is declared AND threaded to --parameters', () => {
    // Breaks if: either half of the check inverts.
    expect(checkProvisionWiring('svc-servicebus', GOOD, WIRED)).toEqual([]);
  });

  it('REFUSES an input the workflow never declares — THE point of this file', () => {
    // GitHub drops an undeclared input silently: the deploy runs with the
    // bicep param at its default and reports success. This is the arm that
    // catches a button that provisions nothing.
    // Breaks if: the declaration regex is widened to a bare substring.
    const undeclared = WIRED.replace('      service_bus_enabled:\n        type: boolean\n', '');
    const d = checkProvisionWiring('svc-servicebus', GOOD, undeclared);
    expect(ids(d)).toContain('workflowInput');
    expect(d[0].detail).toMatch(/provisioned nothing/);
  });

  it('a REFERENCE without a DECLARATION does not count', () => {
    // The specific way a substring test fails: `${{ inputs.service_bus_enabled }}`
    // mentions the name, so a naive `includes()` passes while GitHub still
    // drops the value. The anchor requires the inputs-block key form.
    // Breaks if: the anchor is relaxed to a substring match.
    const referencedOnly = [
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      purview_enabled:',
      '        type: boolean',
      'jobs:',
      '  deploy:',
      '    steps:',
      '      - env:',
      '          X: ${{ inputs.service_bus_enabled }}',
      '      - run: add --parameters "serviceBusEnabled=$X"',
    ].join('\n');
    const d = checkProvisionWiring('svc-servicebus', GOOD, referencedOnly);
    expect(ids(d)).toContain('workflowInput');
  });

  it('REFUSES a declared input that never reaches --parameters', () => {
    // The same no-op wearing a different hat: dispatch succeeds, the value is
    // accepted, and nothing consumes it.
    // Breaks if: the second check is dropped as redundant.
    const notThreaded = WIRED.replace(
      '      - run: add --parameters "serviceBusEnabled=$SERVICE_BUS_ENABLED"',
      '      - run: echo nothing',
    );
    const d = checkProvisionWiring('svc-servicebus', GOOD, notThreaded);
    expect(ids(d)).toContain('bicepParam');
  });

  it('CONTROL: the wired fixture really does exercise both halves', () => {
    // Without this, every REFUSES case above could be passing because the
    // fixture is malformed rather than because the mutation was detected —
    // an absence-only suite. Pin that the positive case is genuinely positive
    // and that each half fires independently.
    expect(checkProvisionWiring('g', GOOD, WIRED)).toEqual([]);
    expect(ids(checkProvisionWiring('g', GOOD, 'on:\n  workflow_dispatch:\n'))).toEqual([
      'workflowInput',
      'bicepParam',
    ]);
  });
});
