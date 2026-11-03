'use client';

/**
 * /admin/api-gateway - the API Gateway Plane admin hub (W1-5).
 * Replaces /admin/api-management and /admin/mcp-servers (both redirect here while
 * LOOM_APIPLANE_ENABLED is not "false").
 */
import { AdminShell } from '@/lib/components/admin-shell';
import { Hub } from './hub';

export default function ApiGatewayHubPage() {
  return (
    <AdminShell
      sectionTitle="API Gateway"
      learn={{
        title: 'API Gateway',
        content: 'One hub for the API Management gateways Loom fronts: register a gateway by resource id, see its observed inventory, telemetry checks and open gates with their Fix its, and manage APIs, products, subscriptions, named values, backends, policies and the developer portal per gateway.',
        tips: [
          'The deploy-owned gateway registers itself; others are registered after an access check',
          'Registering reads the service; it does not change it',
          'Environment classification and findings live under Settings',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/api-management/api-management-key-concepts',
      }}
    >
      <Hub />
    </AdminShell>
  );
}
