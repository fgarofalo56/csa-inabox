/** API Gateway Plane - brownfield APIM discovery (W1-9). Result shapes. */

export type ApimNetworkMode = 'None' | 'External' | 'Internal' | 'unknown';

export interface DiscoveredAccess {
  canRead: boolean;
  canWrite: boolean;
  /** Same meaning as GatewayAccess.source; 'unavailable' = the check itself could not run. */
  source: 'permissions' | 'probe' | 'unavailable';
}

export interface DiscoveryCandidate {
  resourceId: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  sku: string;
  location: string;
  networkMode: ApimNetworkMode;
  access: DiscoveredAccess;
  alreadyRegistered: boolean;
  /** Id of the existing registry record when alreadyRegistered. */
  registeredGatewayId?: string;
  /** Plain statement of what registering this candidate would do (observe mode). */
  observeSummary: string;
}

export interface DiscoveryFailure {
  /** 'subscriptions' = the subscription list itself; otherwise the subscription id; or a service resource id for an access check. */
  scope: string;
  kind: 'subscription-list' | 'service-list' | 'access-check';
  /** Real ARM HTTP status, or 0 when the call threw before a response. */
  status: number;
  reason: string;
}

export interface DiscoveryResult {
  candidates: DiscoveryCandidate[];
  subscriptionsScanned: number;
  /** True when ANY read failed. Absence in a partial result is not evidence of absence. */
  partial: boolean;
  failures: DiscoveryFailure[];
  scannedAt: string;
}
