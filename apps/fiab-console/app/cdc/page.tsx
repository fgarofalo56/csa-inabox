/**
 * /cdc — Debezium CDC connector control plane (N7b).
 *
 * Thin server shell; the surface + all real-backend wiring lives in the client
 * control-plane component. FLAG0 (`n7b-cdc-control-plane`) is enforced by the
 * /api/cdc/connectors/** routes, which return an empty `flagOff` payload the
 * component renders as a guided "turned off" notice.
 */
import type { Metadata } from 'next';
import { CdcControlPlane } from '@/lib/cdc/cdc-control-plane';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'CDC connectors · CSA Loom',
  description: 'Debezium-style change-data-capture control plane over the Azure-native mirror engine.',
};

export default function Page() {
  return <CdcControlPlane />;
}
