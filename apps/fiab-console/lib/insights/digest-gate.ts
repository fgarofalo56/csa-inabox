/**
 * B-N19d — the delivery-gate block shared by every digest BFF route + the pane.
 *
 * A digest is delivered by the EXISTING C5 report-subscriptions timer Function,
 * so it shares that feature's gate (`svc-report-subscriptions`: the timer
 * Function + the delivery Logic App). Definitions still SAVE when the gate is
 * unmet — the pane renders an honest Fix-it banner and delivery begins the
 * moment the infra lands (G2: gate registered, Fix-it inline, Admin gate page).
 */
import { gateStatus, getGate } from '@/lib/gates/registry';
import { gateFixItHref } from '@/lib/api/gate-envelope';

/** The delivery gate a digest shares with C5 report subscriptions. */
export const DIGEST_DELIVERY_GATE_ID = 'svc-report-subscriptions';

export interface DigestDeliveryGate {
  id: string;
  title: string;
  remediation: string;
  missing: string[];
  fixItHref: string;
}

/** Live delivery-gate block, or null when delivery infra is fully configured. */
export function deliveryGateBlock(): DigestDeliveryGate | null {
  const status = gateStatus(DIGEST_DELIVERY_GATE_ID);
  const gate = getGate(DIGEST_DELIVERY_GATE_ID);
  if (!status || !gate || status.status === 'configured') return null;
  return {
    id: DIGEST_DELIVERY_GATE_ID,
    title: gate.title,
    remediation: gate.remediation,
    missing: status.missing,
    fixItHref: gateFixItHref(DIGEST_DELIVERY_GATE_ID),
  };
}
