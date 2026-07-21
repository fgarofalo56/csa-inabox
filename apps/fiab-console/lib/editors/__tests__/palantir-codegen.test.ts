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
  deriveObjectProperties, generateActionReference, generateWorkshopCodeApp, generateWorkshopBundle,
} from '../_palantir-codegen';

const surface = {
  displayName: 'Logistics',
  classes: [
    { name: 'order', description: 'a customer order' },
    { name: 'shipment', parent: 'order' },
  ],
  links: [{ from: 'shipment', to: 'order', kind: 'IS_A' }],
};

// A richer surface with bindings (typed properties) + declared action types.
const bindings = [
  {
    sourceKind: 'warehouse' as const,
    sourceItemId: 'wh1',
    sourceDisplayName: 'fin-dw',
    entityTypes: ['order'],
    keyColumns: { order: 'OrderId' },
    writableColumns: { order: ['Customer', 'Total'] },
  },
];
const actionTypes = [
  { name: 'createOrder', objectType: 'order', kind: 'create' as const, params: ['Customer', 'Total'] },
  { name: 'shipOrder', objectType: 'order', kind: 'update' as const, params: ['Status'] },
  { name: 'cancelOrder', objectType: 'order', kind: 'delete' as const },
];
const typedSurface = {
  ...surface,
  propertiesByType: deriveObjectProperties(surface.classes, bindings, actionTypes),
  actionTypes,
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

describe('generateWorkshopCodeApp (APP-W3 eject-to-code)', () => {
  it('emits a runnable userFiles tree: express proxy + static canvas, relative run-action', () => {
    const files = generateWorkshopCodeApp({
      displayName: 'Field Ops',
      workshopAppId: 'abc-123',
      widgets: [{ id: 'w1', kind: 'metric', title: 'Open orders', entityType: 'Order' } as any],
      variables: [],
    });
    expect(Object.keys(files).sort()).toEqual(['package.json', 'public/app.js', 'public/index.html', 'server.js']);
    // Front-end calls same-origin /run-action; the server proxies with a PAT.
    expect(files['public/app.js']).toContain('const RUN_ACTION_URL = "/run-action"');
    expect(files['server.js']).toContain("'/api/items/workshop-app/abc-123/run-action'");
    expect(files['server.js']).toContain('LOOM_API_TOKEN');
    expect(files['server.js']).toContain('503'); // honest gate when unwired
    expect(files['public/index.html']).toContain('<title>Field Ops</title>');
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.scripts.start).toBe('node server.js');
    expect(pkg.dependencies.express).toBeTruthy();
    // The emitted server MUST parse — a lost regex backslash shipped a
    // SyntaxError to a live container (2026-07-19). Function() parses only.
    expect(() => new Function(files['server.js'])).not.toThrow();
    expect(files['server.js']).toContain("replace(/\\/+$/, '')");
  });
});

describe('generateWorkshopBundle (WS-4.5 multi-page + overlays + widgets)', () => {
  const spec = {
    displayName: 'Ops Console',
    runActionUrl: 'https://loom.example/api/items/workshop-app/a1/run-action',
    variables: [{ id: 'v1', name: 'selected', type: 'string' as const }],
    pages: [
      { id: 'home', name: 'Home', kind: 'page' as const },
      { id: 'detail', name: 'Detail', kind: 'page' as const },
      { id: 'ov1', name: 'Inspector', kind: 'overlay' as const, overlayStyle: 'drawer' as const },
    ],
    widgets: [
      { id: 'w1', kind: 'metric' as const, title: 'Count', entityType: 'Order', pageId: 'home' },
      { id: 'w2', kind: 'pivot' as const, title: 'By region', entityType: 'Order', pageId: 'detail', pivotRowField: 'region', pivotColField: 'quarter', pivotAggFn: 'sum' as const, pivotAggColumn: 'amount' },
      { id: 'w3', kind: 'timeline' as const, title: 'Events', entityType: 'Order', pageId: 'detail', timeColumn: 'created' },
      { id: 'w4', kind: 'map' as const, title: 'Sites', entityType: 'Site', pageId: 'home', geoColumn: 'geo' },
      { id: 'w5', kind: 'object-view' as const, title: 'Detail', entityType: 'Order', pageId: 'ov1', keyVariableId: 'v1', visibleWhen: { variableId: 'v1', op: 'notEmpty' as const } },
      { id: 'b1', kind: 'button' as const, title: 'Open', pageId: 'home', events: [{ id: 'e1', trigger: 'click' as const, effect: 'open-overlay' as const, targetPageId: 'ov1' }] },
    ],
  };

  it('emits index.html + app.js + SWA config; app.js MUST parse (no lost backslash)', () => {
    const files = generateWorkshopBundle(spec as any);
    expect(files.map((f) => f.name).sort()).toEqual(['app.js', 'index.html', 'staticwebapp.config.json']);
    const appJs = files.find((f) => f.name === 'app.js')!.content;
    // A hand-written regex/quote slip ships a SyntaxError to a live SWA (2026-07-19 lesson).
    expect(() => new Function(appJs)).not.toThrow();
  });

  it('embeds the multi-page + overlay + visibility model and the new widget renderers', () => {
    const appJs = generateWorkshopBundle(spec as any).find((f) => f.name === 'app.js')!.content;
    expect(appJs).toContain('const PAGES =');
    expect(appJs).toContain('"kind": "overlay"');
    expect(appJs).toContain('openOverlay');
    expect(appJs).toContain('isVisible');            // conditional visibility
    expect(appJs).toContain('pivotHtml');            // pivot renderer
    expect(appJs).toContain('timelineHtml');         // timeline renderer
    expect(appJs).toContain('mapHtml');              // map renderer
    // object-view falls back to an honest sign-in note in the unauthenticated bundle.
    expect(appJs).toContain('noteHtml');
    const html = generateWorkshopBundle(spec as any).find((f) => f.name === 'index.html')!.content;
    expect(html).toContain('id="nav"');
    expect(html).toContain('id="overlay-host"');
  });

  it('synthesizes a default page when none is passed (back-compat)', () => {
    const appJs = generateWorkshopBundle({ ...spec, pages: undefined } as any).find((f) => f.name === 'app.js')!.content;
    expect(appJs).toContain('"id": "page-1"');
    expect(() => new Function(appJs)).not.toThrow();
  });
});

