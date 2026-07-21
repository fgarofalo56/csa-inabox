/**
 * Microsoft Purview compiler — `PolicyCodeSet` → Data Map classification /
 * sensitivity-marking application descriptors. The classic Purview Data Map
 * (this repo's Purview surface) governs by classification / label / metadata,
 * not by access grant, so a policy statement's `condition.marking` compiles to a
 * "apply classification to asset" op. `reconcile.ts` resolves each asset's guid
 * and calls `addAssetClassification` (real Atlas REST). Access enforcement for a
 * Purview resource is delegated to the serving-engine DENY path (Synapse/UC/ADX
 * resources on the same statement) — Purview marks, the engine enforces.
 *
 * Pure string output; no Azure imports here.
 */

import type { PolicyCodeSet } from '../dsl';
import { type CompiledArtifact, type CompiledOp, dedupeOps } from './types';

export function compilePurview(set: PolicyCodeSet): CompiledArtifact {
  const ops: CompiledOp[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];

  for (const stmt of set.statements) {
    const marking = stmt.condition?.marking?.trim();
    const purviewResources = stmt.resources.filter((r) => r.backend === 'purview');

    if (!marking) {
      if (purviewResources.length) {
        warnings.push(
          `statement "${stmt.id}": Purview resource(s) named but no condition.marking — nothing to classify. ` +
            `Set a marking (sensitivity label / classification) to apply.`,
        );
      }
      continue;
    }
    if (!purviewResources.length) {
      warnings.push(
        `statement "${stmt.id}": marking "${marking}" set but no purview resource to apply it to; skipped.`,
      );
      continue;
    }

    for (const res of purviewResources) {
      ops.push({
        key: `purview:classify:${res.object}:${marking}`,
        kind: 'classification',
        // Descriptor form — the reconcile loop resolves the asset guid and calls
        // addAssetClassification(guid, [marking]).
        statement: `APPLY CLASSIFICATION ${JSON.stringify(marking)} TO ASSET ${JSON.stringify(res.object)}`,
        target: res.object,
        principals: stmt.principals.map((p) => p.id),
        from: stmt.id,
      });
      summary.push(`Classification: "${marking}" → ${res.object}`);
    }
  }

  const deduped = dedupeOps(ops);
  return { backend: 'purview', applicable: deduped.length > 0, ops: deduped, warnings, summary };
}
