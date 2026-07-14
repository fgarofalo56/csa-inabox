/**
 * Commercial / Cross-Industry library — the enterprise functions of a large
 * commercial organization, modeled as Loom domains (issue #1483; Wave 1
 * shallow stub deepened to a genuine multi-level taxonomy in Wave 2).
 *
 * This is the classic data-mesh domain map for a private-sector enterprise
 * (the taxonomy Finance/Supply-Chain/Customer-360/HR/Operations data products
 * are usually organized around): each enterprise function is a root domain
 * and its capability teams — deepened here to capability → sub-capability,
 * e.g. Customer 360 → Customer Data & Insights → Customer Data Platform —
 * are subdomains. Grounded in the standard cross-industry operating-model
 * taxonomy (APQC Process Classification Framework categories) rather than
 * any single company's org chart. Alongside the eight cross-industry
 * functions, a set of industry-vertical enterprises (Financial Services,
 * Healthcare & Life Sciences, Retail & CPG, Manufacturing & Industrial,
 * Energy & Utilities, Technology/ISV, Transportation & Logistics,
 * Professional Services) model the capabilities specific to each sector, so
 * a vertical-aligned business unit can seed its own domain tree directly.
 *
 * NO copyrighted marks: generic Fluent icons + brand-ish colors only.
 */
import type { DomainLibrary, DomainLibraryNode } from './types';

export type CommercialCategory = 'Enterprise Functions' | 'Capabilities & Teams';

