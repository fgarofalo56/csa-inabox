/**
 * Governance-as-Code — a labeled SAMPLE policy set that exercises every backend
 * in one pass (the WS-10.2 "≥ 4 backends in one pass" acceptance shape). Loaded
 * by the `admin/policy-code` "Load sample" action as an editable starting point.
 * SAMPLE — the operator replaces the object names / group ids with real ones
 * before applying (per `no-vaporware.md` disclosure).
 */

import { POLICY_CODE_API_VERSION, type PolicyCodeSet } from './dsl';

export function samplePolicyCodeSet(): PolicyCodeSet {
  return {
    apiVersion: POLICY_CODE_API_VERSION,
    name: 'SAMPLE — Finance read + PII protection',
    description:
      'SAMPLE governance-as-code set: grants the Finance analysts group read on the ' +
      'sales fact across Synapse, Unity Catalog and ADX, restricts rows to the caller’s ' +
      'region, masks the PII column, marks the asset Confidential in Purview, and scopes ' +
      'the warehouse API to the group. Replace object names + group ids before applying.',
    statements: [
      {
        id: 'finance-read-sales',
        description: 'Finance analysts can read the sales fact on every serving engine.',
        principals: [{ kind: 'group', id: '00000000-0000-0000-0000-000000000001', name: 'Finance-Analysts' }],
        resources: [
          { backend: 'synapse', object: 'dbo.FactSales' },
          { backend: 'unity-catalog', object: 'main.sales.fact_sales' },
          { backend: 'adx', object: 'Telemetry/SalesEvents' },
        ],
        actions: ['read'],
        condition: {
          rowFilter: "[Region] = USERPRINCIPALNAME()",
          maskColumns: ['CustomerEmail'],
        },
      },
      {
        id: 'classify-sales-confidential',
        description: 'Mark the sales fact Confidential in the Purview Data Map.',
        principals: [{ kind: 'group', id: '00000000-0000-0000-0000-000000000001', name: 'Finance-Analysts' }],
        resources: [{ backend: 'purview', object: 'https://onelake/sales/fact_sales' }],
        actions: ['read'],
        condition: { marking: 'Confidential' },
      },
      {
        id: 'scope-warehouse-api',
        description: 'Only Finance analysts can call the warehouse item API.',
        principals: [{ kind: 'group', id: '00000000-0000-0000-0000-000000000001', name: 'Finance-Analysts' }],
        resources: [{ backend: 'api-scope', object: '/api/items/warehouse/*' }],
        actions: ['read'],
      },
    ],
  };
}
