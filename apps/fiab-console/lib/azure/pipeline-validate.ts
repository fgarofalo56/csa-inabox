/**
 * Server-side structural validation for ADF / Synapse / Fabric pipeline
 * definitions.
 *
 * WHY THIS EXISTS (no-vaporware.md):
 *   The Azure Data Factory MANAGEMENT REST API does NOT expose a public
 *   "validate pipeline" data-plane action. The `Validate()` methods documented
 *   on Learn (e.g. `Pipeline.Validate`, `PipelineResource.Validate`) are
 *   client-SDK object validators, not REST endpoints, and the ADF Studio
 *   "Validate all" button is a Studio-internal operation with no documented
 *   ARM route under `Microsoft.DataFactory/factories`. There is therefore no
 *   `factories/{f}/validatePipeline` or `pipelines/{name}/validate` endpoint to
 *   call — issuing one returns 404. So the Validate control cannot "POST to ADF
 *   and get a validation verdict".
 *
 *   Per no-vaporware.md, when a real backend REST genuinely cannot exist on the
 *   Azure-native path we implement a GENUINE server-side validation: parse the
 *   pipeline definition and check activities, dependency references, the DAG
 *   acyclicity, and parameter / variable references. The Validate button POSTs
 *   to a BFF route that runs THIS validator server-side — a real server-side
 *   check, not a client-only pretense.
 *
 * Learn grounding for the checks below mirrors ADF's own object validators and
 * pipeline JSON schema:
 *   - Pipeline JSON shape (properties.activities[], parameters{}, variables{}):
 *     https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities
 *   - Activity dependency model (dependsOn[].activity + dependencyConditions:
 *     Succeeded | Failed | Skipped | Completed):
 *     https://learn.microsoft.com/azure/data-factory/tutorial-pipeline-failure-error-handling
 *   - Pipeline expressions (@pipeline().parameters.X, variables('X')):
 *     https://learn.microsoft.com/azure/data-factory/control-flow-expression-language-functions
 */

export interface PipelineValidationIssue {
  /** 'error' fails validation; 'warning' is advisory and does not. */
  severity: 'error' | 'warning';
  /** Stable machine code, e.g. 'DUPLICATE_ACTIVITY_NAME'. */
  code: string;
  /** Human-readable message. */
  message: string;
  /** Activity this issue is attached to, when applicable. */
  activity?: string;
}

export interface PipelineValidationResult {
  ok: boolean;
  issues: PipelineValidationIssue[];
  /** Echo of the activities ADF would see, for the editor's count display. */
  activities: Array<{ name: string; type?: string }>;
  errorCount: number;
  warningCount: number;
}

/** Valid ADF activity dependency conditions. */
const DEPENDENCY_CONDITIONS = new Set(['Succeeded', 'Failed', 'Skipped', 'Completed']);

interface ActivityLike {
  name?: unknown;
  type?: unknown;
  dependsOn?: Array<{ activity?: unknown; dependencyConditions?: unknown }> | unknown;
  typeProperties?: Record<string, unknown> | unknown;
  [key: string]: unknown;
}

interface PipelinePropertiesLike {
  activities?: unknown;
  parameters?: Record<string, unknown> | unknown;
  variables?: Record<string, unknown> | unknown;
}

interface PipelineDefinitionLike {
  name?: unknown;
  properties?: PipelinePropertiesLike | unknown;
}

/**
 * Recursively collect activities including those nested under control-flow
 * containers (ForEach / If / Switch / Until carry child activities under
 * typeProperties). Nested activities share the pipeline's name space in ADF
 * (each container scopes its own dependsOn, but we still flag duplicate names
 * across the whole tree, matching ADF's "duplicate activity name" error).
 */
