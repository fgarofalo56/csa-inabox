/**
 * State & Local Government library — the lines of business a U.S. state,
 * county, municipal, tribal, or territorial government runs, modeled as Loom
 * domains (issue #1483; Wave 1 shallow stub deepened to a genuine
 * multi-level taxonomy in Wave 2).
 *
 * Unlike the Federal Civilian library (a specific org chart), state and local
 * structures vary by jurisdiction — so this library models the FUNCTIONAL
 * taxonomy that is common across them (NASCIO/state-CIO lines of business):
 * Health & Human Services, Public Safety & Justice, Transportation, Revenue,
 * Education, Labor & Workforce, Environment, and General Government, each
 * deepened to agency → division → office (Medicaid → Managed Care Division,
 * DMV → Driver Licensing, K-12 → an example district → its schools, Higher Ed
 * → a state university system → a flagship university). Local, Tribal, and
 * Territorial government are modeled as additional lines of business with
 * their own representative department trees (County → Sheriff/Health/
 * Assessor; City → Police/Public Works/Planning; Tribal Council → Health/
 * Natural Resources/Gaming; Territory → Governor/Health/Education/Revenue).
 * Rename after creation to match the jurisdiction ("Department of Health
 * Services", "Office of Emergency Management", …).
 *
 * NO copyrighted seals: generic Fluent icons + brand-ish colors only.
 */
import type { DomainLibrary, DomainLibraryNode } from './types';

export type StateLocalCategory = 'Lines of Business' | 'Programs & Offices';

