/**
 * N4 — shared project resolver for the `/api/transform/[id]/**` BFF routes.
 *
 * Ownership is enforced by the route itself via `withWorkspaceOwner` (the
 * route-toolkit wrapper that runs the exact `loadOwnedItem` owner/workspace-ACL
 * check), so this helper receives the ALREADY-OWNED item and only does the
 * project work: validate the graph, reject dangling refs, resolve the backend
 * selector, and generate the real project files for that engine.
 */

import { apiError } from '@/lib/api/respond';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  generateTransformProject, runnerEnv, type GeneratedFile,
} from '@/lib/transform/transform-codegen';
import {
  findDanglingRefs, resolveTransformBackend, validateTransformProject,
  type TransformBackend, type TransformProject,
} from '@/lib/transform/transform-project-model';

export const TRANSFORM_ITEM_TYPE = 'transformation-project';

export interface TransformContext {
  itemId: string;
  project: TransformProject;
  backend: TransformBackend;
  files: GeneratedFile[];
  env: Record<string, string>;
  /** The environment the caller asked for, defaulted from the project. */
  environment: string;
}

interface Body {
  environment?: unknown;
  /** Optional in-flight project override so the wizard can plan unsaved edits. */
  project?: unknown;
}

/**
 * Resolve the owned item + request body into a ready-to-run context, or a
 * Response describing the exact problem (400 field-level validation, 400
 * dangling refs) — never an unguarded throw (the dbt-job B10 lesson).
 */
export function resolveTransformContext(
  item: WorkspaceItem,
  body: unknown,
): TransformContext | Response {
  const b = (body ?? {}) as Body;
  const state = (item.state ?? {}) as { project?: unknown };
  const raw = (b.project && typeof b.project === 'object') ? b.project : state.project;

  const errors = validateTransformProject(raw);
  if (errors.length) {
    return apiError(
      `Invalid transformation project: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`,
      400,
      { code: 'invalid_project', errors },
    );
  }
  const project = raw as TransformProject;
  const dangling = findDanglingRefs(project);
  if (dangling.length) {
    return apiError(
      `Model graph has unresolved refs: ${dangling.map((d) => `${d.model}→${d.ref}`).join(', ')}. Add the referenced models or remove the ref.`,
      400,
      { code: 'dangling_refs', dangling },
    );
  }

  const backend = resolveTransformBackend({ project });
  const environment = typeof b.environment === 'string' && b.environment.trim()
    ? b.environment.trim()
    : (project.defaultEnvironment || 'dev');

  return {
    itemId: item.id,
    project: { ...project, backend },
    backend,
    files: generateTransformProject({ ...project, backend }),
    env: runnerEnv(project),
    environment,
  };
}

/** Narrowing helper — `resolveTransformContext` returns either shape. */
export function isResponse(v: TransformContext | Response): v is Response {
  return v instanceof Response;
}
