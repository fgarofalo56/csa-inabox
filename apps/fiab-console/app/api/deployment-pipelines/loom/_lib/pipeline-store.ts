/**
 * Shared store helpers for the Loom-native deployment-pipeline routes.
 *
 * All reads/writes are Cosmos-only (no Fabric / Power BI). Ownership is always
 * scoped by the caller's tenant (oid): a pipeline doc is PK'd by /tenantId, and
 * every workspace a stage points at is verified to belong to the tenant before
 * its items are read or written.
 */
import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import {
  loomPipelinesContainer,
  pipelineStageRulesContainer,
  workspacesContainer,
} from '@/lib/azure/cosmos-client';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { isValidInternalToken, INTERNAL_USER_OID_HEADER } from '@/lib/auth/internal-token';
import type {
  LoomPipeline, LoomDeployRule, LoomPipelineStageRulesDoc,
  LoomApprovalPolicyDoc, LoomApprovalRequest, LoomApprover,
} from '@/lib/types/loom-pipeline';
import type { Workspace } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export function jok(data: unknown, status = 200) {
  return NextResponse.json({ ok: true, data }, { status });
}
export function jerr(error: string, status = 500, code?: string) {
  return apiError(error, status, code ? { code } : undefined);
}

// ---------------------------------------------------------------------------
// Caller resolution — cookie session OR headless CI Bearer token.
//
// These routes back the Loom-native parity for Fabric "deployment pipelines".
// To match Fabric's CI/CD story (the `ms-fabric.fabric-devops-pipelines` Azure
// DevOps task, Build 2026 #31), a headless agent (Azure DevOps / GitHub
// Actions) must be able to drive them. An ADO agent cannot present the
// encrypted `loom_session` cookie, so we accept a Bearer token IN ADDITION to
// the cookie session — the SAME dual-auth pattern /api/iq/mcp already uses for
// external agents.
//
// The token path is OFF by default (`LOOM_PIPELINE_CI_ENABLED !== 'true'`) and
// FAILS CLOSED. When enabled, the presented Bearer must match `LOOM_CI_TOKEN`
// (preferred — lets operators isolate CI from the broader internal-trust
// secret) or, when that is unset, the shared `LOOM_INTERNAL_TOKEN` Bicep wires.
// The acting tenant comes from the `x-user-oid` header. No Fabric / Power BI
// dependency is introduced — the token reaches only the tenant's own Console.
// ---------------------------------------------------------------------------

/** Constant-time compare of a presented secret against an expected value.
 * Hashes both sides so `timingSafeEqual` always sees equal-length buffers and
 * the secret length never leaks. Returns false when either side is empty. */