/** Palette anchors per function (children share a tint of the parent hue). */
const C = {
  finance: '#0b6a0b', supply: '#bd7800', customer: '#0078d4', hr: '#881798',
  ops: '#a4262c', tech: '#5c2d91', product: '#0e7490', legal: '#3b3b6d',
  fs: '#0b5ea8', hls: '#b5325b', retail: '#c46b1e', mfgInd: '#6b6b2e',
  eu: '#d18a1e', isv: '#4a3a9c', tl: '#2e7d5c', ps: '#6a5acd',
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
  { id: 'fn-financial-services', name: 'Financial Services', abbrev: 'FSI', icon: 'building-bank', color: C.fs, category: 'Enterprise Functions', mission: 'Model the banking, payments, and insurance capabilities of an FSI enterprise.' },
  { id: 'fn-healthcare-life-sciences', name: 'Healthcare & Life Sciences', abbrev: 'HLS', icon: 'heart-pulse', color: C.hls, category: 'Enterprise Functions', mission: 'Model clinical, payer, and life-sciences capabilities.' },
  { id: 'fn-retail-cpg', name: 'Retail & Consumer Packaged Goods', abbrev: 'RCPG', icon: 'box', color: C.retail, category: 'Enterprise Functions', mission: 'Model merchandising, store, and brand capabilities for retail and CPG.' },
  { id: 'fn-manufacturing-industrial', name: 'Manufacturing & Industrial', abbrev: 'MFG-I', icon: 'factory', color: C.mfgInd, category: 'Enterprise Functions', mission: 'Model plant-floor, PLM, and industrial aftermarket capabilities.' },
  { id: 'fn-energy-utilities', name: 'Energy & Utilities', abbrev: 'E&U', icon: 'flash', color: C.eu, category: 'Enterprise Functions', mission: 'Model generation, grid, and metering capabilities for energy and utilities.' },
  { id: 'fn-technology-isv', name: 'Technology / ISV & Public Cloud', abbrev: 'ISV', icon: 'cube', color: C.isv, category: 'Enterprise Functions', mission: 'Model product, platform, and go-to-market capabilities for a software company.' },
  { id: 'fn-transportation-logistics', name: 'Transportation & Logistics', abbrev: 'T&L', icon: 'truck', color: C.tl, category: 'Enterprise Functions', mission: 'Model fleet, freight, and delivery capabilities for a logistics enterprise.' },
  { id: 'fn-professional-services', name: 'Professional Services', abbrev: 'PS', icon: 'people-team', color: C.ps, category: 'Enterprise Functions', mission: 'Model engagement delivery and practice capabilities for a services firm.' },

  // ── Finance capabilities ───────────────────────────────────────────────────
  { id: 'fn-fpa', name: 'Financial Planning & Analysis', abbrev: 'FP&A', icon: 'data-trending', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Forecast, budget, and analyze business performance.', parentId: 'fn-finance' },
  { id: 'fn-accounting', name: 'Accounting & Controllership', abbrev: 'ACCT', icon: 'document', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Close the books and report accurate financial statements.', parentId: 'fn-finance' },
  { id: 'fn-treasury', name: 'Treasury', abbrev: 'TRS', icon: 'vault', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Manage cash, liquidity, capital markets, and FX risk.', parentId: 'fn-finance' },
  { id: 'fn-tax', name: 'Tax', abbrev: 'TAX', icon: 'wallet', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Plan and comply with tax obligations across jurisdictions.', parentId: 'fn-finance' },
  { id: 'fn-risk-compliance', name: 'Risk & Compliance', abbrev: 'GRC', icon: 'shield-task', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Identify, measure, and manage enterprise risk and controls.', parentId: 'fn-finance' },
  { id: 'fn-internal-audit', name: 'Internal Audit', abbrev: 'AUD', icon: 'eye', color: '#2b7a2b', category: 'Capabilities & Teams', mission: 'Independently assess governance, risk, and control effectiveness.', parentId: 'fn-finance' },

  { id: 'fn-budgeting', name: 'Budgeting & Forecasting', abbrev: 'B&F', icon: 'data-trending', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Build the annual budget and rolling forecasts.', parentId: 'fn-fpa' },
  { id: 'fn-financial-modeling', name: 'Financial Modeling & Scenario Planning', abbrev: 'FMSP', icon: 'data-histogram', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Model business scenarios to inform strategic decisions.', parentId: 'fn-fpa' },
  { id: 'fn-general-ledger', name: 'General Ledger & Close', abbrev: 'GL', icon: 'document', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Own the chart of accounts and the period-close process.', parentId: 'fn-accounting' },
  { id: 'fn-accounts-payable', name: 'Accounts Payable', abbrev: 'AP', icon: 'wallet', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Process and pay supplier invoices.', parentId: 'fn-accounting' },
  { id: 'fn-accounts-receivable', name: 'Accounts Receivable', abbrev: 'AR', icon: 'wallet', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Invoice customers and collect receivables.', parentId: 'fn-accounting' },
  { id: 'fn-cash-management', name: 'Cash & Liquidity Management', abbrev: 'CLM', icon: 'vault', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Manage daily cash positioning and liquidity forecasting.', parentId: 'fn-treasury' },
  { id: 'fn-capital-markets', name: 'Capital Markets & Funding', abbrev: 'CMF', icon: 'data-trending', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Raise and manage debt and equity capital.', parentId: 'fn-treasury' },
  { id: 'fn-tax-compliance', name: 'Tax Compliance & Reporting', abbrev: 'TCR', icon: 'document', color: '#5da85d', category: 'Capabilities & Teams', mission: 'File tax returns and manage statutory reporting.', parentId: 'fn-tax' },
  { id: 'fn-transfer-pricing', name: 'Transfer Pricing', abbrev: 'TP', icon: 'scales', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Set and document intercompany transfer-pricing policy.', parentId: 'fn-tax' },
  { id: 'fn-enterprise-risk', name: 'Enterprise Risk Management', abbrev: 'ERM', icon: 'shield-task', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Identify and mitigate enterprise-level risk.', parentId: 'fn-risk-compliance' },
  { id: 'fn-regulatory-compliance', name: 'Regulatory Compliance', abbrev: 'REGC', icon: 'gavel', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Monitor and comply with applicable regulation.', parentId: 'fn-risk-compliance' },
  { id: 'fn-sox-compliance', name: 'SOX & Controls Testing', abbrev: 'SOX', icon: 'shield-task', color: '#5da85d', category: 'Capabilities & Teams', mission: 'Test and certify internal controls over financial reporting.', parentId: 'fn-internal-audit' },

  // ── Supply Chain capabilities ──────────────────────────────────────────────
  { id: 'fn-sourcing', name: 'Procurement & Sourcing', abbrev: 'SRC', icon: 'box', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Source goods and services at the best value and risk profile.', parentId: 'fn-supply-chain' },
  { id: 'fn-manufacturing', name: 'Manufacturing & Production', abbrev: 'MFG', icon: 'factory', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Convert materials into finished products safely and efficiently.', parentId: 'fn-supply-chain' },
  { id: 'fn-logistics', name: 'Logistics & Distribution', abbrev: 'LOG', icon: 'truck', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Move and store product from plant to customer.', parentId: 'fn-supply-chain' },
  { id: 'fn-demand-planning', name: 'Inventory & Demand Planning', abbrev: 'IDP', icon: 'data-histogram', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Balance inventory against forecasted demand.', parentId: 'fn-supply-chain' },
  { id: 'fn-supplier-mgmt', name: 'Supplier Management', abbrev: 'SUP', icon: 'people', color: '#d4a017', category: 'Capabilities & Teams', mission: 'Onboard, score, and develop the supplier base.', parentId: 'fn-supply-chain' },

  { id: 'fn-strategic-sourcing', name: 'Strategic Sourcing', abbrev: 'SS', icon: 'box', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Run category strategy and competitive sourcing events.', parentId: 'fn-sourcing' },
  { id: 'fn-procure-to-pay', name: 'Procure-to-Pay', abbrev: 'P2P', icon: 'document', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Operate the requisition-to-payment purchasing process.', parentId: 'fn-sourcing' },
  { id: 'fn-production-planning', name: 'Production Planning & Scheduling', abbrev: 'PPS', icon: 'gear', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Sequence and schedule production runs against demand.', parentId: 'fn-manufacturing' },
  { id: 'fn-plant-operations', name: 'Plant Operations', abbrev: 'PLNT', icon: 'factory', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Run day-to-day plant-floor manufacturing operations.', parentId: 'fn-manufacturing' },
  { id: 'fn-mfg-quality', name: 'Manufacturing Quality Control', abbrev: 'MQC', icon: 'ribbon', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Inspect and assure quality of manufactured goods.', parentId: 'fn-manufacturing' },
  { id: 'fn-warehousing', name: 'Warehousing & Fulfillment', abbrev: 'WH', icon: 'box', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Store, pick, and pack inventory for shipment.', parentId: 'fn-logistics' },
  { id: 'fn-transportation-mgmt', name: 'Transportation Management', abbrev: 'TM', icon: 'truck', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Plan and execute inbound and outbound freight moves.', parentId: 'fn-logistics' },
  { id: 'fn-demand-forecasting', name: 'Demand Forecasting', abbrev: 'DF', icon: 'data-trending', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Forecast product demand across channels and regions.', parentId: 'fn-demand-planning' },
  { id: 'fn-sop', name: 'Sales & Operations Planning (S&OP)', abbrev: 'S&OP', icon: 'data-histogram', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Balance demand and supply plans across the business.', parentId: 'fn-demand-planning' },
  { id: 'fn-supplier-risk', name: 'Supplier Risk & Diversity', abbrev: 'SRD', icon: 'shield-task', color: '#e6bf5c', category: 'Capabilities & Teams', mission: 'Assess supplier risk and manage supplier-diversity programs.', parentId: 'fn-supplier-mgmt' },

  // ── Customer 360 capabilities ──────────────────────────────────────────────
  { id: 'fn-sales', name: 'Sales', abbrev: 'SLS', icon: 'data-trending', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Win and grow revenue across accounts and channels.', parentId: 'fn-customer-360' },
  { id: 'fn-marketing', name: 'Marketing', abbrev: 'MKT', icon: 'megaphone', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Build the brand and generate qualified demand.', parentId: 'fn-customer-360' },
  { id: 'fn-customer-service', name: 'Customer Service & Support', abbrev: 'CSS', icon: 'person-heart', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Resolve customer issues and drive satisfaction and retention.', parentId: 'fn-customer-360' },
  { id: 'fn-digital-commerce', name: 'Digital Commerce', abbrev: 'ECOM', icon: 'globe', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Sell and serve customers through digital storefronts.', parentId: 'fn-customer-360' },
  { id: 'fn-customer-insights', name: 'Customer Data & Insights', abbrev: 'CDI', icon: 'database', color: '#2a8fd4', category: 'Capabilities & Teams', mission: 'Unify customer data into a governed, actionable 360° view.', parentId: 'fn-customer-360' },

  { id: 'fn-account-management', name: 'Account Management', abbrev: 'AM', icon: 'people', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Grow and retain existing customer accounts.', parentId: 'fn-sales' },
  { id: 'fn-sales-ops', name: 'Sales Operations & Enablement', abbrev: 'SOE', icon: 'gear', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Run the sales pipeline process, tools, and territory design.', parentId: 'fn-sales' },
  { id: 'fn-brand-marketing', name: 'Brand & Creative', abbrev: 'B&C', icon: 'megaphone', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Own brand identity and creative campaign development.', parentId: 'fn-marketing' },
  { id: 'fn-demand-generation', name: 'Demand Generation', abbrev: 'DG', icon: 'megaphone', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Generate and nurture marketing-qualified leads.', parentId: 'fn-marketing' },
  { id: 'fn-marketing-analytics', name: 'Marketing Analytics', abbrev: 'MA', icon: 'data-histogram', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Measure campaign performance and marketing ROI.', parentId: 'fn-marketing' },
  { id: 'fn-contact-center', name: 'Contact Center Operations', abbrev: 'CCO', icon: 'person-heart', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Run inbound and outbound contact-center service.', parentId: 'fn-customer-service' },
  { id: 'fn-field-service', name: 'Field Service', abbrev: 'FS', icon: 'wrench', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Dispatch and manage on-site service technicians.', parentId: 'fn-customer-service' },
  { id: 'fn-ecommerce-platform', name: 'eCommerce Platform', abbrev: 'ECP', icon: 'globe', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Operate the digital storefront and checkout experience.', parentId: 'fn-digital-commerce' },
  { id: 'fn-digital-merchandising', name: 'Digital Merchandising', abbrev: 'DM', icon: 'box', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Curate product catalogs and digital shelf placement.', parentId: 'fn-digital-commerce' },
  { id: 'fn-customer-data-platform', name: 'Customer Data Platform', abbrev: 'CDP', icon: 'database', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Unify identity and behavioral data into customer profiles.', parentId: 'fn-customer-insights' },
  { id: 'fn-voice-of-customer', name: 'Voice of the Customer', abbrev: 'VoC', icon: 'person-heart', color: '#5aa9e6', category: 'Capabilities & Teams', mission: 'Capture and act on customer feedback and NPS.', parentId: 'fn-customer-insights' },

  // ── HR capabilities ────────────────────────────────────────────────────────
  { id: 'fn-talent-acquisition', name: 'Talent Acquisition', abbrev: 'TA', icon: 'person-star', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Recruit and hire the talent the business needs.', parentId: 'fn-human-resources' },
  { id: 'fn-total-rewards', name: 'Total Rewards', abbrev: 'TR', icon: 'wallet', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Design competitive compensation and benefits.', parentId: 'fn-human-resources' },
  { id: 'fn-learning-dev', name: 'Learning & Development', abbrev: 'L&D', icon: 'graduation', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Grow employee skills and leadership pipelines.', parentId: 'fn-human-resources' },
  { id: 'fn-people-analytics', name: 'People Analytics', abbrev: 'PA', icon: 'data-histogram', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Measure and predict workforce outcomes with data.', parentId: 'fn-human-resources' },
  { id: 'fn-hr-operations', name: 'HR Operations', abbrev: 'HROPS', icon: 'gear', color: '#9c2faa', category: 'Capabilities & Teams', mission: 'Run payroll, HRIS, and employee services at scale.', parentId: 'fn-human-resources' },

  { id: 'fn-recruiting-ops', name: 'Recruiting Operations', abbrev: 'RO', icon: 'people', color: '#c161cf', category: 'Capabilities & Teams', mission: 'Run the requisition-to-offer recruiting process.', parentId: 'fn-talent-acquisition' },
  { id: 'fn-employer-branding', name: 'Employer Branding', abbrev: 'EB', icon: 'megaphone', color: '#c161cf', category: 'Capabilities & Teams', mission: 'Build the employer brand and candidate experience.', parentId: 'fn-talent-acquisition' },
  { id: 'fn-compensation', name: 'Compensation Design', abbrev: 'COMP', icon: 'wallet', color: '#c161cf', category: 'Capabilities & Teams', mission: 'Design pay structures, bands, and incentive plans.', parentId: 'fn-total-rewards' },
  { id: 'fn-benefits', name: 'Benefits Administration', abbrev: 'BEN', icon: 'heart', color: '#c161cf', category: 'Capabilities & Teams', mission: 'Administer health, retirement, and wellness benefits.', parentId: 'fn-total-rewards' },
  { id: 'fn-leadership-dev', name: 'Leadership Development', abbrev: 'LD', icon: 'person-star', color: '#c161cf', category: 'Capabilities & Teams', mission: 'Build leadership and succession pipelines.', parentId: 'fn-learning-dev' },
  { id: 'fn-onboarding-training', name: 'Onboarding & Training', abbrev: 'O&T', icon: 'graduation', color: '#c161cf', category: 'Capabilities & Teams', mission: 'Onboard new hires and deliver ongoing training.', parentId: 'fn-learning-dev' },
  { id: 'fn-workforce-planning', name: 'Workforce Planning', abbrev: 'WP', icon: 'people-team', color: '#c161cf', category: 'Capabilities & Teams', mission: 'Plan headcount and skills against business demand.', parentId: 'fn-people-analytics' },
  { id: 'fn-payroll', name: 'Payroll Operations', abbrev: 'PAY', icon: 'wallet', color: '#c161cf', category: 'Capabilities & Teams', mission: 'Process accurate, on-time employee payroll.', parentId: 'fn-hr-operations' },
  { id: 'fn-hris', name: 'HRIS & Employee Records', abbrev: 'HRIS', icon: 'database', color: '#c161cf', category: 'Capabilities & Teams', mission: 'Maintain the system of record for employee data.', parentId: 'fn-hr-operations' },

  // ── Operations capabilities ────────────────────────────────────────────────
  { id: 'fn-quality', name: 'Quality Management', abbrev: 'QM', icon: 'ribbon', color: '#bd4347', category: 'Capabilities & Teams', mission: 'Assure product and process quality end to end.', parentId: 'fn-operations' },
  { id: 'fn-asset-mgmt', name: 'Asset & Facilities Management', abbrev: 'EAM', icon: 'building-multiple', color: '#bd4347', category: 'Capabilities & Teams', mission: 'Maintain the plants, equipment, and facilities the business depends on.', parentId: 'fn-operations' },
  { id: 'fn-ehs', name: 'Environment, Health & Safety', abbrev: 'EHS', icon: 'leaf', color: '#bd4347', category: 'Capabilities & Teams', mission: 'Keep people safe and operations environmentally compliant.', parentId: 'fn-operations' },
  { id: 'fn-continuous-improvement', name: 'Continuous Improvement', abbrev: 'CI', icon: 'pulse', color: '#bd4347', category: 'Capabilities & Teams', mission: 'Drive lean, six-sigma, and operational-excellence programs.', parentId: 'fn-operations' },

  { id: 'fn-quality-assurance', name: 'Quality Assurance', abbrev: 'QA', icon: 'ribbon', color: '#d47276', category: 'Capabilities & Teams', mission: 'Define and audit quality management systems.', parentId: 'fn-quality' },
  { id: 'fn-quality-inspection', name: 'Inspection & Testing', abbrev: 'I&T', icon: 'beaker', color: '#d47276', category: 'Capabilities & Teams', mission: 'Inspect and test products against specification.', parentId: 'fn-quality' },
  { id: 'fn-preventive-maintenance', name: 'Preventive Maintenance', abbrev: 'PM', icon: 'wrench', color: '#d47276', category: 'Capabilities & Teams', mission: 'Schedule and perform planned equipment maintenance.', parentId: 'fn-asset-mgmt' },
  { id: 'fn-facilities-ops', name: 'Facilities Operations', abbrev: 'FO', icon: 'building-multiple', color: '#d47276', category: 'Capabilities & Teams', mission: 'Operate and maintain corporate real estate and plants.', parentId: 'fn-asset-mgmt' },
  { id: 'fn-safety-programs', name: 'Safety Programs', abbrev: 'SP', icon: 'shield-task', color: '#d47276', category: 'Capabilities & Teams', mission: 'Run workplace-safety training and incident prevention.', parentId: 'fn-ehs' },
  { id: 'fn-environmental-compliance', name: 'Environmental Compliance', abbrev: 'EC', icon: 'leaf', color: '#d47276', category: 'Capabilities & Teams', mission: 'Ensure operations meet environmental regulation.', parentId: 'fn-ehs' },
  { id: 'fn-lean-six-sigma', name: 'Lean Six Sigma Program', abbrev: 'LSS', icon: 'pulse', color: '#d47276', category: 'Capabilities & Teams', mission: 'Run process-improvement projects across operations.', parentId: 'fn-continuous-improvement' },

  // ── Technology & Data capabilities ─────────────────────────────────────────
  { id: 'fn-enterprise-arch', name: 'Enterprise Architecture', abbrev: 'EA', icon: 'organization', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Shape the target-state technology and integration landscape.', parentId: 'fn-technology-data' },
  { id: 'fn-data-platform', name: 'Data & Analytics Platform', abbrev: 'DAP', icon: 'database', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Operate the governed data platform and analytics products.', parentId: 'fn-technology-data' },
  { id: 'fn-cybersecurity', name: 'Cybersecurity', abbrev: 'SEC', icon: 'shield-keyhole', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Protect the enterprise from cyber threats.', parentId: 'fn-technology-data' },
  { id: 'fn-app-dev', name: 'Application Development', abbrev: 'DEV', icon: 'cube', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Build and run the applications the business uses.', parentId: 'fn-technology-data' },
  { id: 'fn-infra-cloud', name: 'Infrastructure & Cloud', abbrev: 'INFRA', icon: 'server', color: '#6f3fa8', category: 'Capabilities & Teams', mission: 'Provide reliable, scalable compute, network, and cloud services.', parentId: 'fn-technology-data' },

  { id: 'fn-solution-architecture', name: 'Solution Architecture', abbrev: 'SA', icon: 'organization', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Design solutions that align to enterprise architecture standards.', parentId: 'fn-enterprise-arch' },
  { id: 'fn-integration-arch', name: 'Integration Architecture', abbrev: 'IA', icon: 'server', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Design the enterprise’s API and integration patterns.', parentId: 'fn-enterprise-arch' },
  { id: 'fn-data-governance', name: 'Data Governance', abbrev: 'DG', icon: 'shield-task', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Set data-quality, stewardship, and classification policy.', parentId: 'fn-data-platform' },
  { id: 'fn-data-engineering', name: 'Data Engineering', abbrev: 'DE', icon: 'database', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Build and operate data pipelines and the lakehouse.', parentId: 'fn-data-platform' },
  { id: 'fn-analytics-bi', name: 'Analytics & BI', abbrev: 'BI', icon: 'data-histogram', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Deliver dashboards and self-service analytics to the business.', parentId: 'fn-data-platform' },
  { id: 'fn-security-operations', name: 'Security Operations Center', abbrev: 'SOC', icon: 'shield-keyhole', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Monitor, detect, and respond to security incidents 24x7.', parentId: 'fn-cybersecurity' },
  { id: 'fn-identity-access', name: 'Identity & Access Management', abbrev: 'IAM', icon: 'lock-closed', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Govern identity, authentication, and access entitlements.', parentId: 'fn-cybersecurity' },
  { id: 'fn-platform-engineering', name: 'Platform Engineering', abbrev: 'PE', icon: 'cube', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Build internal developer platforms and golden paths.', parentId: 'fn-app-dev' },
  { id: 'fn-devops', name: 'DevOps & Release Engineering', abbrev: 'DEVOPS', icon: 'gear', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Automate build, test, and release pipelines.', parentId: 'fn-app-dev' },
  { id: 'fn-cloud-operations', name: 'Cloud Operations', abbrev: 'CLOUDOPS', icon: 'server', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Operate and optimize the enterprise’s cloud footprint.', parentId: 'fn-infra-cloud' },
  { id: 'fn-network-engineering', name: 'Network Engineering', abbrev: 'NET', icon: 'wifi', color: '#9573c9', category: 'Capabilities & Teams', mission: 'Design and operate enterprise network infrastructure.', parentId: 'fn-infra-cloud' },

  // ── Product & Engineering capabilities ─────────────────────────────────────
  { id: 'fn-product-mgmt', name: 'Product Management', abbrev: 'PM', icon: 'lightbulb-filament', color: '#1390ad', category: 'Capabilities & Teams', mission: 'Own product strategy, roadmap, and customer outcomes.', parentId: 'fn-product-engineering' },
  { id: 'fn-research-dev', name: 'Research & Development', abbrev: 'R&D', icon: 'beaker', color: '#1390ad', category: 'Capabilities & Teams', mission: 'Research new technologies, materials, and methods.', parentId: 'fn-product-engineering' },
  { id: 'fn-engineering', name: 'Engineering', abbrev: 'ENG', icon: 'wrench', color: '#1390ad', category: 'Capabilities & Teams', mission: 'Design and deliver the products on the roadmap.', parentId: 'fn-product-engineering' },

  { id: 'fn-product-strategy', name: 'Product Strategy', abbrev: 'PSTR', icon: 'lightbulb-filament', color: '#4fb3c9', category: 'Capabilities & Teams', mission: 'Set product vision, positioning, and roadmap priorities.', parentId: 'fn-product-mgmt' },
  { id: 'fn-ux-research', name: 'UX Research & Design', abbrev: 'UXR', icon: 'person-star', color: '#4fb3c9', category: 'Capabilities & Teams', mission: 'Research user needs and design product experiences.', parentId: 'fn-product-mgmt' },
  { id: 'fn-applied-research', name: 'Applied Research', abbrev: 'APPR', icon: 'beaker', color: '#4fb3c9', category: 'Capabilities & Teams', mission: 'Apply research findings to near-term product opportunities.', parentId: 'fn-research-dev' },
  { id: 'fn-innovation-labs', name: 'Innovation Labs', abbrev: 'ILAB', icon: 'lightbulb', color: '#4fb3c9', category: 'Capabilities & Teams', mission: 'Incubate early-stage concepts and emerging technology.', parentId: 'fn-research-dev' },
  { id: 'fn-hardware-engineering', name: 'Hardware Engineering', abbrev: 'HW', icon: 'toolbox', color: '#4fb3c9', category: 'Capabilities & Teams', mission: 'Design and validate physical product hardware.', parentId: 'fn-engineering' },
  { id: 'fn-software-engineering', name: 'Software Engineering', abbrev: 'SW', icon: 'cube', color: '#4fb3c9', category: 'Capabilities & Teams', mission: 'Design and build the software behind the product.', parentId: 'fn-engineering' },

  // ── Legal & Corporate Affairs capabilities ─────────────────────────────────
  { id: 'fn-legal-counsel', name: 'Legal Counsel & Contracts', abbrev: 'LC', icon: 'gavel', color: '#54548a', category: 'Capabilities & Teams', mission: 'Advise the business and manage the contract lifecycle.', parentId: 'fn-legal-corporate' },
  { id: 'fn-regulatory', name: 'Regulatory Affairs', abbrev: 'REG', icon: 'document', color: '#54548a', category: 'Capabilities & Teams', mission: 'Navigate industry regulation and licensing.', parentId: 'fn-legal-corporate' },
  { id: 'fn-corp-comms', name: 'Corporate Communications', abbrev: 'COMMS', icon: 'megaphone', color: '#54548a', category: 'Capabilities & Teams', mission: 'Tell the enterprise’s story inside and out.', parentId: 'fn-legal-corporate' },
  { id: 'fn-esg', name: 'ESG & Sustainability', abbrev: 'ESG', icon: 'leaf-three', color: '#54548a', category: 'Capabilities & Teams', mission: 'Measure and improve environmental and social impact.', parentId: 'fn-legal-corporate' },

  { id: 'fn-contract-mgmt', name: 'Contract Lifecycle Management', abbrev: 'CLM', icon: 'document', color: '#8484b8', category: 'Capabilities & Teams', mission: 'Draft, negotiate, and manage enterprise contracts.', parentId: 'fn-legal-counsel' },
  { id: 'fn-litigation', name: 'Litigation & Disputes', abbrev: 'LIT', icon: 'gavel', color: '#8484b8', category: 'Capabilities & Teams', mission: 'Manage litigation, arbitration, and dispute resolution.', parentId: 'fn-legal-counsel' },
  { id: 'fn-licensing-compliance', name: 'Licensing & Permitting', abbrev: 'L&P', icon: 'document', color: '#8484b8', category: 'Capabilities & Teams', mission: 'Secure and maintain regulatory licenses and permits.', parentId: 'fn-regulatory' },
  { id: 'fn-govt-affairs', name: 'Government Affairs', abbrev: 'GA', icon: 'building-government', color: '#8484b8', category: 'Capabilities & Teams', mission: 'Manage relationships with regulators and policymakers.', parentId: 'fn-regulatory' },
  { id: 'fn-internal-comms', name: 'Internal Communications', abbrev: 'IC', icon: 'megaphone', color: '#8484b8', category: 'Capabilities & Teams', mission: 'Communicate strategy and change to employees.', parentId: 'fn-corp-comms' },
  { id: 'fn-media-relations', name: 'Media Relations', abbrev: 'MR', icon: 'megaphone', color: '#8484b8', category: 'Capabilities & Teams', mission: 'Manage press relationships and public messaging.', parentId: 'fn-corp-comms' },
  { id: 'fn-sustainability-reporting', name: 'Sustainability Reporting', abbrev: 'SUSR', icon: 'leaf-three', color: '#8484b8', category: 'Capabilities & Teams', mission: 'Report ESG metrics to investors and regulators.', parentId: 'fn-esg' },

  // ── Financial Services vertical capabilities ───────────────────────────────
  { id: 'fn-fs-retail-banking', name: 'Retail Banking', abbrev: 'RB', icon: 'building-bank', color: '#3f86c9', category: 'Capabilities & Teams', mission: 'Serve consumer deposit, lending, and branch banking.', parentId: 'fn-financial-services' },
  { id: 'fn-fs-commercial-banking', name: 'Commercial & Corporate Banking', abbrev: 'CCB', icon: 'building-bank', color: '#3f86c9', category: 'Capabilities & Teams', mission: 'Serve business lending, treasury, and corporate banking clients.', parentId: 'fn-financial-services' },
  { id: 'fn-fs-wealth-management', name: 'Wealth & Asset Management', abbrev: 'WAM', icon: 'data-trending', color: '#3f86c9', category: 'Capabilities & Teams', mission: 'Manage investment portfolios and advisory relationships.', parentId: 'fn-financial-services' },
  { id: 'fn-fs-payments', name: 'Payments', abbrev: 'PAY', icon: 'money-hand', color: '#3f86c9', category: 'Capabilities & Teams', mission: 'Process consumer and commercial payment transactions.', parentId: 'fn-financial-services' },
  { id: 'fn-fs-underwriting', name: 'Insurance Underwriting', abbrev: 'UW', icon: 'shield-task', color: '#3f86c9', category: 'Capabilities & Teams', mission: 'Assess and price insurance risk.', parentId: 'fn-financial-services' },
  { id: 'fn-fs-claims', name: 'Claims Management', abbrev: 'CLM', icon: 'document', color: '#3f86c9', category: 'Capabilities & Teams', mission: 'Process and settle insurance claims.', parentId: 'fn-financial-services' },
  { id: 'fn-fs-fraud', name: 'Fraud & Financial Crimes', abbrev: 'FFC', icon: 'shield-keyhole', color: '#3f86c9', category: 'Capabilities & Teams', mission: 'Detect and investigate fraud, AML, and financial-crime risk.', parentId: 'fn-financial-services' },
  { id: 'fn-fs-card-processing', name: 'Card Processing', abbrev: 'CARD', icon: 'money-hand', color: '#75aede', category: 'Capabilities & Teams', mission: 'Authorize, clear, and settle card transactions.', parentId: 'fn-fs-payments' },
  { id: 'fn-fs-real-time-payments', name: 'Real-Time Payments', abbrev: 'RTP', icon: 'flash', color: '#75aede', category: 'Capabilities & Teams', mission: 'Process instant account-to-account payment rails.', parentId: 'fn-fs-payments' },

  // ── Healthcare & Life Sciences vertical capabilities ───────────────────────
  { id: 'fn-hls-clinical-ops', name: 'Clinical Operations', abbrev: 'CLINOPS', icon: 'stethoscope', color: '#d15d84', category: 'Capabilities & Teams', mission: 'Run day-to-day clinical care delivery operations.', parentId: 'fn-healthcare-life-sciences' },
  { id: 'fn-hls-revenue-cycle', name: 'Revenue Cycle Management', abbrev: 'RCM', icon: 'wallet', color: '#d15d84', category: 'Capabilities & Teams', mission: 'Manage patient billing, coding, and claims reimbursement.', parentId: 'fn-healthcare-life-sciences' },
  { id: 'fn-hls-population-health', name: 'Population Health', abbrev: 'POPH', icon: 'people', color: '#d15d84', category: 'Capabilities & Teams', mission: 'Manage care and outcomes across a patient population.', parentId: 'fn-healthcare-life-sciences' },
  { id: 'fn-hls-clinical-research', name: 'Clinical Research & Trials', abbrev: 'CRT', icon: 'beaker', color: '#d15d84', category: 'Capabilities & Teams', mission: 'Design and run clinical trials for new therapies.', parentId: 'fn-healthcare-life-sciences' },
  { id: 'fn-hls-pharmacy', name: 'Pharmacy Operations', abbrev: 'RX', icon: 'pill', color: '#d15d84', category: 'Capabilities & Teams', mission: 'Dispense medication and manage pharmacy benefit operations.', parentId: 'fn-healthcare-life-sciences' },
  { id: 'fn-hls-regulatory-affairs', name: 'Regulatory Affairs (FDA Submissions)', abbrev: 'RA', icon: 'document', color: '#d15d84', category: 'Capabilities & Teams', mission: 'Manage regulatory submissions and approvals for therapies.', parentId: 'fn-healthcare-life-sciences' },
  { id: 'fn-hls-care-coordination', name: 'Care Coordination', abbrev: 'CC', icon: 'person-heart', color: '#e392ac', category: 'Capabilities & Teams', mission: 'Coordinate care transitions across providers and settings.', parentId: 'fn-hls-clinical-ops' },
  { id: 'fn-hls-ehr-operations', name: 'EHR Operations', abbrev: 'EHR', icon: 'database', color: '#e392ac', category: 'Capabilities & Teams', mission: 'Operate and optimize the electronic health record platform.', parentId: 'fn-hls-clinical-ops' },

  // ── Retail & CPG vertical capabilities ─────────────────────────────────────
  { id: 'fn-retail-merchandising', name: 'Merchandising', abbrev: 'MERCH', icon: 'box', color: '#dc9450', category: 'Capabilities & Teams', mission: 'Plan assortments, pricing, and promotions.', parentId: 'fn-retail-cpg' },
  { id: 'fn-retail-store-ops', name: 'Store Operations', abbrev: 'STORE', icon: 'building', color: '#dc9450', category: 'Capabilities & Teams', mission: 'Run day-to-day store operations and labor scheduling.', parentId: 'fn-retail-cpg' },
  { id: 'fn-retail-ecommerce', name: 'eCommerce & Omnichannel', abbrev: 'OMNI', icon: 'globe', color: '#dc9450', category: 'Capabilities & Teams', mission: 'Unify online and in-store shopping experiences.', parentId: 'fn-retail-cpg' },
  { id: 'fn-retail-category-mgmt', name: 'Category Management', abbrev: 'CATM', icon: 'chart-multiple', color: '#dc9450', category: 'Capabilities & Teams', mission: 'Manage product category performance and vendor relationships.', parentId: 'fn-retail-cpg' },
  { id: 'fn-cpg-trade-promotion', name: 'Trade Promotion Management', abbrev: 'TPM', icon: 'megaphone', color: '#dc9450', category: 'Capabilities & Teams', mission: 'Plan and settle trade-promotion spend with retail partners.', parentId: 'fn-retail-cpg' },
  { id: 'fn-retail-assortment-planning', name: 'Assortment Planning', abbrev: 'AP', icon: 'box', color: '#eab682', category: 'Capabilities & Teams', mission: 'Plan product assortment by store cluster and season.', parentId: 'fn-retail-merchandising' },
  { id: 'fn-retail-pricing', name: 'Pricing & Promotions', abbrev: 'P&P', icon: 'money', color: '#eab682', category: 'Capabilities & Teams', mission: 'Set everyday and promotional pricing strategy.', parentId: 'fn-retail-merchandising' },

  // ── Manufacturing & Industrial vertical capabilities ───────────────────────
  { id: 'fn-mfg-industrial-plant-floor', name: 'Plant Floor / MES', abbrev: 'MES', icon: 'factory', color: '#8f8f4a', category: 'Capabilities & Teams', mission: 'Run manufacturing execution systems on the plant floor.', parentId: 'fn-manufacturing-industrial' },
  { id: 'fn-mfg-industrial-supply-chain', name: 'Industrial Supply Chain', abbrev: 'ISC', icon: 'truck', color: '#8f8f4a', category: 'Capabilities & Teams', mission: 'Plan and manage the industrial supply chain end to end.', parentId: 'fn-manufacturing-industrial' },
  { id: 'fn-mfg-industrial-product-lifecycle', name: 'Product Lifecycle Management', abbrev: 'PLM', icon: 'cube', color: '#8f8f4a', category: 'Capabilities & Teams', mission: 'Manage product design data across its lifecycle.', parentId: 'fn-manufacturing-industrial' },
  { id: 'fn-mfg-industrial-field-service', name: 'Field Service & Aftermarket', abbrev: 'FSA', icon: 'wrench', color: '#8f8f4a', category: 'Capabilities & Teams', mission: 'Service installed equipment and sell aftermarket parts.', parentId: 'fn-manufacturing-industrial' },
  { id: 'fn-mfg-industrial-oee', name: 'OEE & Downtime Analytics', abbrev: 'OEE', icon: 'data-histogram', color: '#b3b374', category: 'Capabilities & Teams', mission: 'Measure equipment effectiveness and downtime causes.', parentId: 'fn-mfg-industrial-plant-floor' },
  { id: 'fn-mfg-industrial-predictive-maint', name: 'Predictive Maintenance', abbrev: 'PdM', icon: 'pulse', color: '#b3b374', category: 'Capabilities & Teams', mission: 'Predict equipment failure from sensor and telemetry data.', parentId: 'fn-mfg-industrial-plant-floor' },

  // ── Energy & Utilities vertical capabilities ───────────────────────────────
  { id: 'fn-eu-generation', name: 'Generation & Production', abbrev: 'GEN', icon: 'flash', color: '#e0a94a', category: 'Capabilities & Teams', mission: 'Operate power generation and production assets.', parentId: 'fn-energy-utilities' },
  { id: 'fn-eu-grid-ops', name: 'Grid / Distribution Operations', abbrev: 'GRID', icon: 'wifi', color: '#e0a94a', category: 'Capabilities & Teams', mission: 'Operate and balance the electric distribution grid.', parentId: 'fn-energy-utilities' },
  { id: 'fn-eu-metering-billing', name: 'Metering & Billing', abbrev: 'M&B', icon: 'money', color: '#e0a94a', category: 'Capabilities & Teams', mission: 'Meter consumption and bill utility customers.', parentId: 'fn-energy-utilities' },
  { id: 'fn-eu-trading-risk', name: 'Energy Trading & Risk', abbrev: 'ETRM', icon: 'data-trending', color: '#e0a94a', category: 'Capabilities & Teams', mission: 'Trade energy commodities and manage market risk.', parentId: 'fn-energy-utilities' },
  { id: 'fn-eu-outage-management', name: 'Outage Management', abbrev: 'OMS', icon: 'flash', color: '#eec27f', category: 'Capabilities & Teams', mission: 'Detect, manage, and restore service outages.', parentId: 'fn-eu-grid-ops' },
  { id: 'fn-eu-asset-performance', name: 'Asset Performance Management', abbrev: 'APM', icon: 'pulse', color: '#eec27f', category: 'Capabilities & Teams', mission: 'Monitor and optimize grid-asset health and performance.', parentId: 'fn-eu-grid-ops' },

  // ── Technology / ISV vertical capabilities ─────────────────────────────────
  { id: 'fn-isv-product-engineering', name: 'Product Engineering', abbrev: 'PENG', icon: 'cube', color: '#7a68c9', category: 'Capabilities & Teams', mission: 'Build and ship the software product.', parentId: 'fn-technology-isv' },
  { id: 'fn-isv-cloud-platform-ops', name: 'Cloud Platform Operations', abbrev: 'CPO', icon: 'server', color: '#7a68c9', category: 'Capabilities & Teams', mission: 'Operate the multi-tenant SaaS cloud platform.', parentId: 'fn-technology-isv' },
  { id: 'fn-isv-customer-success', name: 'Customer Success & Renewals', abbrev: 'CS', icon: 'person-heart', color: '#7a68c9', category: 'Capabilities & Teams', mission: 'Drive adoption, retention, and renewal of subscriptions.', parentId: 'fn-technology-isv' },
  { id: 'fn-isv-partner-ecosystem', name: 'Partner & ISV Ecosystem', abbrev: 'PE', icon: 'people-team', color: '#7a68c9', category: 'Capabilities & Teams', mission: 'Manage the partner, reseller, and marketplace ecosystem.', parentId: 'fn-technology-isv' },
  { id: 'fn-isv-site-reliability', name: 'Site Reliability Engineering', abbrev: 'SRE', icon: 'pulse', color: '#a698de', category: 'Capabilities & Teams', mission: 'Own platform uptime, incident response, and SLOs.', parentId: 'fn-isv-cloud-platform-ops' },
  { id: 'fn-isv-billing-metering', name: 'Usage Metering & Billing', abbrev: 'UMB', icon: 'money', color: '#a698de', category: 'Capabilities & Teams', mission: 'Meter usage and bill customers for consumption-based pricing.', parentId: 'fn-isv-cloud-platform-ops' },

  // ── Transportation & Logistics vertical capabilities ───────────────────────
  { id: 'fn-tl-fleet-ops', name: 'Fleet Operations', abbrev: 'FLEET', icon: 'truck', color: '#4a9c7e', category: 'Capabilities & Teams', mission: 'Operate and maintain the enterprise vehicle fleet.', parentId: 'fn-transportation-logistics' },
  { id: 'fn-tl-freight-brokerage', name: 'Freight Brokerage', abbrev: 'BROK', icon: 'truck', color: '#4a9c7e', category: 'Capabilities & Teams', mission: 'Broker freight capacity between shippers and carriers.', parentId: 'fn-transportation-logistics' },
  { id: 'fn-tl-warehousing-3pl', name: 'Warehousing & 3PL', abbrev: '3PL', icon: 'box', color: '#4a9c7e', category: 'Capabilities & Teams', mission: 'Operate third-party logistics and warehousing services.', parentId: 'fn-transportation-logistics' },
  { id: 'fn-tl-last-mile', name: 'Last-Mile Delivery', abbrev: 'LM', icon: 'truck', color: '#4a9c7e', category: 'Capabilities & Teams', mission: 'Deliver goods to the final customer destination.', parentId: 'fn-transportation-logistics' },
  { id: 'fn-tl-route-optimization', name: 'Route Optimization', abbrev: 'ROUTE', icon: 'navigation', color: '#7fc4ab', category: 'Capabilities & Teams', mission: 'Optimize delivery routes for cost and time.', parentId: 'fn-tl-fleet-ops' },
  { id: 'fn-tl-driver-safety', name: 'Driver Safety & Compliance', abbrev: 'DSC', icon: 'shield-task', color: '#7fc4ab', category: 'Capabilities & Teams', mission: 'Monitor driver safety and regulatory compliance (ELD, HOS).', parentId: 'fn-tl-fleet-ops' },

  // ── Professional Services vertical capabilities ────────────────────────────
  { id: 'fn-ps-engagement-delivery', name: 'Engagement Delivery', abbrev: 'ED', icon: 'people-team', color: '#8a7ade', category: 'Capabilities & Teams', mission: 'Deliver client engagements on scope, time, and budget.', parentId: 'fn-professional-services' },
  { id: 'fn-ps-resource-management', name: 'Resource & Staffing Management', abbrev: 'RSM', icon: 'people', color: '#8a7ade', category: 'Capabilities & Teams', mission: 'Staff engagements and manage consultant utilization.', parentId: 'fn-professional-services' },
  { id: 'fn-ps-practice-development', name: 'Practice Development', abbrev: 'PD', icon: 'lightbulb', color: '#8a7ade', category: 'Capabilities & Teams', mission: 'Build practice methodology, IP, and offerings.', parentId: 'fn-professional-services' },
  { id: 'fn-ps-billing-realization', name: 'Billing & Realization', abbrev: 'B&R', icon: 'wallet', color: '#8a7ade', category: 'Capabilities & Teams', mission: 'Bill clients and manage revenue realization rates.', parentId: 'fn-professional-services' },
  { id: 'fn-ps-project-governance', name: 'Project Governance', abbrev: 'PG', icon: 'shield-task', color: '#b3a8ec', category: 'Capabilities & Teams', mission: 'Govern project risk, scope, and steering-committee reporting.', parentId: 'fn-ps-engagement-delivery' },
  { id: 'fn-ps-quality-assurance-ps', name: 'Engagement Quality Assurance', abbrev: 'EQA', icon: 'ribbon', color: '#b3a8ec', category: 'Capabilities & Teams', mission: 'Review engagement deliverables for quality standards.', parentId: 'fn-ps-engagement-delivery' },
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
