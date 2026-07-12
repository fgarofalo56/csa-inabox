/**
 * State & Local Government library — the lines of business a U.S. state,
 * county, or municipal government runs, modeled as Loom domains (issue #1483,
 * Wave 1).
 *
 * Unlike the Federal Civilian library (a specific org chart), state and local
 * structures vary by jurisdiction — so this library models the FUNCTIONAL
 * taxonomy that is common across them (NASCIO/state-CIO lines of business):
 * Health & Human Services, Public Safety & Justice, Transportation, Revenue,
 * Education, Labor & Workforce, Environment, and General Government, each
 * with its well-known program areas (Medicaid, 911/dispatch, DMV,
 * unemployment insurance, K-12, …). Rename after creation to match the
 * jurisdiction ("Department of Health Services", "Office of Emergency
 * Management", …).
 *
 * NO copyrighted seals: generic Fluent icons + brand-ish colors only.
 */
import type { DomainLibrary, DomainLibraryNode } from './types';

export type StateLocalCategory = 'Lines of Business' | 'Programs & Offices';

/** Palette anchors per line of business (children share a tint of the hue). */
const C = {
  hhs: '#0078d4', safety: '#a4262c', dot: '#5c2d91', revenue: '#0b6a0b',
  education: '#881798', labor: '#bd7800', environment: '#498205', admin: '#605e5c',
};

