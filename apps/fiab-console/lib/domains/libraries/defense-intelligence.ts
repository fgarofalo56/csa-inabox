/**
 * Defense & Intelligence library — DoD + Intelligence Community organizations
 * modeled as Loom domains (issue #1483; Wave 1 shallow stub deepened to a
 * genuine multi-level org taxonomy in Wave 2).
 *
 * Enterprises are the Military Departments (Army, Navy — incl. the Marine
 * Corps, Air Force — incl. the Space Force), the defense-wide umbrellas (OSD,
 * the Combatant Commands, the Defense Agencies & Field Activities), and the
 * Intelligence Community; children nest to real depth — Department → major
 * command → subordinate command/directorate → division/unit — grounded in
 * the public DoD organizational structure (10 U.S.C.) and the 18-element
 * Intelligence Community. Abbreviations and missions are the well-known
 * public ones; unit/division alignments are illustrative of the real command
 * relationships (they periodically reorganize).
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

/** Palette anchors per enterprise; children use a tint of the parent hue,
 * one shade lighter per level so deeper nodes read as "part of" their branch. */
const C = {
  army: '#4b5320', armyL2: '#5f6f3f', armyL3: '#7a8a5a', armyL4: '#96a378',
  navy: '#1f3f6e', navyL2: '#3a5a8c', navyL3: '#5a7aac',
  airforce: '#00308f', airforceL2: '#2f5ba8', airforceL3: '#5a82c9',
  osd: '#3b4a3a', osdL2: '#5c6e58',
  cocom: '#5c2d91', cocomL2: '#6f4fa8', cocomL3: '#8f74c0',
  agencies: '#566a52', agenciesL2: '#6a7d66', agenciesL3: '#8a9a86',
  ic: '#2f2f5e', icL2: '#44446e', icL3: '#5c5c85',
};

