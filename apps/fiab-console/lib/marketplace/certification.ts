/**
 * WS-10.4 Living Marketplace — publish pipeline = AUTO-CERTIFICATION.
 *
 * Publishing a product is not a claim: it RUNS the existing platform gate
 * registry (`lib/gates/registry`) for the capabilities the product's kind
 * depends on. A product earns `certified` ONLY when every required gate
 * evaluates `configured` (real env-presence check the whole platform gates on).
 * If any required gate is `blocked`, certification is `failed` and the receipt
 * carries the exact missing env vars — an honest remediation, never a fake cert.
 *
 * This keeps the marketplace honest per no-vaporware/G1: a "certified,
 * subscribable" agent means the AOAI backend the agent runs on is actually
 * configured; a certified data product means its lake backend is wired.
 *
 * The core `evaluateCertification` is PURE (takes gate results in) so both the
 * pass and fail paths are unit-tested deterministically; `runCertification`
 * is the thin wrapper that pulls REAL live gate statuses from the registry.
 */
import type { ProductKind, CertGateResult, CertificationStatus } from './product-types';
import { gateStatus, getGate, type GateStatus } from '@/lib/gates/registry';

/**
 * Which platform gates must be `configured` for a product of each kind to
 * certify. Mapped to the real `svc-*` gate ids in the registry. Kinds with an
 * empty list (app, ontology) certify on the always-present console/Cosmos
 * substrate — they have no external backend gate, so they are certifiable by
 * default (default-ON), which is exactly why the acceptance can publish an
 * ontology as certified with no extra infra.
 */
export const KIND_REQUIRED_GATES: Record<ProductKind, string[]> = {
  data: ['svc-adls'],          // a data product serves from ADLS/Delta output ports
  agent: ['svc-aoai'],         // an agent-flow runs on Azure OpenAI
  mcp: ['svc-mcp-catalog'],    // an MCP server is deployed from the MCP catalog
  app: [],                     // a loom-app runs on the console/Cosmos substrate
  ontology: [],                // an ontology is served from the graph/semantic substrate
};

export interface CertificationResult {
  certification: CertificationStatus;
  requiredGateIds: string[];
  gates: CertGateResult[];
  /** Convenience: the blocked gates' first missing var, for the UI note. */
  blockers: string[];
}

/**
 * PURE certification evaluation. Given the required gate ids and the resolved
 * status of each, decide the certification and build the receipt.
 *
 * - zero required gates  → certified (nothing to block; default-ON substrate)
 * - all configured       → certified
 * - any blocked          → failed, with the honest missing-var receipt
 */
export function evaluateCertification(
  requiredGateIds: string[],
  statuses: Array<Pick<GateStatus, 'id' | 'status' | 'missing'> & { title?: string }>,
): CertificationResult {
  const gates: CertGateResult[] = requiredGateIds.map((id) => {
    const st = statuses.find((s) => s.id === id);
    return {
      gateId: id,
      title: st?.title || id,
      status: st?.status === 'configured' ? 'configured' : 'blocked',
      missing: st?.missing || [],
    };
  });
  const blocked = gates.filter((g) => g.status === 'blocked');
  const certification: CertificationStatus = blocked.length === 0 ? 'certified' : 'failed';
  const blockers = blocked.flatMap((g) => g.missing).filter(Boolean);
  return { certification, requiredGateIds, gates, blockers };
}

/**
 * Run auto-certification against the LIVE gate registry for a product kind.
 * Real: each `gateStatus(id)` re-evaluates the env-presence the platform gates
 * on (one cheap in-process pass, no network).
 */
export function runCertification(kind: ProductKind): CertificationResult {
  const requiredGateIds = KIND_REQUIRED_GATES[kind] || [];
  const statuses = requiredGateIds.map((id) => {
    const st = gateStatus(id);
    return {
      id,
      status: (st?.status || 'blocked') as 'configured' | 'blocked',
      missing: st?.missing || [],
      title: getGate(id)?.title || id,
    };
  });
  return evaluateCertification(requiredGateIds, statuses);
}
