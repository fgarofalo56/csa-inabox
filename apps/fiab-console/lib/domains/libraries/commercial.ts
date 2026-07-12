/**
 * Commercial / Cross-Industry library — the enterprise functions of a large
 * commercial organization, modeled as Loom domains (issue #1483, Wave 1).
 *
 * This is the classic data-mesh domain map for a private-sector enterprise
 * (the taxonomy Finance/Supply-Chain/Customer-360/HR/Operations data products
 * are usually organized around): each enterprise function is a root domain
 * and its capability teams are subdomains. Grounded in the standard
 * cross-industry operating-model taxonomy (APQC Process Classification
 * Framework categories) rather than any single company's org chart.
 *
 * NO copyrighted marks: generic Fluent icons + brand-ish colors only.
 */
import type { DomainLibrary, DomainLibraryNode } from './types';

export type CommercialCategory = 'Enterprise Functions' | 'Capabilities & Teams';

/** Palette anchors per function (children share a tint of the parent hue). */
const C = {
  finance: '#0b6a0b', supply: '#bd7800', customer: '#0078d4', hr: '#881798',
  ops: '#a4262c', tech: '#5c2d91', product: '#0e7490', legal: '#3b3b6d',
};

export const COMMERCIAL_NODES: DomainLibraryNode[] = [
  // ── Enterprise Functions (Enterprises) ─────────────────────────────────────
  { id: 'fn-finance', name: 'Finance', abbrev: 'FIN', icon: 'money', color: C.finance, category: 'Enterprise Functions', mission: 'Plan, account for, and safeguard the enterprise’s financial resources.' },
  { id: 'fn-supply-chain', name: 'Supply Chain', abbrev: 'SCM', icon: 'truck', color: C.supply, category: 'Enterprise Functions', mission: 'Source, make, and deliver products and services end to end.' },
  { id: 'fn-customer-360', name: 'Customer 360', abbrev: 'CX', icon: 'people', color: C.customer, category: 'Enterprise Functions', mission: 'Acquire, serve, and grow customers across every channel.' },
  { id: 'fn-human-resources', name: 'Human Resources', abbrev: 'HR', icon: 'people-team', color: C.hr, category: 'Enterprise Functions', mission: 'Attract, develop, and retain the enterprise’s talent.' },
  { id: 'fn-operations', name: 'Operations', abbrev: 'OPS', icon: 'gear', color: C.ops, category: 'Enterprise Functions', mission: 'Run the business safely, reliably, and efficiently.' },
  { id: 'fn-technology-data', name: 'Technology & Data', abbrev: 'IT', icon: 'server', color: C.tech, category: 'Enterprise Functions', mission: 'Deliver the platforms, data, and security the business runs on.' },
  { id: 'fn-product-engineering', name: 'Product & Engineering', abbrev: 'R&D', icon: 'lightbulb', color: C.product, category: 'Enterprise Functions', mission: 'Imagine, build, and evolve the products customers buy.' },
  { id: 'fn-legal-corporate', name: 'Legal & Corporate Affairs', abbrev: 'LEGAL', icon: 'scales', color: C.legal, category: 'Enterprise Functions', mission: 'Protect the enterprise and steward its corporate responsibilities.' },

  // ── Finance capabilities ───────────────────────────────────────────────────
  { id: 'fn-fpa', name: 'Financial Planning & Analysis', abbrev: 'FP&A', icon: 'data-trending', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Forecast, budget, and analyze business performance.', parentId: 'fn-finance' },
  { id: 'fn-accounting', name: 'Accounting & Controllership', abbrev: 'ACCT', icon: 'document', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Close the books and report accurate financial statements.', parentId: 'fn-finance' },
  { id: 'fn-treasury', name: 'Treasury', abbrev: 'TRS', icon: 'vault', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Manage cash, liquidity, capital markets, and FX risk.', parentId: 'fn-finance' },
  { id: 'fn-tax', name: 'Tax', abbrev: 'TAX', icon: 'wallet', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Plan and comply with tax obligations across jurisdictions.', parentId: 'fn-finance' },
  { id: 'fn-risk-compliance', name: 'Risk & Compliance', abbrev: 'GRC', icon: 'shield-task', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Identify, measure, and manage enterprise risk and controls.', parentId: 'fn-finance' },
  { id: 'fn-internal-audit', name: 'Internal Audit', abbrev: 'AUD', icon: 'eye', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Independently assess governance, risk, and control effectiveness.', parentId: 'fn-finance' },

  // ── Supply Chain capabilities ──────────────────────────────────────────────
  { id: 'fn-sourcing', name: 'Procurement & Sourcing', abbrev: 'SRC', icon: 'box', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Source goods and services at the best value and risk profile.', parentId: 'fn-supply-chain' },
  { id: 'fn-manufacturing', name: 'Manufacturing & Production', abbrev: 'MFG', icon: 'factory', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Convert materials into finished products safely and efficiently.', parentId: 'fn-supply-chain' },
  { id: 'fn-logistics', name: 'Logistics & Distribution', abbrev: 'LOG', icon: 'truck', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Move and store product from plant to customer.', parentId: 'fn-supply-chain' },
  { id: 'fn-demand-planning', name: 'Inventory & Demand Planning', abbrev: 'IDP', icon: 'data-histogram', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Balance inventory against forecasted demand.', parentId: 'fn-supply-chain' },
  { id: 'fn-supplier-mgmt', name: 'Supplier Management', abbrev: 'SUP', icon: 'people', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Onboard, score, and develop the supplier base.', parentId: 'fn-supply-chain' },

  // ── Customer 360 capabilities ──────────────────────────────────────────────
  { id: 'fn-sales', name: 'Sales', abbrev: 'SLS', icon: 'data-trending', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Win and grow revenue across accounts and channels.', parentId: 'fn-customer-360' },
  { id: 'fn-marketing', name: 'Marketing', abbrev: 'MKT', icon: 'megaphone', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Build the brand and generate qualified demand.', parentId: 'fn-customer-360' },
  { id: 'fn-customer-service', name: 'Customer Service & Support', abbrev: 'CSS', icon: 'person-heart', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Resolve customer issues and drive satisfaction and retention.', parentId: 'fn-customer-360' },
  { id: 'fn-digital-commerce', name: 'Digital Commerce', abbrev: 'ECOM', icon: 'globe', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Sell and serve customers through digital storefronts.', parentId: 'fn-customer-360' },
  { id: 'fn-customer-insights', name: 'Customer Data & Insights', abbrev: 'CDI', icon: 'database', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Unify customer data into a governed, actionable 360° view.', parentId: 'fn-customer-360' },

  // ── HR capabilities ────────────────────────────────────────────────────────
  { id: 'fn-talent-acquisition', name: 'Talent Acquisition', abbrev: 'TA', icon: 'person-star', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Recruit and hire the talent the business needs.', parentId: 'fn-human-resources' },
  { id: 'fn-total-rewards', name: 'Total Rewards', abbrev: 'TR', icon: 'wallet', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Design competitive compensation and benefits.', parentId: 'fn-human-resources' },
  { id: 'fn-learning-dev', name: 'Learning & Development', abbrev: 'L&D', icon: 'graduation', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Grow employee skills and leadership pipelines.', parentId: 'fn-human-resources' },
  { id: 'fn-people-analytics', name: 'People Analytics', abbrev: 'PA', icon: 'data-histogram', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Measure and predict workforce outcomes with data.', parentId: 'fn-human-resources' },
  { id: 'fn-hr-operations', name: 'HR Operations', abbrev: 'HROPS', icon: 'gear', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Run payroll, HRIS, and employee services at scale.', parentId: 'fn-human-resources' },

  // ── Operations capabilities ────────────────────────────────────────────────
  { id: 'fn-quality', name: 'Quality Management', abbrev: 'QM', icon: 'ribbon', color: '#bd4347', category: 'Capabilities & Teams', mission: 'Assure product and process quality end to end.', parentId: 'fn-operations' },
  { id: 'fn-asset-mgmt', name: 'Asset & Facilities Management', abbrev: 'EAM', icon: 'building-multiple', color: '#bd4347', category: 'Capabilities & Teams', mission: 'Maintain the plants, equipment, and facilities the business depends on.', parentId: 'fn-operations' },
  { id: 'fn-ehs', name: 'Environment, Health & Safety', abbrev: 'EHS', icon: 'leaf', color: '#bd4347', category: 'Capabilities & Teams', mission: 'Keep people safe and operations environmentally compliant.', parentId: 'fn-operations' },
  { id: 'fn-continuous-improvement', name: 'Continuous Improvement', abbrev: 'CI', icon: 'pulse', color: '#bd4347', category: 'Capabilities & Teams', mission: 'Drive lean, six-sigma, and operational-excellence programs.', parentId: 'fn-operations' },

  // ── Technology & Data capabilities ─────────────────────────────────────────
  { id: 'fn-enterprise-arch', name: 'Enterprise Architecture', abbrev: 'EA', icon: 'organization', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Shape the target-state technology and integration landscape.', parentId: 'fn-technology-data' },
  { id: 'fn-data-platform', name: 'Data & Analytics Platform', abbrev: 'DAP', icon: 'database', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Operate the governed data platform and analytics products.', parentId: 'fn-technology-data' },
  { id: 'fn-cybersecurity', name: 'Cybersecurity', abbrev: 'SEC', icon: 'shield-keyhole', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Protect the enterprise from cyber threats.', parentId: 'fn-technology-data' },
  { id: 'fn-app-dev', name: 'Application Development', abbrev: 'DEV', icon: 'cube', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Build and run the applications the business uses.', parentId: 'fn-technology-data' },
  { id: 'fn-infra-cloud', name: 'Infrastructure & Cloud', abbrev: 'INFRA', icon: 'server', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Provide reliable, scalable compute, network, and cloud services.', parentId: 'fn-technology-data' },

  // ── Product & Engineering capabilities ─────────────────────────────────────
  { id: 'fn-product-mgmt', name: 'Product Management', abbrev: 'PM', icon: 'lightbulb-filament', color: '#1390ad', category: 'Capabilities & Teams', mission: 'Own product strategy, roadmap, and customer outcomes.', parentId: 'fn-product-engineering' },
  { id: 'fn-research-dev', name: 'Research & Development', abbrev: 'R&D', icon: 'beaker', color: '#1390ad', category: 'Capabilities & Teams', mission: 'Research new technologies, materials, and methods.', parentId: 'fn-product-engineering' },
  { id: 'fn-engineering', name: 'Engineering', abbrev: 'ENG', icon: 'wrench', color: '#1390ad', category: 'Capabilities & Teams', mission: 'Design and deliver the products on the roadmap.', parentId: 'fn-product-engineering' },

  // ── Legal & Corporate Affairs capabilities ─────────────────────────────────
  { id: 'fn-legal-counsel', name: 'Legal Counsel & Contracts', abbrev: 'LC', icon: 'gavel', color: '#54548a', category: 'Capabilities & Teams', mission: 'Advise the business and manage the contract lifecycle.', parentId: 'fn-legal-corporate' },
  { id: 'fn-regulatory', name: 'Regulatory Affairs', abbrev: 'REG', icon: 'document', color: '#54548a', category: 'Capabilities & Teams', mission: 'Navigate industry regulation and licensing.', parentId: 'fn-legal-corporate' },
  { id: 'fn-corp-comms', name: 'Corporate Communications', abbrev: 'COMMS', icon: 'megaphone', color: '#54548a', category: 'Capabilities & Teams', mission: 'Tell the enterprise’s story inside and out.', parentId: 'fn-legal-corporate' },
  { id: 'fn-esg', name: 'ESG & Sustainability', abbrev: 'ESG', icon: 'leaf-three', color: '#54548a', category: 'Capabilities & Teams', mission: 'Measure and improve environmental and social impact.', parentId: 'fn-legal-corporate' },
];

export const COMMERCIAL_LIBRARY: DomainLibrary = {
  id: 'commercial',
  name: 'Commercial / Cross-Industry',
  label: 'Commercial library',
  description: 'Enterprise functions — Finance, Supply Chain, Customer 360, HR, Operations, and more.',
  icon: 'building-skyscraper',
  color: '#106ebe',
  categories: ['Enterprise Functions', 'Capabilities & Teams'] satisfies CommercialCategory[],
  nodes: COMMERCIAL_NODES,
  copy: {
    enterpriseNoun: 'enterprise functions',
    childNoun: 'capability teams',
    drillNoun: 'capabilities',
    itemPlural: 'functions',
    itemSingular: 'function',
    searchPlaceholder: 'Search functions & capabilities…',
  },
};
