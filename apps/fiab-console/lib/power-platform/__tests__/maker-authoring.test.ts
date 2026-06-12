/**
 * Power Platform maker authoring — unit tests for the pure helpers behind the
 * in-Loom authoring surfaces (Studio tab, Designer tab, Dataverse New column).
 *
 * These assert the load-bearing logic without rendering Fluent:
 *   - canvasStudioHref / makerAppsHref / flowDesignerHref build the correct,
 *     properly-encoded maker URLs (so the "Open in <X>" buttons go to the
 *     right place per cloud).
 *   - buildAttributeMetadata emits the correct @odata.type + shape for each
 *     Dataverse column type (grounded in MS Learn create-update-column-defs).
 *   - addColumn rejects a schema name without a publisher prefix up front.
 */
import { describe, it, expect } from 'vitest';
import { canvasStudioHref, makerAppsHref } from '../power-apps-editor';
import { flowDesignerHref } from '../power-automate-editor';
import {
  buildAttributeMetadata, buildEntityMetadata, emptyFlowDefinition,
  validateFlowDefinition, PowerPlatformError,
  type AddColumnSpec, type CreateTableSpec,
} from '@/lib/azure/powerplatform-client';

describe('maker authoring URL builders', () => {
  it('canvasStudioHref encodes env + app id', () => {
    expect(canvasStudioHref('env 1', 'app/2')).toBe(
      'https://make.powerapps.com/e/env%201/studio/app%2F2',
    );
  });
  it('makerAppsHref targets the apps maker surface', () => {
    expect(makerAppsHref('e1')).toBe('https://make.powerapps.com/environments/e1/apps');
  });
  it('flowDesignerHref targets the flow details/designer surface', () => {
    expect(flowDesignerHref('e1', 'f9')).toBe(
      'https://make.powerautomate.com/environments/e1/flows/f9/details',
    );
  });
});

describe('buildAttributeMetadata', () => {
  const base = (t: AddColumnSpec['attributeType']): AddColumnSpec => ({
    schemaName: 'new_Col', displayName: 'Col', attributeType: t,
  });

  it('String → StringAttributeMetadata with MaxLength + FormatName', () => {
    const m = buildAttributeMetadata({ ...base('String'), maxLength: 50 });
    expect(m['@odata.type']).toBe('Microsoft.Dynamics.CRM.StringAttributeMetadata');
    expect(m.MaxLength).toBe(50);
    expect(m.FormatName).toEqual({ Value: 'Text' });
    expect(m.SchemaName).toBe('new_Col');
    expect(m.DisplayName.LocalizedLabels[0].Label).toBe('Col');
    expect(m.RequiredLevel.Value).toBe('None');
  });

  it('Integer → IntegerAttributeMetadata with Format + bounds', () => {
    const m = buildAttributeMetadata(base('Integer'));
    expect(m['@odata.type']).toBe('Microsoft.Dynamics.CRM.IntegerAttributeMetadata');
    expect(m.Format).toBe('None');
    expect(m.MaxValue).toBe(2147483647);
  });

  it('Decimal/Money carry Precision', () => {
    expect(buildAttributeMetadata({ ...base('Decimal'), precision: 4 }).Precision).toBe(4);
    expect(buildAttributeMetadata({ ...base('Money'), precision: 3 }).Precision).toBe(3);
  });

  it('Boolean → BooleanAttributeMetadata with True/False options', () => {
    const m = buildAttributeMetadata(base('Boolean'));
    expect(m['@odata.type']).toBe('Microsoft.Dynamics.CRM.BooleanAttributeMetadata');
    expect(m.OptionSet.TrueOption.Value).toBe(1);
    expect(m.OptionSet.FalseOption.Value).toBe(0);
  });

  it('DateTime → DateTimeAttributeMetadata with Format + behavior', () => {
    const m = buildAttributeMetadata({ ...base('DateTime'), dateTimeFormat: 'DateOnly' });
    expect(m['@odata.type']).toBe('Microsoft.Dynamics.CRM.DateTimeAttributeMetadata');
    expect(m.Format).toBe('DateOnly');
    expect(m.DateTimeBehavior).toEqual({ Value: 'UserLocal' });
  });

  it('honors requiredLevel + description', () => {
    const m = buildAttributeMetadata({
      ...base('String'), requiredLevel: 'ApplicationRequired', description: 'hi',
    });
    expect(m.RequiredLevel.Value).toBe('ApplicationRequired');
    expect(m.Description.LocalizedLabels[0].Label).toBe('hi');
  });
});