function constantTimeEqual(presented: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || !presented) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf-8').digest();
  const b = crypto.createHash('sha256').update(presented, 'utf-8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** Validate the CI Bearer against LOOM_CI_TOKEN (preferred) or the shared
 * LOOM_INTERNAL_TOKEN fallback. Both fail closed when their env var is unset. */
function isValidCiToken(presented: string | null): boolean {
  const dedicated = process.env.LOOM_CI_TOKEN;
  if (dedicated) return constantTimeEqual(presented, dedicated);
  return isValidInternalToken(presented);
}

export interface ResolvedCaller {
  /** Tenant (oid) the request acts as — partition key for every pipeline doc. */
  tenantId: string;
  /** How the caller authenticated. */
  mode: 'session' | 'token';
  /** A real (cookie) or synthetic (CI-token) session payload, usable by the
   *  item-crud helpers and provisioners the deploy route invokes. */
  session: SessionPayload;
  /** Audit string for createdBy / startedBy / updatedBy. */
  actor: string;
}

/**
 * Resolve the calling principal for a deployment-pipeline route.
 *   1. Cookie session (Console user / the "Deploy" button) — always allowed.
 *   2. Bearer token (headless CI) — only when LOOM_PIPELINE_CI_ENABLED=true.
 * Returns null when neither credential is valid (the route then 401s).
 */
export function resolveCaller(req: NextRequest): ResolvedCaller | null {
  // 1. Cookie session — the interactive Console path.
  const s = getSession();
  if (s?.claims?.oid) {
    return {
      tenantId: s.claims.oid,
      mode: 'session',
      session: s,
      actor: s.claims.upn || s.claims.email || s.claims.oid,
    };
  }

  // 2. Headless CI Bearer token — off by default, fails closed.
  if (process.env.LOOM_PIPELINE_CI_ENABLED !== 'true') return null;
  const authz = req.headers.get('authorization') || '';
  const bearer = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null;
  if (!isValidCiToken(bearer)) return null;
  const oid = (req.headers.get(INTERNAL_USER_OID_HEADER) || '').trim();
  if (!oid) return null;

  // Synthesize a minimal session for item-crud / provisioners. Provisioners are
  // Managed-Identity-backed (the Console UAMI does the Azure work), so no user
  // OBO token is required — the synthetic session only carries identity claims
  // used for tenant scoping + audit.
  const synthetic: SessionPayload = {
    claims: { oid, name: 'Loom CI (pipeline token)', upn: `ci-pipeline@${oid}` },
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  return { tenantId: oid, mode: 'token', session: synthetic, actor: `ci-pipeline:${oid}` };
}

/** Point-read a pipeline owned by the tenant. Returns null when missing. */
export async function loadPipeline(tenantId: string, id: string): Promise<LoomPipeline | null> {
  const c = await loomPipelinesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<LoomPipeline>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** List every pipeline owned by the tenant (newest first). */
export async function listPipelines(tenantId: string): Promise<LoomPipeline[]> {
  const c = await loomPipelinesContainer();
  const { resources } = await c.items
    .query<LoomPipeline>(
      { query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC', parameters: [{ name: '@t', value: tenantId }] },
      { partitionKey: tenantId },
    )
    .fetchAll();
  return resources || [];
}

/** Confirm a workspace belongs to the tenant; returns it (or null). */
export async function ownedWorkspace(tenantId: string, workspaceId: string): Promise<Workspace | null> {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Resolve a stage id → its bound workspace id within a pipeline. */
export function stageWorkspaceId(pipeline: LoomPipeline, stageId: string): string | undefined {
  return pipeline.stages.find((s) => s.id === stageId)?.workspaceId;
}

const rulesDocId = (pipelineId: string, stageId: string) => `rules:${pipelineId}:${stageId}`;

/** Load a stage's deployment rules ([] when none configured). */
export async function loadStageRules(pipelineId: string, stageId: string): Promise<LoomDeployRule[]> {
  const c = await pipelineStageRulesContainer();
  try {
    const { resource } = await c.item(rulesDocId(pipelineId, stageId), pipelineId).read<LoomPipelineStageRulesDoc>();
    return resource?.rules || [];
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}

/** Upsert a stage's deployment rules. */
export async function saveStageRules(
  pipelineId: string,
  stageId: string,
  rules: LoomDeployRule[],
  updatedBy: string,
): Promise<LoomDeployRule[]> {
  const c = await pipelineStageRulesContainer();
  const doc: LoomPipelineStageRulesDoc = {
    id: rulesDocId(pipelineId, stageId),
    pipelineId,
    stageId,
    rules,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await c.items.upsert(doc);
  return rules;
}

// ---------------------------------------------------------------------------
// BR-APPROVAL — required-reviewer promotion gates.
//
// The approval policy (per stage) and the request lifecycle share the
// `pipeline-stage-rules` container (PK /pipelineId), discriminated by `docType`
// and an id prefix — so no new Cosmos container / bicep param is added. Policies
// are point-read by id; requests are point-read by id AND listed per-pipeline
// with a partitioned query filtered on docType.
// ---------------------------------------------------------------------------

const approvalPolicyDocId = (pipelineId: string, stageId: string) => `approval-policy:${pipelineId}:${stageId}`;

/** Load a stage's approval policy (null when never configured). */
export async function loadApprovalPolicy(pipelineId: string, stageId: string): Promise<LoomApprovalPolicyDoc | null> {
  const c = await pipelineStageRulesContainer();
  try {
    const { resource } = await c.item(approvalPolicyDocId(pipelineId, stageId), pipelineId).read<LoomApprovalPolicyDoc>();
    if (!resource || resource.docType !== 'approval-policy') return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Upsert a stage's approval policy. */
export async function saveApprovalPolicy(
  pipelineId: string,
  stageId: string,
  policy: { enabled: boolean; requiredApprovals: number; approvers: LoomApprover[] },
  updatedBy: string,
): Promise<LoomApprovalPolicyDoc> {
  const c = await pipelineStageRulesContainer();
  const doc: LoomApprovalPolicyDoc = {
    id: approvalPolicyDocId(pipelineId, stageId),
    docType: 'approval-policy',
    pipelineId,
    stageId,
    enabled: policy.enabled,
    requiredApprovals: policy.requiredApprovals,
    approvers: policy.approvers,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await c.items.upsert(doc);
  return doc;
}

/** Create a new pending approval request. */
export async function createApprovalRequest(request: LoomApprovalRequest): Promise<LoomApprovalRequest> {
  const c = await pipelineStageRulesContainer();
  await c.items.create(request);
  return request;
}

/** Point-read an approval request scoped to its pipeline (null when missing). */
export async function loadApprovalRequest(pipelineId: string, requestId: string): Promise<LoomApprovalRequest | null> {
  const c = await pipelineStageRulesContainer();
  try {
    const { resource } = await c.item(requestId, pipelineId).read<LoomApprovalRequest>();
    if (!resource || resource.docType !== 'approval-request' || resource.pipelineId !== pipelineId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** List a pipeline's approval requests (newest first), optionally by status. */
export async function listApprovalRequests(
  pipelineId: string,
  opts: { status?: LoomApprovalRequest['status'] } = {},
): Promise<LoomApprovalRequest[]> {
  const c = await pipelineStageRulesContainer();
  const params: Array<{ name: string; value: string }> = [{ name: '@p', value: pipelineId }];
  let query = "SELECT * FROM c WHERE c.pipelineId = @p AND c.docType = 'approval-request'";
  if (opts.status) {
    query += ' AND c.status = @s';
    params.push({ name: '@s', value: opts.status });
  }
  query += ' ORDER BY c.createdAt DESC';
  const { resources } = await c.items
    .query<LoomApprovalRequest>({ query, parameters: params }, { partitionKey: pipelineId })
    .fetchAll();
  return resources || [];
}

/** Upsert an updated approval request. */
export async function saveApprovalRequest(request: LoomApprovalRequest): Promise<LoomApprovalRequest> {
  const c = await pipelineStageRulesContainer();
  await c.items.upsert(request);
  return request;
}
