/**
 * Eventstream authoring-error collection — PURE topology validation behind the
 * docked "Authoring errors" tab (Fabric Eventstream parity), unit-tested with
 * no DOM.
 *
 * Fabric's Eventstream editor surfaces topology-authoring problems (an unbound
 * source field, a destination missing its table, a join with no second stream)
 * in a dedicated tab BEFORE you publish, so you fix them at design time rather
 * than discovering them when the running job errors. Loom previously surfaced
 * these only after a real ASA run failed. This module walks the persisted
 * topology and returns the same pre-flight findings deterministically.
 *
 * It reads the on-wire topology shape the editor already persists
 * ({ sources[], transforms[], sinks[] }); nothing here calls Azure — it's a
 * static lint over typed config, so it runs instantly on every edit.
 */

export type AuthoringSeverity = 'error' | 'warning';
export type AuthoringNodeType = 'source' | 'transform' | 'sink' | 'topology';

export interface AuthoringError {
  /** Stable id (nodeType + index + rule) for the React key. */
  id: string;
  severity: AuthoringSeverity;
  nodeType: AuthoringNodeType;
  /** The offending node's name, when it is a node-scoped finding. */
  nodeName?: string;
  message: string;
}

export interface EsTopology {
  sources: any[];
  transforms: any[];
  sinks: any[];
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function srcName(n: any, i: number): string { return String(n?.name || `source-${i + 1}`); }
function opName(n: any, i: number): string { return String(n?.name || `${n?.kind || 'operator'}-${i + 1}`); }
function sinkName(n: any, i: number): string { return String(n?.name || `destination-${i + 1}`); }

/**
 * Collect every authoring problem in the topology, most-blocking first
 * (errors before warnings, then in node order). An empty array means the
 * topology is publish-ready.
 */
export function collectAuthoringErrors(topology: EsTopology): AuthoringError[] {
  const sources = Array.isArray(topology.sources) ? topology.sources : [];
  const transforms = Array.isArray(topology.transforms) ? topology.transforms : [];
  const sinks = Array.isArray(topology.sinks) ? topology.sinks : [];
  const out: AuthoringError[] = [];

  // ---- topology-level completeness ----
  if (sources.length === 0) {
    out.push({ id: 'topology-no-source', severity: 'error', nodeType: 'topology', message: 'Add at least one source — the stream has no input.' });
  }
  if (sinks.length === 0) {
    out.push({ id: 'topology-no-sink', severity: 'error', nodeType: 'topology', message: 'Add at least one destination — the stream has nowhere to land events.' });
  }

  // ---- per-source required config ----
  sources.forEach((n, i) => {
    const name = srcName(n, i);
    const kind = String(n?.kind || 'eventhub');
    const err = (rule: string, message: string) => out.push({ id: `source-${i}-${rule}`, severity: 'error', nodeType: 'source', nodeName: name, message });
    switch (kind) {
      case 'eventhub':
        if (isBlank(n?.eventHubName)) err('eventhub-name', `Source "${name}": Event Hub name is required.`);
        break;
      case 'iothub':
        if (isBlank(n?.iotHub)) err('iothub-name', `Source "${name}": IoT Hub name is required.`);
        break;
      case 'kafka':
        if (isBlank(n?.topic)) err('kafka-topic', `Source "${name}": Kafka topic is required.`);
        break;
      case 'custom-app':
        if (isBlank(n?.eventHubName)) err('customapp-hub', `Source "${name}": Event Hub name is required.`);
        break;
      case 'cdc-mirror':
        if (isBlank(n?.cdcServerHost)) err('cdc-host', `Source "${name}": database server host is required.`);
        if (isBlank(n?.cdcDatabase)) err('cdc-db', `Source "${name}": database name is required.`);
        if (isBlank(n?.cdcTable)) err('cdc-table', `Source "${name}": table is required.`);
        break;
      case 'mirror-cdf':
        if (isBlank(n?.mirrorItemId)) err('mirror-item', `Source "${name}": pick a mirrored database.`);
        else if (!Array.isArray(n?.mirrorTables) || n.mirrorTables.length === 0) {
          out.push({ id: `source-${i}-mirror-tables`, severity: 'warning', nodeType: 'source', nodeName: name, message: `Source "${name}": no mirror tables selected — no change rows will be produced.` });
        }
        break;
      // 'sample' needs no config.
    }
  });

  // ---- per-operator required config ----
  transforms.forEach((n, i) => {
    const name = opName(n, i);
    const kind = String(n?.kind || 'filter');
    const err = (rule: string, message: string) => out.push({ id: `transform-${i}-${rule}`, severity: 'error', nodeType: 'transform', nodeName: name, message });
    const warn = (rule: string, message: string) => out.push({ id: `transform-${i}-${rule}`, severity: 'warning', nodeType: 'transform', nodeName: name, message });
    switch (kind) {
      case 'filter':
        if (isBlank(n?.expression)) warn('filter-expr', `Filter "${name}": no WHERE condition — every event passes through.`);
        break;
      case 'aggregate':
      case 'group-by': {
        const aggs = Array.isArray(n?.aggregates) ? n.aggregates.filter((a: any) => a && a.func) : [];
        if (aggs.length === 0) err('agg-none', `${kind === 'group-by' ? 'Group by' : 'Aggregate'} "${name}": add at least one aggregation.`);
        break;
      }
      case 'expand':
        if (isBlank(n?.expandField)) err('expand-field', `Expand "${name}": choose the array column to flatten.`);
        break;
      case 'join':
        if (isBlank(n?.joinSource)) err('join-source', `Join "${name}": select a second source to join with.`);
        if (isBlank(n?.joinOn)) warn('join-on', `Join "${name}": no ON condition — the join is a cross product.`);
        break;
      case 'manage-fields': {
        const rows = Array.isArray(n?.fieldMap) ? n.fieldMap.filter((m: any) => m && String(m.source || '').trim()) : [];
        if (rows.length === 0) warn('mf-empty', `Manage fields "${name}": no fields listed — every field passes through unchanged.`);
        break;
      }
      case 'cdc-flatten':
        if (!Array.isArray(n?.cdcColumns) || n.cdcColumns.length === 0) warn('cdc-cols', `CDC transform "${name}": no columns to flatten selected.`);
        if (String(n?.cdcSchemaMode) === 'analytics-ready' && isBlank(n?.cdcDestinationTable)) {
          err('cdc-dest', `CDC transform "${name}": analytics-ready mode needs a destination table.`);
        }
        break;
      case 'union':
        if (sources.length < 2) warn('union-one', `Union "${name}": only one source — union has no effect until a second source is added.`);
        break;
    }
  });

  // ---- per-destination required config ----
  sinks.forEach((n, i) => {
    const name = sinkName(n, i);
    const kind = String(n?.kind || 'kusto');
    const err = (rule: string, message: string) => out.push({ id: `sink-${i}-${rule}`, severity: 'error', nodeType: 'sink', nodeName: name, message });
    const warn = (rule: string, message: string) => out.push({ id: `sink-${i}-${rule}`, severity: 'warning', nodeType: 'sink', nodeName: name, message });
    switch (kind) {
      case 'kusto':
        if (isBlank(n?.table)) err('kusto-table', `Destination "${name}": KQL Database table is required.`);
        break;
      case 'lakehouse':
        if (isBlank(n?.container)) warn('lakehouse-container', `Destination "${name}": no container/filesystem set — defaults to the deployment lake container.`);
        break;
      case 'eventhub':
      case 'reflex':
        if (isBlank(n?.eventHubName)) warn('eh-name', `Destination "${name}": no Event Hub name — one will be derived on publish.`);
        break;
      case 'spark-notebook':
        if (isBlank(n?.notebook)) warn('spark-nb', `Destination "${name}": no notebook selected.`);
        break;
    }
  });

  // Errors first, warnings second; preserve insertion order within each band.
  return [...out.filter((e) => e.severity === 'error'), ...out.filter((e) => e.severity === 'warning')];
}

/** Convenience: counts for the tab badge. */
export function authoringErrorCounts(errs: AuthoringError[]): { errors: number; warnings: number } {
  return {
    errors: errs.filter((e) => e.severity === 'error').length,
    warnings: errs.filter((e) => e.severity === 'warning').length,
  };
}