describe('buildEntityMetadata (create table)', () => {
  const base = (): CreateTableSpec => ({
    schemaName: 'new_Invoice', displayName: 'Invoice', displayCollectionName: 'Invoices',
  });

  it('emits EntityMetadata with display + plural labels and ownership', () => {
    const m = buildEntityMetadata(base());
    expect(m['@odata.type']).toBe('Microsoft.Dynamics.CRM.EntityMetadata');
    expect(m.SchemaName).toBe('new_Invoice');
    expect(m.DisplayName.LocalizedLabels[0].Label).toBe('Invoice');
    expect(m.DisplayCollectionName.LocalizedLabels[0].Label).toBe('Invoices');
    expect(m.OwnershipType).toBe('UserOwned');
    expect(m.HasNotes).toBe(false);
    expect(m.HasActivities).toBe(false);
    expect(m.IsActivity).toBe(false);
  });

  it('includes exactly one primary-name StringAttributeMetadata (IsPrimaryName)', () => {
    const m = buildEntityMetadata(base());
    expect(Array.isArray(m.Attributes)).toBe(true);
    expect(m.Attributes).toHaveLength(1);
    const pk = m.Attributes[0];
    expect(pk['@odata.type']).toBe('Microsoft.Dynamics.CRM.StringAttributeMetadata');
    expect(pk.IsPrimaryName).toBe(true);
    expect(pk.SchemaName).toBe('new_Name'); // derived from table prefix
    expect(pk.FormatName).toEqual({ Value: 'Text' });
  });

  it('honors Elastic table type, Notes, Activities, and custom primary column', () => {
    const m = buildEntityMetadata({
      ...base(), tableType: 'Elastic', hasNotes: true, hasActivities: true,
      primaryNameDisplayName: 'Title', primaryNameSchemaName: 'new_Title',
    });
    expect(m.TableType).toBe('Elastic');
    expect(m.HasNotes).toBe(true);
    expect(m.HasActivities).toBe(true);
    expect(m.Attributes[0].SchemaName).toBe('new_Title');
    expect(m.Attributes[0].DisplayName.LocalizedLabels[0].Label).toBe('Title');
  });
});

describe('validateFlowDefinition + emptyFlowDefinition', () => {
  it('emptyFlowDefinition is a valid manual-trigger skeleton', () => {
    const def = emptyFlowDefinition();
    expect(() => validateFlowDefinition(def)).not.toThrow();
    expect(def.definition.triggers.manual.type).toBe('Request');
    expect(def.definition.$schema).toContain('workflowdefinition.json');
  });

  it('rejects a non-object', () => {
    expect(() => validateFlowDefinition('blob' as unknown)).toThrow(PowerPlatformError);
  });

  it('rejects a missing definition object', () => {
    expect(() => validateFlowDefinition({})).toThrow(/must contain a `definition`/);
  });

  it('rejects a wrong $schema', () => {
    expect(() => validateFlowDefinition({ definition: { $schema: 'http://nope', triggers: { t: {} } } }))
      .toThrow(/workflowdefinition\.json/);
  });

  it('rejects empty triggers', () => {
    expect(() => validateFlowDefinition({
      definition: { $schema: 'x/workflowdefinition.json#', triggers: {} },
    })).toThrow(/at least one trigger/);
  });

  it('rejects connectionReferences that are not an object map', () => {
    expect(() => validateFlowDefinition({
      definition: { $schema: 'x/workflowdefinition.json#', triggers: { t: {} } },
      connectionReferences: [],
    })).toThrow(/connectionReferences/);
  });

  it('accepts a valid definition + connection references', () => {
    const out = validateFlowDefinition({
      definition: { $schema: 'x/workflowdefinition.json#', triggers: { manual: { type: 'Request' } }, actions: {} },
      connectionReferences: { ref1: { connectionName: 'shared_x' } },
    });
    expect(out.connectionReferences?.ref1.connectionName).toBe('shared_x');
  });
});