function collectActivities(activities: ActivityLike[]): ActivityLike[] {
  const out: ActivityLike[] = [];
  const walk = (list: ActivityLike[]) => {
    for (const a of list) {
      if (!a || typeof a !== 'object') continue;
      out.push(a);
      const tp = (a.typeProperties && typeof a.typeProperties === 'object')
        ? (a.typeProperties as Record<string, unknown>)
        : {};
      // ForEach / Until: typeProperties.activities[]
      const nested = tp.activities;
      if (Array.isArray(nested)) walk(nested as ActivityLike[]);
      // If condition: ifTrueActivities / ifFalseActivities
      for (const k of ['ifTrueActivities', 'ifFalseActivities']) {
        if (Array.isArray(tp[k])) walk(tp[k] as ActivityLike[]);
      }
      // Switch: defaultActivities[] + cases[].activities[]
      if (Array.isArray(tp.defaultActivities)) walk(tp.defaultActivities as ActivityLike[]);
      if (Array.isArray(tp.cases)) {
        for (const c of tp.cases as Array<{ activities?: unknown }>) {
          if (c && Array.isArray(c.activities)) walk(c.activities as ActivityLike[]);
        }
      }
    }
  };
  walk(activities);
  return out;
}

/** Extract the `properties` block from either a wrapped or bare definition. */
function extractProperties(def: PipelineDefinitionLike): PipelinePropertiesLike {
  const props = def?.properties;
  if (props && typeof props === 'object' && 'activities' in (props as object)) {
    return props as PipelinePropertiesLike;
  }
  // Bare properties passed directly (the editor sometimes sends
  // { properties } and sometimes the properties object itself).
  if (def && typeof def === 'object' && 'activities' in (def as object)) {
    return def as PipelinePropertiesLike;
  }
  return (props as PipelinePropertiesLike) || {};
}

/**
 * Validate a pipeline definition's structure. Pure + synchronous so it can run
 * server-side in a BFF route and be unit-tested without Azure.
 */
