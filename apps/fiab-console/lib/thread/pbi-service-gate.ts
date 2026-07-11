/**
 * pbi-service-gate — PURE decision helpers for the real Power BI Service
 * destination of the Weave → Power BI edge (`analyze-in-powerbi`, W5).
 *
 * The `analyze-in-powerbi` route lets the user pick, per click, WHERE the new
 * Power BI item lands (operator decision D1):
 *   - `loom-native`      (default) — built over the Azure-native backend, no
 *      Power BI / Fabric workspace required (no-fabric-dependency.md). W1.
 *   - `power-bi-service` (opt-in)  — published as a REAL Power BI item into the
 *      operator's bound workspace (LOOM_PBI_WORKSPACE_ID) over a
 *      Fabric/Premium capacity (LOOM_PBI_CAPACITY_ID), authenticated as the
 *      signed-in user (OBO passthrough), routed to PE-only sources through the
 *      Loom data gateway (W4). W5.
 *
 * These helpers own every GATE DECISION for the real-PBI path so they are pure
 * and unit-testable with mocked env / workspace / gateway state (no live Power
 * BI). Per no-vaporware.md every gate names the EXACT env var / grant /
 * registration the operator must supply — never a fabricated success.
 *
 * The route (analyze-in-powerbi/route.ts) does the live REST orchestration and
 * delegates the "should this proceed / what should we say" questions here.
 */

import type { PbiSourceBinding } from '@/lib/azure/pbi-source-resolver';

/** The two destinations the user picks per click (D1). */
export type PbiDestination = 'loom-native' | 'power-bi-service';

/** Normalize the wizard's `destination` value; anything but the opt-in real
 *  path resolves to the Azure-native default (so a missing/garbage value is
 *  never accidentally the Power BI path). */
export function resolveDestination(raw: unknown): PbiDestination {
  return String(raw ?? '').trim() === 'power-bi-service' ? 'power-bi-service' : 'loom-native';
}

/** The bound-workspace configuration the real-PBI path needs (D3). */
export interface PbiServiceConfig {
  /** LOOM_PBI_WORKSPACE_ID — the Power BI workspace to publish into. */
  workspaceId: string;
  /** LOOM_PBI_CAPACITY_ID — the Fabric/Premium (F/P SKU) capacity backing it. */
  capacityId: string;
}

/** Read the real-PBI destination config from the environment (trimmed). */
export function readPbiServiceConfig(
  env: Record<string, string | undefined> = process.env,
): PbiServiceConfig {
  return {
    workspaceId: (env.LOOM_PBI_WORKSPACE_ID || '').trim(),
    capacityId: (env.LOOM_PBI_CAPACITY_ID || '').trim(),
  };
}

/**
 * Honest gate when the real Power BI Service destination is not fully
 * configured. Returns the verbatim remediation string (naming the exact env
 * vars) — or `null` when both the workspace and capacity are bound and the
 * path may proceed.
 */
export function pbiServiceConfigGate(cfg: PbiServiceConfig): string | null {
  const missing: string[] = [];
  if (!cfg.workspaceId) missing.push('LOOM_PBI_WORKSPACE_ID (the bound Power BI workspace id)');
  if (!cfg.capacityId) missing.push('LOOM_PBI_CAPACITY_ID (the Fabric/Premium capacity id)');
  if (missing.length === 0) return null;
  return (
    'The real Power BI Service destination is not configured for this deployment. ' +
    `Set ${missing.join(' and ')} on the Console app, then retry. ` +
    'Until then, choose the “Loom-native” destination — it builds the same item over the ' +
    'Azure-native backend (Synapse serverless / dedicated or Azure Data Explorer) with no ' +
    'Power BI workspace required.'
  );
}

/**
 * Minimal, mockable view of the gateway state the gate decision needs — a pure
 * subset of `network-discovery.PbiVmGatewayStatus` PLUS the gateways Power BI
 * reports as registered (from `powerbi-client.listGateways`). The route builds
 * this from the two live reads; the gate logic below stays pure.
 */
export interface GatewayState {
  /** The Loom on-prem gateway VM is deployed (ARM). */
  vmFound: boolean;
  /** …and running (its agent can be up). */
  vmRunning: boolean;
  /** Recommended gateway given mode + capacity binding ('vnet' once a capacity binds). */
  recommendedMode: 'vm' | 'vnet';
  /** A Fabric/Premium capacity is bound (LOOM_PBI_CAPACITY_ID set). */
  capacityBound: boolean;
  /** The one manual register-to-tenant step Loom cannot perform. */
  registrationNote: string;
  /** Gateway ids Power BI reports as registered/bindable (listGateways). */
  registeredGatewayIds: string[];
}

/**
 * Does this source require a data gateway on the real-PBI path? Only backends
 * reachable ONLY over a private endpoint do (Synapse serverless / dedicated).
 * ADX is public by default, so it needs no gateway.
 */
export function sourceNeedsGateway(binding: Pick<PbiSourceBinding, 'behindPrivateEndpoint'>): boolean {
  return !!binding.behindPrivateEndpoint;
}

/**
 * Honest gate when a PE-only source has no registered Power BI data gateway to
 * route through (W4's one-time tenant registration is still pending). Returns
 * the verbatim remediation, or `null` when no gateway is needed OR a registered
 * gateway already exists.
 */
export function gatewayGate(needsGateway: boolean, gw: GatewayState): string | null {
  if (!needsGateway) return null;
  if (gw.registeredGatewayIds.length > 0) return null;

  const vm = gw.vmFound
    ? gw.vmRunning
      ? 'The Loom on-prem data-gateway VM is deployed and running, but it is not yet registered in the Power BI tenant. '
      : 'The Loom on-prem data-gateway VM is deployed but not running — start it, then register it. '
    : 'No Loom data-gateway VM was found — deploy platform/fiab/bicep/modules/admin-plane/pbi-vm-data-gateway.bicep (default-on), then register it. ';
  const upgrade =
    gw.recommendedMode === 'vnet'
      ? 'Because a Fabric/Premium capacity is bound, the managed VNet data gateway is preferred (LOOM_PBI_GATEWAY_MODE=auto). '
      : '';
  return (
    'This source is only reachable over a private endpoint, so Power BI must route through a ' +
    'registered data gateway, but none is registered in the Power BI tenant yet. ' +
    vm +
    upgrade +
    gw.registrationNote
  );
}

/**
 * Pick the gateway id to bind the published model to. Prefers a gateway whose
 * name matches the recommended mode when the caller supplies names; otherwise
 * the first registered gateway. (Power BI's DiscoverGateways / gateway list is
 * the source of truth for what is actually bindable.)
 */
export function pickActiveGatewayId(gw: GatewayState): string | undefined {
  return gw.registeredGatewayIds[0];
}

/**
 * Build the `app.powerbi.com` (sovereign-aware host passed in) deep link for a
 * created Power BI artifact so the Weave result can open it in the service.
 */
export function powerBiItemLink(
  host: string,
  workspaceId: string,
  kind: 'dataset' | 'report' | 'dashboard',
  itemId: string,
): string {
  const base = `${host.replace(/\/+$/, '')}/groups/${encodeURIComponent(workspaceId)}`;
  if (kind === 'dataset') return `${base}/datasets/${encodeURIComponent(itemId)}/details`;
  if (kind === 'dashboard') return `${base}/dashboards/${encodeURIComponent(itemId)}`;
  return `${base}/reports/${encodeURIComponent(itemId)}`;
}