export const STATE_LOCAL_NODES: DomainLibraryNode[] = [
  // ── Lines of Business (Enterprises) ────────────────────────────────────────
  { id: 'sled-health-human-services', name: 'Health & Human Services', abbrev: 'HHS', icon: 'heart-pulse', color: C.hhs, category: 'Lines of Business', mission: 'Deliver health coverage, public health, and social services to residents.' },
  { id: 'sled-public-safety', name: 'Public Safety & Justice', abbrev: 'PSJ', icon: 'shield', color: C.safety, category: 'Lines of Business', mission: 'Protect residents through law enforcement, emergency response, and the courts.' },
  { id: 'sled-transportation', name: 'Transportation & Infrastructure', abbrev: 'DOT', icon: 'navigation', color: C.dot, category: 'Lines of Business', mission: 'Plan, build, and operate the jurisdiction’s transportation network.' },
  { id: 'sled-revenue-finance', name: 'Revenue & Finance', abbrev: 'REV', icon: 'money', color: C.revenue, category: 'Lines of Business', mission: 'Collect revenue and steward the jurisdiction’s finances.' },
  { id: 'sled-education', name: 'Education', abbrev: 'EDU', icon: 'graduation', color: C.education, category: 'Lines of Business', mission: 'Oversee public education from early childhood through higher ed.' },
  { id: 'sled-labor-workforce', name: 'Labor & Workforce', abbrev: 'LWD', icon: 'wrench', color: C.labor, category: 'Lines of Business', mission: 'Support workers, job seekers, and employers across the labor market.' },
  { id: 'sled-environment', name: 'Environment & Natural Resources', abbrev: 'ENV', icon: 'leaf', color: C.environment, category: 'Lines of Business', mission: 'Protect the jurisdiction’s environment, parks, water, and wildlife.' },
  { id: 'sled-general-government', name: 'General Government & Administration', abbrev: 'ADMIN', icon: 'building-government', color: C.admin, category: 'Lines of Business', mission: 'Run the internal services that keep government working.' },

  // ── Health & Human Services programs ───────────────────────────────────────
  { id: 'sled-medicaid', name: 'Medicaid & Health Coverage', abbrev: 'MED', icon: 'heart', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Administer Medicaid, CHIP, and public health-coverage programs.', parentId: 'sled-health-human-services' },
  { id: 'sled-public-health', name: 'Public Health', abbrev: 'PH', icon: 'clipboard-pulse', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Track, prevent, and respond to disease and health threats.', parentId: 'sled-health-human-services' },
  { id: 'sled-child-family', name: 'Child & Family Services', abbrev: 'CFS', icon: 'people', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Protect children and strengthen families through welfare services.', parentId: 'sled-health-human-services' },
  { id: 'sled-behavioral-health', name: 'Behavioral Health', abbrev: 'BH', icon: 'person-heart', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Provide mental-health and substance-use services and supports.', parentId: 'sled-health-human-services' },
  { id: 'sled-aging-disability', name: 'Aging & Disability Services', abbrev: 'ADS', icon: 'stethoscope', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Support older adults and people with disabilities to live independently.', parentId: 'sled-health-human-services' },
  { id: 'sled-eligibility', name: 'Eligibility & Enrollment', abbrev: 'E&E', icon: 'document', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Determine eligibility and enroll residents in benefit programs.', parentId: 'sled-health-human-services' },

  // ── Public Safety & Justice programs ───────────────────────────────────────
  { id: 'sled-law-enforcement', name: 'Law Enforcement', abbrev: 'LE', icon: 'shield-task', color: '#bd4347', category: 'Programs & Offices', mission: 'Police the jurisdiction and investigate crime.', parentId: 'sled-public-safety' },
  { id: 'sled-fire-ems', name: 'Fire & EMS', abbrev: 'FIRE', icon: 'fire', color: '#bd4347', category: 'Programs & Offices', mission: 'Respond to fires and medical emergencies.', parentId: 'sled-public-safety' },
  { id: 'sled-emergency-management', name: 'Emergency Management', abbrev: 'EM', icon: 'pulse', color: '#bd4347', category: 'Programs & Offices', mission: 'Prepare for, respond to, and recover from disasters.', parentId: 'sled-public-safety' },
  { id: 'sled-courts', name: 'Courts & Judicial', abbrev: 'CTS', icon: 'gavel', color: '#bd4347', category: 'Programs & Offices', mission: 'Administer the courts and judicial case management.', parentId: 'sled-public-safety' },
  { id: 'sled-corrections', name: 'Corrections & Community Supervision', abbrev: 'DOC', icon: 'lock-closed', color: '#bd4347', category: 'Programs & Offices', mission: 'Operate correctional facilities, probation, and parole.', parentId: 'sled-public-safety' },
  { id: 'sled-911-dispatch', name: '911 & Dispatch', abbrev: '911', icon: 'cellular', color: '#bd4347', category: 'Programs & Offices', mission: 'Answer emergency calls and dispatch first responders.', parentId: 'sled-public-safety' },

  // ── Transportation programs ────────────────────────────────────────────────
  { id: 'sled-highways', name: 'Highways & Bridges', abbrev: 'HWY', icon: 'map', color: '#6f3fa8', category: 'Programs & Offices', mission: 'Build and maintain roads, highways, and bridges.', parentId: 'sled-transportation' },
  { id: 'sled-transit', name: 'Public Transit', abbrev: 'TRN', icon: 'train', color: '#6f3fa8', category: 'Programs & Offices', mission: 'Operate and fund bus, rail, and paratransit service.', parentId: 'sled-transportation' },
  { id: 'sled-dmv', name: 'Motor Vehicles', abbrev: 'DMV', icon: 'car', color: '#6f3fa8', category: 'Programs & Offices', mission: 'License drivers and register and title vehicles.', parentId: 'sled-transportation' },
  { id: 'sled-aviation-ports', name: 'Aviation & Ports', abbrev: 'A&P', icon: 'airplane', color: '#6f3fa8', category: 'Programs & Offices', mission: 'Oversee airports, seaports, and freight gateways.', parentId: 'sled-transportation' },
  { id: 'sled-traffic-safety', name: 'Traffic Operations & Safety', abbrev: 'TOS', icon: 'shield-task', color: '#6f3fa8', category: 'Programs & Offices', mission: 'Manage traffic systems and improve roadway safety.', parentId: 'sled-transportation' },

  // ── Revenue & Finance programs ─────────────────────────────────────────────
  { id: 'sled-tax-administration', name: 'Tax Administration', abbrev: 'TAX', icon: 'document', color: '#2b7a2b', category: 'Programs & Offices', mission: 'Administer and collect income, sales, and property taxes.', parentId: 'sled-revenue-finance' },
  { id: 'sled-budget', name: 'Budget & Comptroller', abbrev: 'BUD', icon: 'chart-multiple', color: '#2b7a2b', category: 'Programs & Offices', mission: 'Prepare the budget and control expenditures and accounting.', parentId: 'sled-revenue-finance' },
  { id: 'sled-procurement', name: 'Procurement & Contracts', abbrev: 'PROC', icon: 'box', color: '#2b7a2b', category: 'Programs & Offices', mission: 'Source goods and services and manage public contracts.', parentId: 'sled-revenue-finance' },
  { id: 'sled-treasury', name: 'Treasury & Debt Management', abbrev: 'TRS', icon: 'vault', color: '#2b7a2b', category: 'Programs & Offices', mission: 'Manage cash, investments, and public debt.', parentId: 'sled-revenue-finance' },

  // ── Education programs ─────────────────────────────────────────────────────
  { id: 'sled-k12', name: 'K-12 Administration', abbrev: 'K12', icon: 'book', color: '#9c2faa', category: 'Programs & Offices', mission: 'Oversee elementary and secondary public education.', parentId: 'sled-education' },
  { id: 'sled-higher-ed', name: 'Higher Education', abbrev: 'HED', icon: 'graduation', color: '#9c2faa', category: 'Programs & Offices', mission: 'Coordinate public colleges, universities, and student aid.', parentId: 'sled-education' },
  { id: 'sled-early-childhood', name: 'Early Childhood', abbrev: 'EC', icon: 'people', color: '#9c2faa', category: 'Programs & Offices', mission: 'Deliver pre-K, child care, and early-learning programs.', parentId: 'sled-education' },
  { id: 'sled-assessment', name: 'Student Data & Assessment', abbrev: 'SDA', icon: 'data-histogram', color: '#9c2faa', category: 'Programs & Offices', mission: 'Run statewide assessment and longitudinal student data systems.', parentId: 'sled-education' },
  { id: 'sled-school-finance', name: 'School Finance', abbrev: 'SF', icon: 'wallet', color: '#9c2faa', category: 'Programs & Offices', mission: 'Distribute and account for school funding formulas and grants.', parentId: 'sled-education' },

  // ── Labor & Workforce programs ─────────────────────────────────────────────
  { id: 'sled-unemployment', name: 'Unemployment Insurance', abbrev: 'UI', icon: 'wallet', color: '#d4a017', category: 'Programs & Offices', mission: 'Pay unemployment benefits and collect employer contributions.', parentId: 'sled-labor-workforce' },
  { id: 'sled-workforce-dev', name: 'Workforce Development', abbrev: 'WFD', icon: 'people-team', color: '#d4a017', category: 'Programs & Offices', mission: 'Connect job seekers to training and employers to talent.', parentId: 'sled-labor-workforce' },
  { id: 'sled-licensing', name: 'Professional Licensing', abbrev: 'LIC', icon: 'ribbon', color: '#d4a017', category: 'Programs & Offices', mission: 'License and regulate trades and professions.', parentId: 'sled-labor-workforce' },

  // ── Environment programs ───────────────────────────────────────────────────
  { id: 'sled-environmental-quality', name: 'Environmental Quality', abbrev: 'EQ', icon: 'leaf-three', color: '#5fa024', category: 'Programs & Offices', mission: 'Regulate air, water, and waste to protect public health.', parentId: 'sled-environment' },
  { id: 'sled-parks-recreation', name: 'Parks & Recreation', abbrev: 'PRK', icon: 'tree', color: '#5fa024', category: 'Programs & Offices', mission: 'Operate parks, trails, and recreation programs.', parentId: 'sled-environment' },
  { id: 'sled-water-resources', name: 'Water Resources', abbrev: 'WTR', icon: 'water', color: '#5fa024', category: 'Programs & Offices', mission: 'Manage water supply, rights, and flood control.', parentId: 'sled-environment' },
  { id: 'sled-fish-wildlife', name: 'Fish & Wildlife', abbrev: 'F&W', icon: 'plant', color: '#5fa024', category: 'Programs & Offices', mission: 'Conserve fish, game, and wildlife habitats.', parentId: 'sled-environment' },

  // ── General Government programs ────────────────────────────────────────────
  { id: 'sled-human-resources', name: 'Human Resources', abbrev: 'HR', icon: 'people-team', color: '#7a7574', category: 'Programs & Offices', mission: 'Recruit, classify, and support the public workforce.', parentId: 'sled-general-government' },
  { id: 'sled-it-digital', name: 'IT & Digital Services', abbrev: 'IT', icon: 'server', color: '#7a7574', category: 'Programs & Offices', mission: 'Deliver technology, digital services, and cybersecurity.', parentId: 'sled-general-government' },
  { id: 'sled-facilities-fleet', name: 'Facilities & Fleet', abbrev: 'F&F', icon: 'building-multiple', color: '#7a7574', category: 'Programs & Offices', mission: 'Manage public buildings, grounds, and vehicle fleets.', parentId: 'sled-general-government' },
  { id: 'sled-elections', name: 'Elections & Records', abbrev: 'ELE', icon: 'vote', color: '#7a7574', category: 'Programs & Offices', mission: 'Run elections and maintain official public records.', parentId: 'sled-general-government' },
];

export const STATE_LOCAL_LIBRARY: DomainLibrary = {
  id: 'state-local',
  name: 'State & Local Government',
  label: 'State & Local Government library',
  description: 'Lines of business and program areas for state, county, and city government.',
  icon: 'building-multiple',
  color: '#1b6b8c',
  categories: ['Lines of Business', 'Programs & Offices'] satisfies StateLocalCategory[],
  nodes: STATE_LOCAL_NODES,
  copy: {
    enterpriseNoun: 'lines of business',
    childNoun: 'programs & offices',
    drillNoun: 'program areas',
    itemPlural: 'programs',
    itemSingular: 'program',
    searchPlaceholder: 'Search lines of business & programs…',
  },
};
