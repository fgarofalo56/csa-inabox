/**
 * fedciv-domain-library — a curated, hierarchical catalog of U.S. Federal
 * Civilian organizations modeled as Loom domains, surfaced in the "Create new
 * domain" flow's library mode.
 *
 * Model: a two-level Enterprise → Sub-agency/Bureau tree that mirrors how Loom
 * domains nest (domain → subdomain). An "Enterprise" is a Cabinet Department or
 * a top-level independent agency; its children are the well-known component
 * agencies / bureaus. Picking an Enterprise creates a root domain; picking a
 * sub-agency creates a SUBDOMAIN under that Enterprise (parentId set), so the
 * admin builds the real org tree (e.g. DHS → CISA).
 *
 * Each node carries a Fluent icon NAME (resolved by lib/domains/domain-icons)
 * and a brand-ish hex color. NO copyrighted material: these are generic Fluent
 * icons + colors as a creative representation — never an official agency seal.
 *
 * Categories drive the browse filter and a sensible palette per group.
 */

export type FedCivCategory =
  | 'Cabinet Departments'
  | 'Independent Agencies'
  | 'Sub-agencies & Bureaus';

export interface FedCivNode {
  /** Stable domain id (lowercase, hyphens) — becomes the Loom domain id. */
  id: string;
  /** Display name. */
  name: string;
  /** Common abbreviation / acronym. */
  abbrev: string;
  /** Fluent icon name (see lib/domains/domain-icons DOMAIN_ICONS). */
  icon: string;
  /** Brand-ish theme color (hex). */
  color: string;
  category: FedCivCategory;
  /** One-line mission statement (paraphrased; informational). */
  mission: string;
  /** Parent Enterprise id when this is a sub-agency / bureau. */
  parentId?: string;
}

/** Palette anchors per Department (children inherit a tint of the parent hue). */
const C = {
  dhs: '#1b3a5c', hhs: '#0078d4', doj: '#3b3b6d', treasury: '#0b6a0b',
  va: '#102e57', usda: '#498205', commerce: '#0e7490', dot: '#5c2d91',
  interior: '#8e562e', energy: '#bd7800', labor: '#a4262c', education: '#881798',
  hud: '#005e5e', state: '#003f7d', defense: '#3b4a3a',
  independent: '#106ebe',
};

/**
 * The library. Enterprises (parentId undefined) come first within each section
 * conceptually; children reference their parent by id. Order here is the
 * browse/list order.
 */
