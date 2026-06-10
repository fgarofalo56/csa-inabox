/**
 * Vitest — Rayfin model-bound app generators (lib/editors/rayfin/model-bound-app.ts).
 *
 * Exercises the pure generators that turn a bound semantic model into a full
 * Rayfin web app. These are the load-bearing functions for the "build a full web
 * app backed by a semantic model" acceptance — a regression here ships a broken
 * app, which a DOM smoke can't catch.
 */
import { describe, it, expect } from 'vitest';
import {
  mapDataType, pascal, camel,
  generateBoundModel, generateDabConfig, generateEntityPage, generateMeasuresPage,
  generateWebApp, generateBoundCommands, generateHomePage,
  type BoundModel,
} from '../rayfin/model-bound-app';

const MODEL: BoundModel = {
  id: 'loom:abc',
  name: 'Sales Analytics',
  tables: [
    {
      name: 'Sales Order',
      columns: [
        { name: 'OrderId', dataType: 'int64' },
        { name: 'OrderDate', dataType: 'dateTime' },
        { name: 'Amount', dataType: 'decimal' },
        { name: 'IsPaid', dataType: 'boolean' },
        { name: 'Customer', dataType: 'string' },
      ],
      measures: [{ name: 'Total Sales', expression: 'SUM(Sales[Amount])' }],
    },
    {
      name: 'Customer',
      columns: [
        { name: 'CustomerId', dataType: 'int64' },
        { name: 'Name', dataType: 'string' },
      ],
      measures: [],
    },
  ],
  relationships: [
    { name: 'rel1', fromTable: 'Sales Order', fromColumn: 'Customer', toTable: 'Customer', toColumn: 'CustomerId', crossFilteringBehavior: 'OneDirection' },
  ],
};

describe('mapDataType', () => {
  it('maps tabular types to rayfin field types', () => {
    expect(mapDataType('int64')).toBe('number');
    expect(mapDataType('decimal')).toBe('number');
    expect(mapDataType('double')).toBe('number');
    expect(mapDataType('boolean')).toBe('boolean');
    expect(mapDataType('dateTime')).toBe('date');
    expect(mapDataType('string')).toBe('text');
    expect(mapDataType(undefined)).toBe('text');
    expect(mapDataType('weird')).toBe('text');
  });
});

describe('pascal / camel', () => {
  it('pascalizes table names', () => {
    expect(pascal('Sales Order')).toBe('SalesOrder');
    expect(camel('Sales Order')).toBe('salesOrder');
    expect(pascal('')).toBe('Entity');
  });
});

describe('generateBoundModel', () => {
  const out = generateBoundModel(MODEL);
  it('emits an @entity per table', () => {
    expect(out).toContain('export class SalesOrder');
    expect(out).toContain('export class Customer');
  });
  it('decorates columns with the mapped type', () => {
    expect(out).toContain('@number() OrderId!: number;');
    expect(out).toContain('@date() OrderDate!: Date;');
    expect(out).toContain('@boolean() IsPaid!: boolean;');
    expect(out).toContain('@text() Customer!: string;');
  });
  it('imports only the decorators it uses, plus entity + relation', () => {
    expect(out).toMatch(/import \{ entity,.*relation \} from '@microsoft\/rayfin-core';/);
  });
  it('emits a @relation for the model relationship', () => {
    expect(out).toContain('@relation(() => Customer) customer?: Customer;');
  });
});

describe('generateDabConfig', () => {
  const cfg = JSON.parse(generateDabConfig(MODEL));
  it('is valid JSON with an entity per table', () => {
    expect(Object.keys(cfg.entities).sort()).toEqual(['Customer', 'SalesOrder']);
  });
  it('exposes REST + GraphQL read with Entra auth', () => {
    expect(cfg.entities.SalesOrder.rest.enabled).toBe(true);
    expect(cfg.entities.SalesOrder.graphql.enabled).toBe(true);
    expect(cfg.entities.SalesOrder.permissions[0].actions[0].action).toBe('read');
    expect(cfg.runtime.host.authentication.provider).toBe('EntraID');
  });
});

describe('generateEntityPage', () => {
  const page = generateEntityPage(MODEL, MODEL.tables[0]);
  it('writes the page under the entity slug', () => {
    expect(page.path).toBe('app/salesOrder/page.tsx');
  });
  it('fetches the DAB endpoint and renders a DataGrid', () => {
    expect(page.content).toContain("fetch('/api/salesOrder')");
    expect(page.content).toContain('DataGrid');
    expect(page.content).toContain('interface SalesOrder');
  });
});

describe('generateMeasuresPage', () => {
  it('surfaces the model measures', () => {
    const page = generateMeasuresPage(MODEL);
    expect(page.path).toBe('app/dashboard/page.tsx');
    expect(page.content).toContain('Total Sales');
    expect(page.content).toContain('SUM(Sales[Amount])');
  });
});

describe('generateWebApp', () => {
  const files = generateWebApp(MODEL);
  it('emits model + dab + a page per table + dashboard + home', () => {
    const paths = files.map((f) => f.path);
    expect(paths).toContain('rayfin/model.ts');
    expect(paths).toContain('rayfin/dab-config.json');
    expect(paths).toContain('app/salesOrder/page.tsx');
    expect(paths).toContain('app/customer/page.tsx');
    expect(paths).toContain('app/dashboard/page.tsx');
    expect(paths).toContain('app/page.tsx');
  });
  it('omits the dashboard when there are no measures', () => {
    const noMeasures: BoundModel = { ...MODEL, tables: MODEL.tables.map((t) => ({ ...t, measures: [] })) };
    const paths = generateWebApp(noMeasures).map((f) => f.path);
    expect(paths).not.toContain('app/dashboard/page.tsx');
  });
});

describe('generateHomePage', () => {
  it('links to every entity', () => {
    const home = generateHomePage(MODEL);
    expect(home).toContain('href="/salesOrder"');
    expect(home).toContain('href="/customer"');
    expect(home).toContain('href="/dashboard"');
  });
});

describe('generateBoundCommands', () => {
  it('emits the scaffold/init/up sequence with the workspace flag', () => {
    const cmds = generateBoundCommands('sales-app', 'My Workspace');
    expect(cmds).toContain('npm create @microsoft/rayfin@latest sales-app --workspace "My Workspace"');
    expect(cmds).toContain('npx rayfin init sales-app --services db --auth-methods fabric --static-hosting');
    expect(cmds).toContain('npx rayfin up');
  });
  it('omits the workspace flag when none is given', () => {
    const cmds = generateBoundCommands('sales-app', '');
    expect(cmds).toContain('npm create @microsoft/rayfin@latest sales-app');
    expect(cmds).not.toContain('--workspace');
  });
});