/** Palette anchors per line of business (children share a tint of the hue). */
const C = {
  hhs: '#0078d4', safety: '#a4262c', dot: '#5c2d91', revenue: '#0b6a0b',
  education: '#881798', labor: '#bd7800', environment: '#498205', admin: '#605e5c',
  local: '#004b8d', tribal: '#7a4b1e', territorial: '#146b5c',
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
  { id: 'sled-local-government', name: 'Local Government (County & City)', abbrev: 'LOCAL', icon: 'building-multiple', color: C.local, category: 'Lines of Business', mission: 'Deliver county and municipal services closest to residents.' },
  { id: 'sled-tribal-government', name: 'Tribal Government', abbrev: 'TRIBAL', icon: 'building', color: C.tribal, category: 'Lines of Business', mission: 'Exercise tribal sovereignty and deliver services to tribal members.' },
  { id: 'sled-territorial-government', name: 'Territorial Government', abbrev: 'TERR', icon: 'earth', color: C.territorial, category: 'Lines of Business', mission: 'Govern and deliver federal-partnered services across a U.S. territory.' },

  // ── Health & Human Services programs ───────────────────────────────────────
  { id: 'sled-medicaid', name: 'Medicaid & Health Coverage', abbrev: 'MED', icon: 'heart', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Administer Medicaid, CHIP, and public health-coverage programs.', parentId: 'sled-health-human-services' },
  { id: 'sled-public-health', name: 'Public Health', abbrev: 'PH', icon: 'clipboard-pulse', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Track, prevent, and respond to disease and health threats.', parentId: 'sled-health-human-services' },
  { id: 'sled-child-family', name: 'Child & Family Services', abbrev: 'CFS', icon: 'people', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Protect children and strengthen families through welfare services.', parentId: 'sled-health-human-services' },
  { id: 'sled-behavioral-health', name: 'Behavioral Health', abbrev: 'BH', icon: 'person-heart', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Provide mental-health and substance-use services and supports.', parentId: 'sled-health-human-services' },
  { id: 'sled-aging-disability', name: 'Aging & Disability Services', abbrev: 'ADS', icon: 'stethoscope', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Support older adults and people with disabilities to live independently.', parentId: 'sled-health-human-services' },
  { id: 'sled-eligibility', name: 'Eligibility & Enrollment', abbrev: 'E&E', icon: 'document', color: '#2a8fd4', category: 'Programs & Offices', mission: 'Determine eligibility and enroll residents in benefit programs.', parentId: 'sled-health-human-services' },

  { id: 'sled-medicaid-managed-care', name: 'Managed Care Division', abbrev: 'MCD', icon: 'heart', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Contract and oversee Medicaid managed-care organizations.', parentId: 'sled-medicaid' },
  { id: 'sled-medicaid-provider-enrollment', name: 'Provider Enrollment & Compliance', abbrev: 'PEC', icon: 'document', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Enroll and audit Medicaid providers for program integrity.', parentId: 'sled-medicaid' },
  { id: 'sled-epidemiology', name: 'Epidemiology & Disease Surveillance', abbrev: 'EPI', icon: 'clipboard-pulse', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Monitor and investigate disease outbreaks statewide.', parentId: 'sled-public-health' },
  { id: 'sled-maternal-child-health', name: 'Maternal & Child Health', abbrev: 'MCH', icon: 'heart', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Improve health outcomes for mothers, infants, and children.', parentId: 'sled-public-health' },
  { id: 'sled-lab-services', name: 'Public Health Laboratory', abbrev: 'LAB', icon: 'beaker', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Provide diagnostic and environmental testing for public health.', parentId: 'sled-public-health' },
  { id: 'sled-child-protective-services', name: 'Child Protective Services', abbrev: 'CPS', icon: 'people', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Investigate and respond to reports of child abuse and neglect.', parentId: 'sled-child-family' },
  { id: 'sled-foster-care', name: 'Foster Care & Adoption', abbrev: 'FCA', icon: 'people', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Place and support children in foster care and adoptive homes.', parentId: 'sled-child-family' },
  { id: 'sled-child-support', name: 'Child Support Enforcement', abbrev: 'CSE', icon: 'wallet', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Establish and enforce child-support orders.', parentId: 'sled-child-family' },
  { id: 'sled-substance-use', name: 'Substance Use Disorder Services', abbrev: 'SUD', icon: 'pill', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Fund and deliver treatment for substance-use disorders.', parentId: 'sled-behavioral-health' },
  { id: 'sled-mental-health-crisis', name: 'Crisis & Emergency Services', abbrev: 'CES', icon: 'pulse', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Operate crisis lines and mobile mental-health response.', parentId: 'sled-behavioral-health' },
  { id: 'sled-adult-protective-services', name: 'Adult Protective Services', abbrev: 'APS', icon: 'person-heart', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Investigate abuse, neglect, and exploitation of vulnerable adults.', parentId: 'sled-aging-disability' },
  { id: 'sled-vocational-rehab', name: 'Vocational Rehabilitation', abbrev: 'VR', icon: 'wrench', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Help people with disabilities prepare for and retain employment.', parentId: 'sled-aging-disability' },
  { id: 'sled-snap', name: 'SNAP / Food Assistance', abbrev: 'SNAP', icon: 'heart', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Administer food-assistance benefits for eligible households.', parentId: 'sled-eligibility' },
  { id: 'sled-tanf', name: 'TANF / Cash Assistance', abbrev: 'TANF', icon: 'wallet', color: '#5aa9e6', category: 'Programs & Offices', mission: 'Administer temporary cash assistance for needy families.', parentId: 'sled-eligibility' },

  // ── Public Safety & Justice programs ───────────────────────────────────────
  { id: 'sled-law-enforcement', name: 'Law Enforcement', abbrev: 'LE', icon: 'shield-task', color: '#bd4347', category: 'Programs & Offices', mission: 'Police the jurisdiction and investigate crime.', parentId: 'sled-public-safety' },
  { id: 'sled-fire-ems', name: 'Fire & EMS', abbrev: 'FIRE', icon: 'fire', color: '#bd4347', category: 'Programs & Offices', mission: 'Respond to fires and medical emergencies.', parentId: 'sled-public-safety' },
  { id: 'sled-emergency-management', name: 'Emergency Management', abbrev: 'EM', icon: 'pulse', color: '#bd4347', category: 'Programs & Offices', mission: 'Prepare for, respond to, and recover from disasters.', parentId: 'sled-public-safety' },
  { id: 'sled-courts', name: 'Courts & Judicial', abbrev: 'CTS', icon: 'gavel', color: '#bd4347', category: 'Programs & Offices', mission: 'Administer the courts and judicial case management.', parentId: 'sled-public-safety' },
  { id: 'sled-corrections', name: 'Corrections & Community Supervision', abbrev: 'DOC', icon: 'lock-closed', color: '#bd4347', category: 'Programs & Offices', mission: 'Operate correctional facilities, probation, and parole.', parentId: 'sled-public-safety' },
  { id: 'sled-911-dispatch', name: '911 & Dispatch', abbrev: '911', icon: 'cellular', color: '#bd4347', category: 'Programs & Offices', mission: 'Answer emergency calls and dispatch first responders.', parentId: 'sled-public-safety' },

  { id: 'sled-state-police-patrol', name: 'Patrol Division', abbrev: 'PD', icon: 'car', color: '#d47276', category: 'Programs & Offices', mission: 'Provide statewide highway and rural patrol coverage.', parentId: 'sled-law-enforcement' },
  { id: 'sled-criminal-investigations', name: 'Bureau of Criminal Investigation', abbrev: 'BCI', icon: 'fingerprint', color: '#d47276', category: 'Programs & Offices', mission: 'Investigate major and multi-jurisdictional crimes.', parentId: 'sled-law-enforcement' },
  { id: 'sled-crime-lab', name: 'State Crime Laboratory', abbrev: 'LAB', icon: 'beaker', color: '#d47276', category: 'Programs & Offices', mission: 'Provide forensic testing to support criminal investigations.', parentId: 'sled-law-enforcement' },
  { id: 'sled-fire-marshal', name: 'Office of the State Fire Marshal', abbrev: 'OSFM', icon: 'fire', color: '#d47276', category: 'Programs & Offices', mission: 'Enforce fire code and investigate fire causes statewide.', parentId: 'sled-fire-ems' },
  { id: 'sled-ems-licensing', name: 'EMS Licensing & Certification', abbrev: 'EMSLC', icon: 'clipboard-pulse', color: '#d47276', category: 'Programs & Offices', mission: 'License EMS providers and certify emergency medical personnel.', parentId: 'sled-fire-ems' },
  { id: 'sled-disaster-recovery', name: 'Disaster Recovery & Mitigation', abbrev: 'DRM', icon: 'pulse', color: '#d47276', category: 'Programs & Offices', mission: 'Administer federal disaster-recovery and hazard-mitigation grants.', parentId: 'sled-emergency-management' },
  { id: 'sled-homeland-security-office', name: 'Office of Homeland Security', abbrev: 'OHS', icon: 'shield', color: '#d47276', category: 'Programs & Offices', mission: 'Coordinate statewide homeland-security grants and planning.', parentId: 'sled-emergency-management' },
  { id: 'sled-trial-courts', name: 'Trial Court Administration', abbrev: 'TCA', icon: 'gavel', color: '#d47276', category: 'Programs & Offices', mission: 'Administer trial-court operations and case management.', parentId: 'sled-courts' },
  { id: 'sled-appellate-courts', name: 'Appellate Courts', abbrev: 'APP', icon: 'scales', color: '#d47276', category: 'Programs & Offices', mission: 'Hear appeals of trial-court decisions.', parentId: 'sled-courts' },
  { id: 'sled-probation-services', name: 'Probation Services', abbrev: 'PROB', icon: 'people', color: '#d47276', category: 'Programs & Offices', mission: 'Supervise court-ordered probation and diversion programs.', parentId: 'sled-courts' },
  { id: 'sled-adult-institutions', name: 'Adult Institutions Division', abbrev: 'AID', icon: 'lock-closed', color: '#d47276', category: 'Programs & Offices', mission: 'Operate state adult correctional facilities.', parentId: 'sled-corrections' },
  { id: 'sled-parole-board', name: 'Board of Parole', abbrev: 'BOP', icon: 'gavel', color: '#d47276', category: 'Programs & Offices', mission: 'Decide parole release and supervision conditions.', parentId: 'sled-corrections' },
  { id: 'sled-community-supervision', name: 'Community Supervision', abbrev: 'CS', icon: 'people', color: '#d47276', category: 'Programs & Offices', mission: 'Supervise offenders serving sentences in the community.', parentId: 'sled-corrections' },
  { id: 'sled-next-gen-911', name: 'Next Generation 911 Program', abbrev: 'NG911', icon: 'cellular', color: '#d47276', category: 'Programs & Offices', mission: 'Modernize 911 systems for text, video, and data.', parentId: 'sled-911-dispatch' },

  // ── Transportation programs ────────────────────────────────────────────────
  { id: 'sled-highways', name: 'Highways & Bridges', abbrev: 'HWY', icon: 'map', color: '#6f3fa8', category: 'Programs & Offices', mission: 'Build and maintain roads, highways, and bridges.', parentId: 'sled-transportation' },
  { id: 'sled-transit', name: 'Public Transit', abbrev: 'TRN', icon: 'train', color: '#6f3fa8', category: 'Programs & Offices', mission: 'Operate and fund bus, rail, and paratransit service.', parentId: 'sled-transportation' },
  { id: 'sled-dmv', name: 'Motor Vehicles', abbrev: 'DMV', icon: 'car', color: '#6f3fa8', category: 'Programs & Offices', mission: 'License drivers and register and title vehicles.', parentId: 'sled-transportation' },
  { id: 'sled-aviation-ports', name: 'Aviation & Ports', abbrev: 'A&P', icon: 'airplane', color: '#6f3fa8', category: 'Programs & Offices', mission: 'Oversee airports, seaports, and freight gateways.', parentId: 'sled-transportation' },
  { id: 'sled-traffic-safety', name: 'Traffic Operations & Safety', abbrev: 'TOS', icon: 'shield-task', color: '#6f3fa8', category: 'Programs & Offices', mission: 'Manage traffic systems and improve roadway safety.', parentId: 'sled-transportation' },

  { id: 'sled-highway-design', name: 'Highway Design & Engineering', abbrev: 'HDE', icon: 'map', color: '#9573c9', category: 'Programs & Offices', mission: 'Design new highway and bridge construction projects.', parentId: 'sled-highways' },
  { id: 'sled-highway-maintenance', name: 'Maintenance & Operations', abbrev: 'M&O', icon: 'wrench', color: '#9573c9', category: 'Programs & Offices', mission: 'Maintain pavement, signage, and roadway infrastructure.', parentId: 'sled-highways' },
  { id: 'sled-bridge-inspection', name: 'Bridge Inspection Program', abbrev: 'BIP', icon: 'shield-task', color: '#9573c9', category: 'Programs & Offices', mission: 'Inspect and rate the condition of state-maintained bridges.', parentId: 'sled-highways' },
  { id: 'sled-transit-grants', name: 'Transit Grants & Planning', abbrev: 'TGP', icon: 'train', color: '#9573c9', category: 'Programs & Offices', mission: 'Fund and plan local and regional transit systems.', parentId: 'sled-transit' },
  { id: 'sled-rail-programs', name: 'State Rail Programs', abbrev: 'RAIL', icon: 'train', color: '#9573c9', category: 'Programs & Offices', mission: 'Plan and invest in passenger and freight rail corridors.', parentId: 'sled-transit' },
  { id: 'sled-driver-licensing', name: 'Driver Licensing', abbrev: 'DL', icon: 'car', color: '#9573c9', category: 'Programs & Offices', mission: 'Test, issue, and renew driver licenses and IDs.', parentId: 'sled-dmv' },
  { id: 'sled-vehicle-registration', name: 'Vehicle Registration & Titling', abbrev: 'VRT', icon: 'car', color: '#9573c9', category: 'Programs & Offices', mission: 'Register, title, and plate motor vehicles.', parentId: 'sled-dmv' },
  { id: 'sled-dmv-compliance', name: 'Compliance & Investigations', abbrev: 'C&I', icon: 'shield-task', color: '#9573c9', category: 'Programs & Offices', mission: 'Investigate title fraud and dealer-licensing compliance.', parentId: 'sled-dmv' },
  { id: 'sled-airport-programs', name: 'Airport Development Program', abbrev: 'ADP', icon: 'airplane', color: '#9573c9', category: 'Programs & Offices', mission: 'Fund and plan public-use airport infrastructure.', parentId: 'sled-aviation-ports' },
  { id: 'sled-port-authority-liaison', name: 'Port & Freight Programs', abbrev: 'PFP', icon: 'ship', color: '#9573c9', category: 'Programs & Offices', mission: 'Coordinate port capacity and freight-corridor investment.', parentId: 'sled-aviation-ports' },
  { id: 'sled-highway-safety-office', name: 'Highway Safety Office', abbrev: 'HSO', icon: 'shield-task', color: '#9573c9', category: 'Programs & Offices', mission: 'Run behavioral highway-safety and impaired-driving programs.', parentId: 'sled-traffic-safety' },
  { id: 'sled-traffic-engineering', name: 'Traffic Engineering', abbrev: 'TE', icon: 'navigation', color: '#9573c9', category: 'Programs & Offices', mission: 'Design signals, signage, and intersection safety improvements.', parentId: 'sled-traffic-safety' },

  // ── Revenue & Finance programs ─────────────────────────────────────────────
  { id: 'sled-tax-administration', name: 'Tax Administration', abbrev: 'TAX', icon: 'document', color: '#2b7a2b', category: 'Programs & Offices', mission: 'Administer and collect income, sales, and property taxes.', parentId: 'sled-revenue-finance' },
  { id: 'sled-budget', name: 'Budget & Comptroller', abbrev: 'BUD', icon: 'chart-multiple', color: '#2b7a2b', category: 'Programs & Offices', mission: 'Prepare the budget and control expenditures and accounting.', parentId: 'sled-revenue-finance' },
  { id: 'sled-procurement', name: 'Procurement & Contracts', abbrev: 'PROC', icon: 'box', color: '#2b7a2b', category: 'Programs & Offices', mission: 'Source goods and services and manage public contracts.', parentId: 'sled-revenue-finance' },
  { id: 'sled-treasury', name: 'Treasury & Debt Management', abbrev: 'TRS', icon: 'vault', color: '#2b7a2b', category: 'Programs & Offices', mission: 'Manage cash, investments, and public debt.', parentId: 'sled-revenue-finance' },

  { id: 'sled-income-tax-division', name: 'Income Tax Division', abbrev: 'ITD', icon: 'document', color: '#5da85d', category: 'Programs & Offices', mission: 'Administer individual and corporate income-tax collection.', parentId: 'sled-tax-administration' },
  { id: 'sled-sales-tax-division', name: 'Sales & Use Tax Division', abbrev: 'STD', icon: 'document', color: '#5da85d', category: 'Programs & Offices', mission: 'Administer sales and use tax collection and remittance.', parentId: 'sled-tax-administration' },
  { id: 'sled-property-tax-division', name: 'Property Tax Division', abbrev: 'PTD', icon: 'document', color: '#5da85d', category: 'Programs & Offices', mission: 'Set assessment standards and equalize property-tax administration.', parentId: 'sled-tax-administration' },
  { id: 'sled-budget-development', name: 'Budget Development', abbrev: 'BD', icon: 'chart-multiple', color: '#5da85d', category: 'Programs & Offices', mission: 'Build the governor’s recommended budget each cycle.', parentId: 'sled-budget' },
  { id: 'sled-financial-reporting', name: 'Statewide Financial Reporting', abbrev: 'SFR', icon: 'data-histogram', color: '#5da85d', category: 'Programs & Offices', mission: 'Produce the state’s annual comprehensive financial report.', parentId: 'sled-budget' },
  { id: 'sled-contract-administration', name: 'Contract Administration', abbrev: 'CA', icon: 'document', color: '#5da85d', category: 'Programs & Offices', mission: 'Administer statewide term contracts and cooperative purchasing.', parentId: 'sled-procurement' },
  { id: 'sled-vendor-management', name: 'Vendor & Supplier Management', abbrev: 'VSM', icon: 'people', color: '#5da85d', category: 'Programs & Offices', mission: 'Register and manage the state’s vendor base.', parentId: 'sled-procurement' },
  { id: 'sled-debt-management', name: 'Debt Management', abbrev: 'DM', icon: 'vault', color: '#5da85d', category: 'Programs & Offices', mission: 'Issue and manage the state’s bonds and long-term debt.', parentId: 'sled-treasury' },
  { id: 'sled-unclaimed-property', name: 'Unclaimed Property Division', abbrev: 'UPD', icon: 'wallet', color: '#5da85d', category: 'Programs & Offices', mission: 'Safeguard and return unclaimed property to its owners.', parentId: 'sled-treasury' },

  // ── Education programs ─────────────────────────────────────────────────────
  { id: 'sled-k12', name: 'K-12 Administration', abbrev: 'K12', icon: 'book', color: '#9c2faa', category: 'Programs & Offices', mission: 'Oversee elementary and secondary public education.', parentId: 'sled-education' },
  { id: 'sled-higher-ed', name: 'Higher Education', abbrev: 'HED', icon: 'graduation', color: '#9c2faa', category: 'Programs & Offices', mission: 'Coordinate public colleges, universities, and student aid.', parentId: 'sled-education' },
  { id: 'sled-early-childhood', name: 'Early Childhood', abbrev: 'EC', icon: 'people', color: '#9c2faa', category: 'Programs & Offices', mission: 'Deliver pre-K, child care, and early-learning programs.', parentId: 'sled-education' },
  { id: 'sled-assessment', name: 'Student Data & Assessment', abbrev: 'SDA', icon: 'data-histogram', color: '#9c2faa', category: 'Programs & Offices', mission: 'Run statewide assessment and longitudinal student data systems.', parentId: 'sled-education' },
  { id: 'sled-school-finance', name: 'School Finance', abbrev: 'SF', icon: 'wallet', color: '#9c2faa', category: 'Programs & Offices', mission: 'Distribute and account for school funding formulas and grants.', parentId: 'sled-education' },

  { id: 'sled-k12-curriculum', name: 'Curriculum & Instruction', abbrev: 'C&I', icon: 'book', color: '#c161cf', category: 'Programs & Offices', mission: 'Set academic standards and instructional guidance for districts.', parentId: 'sled-k12' },
  { id: 'sled-k12-accountability', name: 'Accountability & Accreditation', abbrev: 'A&A', icon: 'clipboard-pulse', color: '#c161cf', category: 'Programs & Offices', mission: 'Rate school performance and administer accreditation.', parentId: 'sled-k12' },
  { id: 'sled-example-district', name: 'Example Unified School District', abbrev: 'EUSD', icon: 'building', color: '#c161cf', category: 'Programs & Offices', mission: 'Operate a representative K-12 school district (rename to the real district).', parentId: 'sled-k12' },
  { id: 'sled-example-high-school', name: 'Example High School', abbrev: 'EHS', icon: 'book', color: '#dd9be3', category: 'Programs & Offices', mission: 'Deliver secondary instruction for grades 9-12.', parentId: 'sled-example-district' },
  { id: 'sled-example-middle-school', name: 'Example Middle School', abbrev: 'EMS', icon: 'book', color: '#dd9be3', category: 'Programs & Offices', mission: 'Deliver instruction for grades 6-8.', parentId: 'sled-example-district' },
  { id: 'sled-example-elementary', name: 'Example Elementary School', abbrev: 'EES', icon: 'book', color: '#dd9be3', category: 'Programs & Offices', mission: 'Deliver instruction for grades K-5.', parentId: 'sled-example-district' },
  { id: 'sled-university-system', name: 'State University System', abbrev: 'SUS', icon: 'graduation', color: '#c161cf', category: 'Programs & Offices', mission: 'Govern the state’s public four-year universities.', parentId: 'sled-higher-ed' },
  { id: 'sled-community-college-system', name: 'Community College System', abbrev: 'CCS', icon: 'graduation', color: '#c161cf', category: 'Programs & Offices', mission: 'Govern the state’s public two-year community colleges.', parentId: 'sled-higher-ed' },
  { id: 'sled-flagship-university', name: 'Flagship State University', abbrev: 'FSU', icon: 'graduation', color: '#dd9be3', category: 'Programs & Offices', mission: 'Operate the state’s flagship research university (rename to the real institution).', parentId: 'sled-university-system' },
  { id: 'sled-example-community-college', name: 'Example Community College', abbrev: 'ECC', icon: 'graduation', color: '#dd9be3', category: 'Programs & Offices', mission: 'Deliver associate degrees, certificates, and workforce training.', parentId: 'sled-community-college-system' },
  { id: 'sled-pre-k-programs', name: 'Pre-K Programs', abbrev: 'PREK', icon: 'people', color: '#c161cf', category: 'Programs & Offices', mission: 'Fund and oversee state-funded pre-kindergarten.', parentId: 'sled-early-childhood' },
  { id: 'sled-child-care-licensing', name: 'Child Care Licensing', abbrev: 'CCL', icon: 'document', color: '#c161cf', category: 'Programs & Offices', mission: 'License and inspect child-care facilities.', parentId: 'sled-early-childhood' },
  { id: 'sled-state-testing', name: 'Statewide Assessment Program', abbrev: 'SAP', icon: 'data-histogram', color: '#c161cf', category: 'Programs & Offices', mission: 'Administer statewide standardized assessments.', parentId: 'sled-assessment' },
  { id: 'sled-funding-formula', name: 'Foundation Funding Formula', abbrev: 'FFF', icon: 'wallet', color: '#c161cf', category: 'Programs & Offices', mission: 'Calculate and distribute per-pupil foundation funding.', parentId: 'sled-school-finance' },

  // ── Labor & Workforce programs ─────────────────────────────────────────────
  { id: 'sled-unemployment', name: 'Unemployment Insurance', abbrev: 'UI', icon: 'wallet', color: '#d4a017', category: 'Programs & Offices', mission: 'Pay unemployment benefits and collect employer contributions.', parentId: 'sled-labor-workforce' },
  { id: 'sled-workforce-dev', name: 'Workforce Development', abbrev: 'WFD', icon: 'people-team', color: '#d4a017', category: 'Programs & Offices', mission: 'Connect job seekers to training and employers to talent.', parentId: 'sled-labor-workforce' },
  { id: 'sled-licensing', name: 'Professional Licensing', abbrev: 'LIC', icon: 'ribbon', color: '#d4a017', category: 'Programs & Offices', mission: 'License and regulate trades and professions.', parentId: 'sled-labor-workforce' },

  { id: 'sled-ui-claims', name: 'Claims & Adjudication', abbrev: 'C&A', icon: 'document', color: '#e6bf5c', category: 'Programs & Offices', mission: 'Process unemployment claims and resolve appeals.', parentId: 'sled-unemployment' },
  { id: 'sled-ui-employer-tax', name: 'Employer Tax Division', abbrev: 'ETD', icon: 'money', color: '#e6bf5c', category: 'Programs & Offices', mission: 'Collect unemployment-insurance employer contributions.', parentId: 'sled-unemployment' },
  { id: 'sled-american-job-centers', name: 'American Job Center Network', abbrev: 'AJC', icon: 'building', color: '#e6bf5c', category: 'Programs & Offices', mission: 'Operate the statewide network of career centers.', parentId: 'sled-workforce-dev' },
  { id: 'sled-apprenticeship', name: 'Registered Apprenticeship Office', abbrev: 'RAO', icon: 'ribbon', color: '#e6bf5c', category: 'Programs & Offices', mission: 'Register and support employer apprenticeship programs.', parentId: 'sled-workforce-dev' },
  { id: 'sled-contractor-licensing', name: 'Contractor Licensing Board', abbrev: 'CLB', icon: 'wrench', color: '#e6bf5c', category: 'Programs & Offices', mission: 'License and regulate construction contractors.', parentId: 'sled-licensing' },
  { id: 'sled-cosmetology-licensing', name: 'Cosmetology & Barbering Board', abbrev: 'CBB', icon: 'ribbon', color: '#e6bf5c', category: 'Programs & Offices', mission: 'License cosmetology, barbering, and personal-care professionals.', parentId: 'sled-licensing' },

  // ── Environment programs ───────────────────────────────────────────────────
  { id: 'sled-environmental-quality', name: 'Environmental Quality', abbrev: 'EQ', icon: 'leaf-three', color: '#5fa024', category: 'Programs & Offices', mission: 'Regulate air, water, and waste to protect public health.', parentId: 'sled-environment' },
  { id: 'sled-parks-recreation', name: 'Parks & Recreation', abbrev: 'PRK', icon: 'tree', color: '#5fa024', category: 'Programs & Offices', mission: 'Operate parks, trails, and recreation programs.', parentId: 'sled-environment' },
  { id: 'sled-water-resources', name: 'Water Resources', abbrev: 'WTR', icon: 'water', color: '#5fa024', category: 'Programs & Offices', mission: 'Manage water supply, rights, and flood control.', parentId: 'sled-environment' },
  { id: 'sled-fish-wildlife', name: 'Fish & Wildlife', abbrev: 'F&W', icon: 'plant', color: '#5fa024', category: 'Programs & Offices', mission: 'Conserve fish, game, and wildlife habitats.', parentId: 'sled-environment' },

  { id: 'sled-air-quality', name: 'Air Quality Division', abbrev: 'AQD', icon: 'leaf-three', color: '#8fc75a', category: 'Programs & Offices', mission: 'Permit and monitor stationary and mobile air-emission sources.', parentId: 'sled-environmental-quality' },
  { id: 'sled-waste-management', name: 'Waste Management Division', abbrev: 'WMD', icon: 'box', color: '#8fc75a', category: 'Programs & Offices', mission: 'Regulate solid, hazardous, and recycling waste streams.', parentId: 'sled-environmental-quality' },
  { id: 'sled-water-quality', name: 'Water Quality Division', abbrev: 'WQD', icon: 'water', color: '#8fc75a', category: 'Programs & Offices', mission: 'Permit and monitor surface- and ground-water discharges.', parentId: 'sled-environmental-quality' },
  { id: 'sled-state-parks-operations', name: 'State Parks Operations', abbrev: 'SPO', icon: 'tree', color: '#8fc75a', category: 'Programs & Offices', mission: 'Operate and maintain the state park system.', parentId: 'sled-parks-recreation' },
  { id: 'sled-trails-program', name: 'Trails & Greenways Program', abbrev: 'TGP', icon: 'tree', color: '#8fc75a', category: 'Programs & Offices', mission: 'Plan and fund statewide trail and greenway networks.', parentId: 'sled-parks-recreation' },
  { id: 'sled-water-rights', name: 'Water Rights Administration', abbrev: 'WRA', icon: 'water', color: '#8fc75a', category: 'Programs & Offices', mission: 'Adjudicate and administer state water rights.', parentId: 'sled-water-resources' },
  { id: 'sled-dam-safety', name: 'Dam Safety Program', abbrev: 'DSP', icon: 'water', color: '#8fc75a', category: 'Programs & Offices', mission: 'Inspect and regulate the safety of state dams.', parentId: 'sled-water-resources' },
  { id: 'sled-wildlife-management', name: 'Wildlife Management Division', abbrev: 'WMD', icon: 'plant', color: '#8fc75a', category: 'Programs & Offices', mission: 'Manage game populations and hunting programs.', parentId: 'sled-fish-wildlife' },
  { id: 'sled-fisheries', name: 'Fisheries Division', abbrev: 'FISH', icon: 'water', color: '#8fc75a', category: 'Programs & Offices', mission: 'Manage fish stocking, hatcheries, and fishing regulations.', parentId: 'sled-fish-wildlife' },

  // ── General Government programs ────────────────────────────────────────────
  { id: 'sled-human-resources', name: 'Human Resources', abbrev: 'HR', icon: 'people-team', color: '#7a7574', category: 'Programs & Offices', mission: 'Recruit, classify, and support the public workforce.', parentId: 'sled-general-government' },
  { id: 'sled-it-digital', name: 'IT & Digital Services', abbrev: 'IT', icon: 'server', color: '#7a7574', category: 'Programs & Offices', mission: 'Deliver technology, digital services, and cybersecurity.', parentId: 'sled-general-government' },
  { id: 'sled-facilities-fleet', name: 'Facilities & Fleet', abbrev: 'F&F', icon: 'building-multiple', color: '#7a7574', category: 'Programs & Offices', mission: 'Manage public buildings, grounds, and vehicle fleets.', parentId: 'sled-general-government' },
  { id: 'sled-elections', name: 'Elections & Records', abbrev: 'ELE', icon: 'vote', color: '#7a7574', category: 'Programs & Offices', mission: 'Run elections and maintain official public records.', parentId: 'sled-general-government' },

  { id: 'sled-classification-comp', name: 'Classification & Compensation', abbrev: 'C&C', icon: 'people-team', color: '#a3a09f', category: 'Programs & Offices', mission: 'Classify positions and administer statewide pay plans.', parentId: 'sled-human-resources' },
  { id: 'sled-employee-benefits', name: 'Employee Benefits Administration', abbrev: 'EBA', icon: 'heart', color: '#a3a09f', category: 'Programs & Offices', mission: 'Administer state-employee health and retirement benefits.', parentId: 'sled-human-resources' },
  { id: 'sled-cybersecurity-office', name: 'Office of Cybersecurity', abbrev: 'OCS', icon: 'shield-keyhole', color: '#a3a09f', category: 'Programs & Offices', mission: 'Set and enforce statewide cybersecurity policy.', parentId: 'sled-it-digital' },
  { id: 'sled-digital-services-office', name: 'Digital Services & Design', abbrev: 'DSD', icon: 'server', color: '#a3a09f', category: 'Programs & Offices', mission: 'Modernize resident-facing digital services and websites.', parentId: 'sled-it-digital' },
  { id: 'sled-capitol-facilities', name: 'Capitol Complex Facilities', abbrev: 'CCF', icon: 'building-multiple', color: '#a3a09f', category: 'Programs & Offices', mission: 'Operate and maintain state capitol-complex buildings.', parentId: 'sled-facilities-fleet' },
  { id: 'sled-fleet-management', name: 'State Fleet Management', abbrev: 'SFM', icon: 'car', color: '#a3a09f', category: 'Programs & Offices', mission: 'Manage the state’s motor-vehicle fleet.', parentId: 'sled-facilities-fleet' },
  { id: 'sled-voter-registration', name: 'Voter Registration Division', abbrev: 'VRD', icon: 'vote', color: '#a3a09f', category: 'Programs & Offices', mission: 'Maintain the statewide voter-registration database.', parentId: 'sled-elections' },
  { id: 'sled-campaign-finance', name: 'Campaign Finance Disclosure', abbrev: 'CFD', icon: 'money', color: '#a3a09f', category: 'Programs & Offices', mission: 'Collect and publish campaign-finance disclosure filings.', parentId: 'sled-elections' },

  // ── Local Government (County & City) ───────────────────────────────────────
  { id: 'sled-county-government', name: 'County Government', abbrev: 'CTY', icon: 'building-government', color: '#337ab0', category: 'Programs & Offices', mission: 'Deliver county-level public services and law enforcement.', parentId: 'sled-local-government' },
  { id: 'sled-city-government', name: 'Municipal / City Government', abbrev: 'CITY', icon: 'building', color: '#337ab0', category: 'Programs & Offices', mission: 'Deliver municipal services within city limits.', parentId: 'sled-local-government' },

  { id: 'sled-county-sheriff', name: 'County Sheriff’s Office', abbrev: 'SHF', icon: 'shield-task', color: '#67a3cc', category: 'Programs & Offices', mission: 'Provide county law enforcement, jail, and court-security services.', parentId: 'sled-county-government' },
  { id: 'sled-county-health-dept', name: 'County Health Department', abbrev: 'CHD', icon: 'heart-pulse', color: '#67a3cc', category: 'Programs & Offices', mission: 'Deliver local public-health programs and inspections.', parentId: 'sled-county-government' },
  { id: 'sled-county-assessor', name: 'County Assessor’s Office', abbrev: 'ASR', icon: 'document', color: '#67a3cc', category: 'Programs & Offices', mission: 'Appraise property for local property-tax assessment.', parentId: 'sled-county-government' },
  { id: 'sled-county-clerk', name: 'County Clerk & Recorder', abbrev: 'CLK', icon: 'archive', color: '#67a3cc', category: 'Programs & Offices', mission: 'Record deeds, licenses, and administer local elections.', parentId: 'sled-county-government' },
  { id: 'sled-city-police', name: 'Municipal Police Department', abbrev: 'PD', icon: 'shield-task', color: '#67a3cc', category: 'Programs & Offices', mission: 'Provide city law enforcement and community-policing services.', parentId: 'sled-city-government' },
  { id: 'sled-city-public-works', name: 'Public Works Department', abbrev: 'PW', icon: 'wrench', color: '#67a3cc', category: 'Programs & Offices', mission: 'Maintain streets, water, sewer, and municipal infrastructure.', parentId: 'sled-city-government' },
  { id: 'sled-city-planning', name: 'Planning & Zoning Department', abbrev: 'P&Z', icon: 'map', color: '#67a3cc', category: 'Programs & Offices', mission: 'Administer land use, zoning, and development permits.', parentId: 'sled-city-government' },
  { id: 'sled-city-parks', name: 'Parks & Recreation Department', abbrev: 'PARD', icon: 'tree', color: '#67a3cc', category: 'Programs & Offices', mission: 'Operate municipal parks, pools, and recreation programs.', parentId: 'sled-city-government' },

  // ── Tribal Government ───────────────────────────────────────────────────────
  { id: 'sled-tribal-council', name: 'Tribal Council / Governing Body', abbrev: 'TC', icon: 'people-team', color: '#a17235', category: 'Programs & Offices', mission: 'Exercise the tribe’s governing and legislative authority.', parentId: 'sled-tribal-government' },
  { id: 'sled-tribal-health-services', name: 'Tribal Health Services', abbrev: 'THS', icon: 'heart-pulse', color: '#a17235', category: 'Programs & Offices', mission: 'Deliver health care to tribal members, often via IHS compacting.', parentId: 'sled-tribal-government' },
  { id: 'sled-tribal-natural-resources', name: 'Tribal Natural Resources Department', abbrev: 'TNR', icon: 'leaf', color: '#a17235', category: 'Programs & Offices', mission: 'Manage tribal lands, water, fish, and wildlife resources.', parentId: 'sled-tribal-government' },
  { id: 'sled-tribal-gaming-commission', name: 'Tribal Gaming Commission', abbrev: 'TGC', icon: 'scales', color: '#a17235', category: 'Programs & Offices', mission: 'Regulate tribal gaming operations under IGRA.', parentId: 'sled-tribal-government' },
  { id: 'sled-tribal-clinic', name: 'Tribal Health Clinic', abbrev: 'THC', icon: 'stethoscope', color: '#c99a5f', category: 'Programs & Offices', mission: 'Provide primary and preventive care at a tribal health facility.', parentId: 'sled-tribal-health-services' },

  // ── Territorial Government ─────────────────────────────────────────────────
  { id: 'sled-territorial-governor-office', name: 'Office of the Governor', abbrev: 'GOV', icon: 'building-government', color: '#1f8a76', category: 'Programs & Offices', mission: 'Lead the territory’s executive branch and federal coordination.', parentId: 'sled-territorial-government' },
  { id: 'sled-territorial-health-dept', name: 'Territorial Department of Health', abbrev: 'TDOH', icon: 'heart-pulse', color: '#1f8a76', category: 'Programs & Offices', mission: 'Deliver public health and Medicaid programs across the territory.', parentId: 'sled-territorial-government' },
  { id: 'sled-territorial-education-dept', name: 'Territorial Department of Education', abbrev: 'TDOE', icon: 'graduation', color: '#1f8a76', category: 'Programs & Offices', mission: 'Operate the territory’s public school system.', parentId: 'sled-territorial-government' },
  { id: 'sled-territorial-revenue-bureau', name: 'Bureau of Internal Revenue', abbrev: 'BIR', icon: 'money', color: '#1f8a76', category: 'Programs & Offices', mission: 'Collect territorial income and excise tax revenue.', parentId: 'sled-territorial-government' },
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
