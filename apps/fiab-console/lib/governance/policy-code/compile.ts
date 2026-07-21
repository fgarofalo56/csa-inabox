/**
 * Governance-as-Code — the one-pass compiler. Runs EVERY per-backend compiler
 * over a single `PolicyCodeSet` and returns the compiled artifacts. This is the
 * "one policy set compiles to ≥ 4 backends in one pass" acceptance surface
 * (WS-10.2 / BTB-8). Pure — no Azure imports; unit-tested.
 */

import type { PolicyBackend, PolicyCodeSet } from './dsl';
import { validatePolicyCodeSet, type PolicyValidation } from './dsl';
import type { CompiledArtifact } from './compilers/types';
import { compileSynapse } from './compilers/synapse';
import { compileUnityCatalog, type UcCompileOptions } from './compilers/unity-catalog';
import { compileAdx, type AdxCompileOptions } from './compilers/adx';
import { compilePurview } from './compilers/purview';
import { compileApiScope } from './compilers/api-scope';

export interface CompileOptions extends UcCompileOptions, AdxCompileOptions {}

export interface CompileResult {
  validation: PolicyValidation;
  artifacts: CompiledArtifact[];
  /** Backends that produced at least one op (the "compiles to N backends" count). */
  compiledBackends: PolicyBackend[];
  totalOps: number;
  warnings: string[];
}

/** Compile the set for every backend in one pass. */
export function compileAll(set: PolicyCodeSet, opts: CompileOptions = {}): CompileResult {
  const validation = validatePolicyCodeSet(set);
  const artifacts: CompiledArtifact[] = [
    compileSynapse(set),
    compileUnityCatalog(set, opts),
    compileAdx(set, opts),
    compilePurview(set),
    compileApiScope(set),
  ];
  const compiledBackends = artifacts.filter((a) => a.applicable).map((a) => a.backend);
  const totalOps = artifacts.reduce((n, a) => n + a.ops.length, 0);
  const warnings = artifacts.flatMap((a) => a.warnings);
  return { validation, artifacts, compiledBackends, totalOps, warnings };
}

/** Convenience — the compiled artifact for one backend (or an empty one). */
export function artifactFor(result: CompileResult, backend: PolicyBackend): CompiledArtifact {
  return result.artifacts.find((a) => a.backend === backend) ?? {
    backend,
    applicable: false,
    ops: [],
    warnings: [],
    summary: [],
  };
}