export const DEFENSE_INTEL_NODES: DomainLibraryNode[] = [
  // ── Military Departments (Enterprises) ─────────────────────────────────────
  { id: 'army', name: 'Department of the Army', abbrev: 'USA', icon: 'shield-task', color: C.army, category: 'Military Departments', mission: 'Deploy, fight, and win the nation’s wars with ready land forces.' },
  { id: 'navy', name: 'Department of the Navy', abbrev: 'USN', icon: 'ship', color: C.navy, category: 'Military Departments', mission: 'Maintain, train, and equip combat-ready naval and Marine forces.' },
  { id: 'air-force', name: 'Department of the Air Force', abbrev: 'USAF', icon: 'airplane', color: C.airforce, category: 'Military Departments', mission: 'Fly, fight, and win — airpower and spacepower anytime, anywhere.' },

  // ── Joint & Defense-wide (Enterprises) ─────────────────────────────────────
  { id: 'osd', name: 'Office of the Secretary of Defense', abbrev: 'OSD', icon: 'building-government', color: C.osd, category: 'Joint & Defense-wide', mission: 'Exercise policy development, planning, and resource management for DoD.' },
  { id: 'cocom', name: 'Combatant Commands', abbrev: 'CCMD', icon: 'globe-shield', color: C.cocom, category: 'Joint & Defense-wide', mission: 'Employ joint military forces across geographic and functional commands.' },
  { id: 'defense-agencies', name: 'Defense Agencies & Field Activities', abbrev: 'DAFA', icon: 'organization', color: C.agencies, category: 'Joint & Defense-wide', mission: 'Deliver defense-wide support functions across the department.' },

  // ── Intelligence Community (Enterprise) ────────────────────────────────────
  { id: 'intel-community', name: 'Intelligence Community', abbrev: 'IC', icon: 'eye', color: C.ic, category: 'Intelligence Community', mission: 'Collect, analyze, and deliver intelligence to protect national security.' },

  // ══════════════════════════════ ARMY ═══════════════════════════════════════
  { id: 'forscom', name: 'U.S. Army Forces Command', abbrev: 'FORSCOM', icon: 'shield', color: C.armyL2, category: 'Components & Commands', mission: 'Train and provide combat-ready conventional forces to combatant commanders.', parentId: 'army' },
  { id: 'tradoc', name: 'Training & Doctrine Command', abbrev: 'TRADOC', icon: 'graduation', color: C.armyL2, category: 'Components & Commands', mission: 'Recruit, train, and educate the Army and shape its doctrine.', parentId: 'army' },
  { id: 'army-futures', name: 'Army Futures Command', abbrev: 'AFC', icon: 'lightbulb-filament', color: C.armyL2, category: 'Components & Commands', mission: 'Lead Army modernization and future-force transformation.', parentId: 'army' },
  { id: 'army-materiel', name: 'Army Materiel Command', abbrev: 'AMC', icon: 'box', color: C.armyL2, category: 'Components & Commands', mission: 'Provide materiel readiness and sustainment for the total force.', parentId: 'army' },
  { id: 'arcyber', name: 'Army Cyber Command', abbrev: 'ARCYBER', icon: 'shield-keyhole', color: C.armyL2, category: 'Components & Commands', mission: 'Operate and defend Army networks and deliver cyberspace effects.', parentId: 'army' },
  { id: 'inscom', name: 'Intelligence & Security Command', abbrev: 'INSCOM', icon: 'eye', color: C.armyL2, category: 'Components & Commands', mission: 'Conduct intelligence and security operations for Army commanders.', parentId: 'army' },
  { id: 'usasoc', name: 'Army Special Operations Command', abbrev: 'USASOC', icon: 'star', color: C.armyL2, category: 'Components & Commands', mission: 'Organize, train, and equip Army special-operations forces.', parentId: 'army' },
  { id: 'usace', name: 'U.S. Army Corps of Engineers', abbrev: 'USACE', icon: 'wrench', color: C.armyL2, category: 'Components & Commands', mission: 'Deliver engineering, construction, and water-resource solutions.', parentId: 'army' },

  // FORSCOM → corps → divisions (depth 4)
  { id: 'i-corps', name: 'I Corps', abbrev: 'I CORPS', icon: 'map', color: C.armyL3, category: 'Components & Commands', mission: 'Provide corps-level command and control for Pacific-postured forces.', parentId: 'forscom' },
  { id: 'iii-corps', name: 'III Armored Corps', abbrev: 'III CORPS', icon: 'shield', color: C.armyL3, category: 'Components & Commands', mission: 'Deploy America’s Armored Corps as a rapid, decisive land force.', parentId: 'forscom' },
  { id: 'xviii-abn-corps', name: 'XVIII Airborne Corps', abbrev: 'XVIII ABN', icon: 'airplane', color: C.armyL3, category: 'Components & Commands', mission: 'Provide America’s Contingency Corps, ready to deploy rapidly worldwide.', parentId: 'forscom' },
  { id: '7th-infantry-division', name: '7th Infantry Division', abbrev: '7ID', icon: 'shield-task', color: C.armyL4, category: 'Components & Commands', mission: 'Train and deploy division-level combat power in the Pacific theater.', parentId: 'i-corps' },
  { id: '2nd-infantry-division', name: '2nd Infantry Division', abbrev: '2ID', icon: 'shield-task', color: C.armyL4, category: 'Components & Commands', mission: 'Deter aggression on the Korean Peninsula as a combined division.', parentId: 'i-corps' },
  { id: '1st-cavalry-division', name: '1st Cavalry Division', abbrev: '1CD', icon: 'shield-task', color: C.armyL4, category: 'Components & Commands', mission: 'Provide rapidly deployable armored division combat power.', parentId: 'iii-corps' },
  { id: '1st-armored-division', name: '1st Armored Division', abbrev: '1AD', icon: 'shield-task', color: C.armyL4, category: 'Components & Commands', mission: 'Train and lead an armored division ready for large-scale combat operations.', parentId: 'iii-corps' },
  { id: '82nd-airborne-division', name: '82nd Airborne Division', abbrev: '82ABN', icon: 'airplane', color: C.armyL4, category: 'Components & Commands', mission: 'Maintain the Army’s global-response-force airborne division.', parentId: 'xviii-abn-corps' },
  { id: '101st-airborne-division', name: '101st Airborne Division (Air Assault)', abbrev: '101ABN', icon: 'airplane', color: C.armyL4, category: 'Components & Commands', mission: 'Deliver air-assault division combat power anywhere in the world.', parentId: 'xviii-abn-corps' },
  { id: '10th-mountain-division', name: '10th Mountain Division (Light Infantry)', abbrev: '10MTN', icon: 'shield-task', color: C.armyL4, category: 'Components & Commands', mission: 'Provide light-infantry division forces for rapid worldwide deployment.', parentId: 'xviii-abn-corps' },

  // TRADOC → centers of excellence
  { id: 'cac', name: 'Combined Arms Center', abbrev: 'CAC', icon: 'book', color: C.armyL3, category: 'Components & Commands', mission: 'Lead leader development, doctrine, and lessons learned for the Army.', parentId: 'tradoc' },
  { id: 'mcoe', name: 'Maneuver Center of Excellence', abbrev: 'MCoE', icon: 'shield-task', color: C.armyL3, category: 'Components & Commands', mission: 'Train and develop doctrine for infantry and armor formations.', parentId: 'tradoc' },
  { id: 'cybercoe', name: 'Cyber Center of Excellence', abbrev: 'CyCoE', icon: 'shield-keyhole', color: C.armyL3, category: 'Components & Commands', mission: 'Train and develop doctrine for cyber, signal, and EW forces.', parentId: 'tradoc' },

  // Army Futures Command → components
  { id: 'devcom', name: 'DEVCOM (Combat Capabilities Development Command)', abbrev: 'DEVCOM', icon: 'beaker', color: C.armyL3, category: 'Components & Commands', mission: 'Perform research and engineering to field next-generation Army capability.', parentId: 'army-futures' },
  { id: 'fcc', name: 'Futures & Concepts Center', abbrev: 'FCC', icon: 'lightbulb', color: C.armyL3, category: 'Components & Commands', mission: 'Develop future force concepts, requirements, and force design.', parentId: 'army-futures' },

  // Army Materiel Command → components
  { id: 'tacom', name: 'Tank-automotive & Armaments Command', abbrev: 'TACOM', icon: 'car', color: C.armyL3, category: 'Components & Commands', mission: 'Develop, acquire, and sustain ground combat and tactical vehicles.', parentId: 'army-materiel' },
  { id: 'amcom', name: 'Aviation & Missile Command', abbrev: 'AMCOM', icon: 'rocket', color: C.armyL3, category: 'Components & Commands', mission: 'Provide aviation and missile life-cycle logistics and readiness.', parentId: 'army-materiel' },
  { id: 'usasac', name: 'Security Assistance Command', abbrev: 'USASAC', icon: 'globe', color: C.armyL3, category: 'Components & Commands', mission: 'Execute Army foreign military sales and security-assistance programs.', parentId: 'army-materiel' },

  // Army Cyber Command → components
  { id: 'cyber-protection-brigade', name: '1st Information Operations Command / Cyber Protection Brigade', abbrev: 'CPB', icon: 'shield-keyhole', color: C.armyL3, category: 'Components & Commands', mission: 'Conduct defensive cyberspace operations to protect Army networks.', parentId: 'arcyber' },
  { id: 'mi-brigade-780', name: '780th Military Intelligence Brigade (Cyber)', abbrev: '780th MI', icon: 'eye', color: C.armyL3, category: 'Components & Commands', mission: 'Conduct signals-intelligence-enabled cyberspace operations.', parentId: 'arcyber' },

  // INSCOM → components
  { id: 'mi-brigade-66', name: '66th Military Intelligence Brigade', abbrev: '66th MI', icon: 'eye', color: C.armyL3, category: 'Components & Commands', mission: 'Provide multi-discipline intelligence support across Europe.', parentId: 'inscom' },
  { id: 'mi-brigade-500', name: '500th Military Intelligence Brigade', abbrev: '500th MI', icon: 'globe-location', color: C.armyL3, category: 'Components & Commands', mission: 'Provide multi-discipline intelligence support across the Indo-Pacific.', parentId: 'inscom' },

  // USASOC → components
  { id: 'ranger-regiment-75', name: '75th Ranger Regiment', abbrev: '75th RGR', icon: 'star', color: C.armyL3, category: 'Components & Commands', mission: 'Plan and conduct large-scale joint forcible-entry raids.', parentId: 'usasoc' },
  { id: 'sfc-abn', name: 'Special Forces Command (Airborne)', abbrev: 'SFC(A)', icon: 'shield', color: C.armyL3, category: 'Components & Commands', mission: 'Organize, train, and deploy Army Special Forces groups.', parentId: 'usasoc' },
  { id: 'soar-160th', name: '160th Special Operations Aviation Regiment', abbrev: '160th SOAR', icon: 'airplane', color: C.armyL3, category: 'Components & Commands', mission: 'Provide precision special-operations aviation support.', parentId: 'usasoc' },

  // USACE → divisions
  { id: 'usace-north-atlantic', name: 'North Atlantic Division', abbrev: 'NAD', icon: 'water', color: C.armyL3, category: 'Components & Commands', mission: 'Deliver Corps of Engineers civil-works and military programs in the Northeast.', parentId: 'usace' },
  { id: 'usace-south-pacific', name: 'South Pacific Division', abbrev: 'SPD', icon: 'water', color: C.armyL3, category: 'Components & Commands', mission: 'Deliver Corps of Engineers civil-works and military programs across the Southwest.', parentId: 'usace' },

  // ══════════════════════════════ NAVY (incl. USMC) ══════════════════════════
  { id: 'usmc', name: 'U.S. Marine Corps', abbrev: 'USMC', icon: 'shield', color: C.navyL2, category: 'Components & Commands', mission: 'Serve as the nation’s expeditionary force in readiness.', parentId: 'navy' },
  { id: 'fleet-forces', name: 'U.S. Fleet Forces Command', abbrev: 'USFF', icon: 'ship', color: C.navyL2, category: 'Components & Commands', mission: 'Man, train, and equip combat-ready Atlantic fleet forces.', parentId: 'navy' },
  { id: 'pacfleet', name: 'U.S. Pacific Fleet', abbrev: 'PACFLT', icon: 'ship', color: C.navyL2, category: 'Components & Commands', mission: 'Man, train, and equip combat-ready Pacific fleet forces.', parentId: 'navy' },
  { id: 'navsea', name: 'Naval Sea Systems Command', abbrev: 'NAVSEA', icon: 'toolbox', color: C.navyL2, category: 'Components & Commands', mission: 'Design, build, and maintain the fleet’s ships and submarines.', parentId: 'navy' },
  { id: 'navair', name: 'Naval Air Systems Command', abbrev: 'NAVAIR', icon: 'airplane', color: C.navyL2, category: 'Components & Commands', mission: 'Develop and sustain naval aviation aircraft and weapons.', parentId: 'navy' },
  { id: 'navwar', name: 'Naval Information Warfare Systems Command', abbrev: 'NAVWAR', icon: 'server', color: C.navyL2, category: 'Components & Commands', mission: 'Deliver and sustain the Navy’s information-warfare capabilities.', parentId: 'navy' },
  { id: 'onr', name: 'Office of Naval Research', abbrev: 'ONR', icon: 'beaker', color: C.navyL2, category: 'Components & Commands', mission: 'Advance science and technology for future naval power.', parentId: 'navy' },
  { id: 'oni', name: 'Office of Naval Intelligence', abbrev: 'ONI', icon: 'eye', color: C.navyL2, category: 'Components & Commands', mission: 'Deliver maritime intelligence for decision advantage at sea.', parentId: 'navy' },
  { id: 'bumed', name: 'Navy Medicine (Bureau of Medicine & Surgery)', abbrev: 'BUMED', icon: 'stethoscope', color: C.navyL2, category: 'Components & Commands', mission: 'Deliver health care readiness across the Navy and Marine Corps.', parentId: 'navy' },

  { id: 'i-mef', name: 'I Marine Expeditionary Force', abbrev: 'I MEF', icon: 'shield', color: C.navyL3, category: 'Components & Commands', mission: 'Provide a Marine air-ground task force ready for global response from the West Coast.', parentId: 'usmc' },
  { id: 'ii-mef', name: 'II Marine Expeditionary Force', abbrev: 'II MEF', icon: 'shield', color: C.navyL3, category: 'Components & Commands', mission: 'Provide a Marine air-ground task force ready for global response from the East Coast.', parentId: 'usmc' },
  { id: 'marsoc', name: 'Marine Forces Special Operations Command', abbrev: 'MARSOC', icon: 'star', color: C.navyL3, category: 'Components & Commands', mission: 'Organize, train, and equip Marine special-operations forces.', parentId: 'usmc' },

  { id: 'navsurflant', name: 'Naval Surface Force Atlantic', abbrev: 'SURFLANT', icon: 'ship', color: C.navyL3, category: 'Components & Commands', mission: 'Man, train, and equip Atlantic-based surface combatants.', parentId: 'fleet-forces' },
  { id: 'subforlant', name: 'Submarine Force Atlantic', abbrev: 'SUBLANT', icon: 'water', color: C.navyL3, category: 'Components & Commands', mission: 'Man, train, and equip Atlantic-based submarine forces.', parentId: 'fleet-forces' },

  { id: 'third-fleet', name: 'U.S. Third Fleet', abbrev: 'C3F', icon: 'ship', color: C.navyL3, category: 'Components & Commands', mission: 'Command naval forces in the Eastern and Northern Pacific.', parentId: 'pacfleet' },
  { id: 'seventh-fleet', name: 'U.S. Seventh Fleet', abbrev: 'C7F', icon: 'ship', color: C.navyL3, category: 'Components & Commands', mission: 'Command the Navy’s largest forward-deployed fleet in the Indo-Pacific.', parentId: 'pacfleet' },

  { id: 'peo-ships', name: 'Program Executive Office Ships', abbrev: 'PEO SHIPS', icon: 'ship', color: C.navyL3, category: 'Components & Commands', mission: 'Acquire and modernize the Navy’s surface-ship fleet.', parentId: 'navsea' },
  { id: 'peo-submarines', name: 'Program Executive Office Submarines', abbrev: 'PEO SUB', icon: 'water', color: C.navyL3, category: 'Components & Commands', mission: 'Acquire and modernize the Navy’s submarine fleet.', parentId: 'navsea' },

  { id: 'peo-tactical-aircraft', name: 'Program Executive Office Tactical Aircraft', abbrev: 'PEO(T)', icon: 'airplane', color: C.navyL3, category: 'Components & Commands', mission: 'Acquire and sustain naval strike-fighter aircraft programs.', parentId: 'navair' },
  { id: 'peo-unmanned-aviation', name: 'Program Executive Office Unmanned Aviation & Strike Weapons', abbrev: 'PEO(U&W)', icon: 'airplane', color: C.navyL3, category: 'Components & Commands', mission: 'Acquire naval unmanned-aviation and strike-weapon systems.', parentId: 'navair' },

  { id: 'niwc-atlantic', name: 'Naval Information Warfare Center Atlantic', abbrev: 'NIWC LANT', icon: 'server', color: C.navyL3, category: 'Components & Commands', mission: 'Deliver C4ISR research, development, and engineering from the East Coast.', parentId: 'navwar' },
  { id: 'niwc-pacific', name: 'Naval Information Warfare Center Pacific', abbrev: 'NIWC PAC', icon: 'server', color: C.navyL3, category: 'Components & Commands', mission: 'Deliver C4ISR research, development, and engineering from the West Coast.', parentId: 'navwar' },

  { id: 'nrl', name: 'Naval Research Laboratory', abbrev: 'NRL', icon: 'beaker', color: C.navyL3, category: 'Components & Commands', mission: 'Conduct broad-based, multidisciplinary research for the Navy and Marine Corps.', parentId: 'onr' },
  { id: 'noic', name: 'Nimitz Operational Intelligence Center', abbrev: 'NOIC', icon: 'eye', color: C.navyL3, category: 'Components & Commands', mission: 'Provide current maritime operational intelligence to the fleet.', parentId: 'oni' },

  // ══════════════════════════════ AIR FORCE (incl. Space Force) ═════════════
  { id: 'ussf', name: 'U.S. Space Force', abbrev: 'USSF', icon: 'rocket', color: C.airforceL2, category: 'Components & Commands', mission: 'Secure the nation’s interests in, from, and to space.', parentId: 'air-force' },
  { id: 'acc', name: 'Air Combat Command', abbrev: 'ACC', icon: 'airplane', color: C.airforceL2, category: 'Components & Commands', mission: 'Provide combat airpower ready for rapid global employment.', parentId: 'air-force' },
  { id: 'air-mobility', name: 'Air Mobility Command', abbrev: 'AMC', icon: 'box', color: C.airforceL2, category: 'Components & Commands', mission: 'Deliver rapid global airlift, air refueling, and aeromedical evacuation.', parentId: 'air-force' },
  { id: 'afmc', name: 'Air Force Materiel Command', abbrev: 'AFMC', icon: 'toolbox', color: C.airforceL2, category: 'Components & Commands', mission: 'Develop, acquire, and sustain Air Force weapon systems.', parentId: 'air-force' },
  { id: 'afrl', name: 'Air Force Research Laboratory', abbrev: 'AFRL', icon: 'beaker', color: C.airforceL2, category: 'Components & Commands', mission: 'Discover and develop the science behind future air and space power.', parentId: 'air-force' },
  { id: 'afgsc', name: 'Air Force Global Strike Command', abbrev: 'AFGSC', icon: 'rocket', color: C.airforceL2, category: 'Components & Commands', mission: 'Provide strategic deterrence and global-strike bomber and ICBM forces.', parentId: 'air-force' },
  { id: 'aetc', name: 'Air Education & Training Command', abbrev: 'AETC', icon: 'graduation', color: C.airforceL2, category: 'Components & Commands', mission: 'Recruit, train, and educate Airmen for the Air Force.', parentId: 'air-force' },
  { id: 'pacaf', name: 'Pacific Air Forces', abbrev: 'PACAF', icon: 'globe-location', color: C.airforceL2, category: 'Components & Commands', mission: 'Provide air and space power across the Indo-Pacific theater.', parentId: 'air-force' },
  { id: 'usafe-afafrica', name: 'U.S. Air Forces in Europe – Air Forces Africa', abbrev: 'USAFE-AFAFRICA', icon: 'globe-location', color: C.airforceL2, category: 'Components & Commands', mission: 'Provide air and space power across Europe and Africa.', parentId: 'air-force' },

  { id: 'space-ops-command', name: 'Space Operations Command', abbrev: 'SpOC', icon: 'rocket', color: C.airforceL3, category: 'Components & Commands', mission: 'Present combat-ready space forces to combatant commanders.', parentId: 'ussf' },
  { id: 'space-systems-command', name: 'Space Systems Command', abbrev: 'SSC', icon: 'rocket', color: C.airforceL3, category: 'Components & Commands', mission: 'Acquire and field space capabilities for national security.', parentId: 'ussf' },
  { id: 'star-command', name: 'Space Training & Readiness Command', abbrev: 'STARCOM', icon: 'graduation', color: C.airforceL3, category: 'Components & Commands', mission: 'Train, educate, and test Guardians and space-force doctrine.', parentId: 'ussf' },

  { id: 'ninth-af', name: 'Ninth Air Force (Air Forces Central)', abbrev: '9 AF', icon: 'airplane', color: C.airforceL3, category: 'Components & Commands', mission: 'Present air combat power across the Central Command area of responsibility.', parentId: 'acc' },
  { id: '16th-af', name: 'Sixteenth Air Force (Air Forces Cyber)', abbrev: '16 AF', icon: 'shield-keyhole', color: C.airforceL3, category: 'Components & Commands', mission: 'Conduct information warfare and cyber operations for the Air Force.', parentId: 'acc' },

  { id: '18th-af', name: 'Eighteenth Air Force', abbrev: '18 AF', icon: 'airplane', color: C.airforceL3, category: 'Components & Commands', mission: 'Provide rapid global mobility forces under Air Mobility Command.', parentId: 'air-mobility' },

  { id: 'aflcmc', name: 'Air Force Life Cycle Management Center', abbrev: 'AFLCMC', icon: 'toolbox', color: C.airforceL3, category: 'Components & Commands', mission: 'Manage the full life cycle of Air Force weapon systems.', parentId: 'afmc' },
  { id: 'afsc', name: 'Air Force Sustainment Center', abbrev: 'AFSC', icon: 'wrench', color: C.airforceL3, category: 'Components & Commands', mission: 'Provide depot maintenance, supply chain, and logistics support.', parentId: 'afmc' },
  { id: 'aftc', name: 'Air Force Test Center', abbrev: 'AFTC', icon: 'beaker', color: C.airforceL3, category: 'Components & Commands', mission: 'Test and evaluate Air Force aircraft, weapons, and systems.', parentId: 'afmc' },

  { id: 'eighth-af', name: 'Eighth Air Force', abbrev: '8 AF', icon: 'rocket', color: C.airforceL3, category: 'Components & Commands', mission: 'Provide long-range bomber forces for global strike.', parentId: 'afgsc' },
  { id: 'twentieth-af', name: 'Twentieth Air Force', abbrev: '20 AF', icon: 'rocket', color: C.airforceL3, category: 'Components & Commands', mission: 'Operate and secure the nation’s ICBM force.', parentId: 'afgsc' },

  { id: 'second-af', name: 'Second Air Force', abbrev: '2 AF', icon: 'graduation', color: C.airforceL3, category: 'Components & Commands', mission: 'Conduct basic military and technical training for enlisted Airmen.', parentId: 'aetc' },
  { id: 'nineteenth-af', name: 'Nineteenth Air Force', abbrev: '19 AF', icon: 'graduation', color: C.airforceL3, category: 'Components & Commands', mission: 'Conduct flying training for pilots, navigators, and aircrew.', parentId: 'aetc' },

  // ══════════════════════════════ OSD (component offices) ════════════════════
  { id: 'cdao', name: 'Chief Digital & Artificial Intelligence Office', abbrev: 'CDAO', icon: 'database', color: C.osdL2, category: 'Components & Commands', mission: 'Accelerate DoD adoption of data, analytics, and AI.', parentId: 'osd' },
  { id: 'diu', name: 'Defense Innovation Unit', abbrev: 'DIU', icon: 'lightbulb', color: C.osdL2, category: 'Components & Commands', mission: 'Field commercial technology to strengthen national security.', parentId: 'osd' },
  { id: 'usd-personnel-readiness', name: 'Personnel & Readiness', abbrev: 'P&R', icon: 'people-team', color: C.osdL2, category: 'Components & Commands', mission: 'Manage total-force readiness, personnel, and military health policy.', parentId: 'osd' },
  { id: 'usd-comptroller', name: 'Comptroller / Chief Financial Officer', abbrev: 'USD(C)', icon: 'money', color: C.osdL2, category: 'Components & Commands', mission: 'Steward the department’s budget and financial management.', parentId: 'osd' },
  { id: 'usd-intel-security', name: 'Intelligence & Security', abbrev: 'USD(I&S)', icon: 'shield-lock', color: C.osdL2, category: 'Components & Commands', mission: 'Oversee defense intelligence, counterintelligence, and security policy.', parentId: 'osd' },
  { id: 'usd-policy', name: 'Policy', abbrev: 'USD(P)', icon: 'scales', color: C.osdL2, category: 'Components & Commands', mission: 'Develop defense strategy and oversee politico-military affairs.', parentId: 'osd' },
  { id: 'usd-acquisition', name: 'Acquisition & Sustainment', abbrev: 'USD(A&S)', icon: 'toolbox', color: C.osdL2, category: 'Components & Commands', mission: 'Set acquisition policy and oversee the defense industrial base.', parentId: 'osd' },

  // ══════════════════════════════ COMBATANT COMMANDS ═════════════════════════
  { id: 'northcom', name: 'U.S. Northern Command', abbrev: 'USNORTHCOM', icon: 'home', color: C.cocomL2, category: 'Components & Commands', mission: 'Defend the homeland and support civil authorities.', parentId: 'cocom' },
  { id: 'southcom', name: 'U.S. Southern Command', abbrev: 'USSOUTHCOM', icon: 'map', color: C.cocomL2, category: 'Components & Commands', mission: 'Promote security cooperation across Central and South America.', parentId: 'cocom' },
  { id: 'eucom', name: 'U.S. European Command', abbrev: 'USEUCOM', icon: 'globe-location', color: C.cocomL2, category: 'Components & Commands', mission: 'Defend and protect U.S. interests across Europe with allies.', parentId: 'cocom' },
  { id: 'africom', name: 'U.S. Africa Command', abbrev: 'USAFRICOM', icon: 'earth', color: C.cocomL2, category: 'Components & Commands', mission: 'Advance U.S. interests and regional security across Africa.', parentId: 'cocom' },
  { id: 'centcom', name: 'U.S. Central Command', abbrev: 'USCENTCOM', icon: 'globe-shield', color: C.cocomL2, category: 'Components & Commands', mission: 'Direct military operations across the central region.', parentId: 'cocom' },
  { id: 'indopacom', name: 'U.S. Indo-Pacific Command', abbrev: 'USINDOPACOM', icon: 'earth', color: C.cocomL2, category: 'Components & Commands', mission: 'Promote security and stability across the Indo-Pacific region.', parentId: 'cocom' },
  { id: 'spacecom', name: 'U.S. Space Command', abbrev: 'USSPACECOM', icon: 'rocket', color: C.cocomL2, category: 'Components & Commands', mission: 'Conduct operations in, from, and to space to deter conflict.', parentId: 'cocom' },
  { id: 'socom', name: 'U.S. Special Operations Command', abbrev: 'USSOCOM', icon: 'star', color: C.cocomL2, category: 'Components & Commands', mission: 'Provide fully capable special-operations forces worldwide.', parentId: 'cocom' },
  { id: 'transcom', name: 'U.S. Transportation Command', abbrev: 'USTRANSCOM', icon: 'truck', color: C.cocomL2, category: 'Components & Commands', mission: 'Project and sustain military power through global mobility.', parentId: 'cocom' },
  { id: 'stratcom', name: 'U.S. Strategic Command', abbrev: 'USSTRATCOM', icon: 'globe', color: C.cocomL2, category: 'Components & Commands', mission: 'Deter strategic attack through a safe, secure, effective deterrent.', parentId: 'cocom' },
  { id: 'cybercom', name: 'U.S. Cyber Command', abbrev: 'USCYBERCOM', icon: 'shield-keyhole', color: C.cocomL2, category: 'Components & Commands', mission: 'Direct, synchronize, and conduct cyberspace operations.', parentId: 'cocom' },

  { id: 'cnmf', name: 'Cyber National Mission Force', abbrev: 'CNMF', icon: 'shield-keyhole', color: C.cocomL3, category: 'Components & Commands', mission: 'Defend the nation by countering adversary cyber actors.', parentId: 'cybercom' },
  { id: 'ccmf', name: 'Cyber Combat Mission Force', abbrev: 'CCMF', icon: 'shield-keyhole', color: C.cocomL3, category: 'Components & Commands', mission: 'Generate offensive cyberspace effects supporting combatant commands.', parentId: 'cybercom' },
  { id: 'cpf', name: 'Cyber Protection Force', abbrev: 'CPF', icon: 'shield-lock', color: C.cocomL3, category: 'Components & Commands', mission: 'Defend DoD Information Network priority missions and terrain.', parentId: 'cybercom' },

  { id: 'jsoc', name: 'Joint Special Operations Command', abbrev: 'JSOC', icon: 'star', color: C.cocomL3, category: 'Components & Commands', mission: 'Study special-operations requirements and standardize joint SOF equipment and tactics.', parentId: 'socom' },
  { id: 'navsoc-cmd', name: 'Naval Special Warfare Command', abbrev: 'NAVSPECWARCOM', icon: 'ship', color: C.cocomL3, category: 'Components & Commands', mission: 'Organize, train, and equip Navy SEAL and special-warfare forces.', parentId: 'socom' },
  { id: 'afsoc', name: 'Air Force Special Operations Command', abbrev: 'AFSOC', icon: 'airplane', color: C.cocomL3, category: 'Components & Commands', mission: 'Organize, train, and equip Air Force special-operations forces.', parentId: 'socom' },

  { id: 'msc', name: 'Military Sealift Command', abbrev: 'MSC', icon: 'ship', color: C.cocomL3, category: 'Components & Commands', mission: 'Provide ocean transportation for the Department of Defense.', parentId: 'transcom' },
  { id: 'sddc', name: 'Surface Deployment & Distribution Command', abbrev: 'SDDC', icon: 'ship', color: C.cocomL3, category: 'Components & Commands', mission: 'Provide global surface-deployment and distribution capability.', parentId: 'transcom' },

  // ══════════════════════════════ DEFENSE AGENCIES & FIELD ACTIVITIES ════════
  { id: 'disa', name: 'Defense Information Systems Agency', abbrev: 'DISA', icon: 'server', color: C.agenciesL2, category: 'Components & Commands', mission: 'Provide IT and communications support to the warfighter.', parentId: 'defense-agencies' },
  { id: 'dla', name: 'Defense Logistics Agency', abbrev: 'DLA', icon: 'box', color: C.agenciesL2, category: 'Components & Commands', mission: 'Provide logistics, acquisition, and technical services to the military.', parentId: 'defense-agencies' },
  { id: 'darpa', name: 'Defense Advanced Research Projects Agency', abbrev: 'DARPA', icon: 'lightbulb-filament', color: C.agenciesL2, category: 'Components & Commands', mission: 'Make pivotal investments in breakthrough technologies for national security.', parentId: 'defense-agencies' },
  { id: 'dtra', name: 'Defense Threat Reduction Agency', abbrev: 'DTRA', icon: 'shield-task', color: C.agenciesL2, category: 'Components & Commands', mission: 'Counter weapons of mass destruction and emerging threats.', parentId: 'defense-agencies' },
  { id: 'mda', name: 'Missile Defense Agency', abbrev: 'MDA', icon: 'rocket', color: C.agenciesL2, category: 'Components & Commands', mission: 'Develop and field a layered missile-defense system.', parentId: 'defense-agencies' },
  { id: 'dcsa', name: 'Defense Counterintelligence & Security Agency', abbrev: 'DCSA', icon: 'shield', color: C.agenciesL2, category: 'Components & Commands', mission: 'Secure the trustworthiness of the U.S. government’s workforce.', parentId: 'defense-agencies' },
  { id: 'dcma', name: 'Defense Contract Management Agency', abbrev: 'DCMA', icon: 'document', color: C.agenciesL2, category: 'Components & Commands', mission: 'Ensure defense contracts deliver as promised, on time and on cost.', parentId: 'defense-agencies' },
  { id: 'dfas', name: 'Defense Finance & Accounting Service', abbrev: 'DFAS', icon: 'wallet', color: C.agenciesL2, category: 'Components & Commands', mission: 'Deliver payroll and accounting services across DoD.', parentId: 'defense-agencies' },
  { id: 'dha', name: 'Defense Health Agency', abbrev: 'DHA', icon: 'heart-pulse', color: C.agenciesL2, category: 'Components & Commands', mission: 'Operate the Military Health System as an integrated system of readiness and health.', parentId: 'defense-agencies' },
  { id: 'dodea', name: 'Department of Defense Education Activity', abbrev: 'DoDEA', icon: 'graduation', color: C.agenciesL2, category: 'Components & Commands', mission: 'Educate military-connected children at schools worldwide.', parentId: 'defense-agencies' },
  { id: 'dpaa', name: 'Defense POW/MIA Accounting Agency', abbrev: 'DPAA', icon: 'ribbon', color: C.agenciesL2, category: 'Components & Commands', mission: 'Provide the fullest possible accounting of missing personnel to their families.', parentId: 'defense-agencies' },
  { id: 'dsca', name: 'Defense Security Cooperation Agency', abbrev: 'DSCA', icon: 'globe', color: C.agenciesL2, category: 'Components & Commands', mission: 'Lead security-cooperation programs that build partner-nation capability.', parentId: 'defense-agencies' },
  { id: 'dcaa', name: 'Defense Contract Audit Agency', abbrev: 'DCAA', icon: 'chart-multiple', color: C.agenciesL2, category: 'Components & Commands', mission: 'Perform contract audits and provide accounting advisory services to DoD.', parentId: 'defense-agencies' },

  { id: 'jfhq-dodin', name: 'Joint Force Headquarters – DODIN', abbrev: 'JFHQ-DODIN', icon: 'shield-keyhole', color: C.agenciesL3, category: 'Components & Commands', mission: 'Operate and defend the DoD Information Network.', parentId: 'disa' },
  { id: 'dla-troop-support', name: 'DLA Troop Support', abbrev: 'DLA TS', icon: 'box', color: C.agenciesL3, category: 'Components & Commands', mission: 'Supply food, clothing, medical materiel, and construction supplies.', parentId: 'dla' },
  { id: 'dla-aviation', name: 'DLA Aviation', abbrev: 'DLA AV', icon: 'airplane', color: C.agenciesL3, category: 'Components & Commands', mission: 'Supply repair parts and support equipment to keep aircraft flying.', parentId: 'dla' },
  { id: 'dla-land-maritime', name: 'DLA Land & Maritime', abbrev: 'DLA LM', icon: 'truck', color: C.agenciesL3, category: 'Components & Commands', mission: 'Supply land and maritime weapon-system parts across the services.', parentId: 'dla' },

  // ══════════════════════════════ INTELLIGENCE COMMUNITY ═════════════════════
  { id: 'odni', name: 'Office of the Director of National Intelligence', abbrev: 'ODNI', icon: 'organization', color: C.icL2, category: 'Intelligence Community', mission: 'Lead and integrate the Intelligence Community.', parentId: 'intel-community' },
  { id: 'cia', name: 'Central Intelligence Agency', abbrev: 'CIA', icon: 'globe-shield', color: C.icL2, category: 'Intelligence Community', mission: 'Collect foreign intelligence and conduct all-source analysis.', parentId: 'intel-community' },
  { id: 'nsa', name: 'National Security Agency', abbrev: 'NSA', icon: 'shield-keyhole', color: C.icL2, category: 'Intelligence Community', mission: 'Lead signals intelligence and cybersecurity for the nation.', parentId: 'intel-community' },
  { id: 'dia', name: 'Defense Intelligence Agency', abbrev: 'DIA', icon: 'eye', color: C.icL2, category: 'Intelligence Community', mission: 'Provide military intelligence to warfighters and policymakers.', parentId: 'intel-community' },
  { id: 'nga', name: 'National Geospatial-Intelligence Agency', abbrev: 'NGA', icon: 'map', color: C.icL2, category: 'Intelligence Community', mission: 'Deliver geospatial intelligence for decision advantage.', parentId: 'intel-community' },
  { id: 'nro', name: 'National Reconnaissance Office', abbrev: 'NRO', icon: 'rocket', color: C.icL2, category: 'Intelligence Community', mission: 'Develop and operate the nation’s reconnaissance satellites.', parentId: 'intel-community' },
  { id: 'fbi-ib', name: 'FBI Intelligence Branch', abbrev: 'FBI-IB', icon: 'fingerprint', color: C.icL2, category: 'Intelligence Community', mission: 'Integrate intelligence into the FBI’s national-security mission.', parentId: 'intel-community' },
  { id: 'dea-onsi', name: 'DEA Office of National Security Intelligence', abbrev: 'ONSI', icon: 'shield-task', color: C.icL2, category: 'Intelligence Community', mission: 'Fuse drug-related intelligence into the national-security enterprise.', parentId: 'intel-community' },
  { id: 'dhs-ia', name: 'DHS Office of Intelligence & Analysis', abbrev: 'DHS I&A', icon: 'shield', color: C.icL2, category: 'Intelligence Community', mission: 'Deliver homeland-security intelligence to state, local, and federal partners.', parentId: 'intel-community' },
  { id: 'state-inr', name: 'State Bureau of Intelligence & Research', abbrev: 'INR', icon: 'globe', color: C.icL2, category: 'Intelligence Community', mission: 'Provide independent analysis to inform U.S. diplomacy.', parentId: 'intel-community' },
  { id: 'treasury-oia', name: 'Treasury Office of Intelligence & Analysis', abbrev: 'OIA', icon: 'money', color: C.icL2, category: 'Intelligence Community', mission: 'Deliver intelligence on threats to the financial system.', parentId: 'intel-community' },
  { id: 'energy-oici', name: 'DOE Office of Intelligence & Counterintelligence', abbrev: 'OICI', icon: 'flash', color: C.icL2, category: 'Intelligence Community', mission: 'Protect and leverage the national-lab complex for nuclear and energy intelligence.', parentId: 'intel-community' },
  { id: 'uscg-intel', name: 'Coast Guard Intelligence', abbrev: 'CGI', icon: 'ship', color: C.icL2, category: 'Intelligence Community', mission: 'Deliver maritime intelligence supporting homeland and border security.', parentId: 'intel-community' },
  { id: 'marine-intel', name: 'Marine Corps Intelligence', abbrev: 'MCIA', icon: 'shield', color: C.icL2, category: 'Intelligence Community', mission: 'Provide intelligence support to Marine Corps expeditionary forces.', parentId: 'intel-community' },
  { id: 'space-force-intel', name: 'Space Force Intelligence', abbrev: 'SF INTEL', icon: 'rocket', color: C.icL2, category: 'Intelligence Community', mission: 'Provide intelligence support to space-domain operations.', parentId: 'intel-community' },

  { id: 'nic', name: 'National Intelligence Council', abbrev: 'NIC', icon: 'people-team', color: C.icL3, category: 'Intelligence Community', mission: 'Produce National Intelligence Estimates for senior policymakers.', parentId: 'odni' },
  { id: 'nctc', name: 'National Counterterrorism Center', abbrev: 'NCTC', icon: 'shield-task', color: C.icL3, category: 'Intelligence Community', mission: 'Integrate and analyze terrorism intelligence across the government.', parentId: 'odni' },
  { id: 'ncsc-ic', name: 'National Counterintelligence & Security Center', abbrev: 'NCSC', icon: 'shield-lock', color: C.icL3, category: 'Intelligence Community', mission: 'Lead national counterintelligence and security-clearance reform.', parentId: 'odni' },
  { id: 'ctiic', name: 'Cyber Threat Intelligence Integration Center', abbrev: 'CTIIC', icon: 'shield-keyhole', color: C.icL3, category: 'Intelligence Community', mission: 'Integrate cyber-threat intelligence across the Intelligence Community.', parentId: 'odni' },

  { id: 'cia-analysis', name: 'Directorate of Analysis', abbrev: 'DA', icon: 'data-histogram', color: C.icL3, category: 'Intelligence Community', mission: 'Produce all-source analysis on foreign issues for policymakers.', parentId: 'cia' },
  { id: 'cia-operations', name: 'Directorate of Operations', abbrev: 'DO', icon: 'globe-shield', color: C.icL3, category: 'Intelligence Community', mission: 'Conduct clandestine human-intelligence collection worldwide.', parentId: 'cia' },
  { id: 'cia-st', name: 'Directorate of Science & Technology', abbrev: 'DS&T', icon: 'beaker', color: C.icL3, category: 'Intelligence Community', mission: 'Create technology to advance the CIA’s intelligence mission.', parentId: 'cia' },
  { id: 'cia-digital-innovation', name: 'Directorate of Digital Innovation', abbrev: 'DDI', icon: 'database', color: C.icL3, category: 'Intelligence Community', mission: 'Accelerate digital and cyber tradecraft across the agency.', parentId: 'cia' },
  { id: 'cia-support', name: 'Directorate of Support', abbrev: 'DS', icon: 'toolbox', color: C.icL3, category: 'Intelligence Community', mission: 'Deliver the logistics, security, and infrastructure that enable the mission.', parentId: 'cia' },

  { id: 'nsa-cybersecurity', name: 'Cybersecurity Directorate', abbrev: 'NSA CSD', icon: 'shield-keyhole', color: C.icL3, category: 'Intelligence Community', mission: 'Prevent and eradicate threats to national-security systems.', parentId: 'nsa' },
  { id: 'nsa-sigint', name: 'Signals Intelligence Directorate', abbrev: 'NSA SID', icon: 'eye', color: C.icL3, category: 'Intelligence Community', mission: 'Collect and process foreign signals intelligence.', parentId: 'nsa' },

  { id: 'das', name: 'Defense Attaché Service', abbrev: 'DAS', icon: 'globe-location', color: C.icL3, category: 'Intelligence Community', mission: 'Represent DIA and DoD at U.S. embassies worldwide.', parentId: 'dia' },
  { id: 'ncmi', name: 'National Center for Medical Intelligence', abbrev: 'NCMI', icon: 'stethoscope', color: C.icL3, category: 'Intelligence Community', mission: 'Produce medical intelligence on foreign health and biological threats.', parentId: 'dia' },

  { id: 'nga-analysis', name: 'Analysis & Production Directorate', abbrev: 'NGA A&P', icon: 'data-histogram', color: C.icL3, category: 'Intelligence Community', mission: 'Produce geospatial-intelligence analysis and products.', parentId: 'nga' },
  { id: 'nga-source', name: 'Source Operations & Management Directorate', abbrev: 'NGA SOM', icon: 'map', color: C.icL3, category: 'Intelligence Community', mission: 'Manage imagery and geospatial data sourcing and tasking.', parentId: 'nga' },

  { id: 'nro-systems-acquisition', name: 'Systems Acquisition Directorate', abbrev: 'NRO SAD', icon: 'rocket', color: C.icL3, category: 'Intelligence Community', mission: 'Acquire and field the nation’s reconnaissance satellite systems.', parentId: 'nro' },
  { id: 'nro-comm-systems', name: 'Communications Systems Acquisition Directorate', abbrev: 'NRO CSAD', icon: 'wifi', color: C.icL3, category: 'Intelligence Community', mission: 'Acquire ground and communications systems for reconnaissance data.', parentId: 'nro' },
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
