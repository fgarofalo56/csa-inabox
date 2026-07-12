/**
 * Defense & Intelligence library — DoD + Intelligence Community organizations
 * modeled as Loom domains (issue #1483, Wave 1).
 *
 * Enterprises are the Military Departments (Army, Navy, Air Force), the
 * defense-wide umbrellas (OSD, the Combatant Commands, the Defense Agencies &
 * Field Activities), and the Intelligence Community; children are the real
 * major commands / components / agencies under each. Grounded in the public
 * DoD organizational structure (10 U.S.C.) and the 18-element Intelligence
 * Community — abbreviations and missions are the well-known public ones.
 *
 * NO copyrighted seals or emblems: generic Fluent icons + brand-ish colors as
 * a creative representation (same policy as the Federal Civilian library).
 */
import type { DomainLibrary, DomainLibraryNode } from './types';

export type DefenseIntelCategory =
  | 'Military Departments'
  | 'Joint & Defense-wide'
  | 'Intelligence Community'
  | 'Components & Commands';

/** Palette anchors per enterprise (children share a tint of the parent hue). */
const C = {
  army: '#4b5320', navy: '#1f3f6e', airforce: '#00308f',
  osd: '#3b4a3a', cocom: '#5c2d91', agencies: '#566a52', ic: '#2f2f5e',
};

