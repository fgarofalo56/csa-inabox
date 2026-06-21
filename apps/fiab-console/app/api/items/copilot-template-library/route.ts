/**
 * Copilot template library — Cosmos-backed CSA-curated agent templates.
 *
 * GET  /api/items/copilot-template-library          — list templates
 * POST /api/items/copilot-template-library          — create template
 *   body: { name, description, instructions, knowledge?, topics?, suggestedModel? }
 *
 * On first call we ensure the `copilot-template-library` container exists
 * and pre-seed the CSA-curated templates if the container is empty.
 *
 * Container partition key: /tenantId  (single-tenant in this deployment;
 * we use a fixed value to keep partition cardinality reasonable).
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Container } from '@azure/cosmos';
import { CosmosClient } from '@azure/cosmos';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TENANT_PK = process.env.LOOM_TEMPLATE_TENANT || 'csa';

interface TemplateDoc {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  instructions: string;
  knowledge?: Array<{ type: string; name: string; uri?: string }>;
  topics?: Array<{ name: string; triggerPhrases: string[]; flowYaml: string }>;
  suggestedModel?: string;
  category?: string;
  builtin?: boolean;
}

const SEED_TEMPLATES: TemplateDoc[] = [
  {
    id: 'data-steward',
    tenantId: TENANT_PK,
    name: 'Data Steward Agent',
    description: 'Answers data-catalog questions: who owns a dataset, what columns mean, lineage, freshness, classification.',
    instructions:
      'You are the Data Steward for the organization. Help users locate datasets in Purview/OneLake, identify owners, ' +
      'describe lineage, and surface data-classification (PII, PHI, ITAR) policies. When unsure, route the user to ' +
      'the dataset owner via Teams. Never expose row-level data — only metadata.',
    knowledge: [
      { type: 'dataverse-table', name: 'Purview catalog entities (synced)' },
      { type: 'url', name: 'Internal data dictionary' },
    ],
    topics: [
      {
        name: 'Find dataset owner',
        triggerPhrases: ['who owns', 'data owner of', 'dataset owner', 'steward for'],
        flowYaml:
          'kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Ask Purview for the owner..."',
      },
    ],
    suggestedModel: 'gpt-4o',
    category: 'Governance',
    builtin: true,
  },
  {
    id: 'contract-analyzer',
    tenantId: TENANT_PK,
    name: 'Contract Analyzer',
    description: 'Reads vendor contracts and surfaces risks, renewal dates, indemnification clauses, and pricing.',
    instructions:
      'You analyze contracts uploaded by the user or referenced from SharePoint. Extract: parties, effective date, ' +
      'term, auto-renewal clauses, termination-for-convenience, indemnification, limitation of liability, ' +
      'data-protection terms, and total contract value. Flag any clause that conflicts with the organization\'s ' +
      'standard terms.',
    knowledge: [
      { type: 'sharepoint', name: 'Contracts site' },
      { type: 'url', name: 'Standard contract playbook' },
    ],
    topics: [
      {
        name: 'Summarize contract',
        triggerPhrases: ['summarize this contract', 'contract summary', 'what does this contract say'],
        flowYaml:
          'kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Extracting key clauses..."',
      },
    ],
    suggestedModel: 'gpt-4o',
    category: 'Legal',
    builtin: true,
  },
  {
    id: 'rfp-responder',
    tenantId: TENANT_PK,
    name: 'RFP Responder',
    description: 'Generates first-draft answers to RFP/RFI questions grounded in the organization\'s solution library.',
    instructions:
      'You draft responses to procurement questions using prior winning proposals, capability statements, and ' +
      'security/compliance attestations. Always cite the source proposal and the date — never invent capabilities. ' +
      'For technical claims, defer to the latest architecture reference. Output Markdown with section headers ' +
      'matching the RFP structure.',
    knowledge: [
      { type: 'sharepoint', name: 'Proposal library' },
      { type: 'sharepoint', name: 'Capability statements' },
      { type: 'url', name: 'Compliance attestations (SOC2, FedRAMP, ISO)' },
    ],
    topics: [
      {
        name: 'Draft RFP section',
        triggerPhrases: ['draft answer', 'rfp section', 'help me respond to'],
        flowYaml:
          'kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Drafting from the proposal library..."',
      },
    ],
    suggestedModel: 'gpt-4o',
    category: 'Sales',
    builtin: true,
  },
  {
    id: 'fedramp-coach',
    tenantId: TENANT_PK,
    name: 'FedRAMP Compliance Coach',
    description: 'Coaches engineering teams through FedRAMP Moderate/High control mapping and ATO evidence collection.',
    instructions:
      'You are an authorized FedRAMP compliance coach. Walk the user through specific NIST SP 800-53 controls, ' +
      'explain the inherited vs. customer-responsibility split for Azure Gov, and suggest evidence artifacts ' +
      '(screenshots, policy excerpts, code references) that auditors typically accept. Never claim a control is ' +
      'satisfied — only the organization\'s 3PAO can do that.',
    knowledge: [
      { type: 'url', name: 'NIST SP 800-53 Rev. 5 catalog' },
      { type: 'url', name: 'Azure Government FedRAMP H/M CRM' },
    ],
    topics: [
      {
        name: 'Explain control',
        triggerPhrases: ['what is AC-2', 'explain control', 'how do I satisfy', 'nist control'],
        flowYaml:
          'kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Looking up control..."',
      },
    ],
    suggestedModel: 'gpt-4o',
    category: 'Compliance',
    builtin: true,
  },
  {
    id: 'lakehouse-qna',
    tenantId: TENANT_PK,
    name: 'Lakehouse Q&A Assistant',
    description: 'Conversational Q&A grounded in a Fabric Lakehouse via Data Agent + semantic model.',
    instructions:
      'You answer business questions by querying the Lakehouse through the bound Data Agent. Always return: ' +
      '(1) the natural-language answer, (2) the underlying SQL/DAX that produced it, (3) the table(s) used, ' +
      'and (4) row counts. If a query exceeds 5 seconds, suggest a more focused filter.',
    knowledge: [
      { type: 'dataverse-table', name: 'Fabric Lakehouse semantic model' },
    ],
    topics: [
      {
        name: 'Ask a question',
        triggerPhrases: ['show me', 'how many', 'what was', 'trend of'],
        flowYaml:
          'kind: AdaptiveDialog\nbeginDialog:\n  - kind: SendActivity\n    activity: "Querying lakehouse..."',
      },
    ],
    suggestedModel: 'gpt-4o',
    category: 'Analytics',
    builtin: true,
  },
];

let _container: Container | null = null;
let _seeded = false;

function credential() {
  // ACA-first UAMI chain (shared helper) — AcaManagedIdentityCredential is the
  // first link so the ACA MI token bug never breaks Cosmos AAD auth.
  return uamiArmCredential();
}

async function getContainer(): Promise<Container> {
  if (_container) return _container;
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
  if (!endpoint) throw new Error('LOOM_COSMOS_ENDPOINT not set');
  const client = new CosmosClient({ endpoint, aadCredentials: credential() });
  const databaseId = process.env.LOOM_COSMOS_DATABASE || 'loom';
  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  const { container } = await database.containers.createIfNotExists({
    id: 'copilot-template-library',
    partitionKey: { paths: ['/tenantId'] },
  });
  _container = container;
  return container;
}

async function ensureSeeded(container: Container) {
  if (_seeded) return;
  const { resources } = await container.items
    .query({ query: 'SELECT VALUE COUNT(1) FROM c WHERE c.tenantId = @t', parameters: [{ name: '@t', value: TENANT_PK }] })
    .fetchAll();
  const count = Array.isArray(resources) && resources.length ? Number(resources[0]) : 0;
  if (count === 0) {
    for (const t of SEED_TEMPLATES) {
      await container.items.upsert(t);
    }
  }
  _seeded = true;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const container = await getContainer();
    await ensureSeeded(container);
    const { resources } = await container.items
      .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name', parameters: [{ name: '@t', value: TENANT_PK }] })
      .fetchAll();
    return NextResponse.json({ ok: true, templates: resources });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), status: 502 }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.name || !body?.description || !body?.instructions) {
    return NextResponse.json({ ok: false, error: 'name, description, and instructions are required' }, { status: 400 });
  }
  try {
    const container = await getContainer();
    const id = String(body.id || body.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || `tmpl-${Date.now()}`;
    const doc: TemplateDoc = {
      id,
      tenantId: TENANT_PK,
      name: String(body.name),
      description: String(body.description),
      instructions: String(body.instructions),
      knowledge: Array.isArray(body.knowledge) ? body.knowledge : undefined,
      topics: Array.isArray(body.topics) ? body.topics : undefined,
      suggestedModel: body.suggestedModel,
      category: body.category,
      builtin: false,
    };
    await container.items.upsert(doc);
    return NextResponse.json({ ok: true, template: doc });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), status: 502 }, { status: 502 });
  }
}