describe('deriveObjectProperties', () => {
  it('collects key + writable columns + action params, key first, deduped', () => {
    const props = deriveObjectProperties(surface.classes, bindings, actionTypes);
    expect(props.order.map((p) => p.name)).toEqual(['OrderId', 'Customer', 'Total', 'Status']);
    expect(props.order[0].isKey).toBe(true);
    // shipment has no binding/action metadata → no entry (untyped fallback).
    expect(props.shipment).toBeUndefined();
  });
});

describe('typed object properties (cap 3)', () => {
  it('TS emits named members + a key, no untyped bag, for bound types', () => {
    const ts = generateTypeScriptSdk(typedSurface);
    expect(ts).toContain('OrderId: string;');
    expect(ts).toContain('Customer?: string;');
    expect(ts).toContain('Status?: string;');
    // The bound Order interface must NOT fall back to the untyped index signature.
    const orderBlock = ts.slice(ts.indexOf('export interface Order {'), ts.indexOf('export interface Shipment {'));
    expect(orderBlock).not.toContain('[property: string]: unknown;');
    // Unbound Shipment still uses the untyped bag.
    expect(ts).toContain('  [property: string]: unknown;');
  });
  it('Python emits Optional typed fields for bound types', () => {
    const py = generatePythonSdk(typedSurface);
    expect(py).toContain('OrderId: Optional[str] = None');
    expect(py).toContain('Customer: Optional[str] = None');
  });
});

describe('action-type code-gen (cap 5)', () => {
  it('TS emits applyCreate/applyUpdate/applyDelete using DAB REST verbs + the key column', () => {
    const ts = generateTypeScriptSdk(typedSurface);
    expect(ts).toContain('applyCreateOrder(input: OrderInput): Promise<Order>');
    expect(ts).toContain("this.write<Order>('POST', '/order', input)");
    expect(ts).toContain('applyShipOrder(id: string, input: OrderInput): Promise<Order>');
    expect(ts).toContain('PATCH');
    expect(ts).toContain('applyCancelOrder(id: string): Promise<void>');
    expect(ts).toContain('DELETE');
    // key column from the binding drives the by-key path.
    expect(ts).toContain('/order/OrderId/');
    expect(ts).toContain('export interface OrderInput {');
  });
  it('Python emits snake_case apply methods with a _write helper', () => {
    const py = generatePythonSdk(typedSurface);
    expect(py).toContain('def apply_create_order(self, input: Dict[str, Any])');
    expect(py).toContain('def apply_ship_order(self, id: str, input: Dict[str, Any])');
    expect(py).toContain('def apply_cancel_order(self, id: str) -> None');
    expect(py).toContain('def _write(self,');
  });
  it('dab-config grants create/update/delete only where an action declares it', () => {
    const cfg = generateDabConfig(typedSurface) as any;
    expect(cfg.entities.Order.permissions[0].actions.sort()).toEqual(['create', 'delete', 'read', 'update']);
    // shipment has no actions → read-only.
    expect(cfg.entities.Shipment.permissions[0].actions).toEqual(['read']);
  });
  it('action reference lists each action; empty when no actions', () => {
    const ref = generateActionReference(typedSurface);
    expect(ref).toContain('createOrder — create on Order');
    expect(ref).toContain('client.applyCreateOrder');
    expect(generateActionReference(surface)).toBe('');
  });
});
