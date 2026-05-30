/**
 * Shared deploy-plan types — imported by both the client planner and the
 * server route so neither pulls the other across the client/server boundary.
 */

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
}