export const FEDCIV_DOMAIN_LIBRARY: FedCivNode[] = [
  // ── Cabinet Departments (Enterprises) ──────────────────────────────────────
  { id: 'dhs', name: 'Homeland Security', abbrev: 'DHS', icon: 'shield', color: C.dhs, category: 'Cabinet Departments', mission: 'Secure the nation from the many threats it faces.' },
  { id: 'hhs', name: 'Health & Human Services', abbrev: 'HHS', icon: 'heart-pulse', color: C.hhs, category: 'Cabinet Departments', mission: 'Enhance the health and well-being of all Americans.' },
  { id: 'doj', name: 'Justice', abbrev: 'DOJ', icon: 'gavel', color: C.doj, category: 'Cabinet Departments', mission: 'Enforce the law and defend the interests of the United States.' },
  { id: 'treasury', name: 'Treasury', abbrev: 'TREAS', icon: 'money', color: C.treasury, category: 'Cabinet Departments', mission: 'Maintain a strong economy and manage the U.S. government’s finances.' },
  { id: 'va', name: 'Veterans Affairs', abbrev: 'VA', icon: 'ribbon', color: C.va, category: 'Cabinet Departments', mission: 'Care for those who have served in the nation’s military.' },
  { id: 'usda', name: 'Agriculture', abbrev: 'USDA', icon: 'plant', color: C.usda, category: 'Cabinet Departments', mission: 'Provide leadership on food, agriculture, and natural resources.' },
  { id: 'commerce', name: 'Commerce', abbrev: 'DOC', icon: 'chart-multiple', color: C.commerce, category: 'Cabinet Departments', mission: 'Promote job creation and economic growth.' },
  { id: 'dot', name: 'Transportation', abbrev: 'DOT', icon: 'navigation', color: C.dot, category: 'Cabinet Departments', mission: 'Ensure a fast, safe, efficient, and convenient transportation system.' },
  { id: 'interior', name: 'Interior', abbrev: 'DOI', icon: 'leaf-three', color: C.interior, category: 'Cabinet Departments', mission: 'Protect America’s natural resources and cultural heritage.' },
  { id: 'energy', name: 'Energy', abbrev: 'DOE', icon: 'flash', color: C.energy, category: 'Cabinet Departments', mission: 'Ensure America’s security and prosperity through energy and science.' },
  { id: 'labor', name: 'Labor', abbrev: 'DOL', icon: 'wrench', color: C.labor, category: 'Cabinet Departments', mission: 'Foster the welfare of wage earners, job seekers, and retirees.' },
  { id: 'education', name: 'Education', abbrev: 'ED', icon: 'graduation', color: C.education, category: 'Cabinet Departments', mission: 'Promote student achievement and prepare for global competitiveness.' },
  { id: 'hud', name: 'Housing & Urban Development', abbrev: 'HUD', icon: 'home', color: C.hud, category: 'Cabinet Departments', mission: 'Create strong, sustainable communities and quality affordable homes.' },
  { id: 'state', name: 'State', abbrev: 'DOS', icon: 'globe', color: C.state, category: 'Cabinet Departments', mission: 'Lead America’s foreign policy through diplomacy and partnership.' },
  { id: 'defense', name: 'Defense (Civilian)', abbrev: 'DOD', icon: 'shield-task', color: C.defense, category: 'Cabinet Departments', mission: 'Provide the military forces needed to deter war and ensure security.' },

  // ── Independent Agencies (Enterprises) ──────────────────────────────────────
  { id: 'nasa', name: 'National Aeronautics & Space Administration', abbrev: 'NASA', icon: 'rocket', color: '#0b3d91', category: 'Independent Agencies', mission: 'Explore space and aeronautics for the benefit of all.' },
  { id: 'epa', name: 'Environmental Protection Agency', abbrev: 'EPA', icon: 'leaf', color: '#0b6a0b', category: 'Independent Agencies', mission: 'Protect human health and the environment.' },
  { id: 'ssa', name: 'Social Security Administration', abbrev: 'SSA', icon: 'person-heart', color: '#1b6b8c', category: 'Independent Agencies', mission: 'Deliver Social Security services that meet changing needs.' },
  { id: 'gsa', name: 'General Services Administration', abbrev: 'GSA', icon: 'building-multiple', color: '#005a9e', category: 'Independent Agencies', mission: 'Deliver effective government buildings, products, and services.' },
  { id: 'opm', name: 'Office of Personnel Management', abbrev: 'OPM', icon: 'people-team', color: '#5c2d91', category: 'Independent Agencies', mission: 'Lead federal human-capital management for the civil service.' },
  { id: 'sba', name: 'Small Business Administration', abbrev: 'SBA', icon: 'wallet', color: '#a80000', category: 'Independent Agencies', mission: 'Aid, counsel, assist, and protect the interests of small businesses.' },
  { id: 'nsf', name: 'National Science Foundation', abbrev: 'NSF', icon: 'beaker', color: '#0e7490', category: 'Independent Agencies', mission: 'Promote the progress of science and advance national health and prosperity.' },
  { id: 'nrc', name: 'Nuclear Regulatory Commission', abbrev: 'NRC', icon: 'shield-keyhole', color: '#bd7800', category: 'Independent Agencies', mission: 'Regulate civilian use of nuclear materials to protect people and the environment.' },
  { id: 'fcc', name: 'Federal Communications Commission', abbrev: 'FCC', icon: 'cellular', color: '#106ebe', category: 'Independent Agencies', mission: 'Regulate interstate and international communications.' },
  { id: 'ftc', name: 'Federal Trade Commission', abbrev: 'FTC', icon: 'scales', color: '#3b3b6d', category: 'Independent Agencies', mission: 'Protect consumers and promote competition.' },
  { id: 'sec', name: 'Securities & Exchange Commission', abbrev: 'SEC', icon: 'data-trending', color: '#0b6a0b', category: 'Independent Agencies', mission: 'Protect investors and maintain fair, orderly, efficient markets.' },
  { id: 'fdic', name: 'Federal Deposit Insurance Corporation', abbrev: 'FDIC', icon: 'building-bank', color: '#003f7d', category: 'Independent Agencies', mission: 'Maintain stability and public confidence in the financial system.' },
  { id: 'nara', name: 'National Archives & Records Administration', abbrev: 'NARA', icon: 'archive', color: '#8e562e', category: 'Independent Agencies', mission: 'Preserve and provide access to the nation’s records.' },
  { id: 'usaid', name: 'U.S. Agency for International Development', abbrev: 'USAID', icon: 'globe-location', color: '#002f6c', category: 'Independent Agencies', mission: 'Advance development and humanitarian efforts abroad.' },
  { id: 'peace-corps', name: 'Peace Corps', abbrev: 'PC', icon: 'globe-shield', color: '#1b6b8c', category: 'Independent Agencies', mission: 'Promote world peace and friendship through service.' },

  // ── DHS sub-agencies ────────────────────────────────────────────────────────
  { id: 'cisa', name: 'Cybersecurity & Infrastructure Security Agency', abbrev: 'CISA', icon: 'shield-keyhole', color: '#264a73', category: 'Sub-agencies & Bureaus', mission: 'Lead the national effort to defend critical infrastructure.', parentId: 'dhs' },
  { id: 'fema', name: 'Federal Emergency Management Agency', abbrev: 'FEMA', icon: 'pulse', color: '#264a73', category: 'Sub-agencies & Bureaus', mission: 'Help people before, during, and after disasters.', parentId: 'dhs' },
  { id: 'tsa', name: 'Transportation Security Administration', abbrev: 'TSA', icon: 'airplane', color: '#264a73', category: 'Sub-agencies & Bureaus', mission: 'Protect the nation’s transportation systems.', parentId: 'dhs' },
  { id: 'cbp', name: 'Customs & Border Protection', abbrev: 'CBP', icon: 'globe-shield', color: '#264a73', category: 'Sub-agencies & Bureaus', mission: 'Safeguard America’s borders while enabling lawful trade and travel.', parentId: 'dhs' },
  { id: 'uscis', name: 'Citizenship & Immigration Services', abbrev: 'USCIS', icon: 'people', color: '#264a73', category: 'Sub-agencies & Bureaus', mission: 'Administer the nation’s lawful immigration system.', parentId: 'dhs' },
  { id: 'usss', name: 'U.S. Secret Service', abbrev: 'USSS', icon: 'shield', color: '#264a73', category: 'Sub-agencies & Bureaus', mission: 'Protect leaders and safeguard the financial infrastructure.', parentId: 'dhs' },
  { id: 'uscg', name: 'U.S. Coast Guard', abbrev: 'USCG', icon: 'ship', color: '#264a73', category: 'Sub-agencies & Bureaus', mission: 'Ensure the safety, security, and stewardship of the seas.', parentId: 'dhs' },
  { id: 'ice', name: 'Immigration & Customs Enforcement', abbrev: 'ICE', icon: 'lock-closed', color: '#264a73', category: 'Sub-agencies & Bureaus', mission: 'Enforce immigration and customs laws.', parentId: 'dhs' },

  // ── HHS sub-agencies ────────────────────────────────────────────────────────
  { id: 'cdc', name: 'Centers for Disease Control & Prevention', abbrev: 'CDC', icon: 'clipboard-pulse', color: '#2a8fd4', category: 'Sub-agencies & Bureaus', mission: 'Protect America from health, safety, and security threats.', parentId: 'hhs' },
  { id: 'nih', name: 'National Institutes of Health', abbrev: 'NIH', icon: 'beaker', color: '#2a8fd4', category: 'Sub-agencies & Bureaus', mission: 'Seek fundamental knowledge to enhance health and reduce illness.', parentId: 'hhs' },
  { id: 'fda', name: 'Food & Drug Administration', abbrev: 'FDA', icon: 'pill', color: '#2a8fd4', category: 'Sub-agencies & Bureaus', mission: 'Protect public health by ensuring safety of foods and drugs.', parentId: 'hhs' },
  { id: 'cms', name: 'Centers for Medicare & Medicaid Services', abbrev: 'CMS', icon: 'heart', color: '#2a8fd4', category: 'Sub-agencies & Bureaus', mission: 'Administer Medicare, Medicaid, and the Marketplace.', parentId: 'hhs' },
  { id: 'hrsa', name: 'Health Resources & Services Administration', abbrev: 'HRSA', icon: 'stethoscope', color: '#2a8fd4', category: 'Sub-agencies & Bureaus', mission: 'Improve health care access for the geographically isolated and vulnerable.', parentId: 'hhs' },
  { id: 'samhsa', name: 'Substance Abuse & Mental Health Services Admin.', abbrev: 'SAMHSA', icon: 'person-heart', color: '#2a8fd4', category: 'Sub-agencies & Bureaus', mission: 'Reduce the impact of substance abuse and mental illness.', parentId: 'hhs' },
  { id: 'ihs', name: 'Indian Health Service', abbrev: 'IHS', icon: 'syringe', color: '#2a8fd4', category: 'Sub-agencies & Bureaus', mission: 'Raise the health status of American Indians and Alaska Natives.', parentId: 'hhs' },

  // ── DOJ sub-agencies ────────────────────────────────────────────────────────
  { id: 'fbi', name: 'Federal Bureau of Investigation', abbrev: 'FBI', icon: 'fingerprint', color: '#54548a', category: 'Sub-agencies & Bureaus', mission: 'Protect the American people and uphold the Constitution.', parentId: 'doj' },
  { id: 'dea', name: 'Drug Enforcement Administration', abbrev: 'DEA', icon: 'shield-task', color: '#54548a', category: 'Sub-agencies & Bureaus', mission: 'Enforce the controlled-substances laws of the United States.', parentId: 'doj' },
  { id: 'atf', name: 'Bureau of Alcohol, Tobacco, Firearms & Explosives', abbrev: 'ATF', icon: 'shield', color: '#54548a', category: 'Sub-agencies & Bureaus', mission: 'Protect communities from violent criminals and illegal trafficking.', parentId: 'doj' },
  { id: 'usms', name: 'U.S. Marshals Service', abbrev: 'USMS', icon: 'star', color: '#54548a', category: 'Sub-agencies & Bureaus', mission: 'Enforce federal laws and provide judicial security.', parentId: 'doj' },
  { id: 'bop', name: 'Federal Bureau of Prisons', abbrev: 'BOP', icon: 'lock-closed', color: '#54548a', category: 'Sub-agencies & Bureaus', mission: 'Protect society by confining offenders in safe, humane facilities.', parentId: 'doj' },

  // ── Treasury sub-agencies ───────────────────────────────────────────────────
  { id: 'irs', name: 'Internal Revenue Service', abbrev: 'IRS', icon: 'document', color: '#2b7a2b', category: 'Sub-agencies & Bureaus', mission: 'Provide America’s taxpayers top-quality service and enforce the tax law.', parentId: 'treasury' },
  { id: 'occ', name: 'Office of the Comptroller of the Currency', abbrev: 'OCC', icon: 'building-bank', color: '#2b7a2b', category: 'Sub-agencies & Bureaus', mission: 'Charter, regulate, and supervise national banks.', parentId: 'treasury' },
  { id: 'fincen', name: 'Financial Crimes Enforcement Network', abbrev: 'FinCEN', icon: 'eye', color: '#2b7a2b', category: 'Sub-agencies & Bureaus', mission: 'Safeguard the financial system from illicit use.', parentId: 'treasury' },
  { id: 'us-mint', name: 'United States Mint', abbrev: 'MINT', icon: 'vault', color: '#2b7a2b', category: 'Sub-agencies & Bureaus', mission: 'Produce the nation’s coinage and safeguard reserve assets.', parentId: 'treasury' },
  { id: 'fiscal-service', name: 'Bureau of the Fiscal Service', abbrev: 'BFS', icon: 'wallet', color: '#2b7a2b', category: 'Sub-agencies & Bureaus', mission: 'Manage the government’s finances and accounting.', parentId: 'treasury' },
  { id: 'bep', name: 'Bureau of Engraving & Printing', abbrev: 'BEP', icon: 'money-hand', color: '#2b7a2b', category: 'Sub-agencies & Bureaus', mission: 'Design and produce U.S. currency and security documents.', parentId: 'treasury' },

  // ── VA sub-agencies ─────────────────────────────────────────────────────────
  { id: 'vha', name: 'Veterans Health Administration', abbrev: 'VHA', icon: 'stethoscope', color: '#2a4a78', category: 'Sub-agencies & Bureaus', mission: 'Provide health care to enrolled veterans.', parentId: 'va' },
  { id: 'vba', name: 'Veterans Benefits Administration', abbrev: 'VBA', icon: 'ribbon', color: '#2a4a78', category: 'Sub-agencies & Bureaus', mission: 'Deliver benefits and services to veterans and their families.', parentId: 'va' },
  { id: 'nca', name: 'National Cemetery Administration', abbrev: 'NCA', icon: 'star', color: '#2a4a78', category: 'Sub-agencies & Bureaus', mission: 'Honor veterans with final resting places and lasting tributes.', parentId: 'va' },

  // ── USDA sub-agencies ───────────────────────────────────────────────────────
  { id: 'forest-service', name: 'Forest Service', abbrev: 'USFS', icon: 'tree', color: '#5fa024', category: 'Sub-agencies & Bureaus', mission: 'Sustain the health and productivity of the nation’s forests.', parentId: 'usda' },
  { id: 'fns', name: 'Food & Nutrition Service', abbrev: 'FNS', icon: 'heart', color: '#5fa024', category: 'Sub-agencies & Bureaus', mission: 'Increase food security and reduce hunger.', parentId: 'usda' },
  { id: 'fsis', name: 'Food Safety & Inspection Service', abbrev: 'FSIS', icon: 'shield-task', color: '#5fa024', category: 'Sub-agencies & Bureaus', mission: 'Ensure the nation’s meat, poultry, and eggs are safe.', parentId: 'usda' },
  { id: 'nrcs', name: 'Natural Resources Conservation Service', abbrev: 'NRCS', icon: 'leaf', color: '#5fa024', category: 'Sub-agencies & Bureaus', mission: 'Help people conserve and sustain natural resources on private lands.', parentId: 'usda' },
  { id: 'fsa-usda', name: 'Farm Service Agency', abbrev: 'FSA', icon: 'plant', color: '#5fa024', category: 'Sub-agencies & Bureaus', mission: 'Support farmers through programs, loans, and disaster aid.', parentId: 'usda' },
  { id: 'ars', name: 'Agricultural Research Service', abbrev: 'ARS', icon: 'beaker', color: '#5fa024', category: 'Sub-agencies & Bureaus', mission: 'Find solutions to agricultural problems through research.', parentId: 'usda' },

  // ── Commerce sub-agencies ───────────────────────────────────────────────────
  { id: 'census', name: 'U.S. Census Bureau', abbrev: 'CENSUS', icon: 'data-histogram', color: '#1390ad', category: 'Sub-agencies & Bureaus', mission: 'Serve as the leading source of data about the nation’s people and economy.', parentId: 'commerce' },
  { id: 'noaa', name: 'National Oceanic & Atmospheric Administration', abbrev: 'NOAA', icon: 'rain', color: '#1390ad', category: 'Sub-agencies & Bureaus', mission: 'Understand and predict the oceans and atmosphere.', parentId: 'commerce' },
  { id: 'nist', name: 'National Institute of Standards & Technology', abbrev: 'NIST', icon: 'beaker', color: '#1390ad', category: 'Sub-agencies & Bureaus', mission: 'Advance measurement science, standards, and technology.', parentId: 'commerce' },
  { id: 'uspto', name: 'Patent & Trademark Office', abbrev: 'USPTO', icon: 'lightbulb', color: '#1390ad', category: 'Sub-agencies & Bureaus', mission: 'Grant patents and register trademarks to foster innovation.', parentId: 'commerce' },
  { id: 'bis', name: 'Bureau of Industry & Security', abbrev: 'BIS', icon: 'shield', color: '#1390ad', category: 'Sub-agencies & Bureaus', mission: 'Advance national security through export control.', parentId: 'commerce' },
  { id: 'ita', name: 'International Trade Administration', abbrev: 'ITA', icon: 'globe', color: '#1390ad', category: 'Sub-agencies & Bureaus', mission: 'Strengthen U.S. industry competitiveness and promote trade.', parentId: 'commerce' },

  // ── DOT sub-agencies ────────────────────────────────────────────────────────
  { id: 'faa', name: 'Federal Aviation Administration', abbrev: 'FAA', icon: 'airplane', color: '#6f3fa8', category: 'Sub-agencies & Bureaus', mission: 'Provide the safest, most efficient aerospace system in the world.', parentId: 'dot' },
  { id: 'fhwa', name: 'Federal Highway Administration', abbrev: 'FHWA', icon: 'navigation', color: '#6f3fa8', category: 'Sub-agencies & Bureaus', mission: 'Improve mobility on the nation’s highways.', parentId: 'dot' },
  { id: 'fra', name: 'Federal Railroad Administration', abbrev: 'FRA', icon: 'train', color: '#6f3fa8', category: 'Sub-agencies & Bureaus', mission: 'Enable the safe, reliable movement of people and goods by rail.', parentId: 'dot' },
  { id: 'fta', name: 'Federal Transit Administration', abbrev: 'FTA', icon: 'train', color: '#6f3fa8', category: 'Sub-agencies & Bureaus', mission: 'Provide support to public transit systems.', parentId: 'dot' },
  { id: 'nhtsa', name: 'National Highway Traffic Safety Administration', abbrev: 'NHTSA', icon: 'car', color: '#6f3fa8', category: 'Sub-agencies & Bureaus', mission: 'Save lives and prevent injuries on the nation’s roads.', parentId: 'dot' },
  { id: 'phmsa', name: 'Pipeline & Hazardous Materials Safety Admin.', abbrev: 'PHMSA', icon: 'truck', color: '#6f3fa8', category: 'Sub-agencies & Bureaus', mission: 'Protect people and the environment from hazardous-material transport risks.', parentId: 'dot' },

  // ── Interior sub-agencies ───────────────────────────────────────────────────
  { id: 'nps', name: 'National Park Service', abbrev: 'NPS', icon: 'tree', color: '#a06a3a', category: 'Sub-agencies & Bureaus', mission: 'Preserve the natural and cultural resources of the National Park System.', parentId: 'interior' },
  { id: 'blm', name: 'Bureau of Land Management', abbrev: 'BLM', icon: 'map', color: '#a06a3a', category: 'Sub-agencies & Bureaus', mission: 'Sustain the health and productivity of public lands.', parentId: 'interior' },
  { id: 'usgs', name: 'U.S. Geological Survey', abbrev: 'USGS', icon: 'map', color: '#a06a3a', category: 'Sub-agencies & Bureaus', mission: 'Provide science about natural hazards, resources, and ecosystems.', parentId: 'interior' },
  { id: 'fws', name: 'Fish & Wildlife Service', abbrev: 'FWS', icon: 'leaf-three', color: '#a06a3a', category: 'Sub-agencies & Bureaus', mission: 'Conserve fish, wildlife, plants, and their habitats.', parentId: 'interior' },
  { id: 'bia', name: 'Bureau of Indian Affairs', abbrev: 'BIA', icon: 'people', color: '#a06a3a', category: 'Sub-agencies & Bureaus', mission: 'Enhance the quality of life for American Indians and Alaska Natives.', parentId: 'interior' },
  { id: 'bor', name: 'Bureau of Reclamation', abbrev: 'BOR', icon: 'water', color: '#a06a3a', category: 'Sub-agencies & Bureaus', mission: 'Manage water and power in the American West.', parentId: 'interior' },

  // ── Energy sub-agencies ─────────────────────────────────────────────────────
  { id: 'nnsa', name: 'National Nuclear Security Administration', abbrev: 'NNSA', icon: 'shield-keyhole', color: '#d4a017', category: 'Sub-agencies & Bureaus', mission: 'Enhance national security through the military application of nuclear science.', parentId: 'energy' },
  { id: 'eia', name: 'Energy Information Administration', abbrev: 'EIA', icon: 'chart-multiple', color: '#d4a017', category: 'Sub-agencies & Bureaus', mission: 'Collect and analyze independent energy information.', parentId: 'energy' },
  { id: 'doe-labs', name: 'National Laboratories', abbrev: 'LABS', icon: 'beaker', color: '#d4a017', category: 'Sub-agencies & Bureaus', mission: 'Advance science and technology across the DOE lab complex.', parentId: 'energy' },

  // ── Labor sub-agencies ──────────────────────────────────────────────────────
  { id: 'osha', name: 'Occupational Safety & Health Administration', abbrev: 'OSHA', icon: 'shield-task', color: '#bd4347', category: 'Sub-agencies & Bureaus', mission: 'Ensure safe and healthful working conditions.', parentId: 'labor' },
  { id: 'bls', name: 'Bureau of Labor Statistics', abbrev: 'BLS', icon: 'data-histogram', color: '#bd4347', category: 'Sub-agencies & Bureaus', mission: 'Measure labor-market activity, working conditions, and prices.', parentId: 'labor' },
  { id: 'eta', name: 'Employment & Training Administration', abbrev: 'ETA', icon: 'people-team', color: '#bd4347', category: 'Sub-agencies & Bureaus', mission: 'Administer job training and employment-service programs.', parentId: 'labor' },
  { id: 'whd', name: 'Wage & Hour Division', abbrev: 'WHD', icon: 'wallet', color: '#bd4347', category: 'Sub-agencies & Bureaus', mission: 'Enforce federal labor standards for wages and hours.', parentId: 'labor' },

  // ── Education sub-agencies ──────────────────────────────────────────────────
  { id: 'fsa-ed', name: 'Federal Student Aid', abbrev: 'FSA', icon: 'graduation', color: '#9c2faa', category: 'Sub-agencies & Bureaus', mission: 'Make education beyond high school accessible through financial aid.', parentId: 'education' },
  { id: 'ocr-ed', name: 'Office for Civil Rights', abbrev: 'OCR', icon: 'scales', color: '#9c2faa', category: 'Sub-agencies & Bureaus', mission: 'Ensure equal access to education and enforce civil-rights laws.', parentId: 'education' },

  // ── HUD sub-agencies ────────────────────────────────────────────────────────
  { id: 'fha', name: 'Federal Housing Administration', abbrev: 'FHA', icon: 'home', color: '#1b7878', category: 'Sub-agencies & Bureaus', mission: 'Provide mortgage insurance to expand access to homeownership.', parentId: 'hud' },
  { id: 'ginnie-mae', name: 'Government National Mortgage Association', abbrev: 'GNMA', icon: 'building-bank', color: '#1b7878', category: 'Sub-agencies & Bureaus', mission: 'Expand affordable housing by guaranteeing mortgage-backed securities.', parentId: 'hud' },

  // ── Defense (civilian) sub-agencies ─────────────────────────────────────────
  { id: 'disa', name: 'Defense Information Systems Agency', abbrev: 'DISA', icon: 'server', color: '#566a52', category: 'Sub-agencies & Bureaus', mission: 'Provide IT and communications support to the warfighter.', parentId: 'defense' },
  { id: 'dla', name: 'Defense Logistics Agency', abbrev: 'DLA', icon: 'box', color: '#566a52', category: 'Sub-agencies & Bureaus', mission: 'Provide logistics, acquisition, and technical services to the military.', parentId: 'defense' },
  { id: 'darpa', name: 'Defense Advanced Research Projects Agency', abbrev: 'DARPA', icon: 'lightbulb-filament', color: '#566a52', category: 'Sub-agencies & Bureaus', mission: 'Make pivotal investments in breakthrough technologies for national security.', parentId: 'defense' },
  { id: 'dcsa', name: 'Defense Counterintelligence & Security Agency', abbrev: 'DCSA', icon: 'shield', color: '#566a52', category: 'Sub-agencies & Bureaus', mission: 'Secure the trustworthiness of the U.S. government’s workforce.', parentId: 'defense' },
];

export const FEDCIV_CATEGORIES: FedCivCategory[] = [
  'Cabinet Departments',
  'Independent Agencies',
  'Sub-agencies & Bureaus',
];

/** Top-level Enterprises (Departments + independent agencies). */
export function fedCivEnterprises(): FedCivNode[] {
  return FEDCIV_DOMAIN_LIBRARY.filter((n) => !n.parentId);
}

/** Sub-agencies/bureaus of a given Enterprise id. */
export function fedCivChildren(parentId: string): FedCivNode[] {
  return FEDCIV_DOMAIN_LIBRARY.filter((n) => n.parentId === parentId);
}

/** Look up a node by id. */
export function fedCivNode(id: string): FedCivNode | undefined {
  return FEDCIV_DOMAIN_LIBRARY.find((n) => n.id === id);
}

/** Count of departments/independent agencies and sub-agencies (for UI copy). */
export const FEDCIV_LIBRARY_STATS = {
  enterprises: FEDCIV_DOMAIN_LIBRARY.filter((n) => !n.parentId).length,
  subAgencies: FEDCIV_DOMAIN_LIBRARY.filter((n) => n.parentId).length,
  total: FEDCIV_DOMAIN_LIBRARY.length,
};
