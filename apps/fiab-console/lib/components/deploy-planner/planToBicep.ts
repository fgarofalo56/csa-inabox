/**
 * Deploy-planner STANDALONE Bicep template generation.
 *
 * Where `planToBicepparam` emits a `.bicepparam` that drives the maintained
 * `platform/fiab/bicep/main.bicep` (the primary, fully-orchestrated deploy
 * path), this emitter produces a self-contained, subscription-scoped `.bicep`
 * **template** straight from the planned graph:
 *
 *   - every SELECTED service that has a self-contained deploy-planner module
 *     (`platform/fiab/bicep/modules/deploy-planner/<svc>.bicep`) becomes a real
 *     `module` reference, with its per-resource config (SKU/tier/runtime)
 *     threaded through,
 *   - the canvas dependency arrows (`sub.edges`) become real `dependsOn`
 *     between those modules, so the visual ordering is actually enforced at
 *     deploy time,
 *   - services WITHOUT a self-contained module (AI Search, API Management, AI
 *     Foundry, … which deploy via main.bicep's DLZ orchestrator) are listed as
 *     honest comments, never as fake modules.
 *
 * The output is `az bicep build`-clean and deployable with
 *   `az deployment sub create -l <region> -f <file>.bicep`
 * once saved alongside main.bicep (so the relative module paths resolve). The
 * Console UAMI role grants are intentionally skipped here (every module's
 * `consolePrincipalId` defaults to '') — this template provisions resources;
 * run main.bicep (or grant separately) to wire the Loom Console to them. That
 * is disclosed in the generated header (no vaporware).
 */
import {
  SERVICE_CATALOG, serviceByKey, resolveConfigValue, type ConfigField, type ConfigValue,
} from './service-catalog';
import { parseServiceNodeId } from './plan-validation';
import { BOUNDARY_DEFAULT_REGION } from './bicepparam';
import type { PlanSubscription } from './types';

/**
 * Spec for one service key that has a self-contained deploy-planner module.
 * `file` is the module filename under modules/deploy-planner/. `scope` is the
 * deployment scope: 'rg' modules deploy into the generated resource group;
 * 'sub' modules (Defender for Cloud, Policy) deploy at the subscription scope
 * with no `scope:` line. `config` maps a catalog ConfigField.key → the MODULE
 * param name (which differs from the top-level main.bicep `bicepParam`). `extra`
 * are fixed literal module params required by shared modules (cognitive-account
 * needs `kind` + `nameFragment`), mirroring exactly how main.bicep invokes them.
 */
interface DpModuleSpec {
  file: string;
  scope: 'rg' | 'sub';
  /** catalog ConfigField.key → module param name. */
  config?: Record<string, string>;
  /** fixed literal module params (already quoted-safe strings). */
  extra?: Record<string, string>;
}

/**
 * The service keys with a real, self-contained module under
 * platform/fiab/bicep/modules/deploy-planner/. Kept 1:1 with how main.bicep
 * wires each `dp*` module (verified against main.bicep + each module's params),
 * so the standalone template invokes them identically — no drift.
 */
