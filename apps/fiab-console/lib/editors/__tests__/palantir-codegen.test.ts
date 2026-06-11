/**
 * Vitest — Palantir-class migration codegen (audit-T29).
 *
 * Exercises the pure generators in lib/editors/_palantir-codegen.ts that back
 * the ontology-sdk + slate-app "generate" routes. These produce real artifacts
 * (typed SDK source, dab-config.json, a SWA bundle), so a deterministic unit
 * test guards against codegen regressions without a browser.
 */
import { describe, it, expect } from 'vitest';
import {
  pascal, generateDabConfig, generateTypeScriptSdk, generatePythonSdk, generateSlateBundle,
} from '../_palantir-codegen';

const surface = {
  displayName: 'Logistics',
  classes: [
    { name: 'order', description: 'a customer order' },
    { name: 'shipment', parent: 'order' },
  ],
  links: [{ from: 'shipment', to: 'order', kind: 'IS_A' }],
};

describe('pascal', () => {
  it('PascalCases snake / space / mixed names', () => {
    expect(pascal('order')).toBe('Order');
    expect(pascal('customer_order')).toBe('CustomerOrder');
    expect(pascal('line item')).toBe('LineItem');
  });
  it('never returns empty', () => {
    expect(pascal('')).toBe('Object');
    expect(pascal('123')).toBe('123');
  });
});

describe('generateDabConfig', () => {
  it('emits a real DAB entity per object type with REST + GraphQL', () => {
    const cfg = generateDabConfig(surface) as any;
    expect(cfg.entities.Order).toBeDefined();
    expect(cfg.entities.Order.rest.path).toBe('/order');
    expect(cfg.entities.Order.graphql.enabled).toBe(true);
    expect(cfg.entities.Shipment.source.object).toBe('shipment');
    expect(cfg.runtime.host.authentication.provider).toBe('EntraID');
  });
});

describe('generateTypeScriptSdk', () => {
  it('emits a typed interface + client method per object type', () => {
    const ts = generateTypeScriptSdk(surface);
    expect(ts).toContain('export interface Order {');
    expect(ts).toContain('export interface Shipment {');
    expect(ts).toContain('listOrders()');
    expect(ts).toContain('getShipment(id: string)');
    // IS_A link surfaces as an optional reference on the child interface.
    expect(ts).toContain('is_a_order?: Order;');
    expect(ts).toContain('export class OntologyClient');
  });
});

describe('generatePythonSdk', () => {
  it('emits a dataclass + list method per object type', () => {
    const py = generatePythonSdk(surface);
    expect(py).toContain('class Order:');
    expect(py).toContain('def list_order(self)');
    expect(py).toContain('class OntologyClient:');
  });
});

describe('generateSlateBundle', () => {
  it('emits index.html + app.js + staticwebapp.config.json embedding the widgets', () => {
    const files = generateSlateBundle({
      displayName: 'Ops',
      apiBaseUrl: '/api',
      widgets: [{ id: 'w1', title: 'Open orders', kind: 'table', query: 'order' }],
    });
    const names = files.map((f) => f.name);
    expect(names).toEqual(['index.html', 'app.js', 'staticwebapp.config.json']);
    expect(files.find((f) => f.name === 'app.js')!.content).toContain('Open orders');
    expect(files.find((f) => f.name === 'index.html')!.content).toContain('<title>Ops</title>');
    const cfg = JSON.parse(files.find((f) => f.name === 'staticwebapp.config.json')!.content);
    expect(cfg.routes[0].route).toBe('/api/*');
  });
});