export function validatePipelineSpec(def: PipelineDefinitionLike): PipelineValidationResult {
  const issues: PipelineValidationIssue[] = [];
  const props = extractProperties(def);

  const rawActivities = Array.isArray(props.activities) ? (props.activities as ActivityLike[]) : [];
  if (!Array.isArray(props.activities)) {
    issues.push({
      severity: 'error',
      code: 'MISSING_ACTIVITIES',
      message: 'Pipeline is missing a properties.activities array.',
    });
  }

  const allActivities = collectActivities(rawActivities);
  const echo = allActivities.map((a) => ({
    name: typeof a.name === 'string' ? a.name : '(unnamed)',
    type: typeof a.type === 'string' ? a.type : undefined,
  }));

  // ── Activity-level checks ──
  const seen = new Map<string, number>();
  for (const a of allActivities) {
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    if (!name) {
      issues.push({ severity: 'error', code: 'MISSING_ACTIVITY_NAME', message: 'An activity has no name.' });
    } else {
      seen.set(name, (seen.get(name) || 0) + 1);
    }
    if (!a.type || typeof a.type !== 'string') {
      issues.push({
        severity: 'error',
        code: 'MISSING_ACTIVITY_TYPE',
        message: `Activity "${name || '(unnamed)'}" has no type.`,
        activity: name || undefined,
      });
    }
  }
  for (const [name, count] of seen) {
    if (count > 1) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_ACTIVITY_NAME',
        message: `Duplicate activity name "${name}" (used ${count} times). Activity names must be unique.`,
        activity: name,
      });
    }
  }

  const names = new Set([...seen.keys()]);

  // ── Dependency reference + condition checks (per-container scope for cycle
  //    detection uses the top-level graph, which is where the editor wires) ──
  const topNames = new Set(
    rawActivities
      .map((a) => (typeof a.name === 'string' ? a.name.trim() : ''))
      .filter(Boolean),
  );
  for (const a of allActivities) {
    const name = typeof a.name === 'string' ? a.name.trim() : '(unnamed)';
    const deps = Array.isArray(a.dependsOn) ? (a.dependsOn as Array<{ activity?: unknown; dependencyConditions?: unknown }>) : [];
    for (const d of deps) {
      const target = typeof d?.activity === 'string' ? d.activity.trim() : '';
      if (!target) {
        issues.push({
          severity: 'error', code: 'EMPTY_DEPENDENCY',
          message: `Activity "${name}" has a dependsOn entry with no activity reference.`,
          activity: name,
        });
        continue;
      }
      if (!names.has(target)) {
        issues.push({
          severity: 'error', code: 'UNRESOLVED_DEPENDENCY',
          message: `Activity "${name}" depends on "${target}", which does not exist.`,
          activity: name,
        });
      }
      const conds = Array.isArray(d?.dependencyConditions) ? d.dependencyConditions : [];
      for (const c of conds) {
        if (typeof c !== 'string' || !DEPENDENCY_CONDITIONS.has(c)) {
          issues.push({
            severity: 'error', code: 'INVALID_DEPENDENCY_CONDITION',
            message: `Activity "${name}" has invalid dependency condition "${String(c)}". Allowed: ${[...DEPENDENCY_CONDITIONS].join(', ')}.`,
            activity: name,
          });
        }
      }
    }
  }

  // ── Cycle detection over the TOP-LEVEL graph (the canvas DAG) ──
  const adj = new Map<string, string[]>();
  for (const a of rawActivities) {
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    if (!name) continue;
    const deps = Array.isArray(a.dependsOn) ? (a.dependsOn as Array<{ activity?: unknown }>) : [];
    // edge: dependency -> activity (dependency runs first)
    for (const d of deps) {
      const from = typeof d?.activity === 'string' ? d.activity.trim() : '';
      if (from && topNames.has(from)) {
        adj.set(from, [...(adj.get(from) || []), name]);
      }
    }
    if (!adj.has(name)) adj.set(name, adj.get(name) || []);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  let cycleNode: string | null = null;
  const dfs = (node: string): boolean => {
    color.set(node, GRAY);
    for (const next of adj.get(node) || []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) { cycleNode = next; return true; }
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  };
  for (const node of topNames) {
    if ((color.get(node) ?? WHITE) === WHITE && dfs(node)) break;
  }
  if (cycleNode) {
    issues.push({
      severity: 'error', code: 'DEPENDENCY_CYCLE',
      message: `Activity dependency graph contains a cycle (involving "${cycleNode}"). Pipelines must be acyclic.`,
      activity: cycleNode,
    });
  }

  // ── Parameter / variable reference checks against the declared sets ──
  const declaredParams = new Set(
    props.parameters && typeof props.parameters === 'object'
      ? Object.keys(props.parameters as Record<string, unknown>)
      : [],
  );
  const declaredVars = new Set(
    props.variables && typeof props.variables === 'object'
      ? Object.keys(props.variables as Record<string, unknown>)
      : [],
  );
  const blob = JSON.stringify(rawActivities);

  // @pipeline().parameters.<name>  and  pipeline().parameters['<name>']
  const paramRefs = new Set<string>();
  for (const m of blob.matchAll(/pipeline\(\)\.parameters\.([A-Za-z_][A-Za-z0-9_]*)/g)) paramRefs.add(m[1]);
  for (const m of blob.matchAll(/pipeline\(\)\.parameters\[['"]([^'"]+)['"]\]/g)) paramRefs.add(m[1]);
  for (const p of paramRefs) {
    if (!declaredParams.has(p)) {
      issues.push({
        severity: 'error', code: 'UNDECLARED_PARAMETER',
        message: `Expression references @pipeline().parameters.${p}, but no parameter "${p}" is declared.`,
      });
    }
  }

  // variables('<name>')  used by Set/Append variable + expressions
  const varRefs = new Set<string>();
  for (const m of blob.matchAll(/variables\(\s*['"]([^'"]+)['"]\s*\)/g)) varRefs.add(m[1]);
  // SetVariable / AppendVariable activities carry variableName in typeProperties.
  for (const a of allActivities) {
    const tp = (a.typeProperties && typeof a.typeProperties === 'object')
      ? (a.typeProperties as Record<string, unknown>)
      : {};
    if (typeof tp.variableName === 'string') varRefs.add(tp.variableName);
  }
  for (const v of varRefs) {
    if (!declaredVars.has(v)) {
      issues.push({
        severity: 'warning', code: 'UNDECLARED_VARIABLE',
        message: `Expression references variable "${v}", which is not declared in pipeline variables.`,
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  return {
    ok: errorCount === 0,
    issues,
    activities: echo,
    errorCount,
    warningCount,
  };
}