export const DP_MODULES: Record<string, DpModuleSpec> = {
  // compute & apps
  appService: { file: 'app-service.bicep', scope: 'rg', config: { planSku: 'planSku', linuxFxVersion: 'linuxFxVersion' } },
  functions: { file: 'functions.bicep', scope: 'rg', config: { workerRuntime: 'functionsWorkerRuntime', linuxFxVersion: 'linuxFxVersion' } },
  containerInstances: { file: 'container-instances.bicep', scope: 'rg' },
  vm: { file: 'virtual-machine.bicep', scope: 'rg' },
  batch: { file: 'batch.bicep', scope: 'rg' },
  logicApps: { file: 'logic-app.bicep', scope: 'rg' },
  staticWebApps: { file: 'static-web-app.bicep', scope: 'rg' },
  // data & analytics
  postgres: { file: 'postgres.bicep', scope: 'rg', config: { version: 'postgresVersion', storageSizeGB: 'storageSizeGB' } },
  mysql: { file: 'mysql.bicep', scope: 'rg', config: { version: 'mysqlVersion', storageSizeGB: 'storageSizeGB' } },
  redis: { file: 'redis.bicep', scope: 'rg', config: { skuName: 'skuName' } },
  streamAnalytics: { file: 'stream-analytics.bicep', scope: 'rg', config: { streamingUnits: 'startingStreamingUnits' } },
  dataFactory: { file: 'data-factory.bicep', scope: 'rg' },
  // ai & ML — cognitive-account.bicep is shared; kind + nameFragment per main.bicep
  aiServices: { file: 'cognitive-account.bicep', scope: 'rg', extra: { kind: "'CognitiveServices'", nameFragment: "'aiservices'" } },
  documentIntelligence: { file: 'cognitive-account.bicep', scope: 'rg', extra: { kind: "'FormRecognizer'", nameFragment: "'docintel'" } },
  contentSafety: { file: 'cognitive-account.bicep', scope: 'rg', extra: { kind: "'ContentSafety'", nameFragment: "'contentsafety'" } },
  visionServices: { file: 'cognitive-account.bicep', scope: 'rg', extra: { kind: "'ComputerVision'", nameFragment: "'vision'" } },
  speechServices: { file: 'cognitive-account.bicep', scope: 'rg', extra: { kind: "'SpeechServices'", nameFragment: "'speech'" } },
  languageServices: { file: 'cognitive-account.bicep', scope: 'rg', extra: { kind: "'TextAnalytics'", nameFragment: "'language'" } },
  mlWorkspace: { file: 'ml-workspace.bicep', scope: 'rg' },
  // integration & messaging
  eventGrid: { file: 'event-grid.bicep', scope: 'rg' },
  serviceBus: { file: 'service-bus.bicep', scope: 'rg', config: { skuName: 'skuName' } },
  storageQueues: { file: 'storage-queues.bicep', scope: 'rg' },
  signalr: { file: 'signalr.bicep', scope: 'rg' },
  // governance & security — these are subscription-scoped (no rg)
  defenderCloud: { file: 'defender-cloud.bicep', scope: 'sub' },
  policy: { file: 'policy-assignment.bicep', scope: 'sub' },
  // networking & edge
  cdn: { file: 'cdn.bicep', scope: 'rg' },
  loadBalancer: { file: 'load-balancer.bicep', scope: 'rg' },
  firewall: { file: 'firewall.bicep', scope: 'rg', config: { tier: 'firewallTier' } },
};

/** Service keys that have a self-contained deploy-planner module. */
export const MODULE_BACKED_KEYS = new Set(Object.keys(DP_MODULES));

/** A valid Bicep symbolic name for a service's module (`svc_<key>`). */
function moduleSymbol(key: string): string {
  return `svc_${key.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** Render one config value as a Bicep literal (bare int or quoted string). */
function formatValue(field: ConfigField, value: ConfigValue): string {
  const asInt = field.emit === 'int' || (field.emit === undefined && field.type === 'number');
  if (asInt) return String(Math.round(Number(value)));
  return `'${String(value).replace(/'/g, "\\'")}'`;
}

