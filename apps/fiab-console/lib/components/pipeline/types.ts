/**
 * Shared pipeline DAG types — kept in a leaf module so palette, canvas,
 * properties-panel, and the editor don't have circular imports.
 */

export interface PipelineActivityRef {
  activity: string;
  dependencyConditions?: string[];
}

export interface PipelineActivity {
  name: string;
  type?: string;
  description?: string;
  dependsOn?: PipelineActivityRef[];
  typeProperties?: Record<string, unknown>;
  linkedServiceName?: { referenceName: string; type: string };
  inputs?: unknown[];
  outputs?: unknown[];
  policy?: Record<string, unknown>;
  userProperties?: Array<{ name: string; value: unknown }>;
  // Compound shapes carry nested activities[] under typeProperties; we
  // surface them via the catalog rather than the type.
  [key: string]: unknown;
}

export type PipelineParameterType = 'string' | 'int' | 'float' | 'bool' | 'array' | 'object' | 'secureString';

export interface PipelineParameter {
  name: string;
  type: PipelineParameterType;
  defaultValue?: unknown;
}

export interface PipelineVariable {
  name: string;
  type: 'String' | 'Boolean' | 'Array';
  defaultValue?: unknown;
}

export interface PipelineSettings {
  description?: string;
  concurrency?: number;
  annotations?: string[];
}

/** Top-level pipeline JSON shape (matches ADF / Synapse / Fabric). */
export interface PipelineSpec {
  name?: string;
  properties: {
    description?: string;
    activities: PipelineActivity[];
    parameters?: Record<string, { type: string; defaultValue?: unknown }>;
    variables?: Record<string, { type: string; defaultValue?: unknown }>;
    annotations?: unknown[];
    concurrency?: number;
    folder?: { name: string };
    policy?: unknown;
  };
}

/** Convert a spec to/from the JSON text the editor edits. */
export function specToText(spec: PipelineSpec): string {
  return JSON.stringify(spec, null, 2);
}

export function textToSpec(text: string): PipelineSpec | null {
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.properties) obj.properties = { activities: [] };
    if (!Array.isArray(obj.properties.activities)) obj.properties.activities = [];
    return obj as PipelineSpec;
  } catch {
    return null;
  }
}

/** Convert paramRecord (ADF wire format) to flat array for editor UI. */
export function paramsFromSpec(spec: PipelineSpec): PipelineParameter[] {
  const out: PipelineParameter[] = [];
  const p = spec.properties.parameters || {};
  for (const [name, def] of Object.entries(p)) {
    out.push({ name, type: (def.type as PipelineParameterType) || 'string', defaultValue: def.defaultValue });
  }
  return out;
}

export function paramsToSpec(params: PipelineParameter[]): Record<string, { type: string; defaultValue?: unknown }> {
  const out: Record<string, { type: string; defaultValue?: unknown }> = {};
  for (const p of params) {
    if (!p.name) continue;
    out[p.name] = { type: p.type, defaultValue: p.defaultValue };
  }
  return out;
}

export function varsFromSpec(spec: PipelineSpec): PipelineVariable[] {
  const out: PipelineVariable[] = [];
  const v = spec.properties.variables || {};
  for (const [name, def] of Object.entries(v)) {
    out.push({ name, type: (def.type as PipelineVariable['type']) || 'String', defaultValue: def.defaultValue });
  }
  return out;
}

export function varsToSpec(vars: PipelineVariable[]): Record<string, { type: string; defaultValue?: unknown }> {
  const out: Record<string, { type: string; defaultValue?: unknown }> = {};
  for (const v of vars) {
    if (!v.name) continue;
    out[v.name] = { type: v.type, defaultValue: v.defaultValue };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pipeline runtime model — single source of truth (Wave A, Contract A)
//
// This type lives here, in the leaf DAG-types module (no React / no Azure-SDK
// deps), so BOTH the unified DataPipelineEditor and PipelineEditorCore can
// import it without creating an import cycle. The runtime selector, the
// bind/run/save apiBase resolution, and the per-runtime backend-client choice
// (adf-client / synapse-dev-client / Fabric routes) all key off this shape.
//
// Per .claude/rules/no-fabric-dependency.md: 'adf' (Azure-native ADF) is the
// DEFAULT. 'synapse' is the Azure-native Synapse path. 'fabric' is STRICTLY
// opt-in — selectable ONLY when a Fabric workspace is bound; it is never
// auto-selected and no code path may gate on fabricWorkspaceId.
// ---------------------------------------------------------------------------

/** Backend that authors/executes the pipeline. Azure-native ('adf'|'synapse') by default; 'fabric' is opt-in only. */
export type PipelineRuntime = 'adf' | 'synapse' | 'fabric';

/** Resolved backend context the unified editor carries while authoring/binding/running a pipeline. */
export interface PipelineRuntimeContext {
  /** Selected backend. */
  runtime: PipelineRuntime;
  /** ADF-standalone factory ARM id when runtime==='adf' and operator chose a non-default factory. */
  factory?: { id: string; name: string; subscriptionId: string; resourceGroup: string } | null;
  /** Synapse workspace name when runtime==='synapse'. */
  synapseWorkspace?: string | null;
  /** Fabric workspace id when runtime==='fabric' (opt-in only). */
  fabricWorkspaceId?: string | null;
}

/** Azure-native default backend per no-fabric-dependency.md. Never default to 'fabric'. */
export const DEFAULT_PIPELINE_RUNTIME: PipelineRuntime = 'adf';
