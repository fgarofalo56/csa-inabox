/**
 * Shared deploy-plan types — imported by both the client planner and the
 * server route so neither pulls the other across the client/server boundary.
 */

/** A scalar config value the user can set on a planned resource. */
export type ConfigValue = string | number;

/**
 * Per-service resource configuration, keyed by the catalog ConfigField.key.
 * Stored at the SUBSCRIPTION level because bicep deploys one instance of each
 * toggleable service per subscription (single-sub deploymentMode), so its
 * SKU/tier/runtime is a subscription-scoped choice — matching how the emitter
 * unions service flags across a subscription's domains.
 */
export type ServiceConfig = Record<string, ConfigValue>;

/** A dependency arrow drawn between two planned service nodes on the canvas. */
export interface PlanEdge {
  /** React Flow source node id (svc:<si>:<di>:<key>). */
  from: string;
  /** React Flow target node id (svc:<si>:<di>:<key>). */
  to: string;
}

export interface PlanDomain {
  domainId: string;
  name: string;
  services: string[]; // service-catalog keys
}

export interface PlanSubscription {
  id: string;
  name: string;
  boundary?: 'Commercial' | 'GCC-High' | 'GCC' | 'IL5';
  region?: string;
  domains: PlanDomain[];
  /**
   * Per-resource configuration, keyed by service-catalog key → field map.
   * Only toggleable services with a catalog `config` schema carry values; the
   * emitter writes these as real main.bicep params (SKU/tier/runtime).
   */
  serviceConfigs?: Record<string, ServiceConfig>;
  /** Dependency arrows between planned service nodes (plan metadata). */
  edges?: PlanEdge[];
}