/** A safe `resourceGroupName` default slug from the subscription name. */
function slug(name: string): string {
  return (name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';
}

/**
 * Generate a standalone, subscription-scoped Bicep template for one planned
 * subscription. Module-backed selected services become real modules wired in
 * dependency order from the canvas edges; everything else is documented.
 */
export function planToBicep(sub: PlanSubscription): string {
  const boundary = sub.boundary || 'Commercial';
  const region = sub.region || BOUNDARY_DEFAULT_REGION[boundary] || 'eastus2';

  // Distinct selected service keys across the subscription's domains.
  const selected = new Set<string>();
  for (const d of sub.domains) for (const k of d.services) selected.add(k);

  // Module-backed selected keys, in catalog order (deterministic output).
  const moduleKeys = SERVICE_CATALOG
    .map((s) => s.key)
    .filter((k) => selected.has(k) && MODULE_BACKED_KEYS.has(k));
  const moduleKeySet = new Set(moduleKeys);

  // Build dependsOn from edges: an arrow from→to records that `from` depends on
  // `to`. Collapse node ids to service keys (one module per key per sub) and
  // keep only edges where BOTH endpoints are module-backed selected services.
  const deps = new Map<string, Set<string>>();
  for (const e of sub.edges || []) {
    const from = parseServiceNodeId(e.from);
    const to = parseServiceNodeId(e.to);
    if (!from || !to) continue;
    if (from.key === to.key) continue;
    if (!moduleKeySet.has(from.key) || !moduleKeySet.has(to.key)) continue;
    if (!deps.has(from.key)) deps.set(from.key, new Set());
    deps.get(from.key)!.add(to.key);
  }

  const lines: string[] = [];
  lines.push(`// Generated by the CSA Loom Deployment planner — architecture template`);
  lines.push(`// ${sub.name} (${boundary})`);
  lines.push(`//`);
  lines.push(`// A standalone, subscription-scoped Bicep TEMPLATE built from the planned`);
  lines.push(`// graph. Save it alongside main.bicep so the relative module paths resolve:`);
  lines.push(`//   platform/fiab/bicep/${slug(sub.name)}.architecture.bicep`);
  lines.push(`// then deploy:`);
  lines.push(`//   az deployment sub create -l ${region} -f ${slug(sub.name)}.architecture.bicep`);
  lines.push(`//`);
  lines.push(`// Dependency arrows on the canvas become real module \`dependsOn\` below.`);
  lines.push(`// This template PROVISIONS resources only — the Loom Console UAMI role grants`);
  lines.push(`// are skipped here (each module's consolePrincipalId defaults to ''); run`);
  lines.push(`// main.bicep (or grant separately) to wire the Console to these resources.`);
  lines.push(``);
  lines.push(`targetScope = 'subscription'`);
  lines.push(``);
  lines.push(`@description('Region for the architecture resource group + resources.')`);
  lines.push(`param location string = '${region}'`);
  lines.push(``);
  lines.push(`@description('Resource group the planned resources deploy into.')`);
  lines.push(`param resourceGroupName string = 'rg-loom-${slug(sub.name)}'`);
  lines.push(``);
  lines.push(`@description('Compliance tags applied to every resource.')`);
  lines.push(`param complianceTags object = {}`);
  lines.push(``);

  const rgScoped = moduleKeys.filter((k) => DP_MODULES[k].scope === 'rg');
  if (rgScoped.length) {
    lines.push(`resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {`);
    lines.push(`  name: resourceGroupName`);
    lines.push(`  location: location`);
    lines.push(`  tags: complianceTags`);
    lines.push(`}`);
    lines.push(``);
  }

  if (moduleKeys.length === 0) {
    lines.push(`// No module-backed services are selected in this subscription yet — add`);
    lines.push(`// services with a one-button bicep toggle to generate real modules here.`);
  }

  for (const key of moduleKeys) {
    const spec = DP_MODULES[key];
    const def = serviceByKey(key);
    const sym = moduleSymbol(key);
    lines.push(`// ${def?.label || key}`);
    lines.push(`module ${sym} 'modules/deploy-planner/${spec.file}' = {`);
    lines.push(`  name: 'dp-${key.toLowerCase()}'`);
    if (spec.scope === 'rg') lines.push(`  scope: rg`);
    // params block
    const params: string[] = [];
    if (spec.scope === 'rg') {
      params.push(`    location: location`);
      params.push(`    complianceTags: complianceTags`);
    }
    for (const [pk, pv] of Object.entries(spec.extra || {})) params.push(`    ${pk}: ${pv}`);
    if (spec.config && def?.config) {
      for (const [fieldKey, moduleParam] of Object.entries(spec.config)) {
        const field = def.config.find((f) => f.key === fieldKey);
        if (!field) continue;
        const value = resolveConfigValue(field, sub.serviceConfigs?.[key]);
        params.push(`    ${moduleParam}: ${formatValue(field, value)}`);
      }
    }
    if (params.length) {
      lines.push(`  params: {`);
      lines.push(...params);
      lines.push(`  }`);
    } else {
      lines.push(`  params: {}`);
    }
    // dependsOn from edges (only module-backed targets)
    const d = deps.get(key);
    if (d && d.size) {
      const ordered = [...d].sort();
      lines.push(`  dependsOn: [`);
      for (const t of ordered) lines.push(`    ${moduleSymbol(t)}`);
      lines.push(`  ]`);
    }
    lines.push(`}`);
    lines.push(``);
  }

  // Honest disclosure: selected services with NO self-contained module deploy
  // via main.bicep's DLZ orchestrator, so they are documented, not faked.
  const orchestrated = SERVICE_CATALOG
    .filter((s) => selected.has(s.key) && !MODULE_BACKED_KEYS.has(s.key))
    .filter((s) => !!s.bicepFlag);
  if (orchestrated.length) {
    lines.push(`// ── Deployed via main.bicep's DLZ orchestrator (no standalone module) ──`);
    lines.push(`// Use the exported .bicepparam against main.bicep to deploy these:`);
    for (const s of orchestrated) lines.push(`//   - ${s.label} (param ${s.bicepFlag})`);
    lines.push(``);
  }

  return lines.join('\n');
}