export const DEFENSE_INTEL_NODES: DomainLibraryNode[] = [
  // ── Military Departments (Enterprises) ─────────────────────────────────────
  { id: 'army', name: 'Department of the Army', abbrev: 'USA', icon: 'shield-task', color: C.army, category: 'Military Departments', mission: 'Deploy, fight, and win the nation’s wars with ready land forces.' },
  { id: 'navy', name: 'Department of the Navy', abbrev: 'USN', icon: 'ship', color: C.navy, category: 'Military Departments', mission: 'Maintain, train, and equip combat-ready naval forces.' },
  { id: 'air-force', name: 'Department of the Air Force', abbrev: 'USAF', icon: 'airplane', color: C.airforce, category: 'Military Departments', mission: 'Fly, fight, and win — airpower anytime, anywhere.' },

  // ── Joint & Defense-wide (Enterprises) ─────────────────────────────────────
  { id: 'osd', name: 'Office of the Secretary of Defense', abbrev: 'OSD', icon: 'building-government', color: C.osd, category: 'Joint & Defense-wide', mission: 'Exercise policy development, planning, and resource management for DoD.' },
  { id: 'cocom', name: 'Combatant Commands', abbrev: 'CCMD', icon: 'globe-shield', color: C.cocom, category: 'Joint & Defense-wide', mission: 'Employ joint military forces across geographic and functional commands.' },
  { id: 'defense-agencies', name: 'Defense Agencies & Field Activities', abbrev: 'DAFA', icon: 'organization', color: C.agencies, category: 'Joint & Defense-wide', mission: 'Deliver defense-wide support functions across the department.' },

  // ── Intelligence Community (Enterprise) ────────────────────────────────────
  { id: 'intel-community', name: 'Intelligence Community', abbrev: 'IC', icon: 'eye', color: C.ic, category: 'Intelligence Community', mission: 'Collect, analyze, and deliver intelligence to protect national security.' },

  // ── Army components ─────────────────────────────────────────────────────────
  { id: 'army-futures', name: 'Army Futures Command', abbrev: 'AFC', icon: 'lightbulb-filament', color: '#5f6f3f', category: 'Components & Commands', mission: 'Lead Army modernization and future-force transformation.', parentId: 'army' },
  { id: 'army-materiel', name: 'Army Materiel Command', abbrev: 'AMC', icon: 'box', color: '#5f6f3f', category: 'Components & Commands', mission: 'Provide materiel readiness and sustainment for the total force.', parentId: 'army' },
  { id: 'tradoc', name: 'Training & Doctrine Command', abbrev: 'TRADOC', icon: 'graduation', color: '#5f6f3f', category: 'Components & Commands', mission: 'Recruit, train, and educate the Army and shape its doctrine.', parentId: 'army' },
  { id: 'arcyber', name: 'Army Cyber Command', abbrev: 'ARCYBER', icon: 'shield-keyhole', color: '#5f6f3f', category: 'Components & Commands', mission: 'Operate and defend Army networks and deliver cyberspace effects.', parentId: 'army' },
  { id: 'usace', name: 'U.S. Army Corps of Engineers', abbrev: 'USACE', icon: 'wrench', color: '#5f6f3f', category: 'Components & Commands', mission: 'Deliver engineering solutions for the nation’s toughest challenges.', parentId: 'army' },
  { id: 'inscom', name: 'Intelligence & Security Command', abbrev: 'INSCOM', icon: 'eye', color: '#5f6f3f', category: 'Components & Commands', mission: 'Conduct intelligence and security operations for Army commanders.', parentId: 'army' },

  // ── Navy components ─────────────────────────────────────────────────────────
  { id: 'usmc', name: 'U.S. Marine Corps', abbrev: 'USMC', icon: 'shield', color: '#3a5a8c', category: 'Components & Commands', mission: 'Serve as the nation’s expeditionary force in readiness.', parentId: 'navy' },
  { id: 'fleet-forces', name: 'U.S. Fleet Forces Command', abbrev: 'USFF', icon: 'ship', color: '#3a5a8c', category: 'Components & Commands', mission: 'Man, train, and equip combat-ready fleet forces.', parentId: 'navy' },
  { id: 'navsea', name: 'Naval Sea Systems Command', abbrev: 'NAVSEA', icon: 'toolbox', color: '#3a5a8c', category: 'Components & Commands', mission: 'Design, build, and maintain the fleet’s ships and submarines.', parentId: 'navy' },
  { id: 'navair', name: 'Naval Air Systems Command', abbrev: 'NAVAIR', icon: 'airplane', color: '#3a5a8c', category: 'Components & Commands', mission: 'Develop and sustain naval aviation aircraft and weapons.', parentId: 'navy' },
  { id: 'navwar', name: 'Naval Information Warfare Systems Command', abbrev: 'NAVWAR', icon: 'server', color: '#3a5a8c', category: 'Components & Commands', mission: 'Deliver and sustain the Navy’s information-warfare capabilities.', parentId: 'navy' },
  { id: 'onr', name: 'Office of Naval Research', abbrev: 'ONR', icon: 'beaker', color: '#3a5a8c', category: 'Components & Commands', mission: 'Advance science and technology for future naval power.', parentId: 'navy' },
  { id: 'oni', name: 'Office of Naval Intelligence', abbrev: 'ONI', icon: 'eye', color: '#3a5a8c', category: 'Components & Commands', mission: 'Deliver maritime intelligence for decision advantage at sea.', parentId: 'navy' },

  // ── Air Force components ────────────────────────────────────────────────────
  { id: 'ussf', name: 'U.S. Space Force', abbrev: 'USSF', icon: 'rocket', color: '#2f5ba8', category: 'Components & Commands', mission: 'Secure the nation’s interests in, from, and to space.', parentId: 'air-force' },
  { id: 'acc', name: 'Air Combat Command', abbrev: 'ACC', icon: 'airplane', color: '#2f5ba8', category: 'Components & Commands', mission: 'Provide combat airpower ready for rapid global employment.', parentId: 'air-force' },
  { id: 'air-mobility', name: 'Air Mobility Command', abbrev: 'AMC', icon: 'box', color: '#2f5ba8', category: 'Components & Commands', mission: 'Deliver rapid global airlift, air refueling, and aeromedical evacuation.', parentId: 'air-force' },
  { id: 'afmc', name: 'Air Force Materiel Command', abbrev: 'AFMC', icon: 'toolbox', color: '#2f5ba8', category: 'Components & Commands', mission: 'Develop, acquire, and sustain Air Force weapon systems.', parentId: 'air-force' },
  { id: 'afrl', name: 'Air Force Research Laboratory', abbrev: 'AFRL', icon: 'beaker', color: '#2f5ba8', category: 'Components & Commands', mission: 'Discover and develop the science behind future air and space power.', parentId: 'air-force' },

  // ── OSD components ──────────────────────────────────────────────────────────
  { id: 'cdao', name: 'Chief Digital & Artificial Intelligence Office', abbrev: 'CDAO', icon: 'database', color: '#5c6e58', category: 'Components & Commands', mission: 'Accelerate DoD adoption of data, analytics, and AI.', parentId: 'osd' },
  { id: 'diu', name: 'Defense Innovation Unit', abbrev: 'DIU', icon: 'lightbulb', color: '#5c6e58', category: 'Components & Commands', mission: 'Field commercial technology to strengthen national security.', parentId: 'osd' },
  { id: 'usd-personnel-readiness', name: 'Personnel & Readiness', abbrev: 'P&R', icon: 'people-team', color: '#5c6e58', category: 'Components & Commands', mission: 'Manage total-force readiness, personnel, and military health policy.', parentId: 'osd' },
  { id: 'usd-comptroller', name: 'Comptroller / Chief Financial Officer', abbrev: 'USD(C)', icon: 'money', color: '#5c6e58', category: 'Components & Commands', mission: 'Steward the department’s budget and financial management.', parentId: 'osd' },
  { id: 'usd-intel-security', name: 'Intelligence & Security', abbrev: 'USD(I&S)', icon: 'shield-lock', color: '#5c6e58', category: 'Components & Commands', mission: 'Oversee defense intelligence, counterintelligence, and security policy.', parentId: 'osd' },

  // ── Combatant Commands ──────────────────────────────────────────────────────
  { id: 'cybercom', name: 'U.S. Cyber Command', abbrev: 'USCYBERCOM', icon: 'shield-keyhole', color: '#6f4fa8', category: 'Components & Commands', mission: 'Direct, synchronize, and conduct cyberspace operations.', parentId: 'cocom' },
  { id: 'socom', name: 'U.S. Special Operations Command', abbrev: 'USSOCOM', icon: 'star', color: '#6f4fa8', category: 'Components & Commands', mission: 'Provide fully capable special-operations forces worldwide.', parentId: 'cocom' },
  { id: 'transcom', name: 'U.S. Transportation Command', abbrev: 'USTRANSCOM', icon: 'truck', color: '#6f4fa8', category: 'Components & Commands', mission: 'Project and sustain military power through global mobility.', parentId: 'cocom' },
  { id: 'stratcom', name: 'U.S. Strategic Command', abbrev: 'USSTRATCOM', icon: 'globe', color: '#6f4fa8', category: 'Components & Commands', mission: 'Deter strategic attack through a safe, secure, effective deterrent.', parentId: 'cocom' },
  { id: 'spacecom', name: 'U.S. Space Command', abbrev: 'USSPACECOM', icon: 'rocket', color: '#6f4fa8', category: 'Components & Commands', mission: 'Conduct operations in, from, and to space to deter conflict.', parentId: 'cocom' },
  { id: 'indopacom', name: 'U.S. Indo-Pacific Command', abbrev: 'USINDOPACOM', icon: 'earth', color: '#6f4fa8', category: 'Components & Commands', mission: 'Promote security and stability across the Indo-Pacific region.', parentId: 'cocom' },
  { id: 'eucom', name: 'U.S. European Command', abbrev: 'USEUCOM', icon: 'globe-location', color: '#6f4fa8', category: 'Components & Commands', mission: 'Defend and protect U.S. interests across Europe with allies.', parentId: 'cocom' },
  { id: 'centcom', name: 'U.S. Central Command', abbrev: 'USCENTCOM', icon: 'globe-shield', color: '#6f4fa8', category: 'Components & Commands', mission: 'Direct military operations across the central region.', parentId: 'cocom' },
  { id: 'northcom', name: 'U.S. Northern Command', abbrev: 'USNORTHCOM', icon: 'home', color: '#6f4fa8', category: 'Components & Commands', mission: 'Defend the homeland and support civil authorities.', parentId: 'cocom' },
  { id: 'southcom', name: 'U.S. Southern Command', abbrev: 'USSOUTHCOM', icon: 'map', color: '#6f4fa8', category: 'Components & Commands', mission: 'Promote security cooperation across Central and South America.', parentId: 'cocom' },
  { id: 'africom', name: 'U.S. Africa Command', abbrev: 'USAFRICOM', icon: 'earth', color: '#6f4fa8', category: 'Components & Commands', mission: 'Advance U.S. interests and regional security across Africa.', parentId: 'cocom' },

  // ── Defense Agencies & Field Activities ─────────────────────────────────────
  { id: 'disa', name: 'Defense Information Systems Agency', abbrev: 'DISA', icon: 'server', color: '#6a7d66', category: 'Components & Commands', mission: 'Provide IT and communications support to the warfighter.', parentId: 'defense-agencies' },
  { id: 'dla', name: 'Defense Logistics Agency', abbrev: 'DLA', icon: 'box', color: '#6a7d66', category: 'Components & Commands', mission: 'Provide logistics, acquisition, and technical services to the military.', parentId: 'defense-agencies' },
  { id: 'darpa', name: 'Defense Advanced Research Projects Agency', abbrev: 'DARPA', icon: 'lightbulb-filament', color: '#6a7d66', category: 'Components & Commands', mission: 'Make pivotal investments in breakthrough technologies for national security.', parentId: 'defense-agencies' },
  { id: 'dtra', name: 'Defense Threat Reduction Agency', abbrev: 'DTRA', icon: 'shield-task', color: '#6a7d66', category: 'Components & Commands', mission: 'Counter weapons of mass destruction and emerging threats.', parentId: 'defense-agencies' },
  { id: 'mda', name: 'Missile Defense Agency', abbrev: 'MDA', icon: 'rocket', color: '#6a7d66', category: 'Components & Commands', mission: 'Develop and field a layered missile-defense system.', parentId: 'defense-agencies' },
  { id: 'dcsa', name: 'Defense Counterintelligence & Security Agency', abbrev: 'DCSA', icon: 'shield', color: '#6a7d66', category: 'Components & Commands', mission: 'Secure the trustworthiness of the U.S. government’s workforce.', parentId: 'defense-agencies' },
  { id: 'dcma', name: 'Defense Contract Management Agency', abbrev: 'DCMA', icon: 'document', color: '#6a7d66', category: 'Components & Commands', mission: 'Ensure defense contracts deliver as promised, on time and on cost.', parentId: 'defense-agencies' },
  { id: 'dfas', name: 'Defense Finance & Accounting Service', abbrev: 'DFAS', icon: 'wallet', color: '#6a7d66', category: 'Components & Commands', mission: 'Deliver payroll and accounting services across DoD.', parentId: 'defense-agencies' },
  { id: 'dha', name: 'Defense Health Agency', abbrev: 'DHA', icon: 'heart-pulse', color: '#6a7d66', category: 'Components & Commands', mission: 'Operate the Military Health System as an integrated system of readiness and health.', parentId: 'defense-agencies' },

  // ── Intelligence Community elements ─────────────────────────────────────────
  { id: 'odni', name: 'Office of the Director of National Intelligence', abbrev: 'ODNI', icon: 'organization', color: '#44446e', category: 'Intelligence Community', mission: 'Lead and integrate the Intelligence Community.', parentId: 'intel-community' },
  { id: 'cia', name: 'Central Intelligence Agency', abbrev: 'CIA', icon: 'globe-shield', color: '#44446e', category: 'Intelligence Community', mission: 'Collect foreign intelligence and conduct all-source analysis.', parentId: 'intel-community' },
  { id: 'nsa', name: 'National Security Agency', abbrev: 'NSA', icon: 'shield-keyhole', color: '#44446e', category: 'Intelligence Community', mission: 'Lead signals intelligence and cybersecurity for the nation.', parentId: 'intel-community' },
  { id: 'dia', name: 'Defense Intelligence Agency', abbrev: 'DIA', icon: 'eye', color: '#44446e', category: 'Intelligence Community', mission: 'Provide military intelligence to warfighters and policymakers.', parentId: 'intel-community' },
  { id: 'nga', name: 'National Geospatial-Intelligence Agency', abbrev: 'NGA', icon: 'map', color: '#44446e', category: 'Intelligence Community', mission: 'Deliver geospatial intelligence for decision advantage.', parentId: 'intel-community' },
  { id: 'nro', name: 'National Reconnaissance Office', abbrev: 'NRO', icon: 'rocket', color: '#44446e', category: 'Intelligence Community', mission: 'Develop and operate the nation’s reconnaissance satellites.', parentId: 'intel-community' },
];

export const DEFENSE_INTEL_LIBRARY: DomainLibrary = {
  id: 'defense-intelligence',
  name: 'Defense & Intelligence',
  label: 'Defense & Intelligence library',
  description: 'Military departments, combatant commands, defense agencies, and the IC.',
  icon: 'shield',
  color: '#3b4a3a',
  categories: [
    'Military Departments',
    'Joint & Defense-wide',
    'Intelligence Community',
    'Components & Commands',
  ] satisfies DefenseIntelCategory[],
  nodes: DEFENSE_INTEL_NODES,
  copy: {
    enterpriseNoun: 'departments, joint organizations & IC elements',
    childNoun: 'components & commands',
    drillNoun: 'components',
    itemPlural: 'organizations',
    itemSingular: 'organization',
    searchPlaceholder: 'Search commands & agencies…',
  },
};
