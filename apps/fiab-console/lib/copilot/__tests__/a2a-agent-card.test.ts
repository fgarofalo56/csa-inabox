/**
 * a2a-agent-card (B-N14d) — the spec-conformant Agent Card generator.
 *
 * Every assertion is anchored to the CURRENT A2A specification
 * (https://a2a-protocol.org/latest/specification/), whose §-numbers are quoted
 * in the module under test:
 *   §4.4.1 AgentCard (required: name, description, supportedInterfaces,
 *          version, capabilities, defaultInputModes, defaultOutputModes, skills)
 *   §4.4.2 AgentProvider (url + organization both REQUIRED)
 *   §4.4.3 AgentCapabilities (extendedAgentCard, extensions)
 *   §4.4.5 AgentSkill · §4.4.6 AgentInterface (url/protocolBinding/tenant/protocolVersion)
 *   §4.4.7 AgentCardSignature · §4.5.1 SecurityScheme one-of
 */
import { describe, it, expect } from 'vitest';
import {
  A2A_CARD_PROTOCOL_VERSION,
  A2A_PROTOCOL_BINDING_JSONRPC,
  A2A_WELL_KNOWN_PATH,
  agentCardCatalogEntry,
  agentInterfaceTenant,
  generateAgentCard,
  generateValidatedAgentCard,
  itemAgentSkillId,
  registeredAgentFromItem,
  registeredAgentFromMeshAgent,
  registeredPlatformAgent,
  validateAgentCard,
  type A2aSpecAgentCard,
} from '../a2a-agent-card';
import { buildPlatformAgentCard, PLATFORM_SKILLS } from '../a2a-tasks';
import { buildItemAgentCard } from '../a2a-item-server';

const meta = () =>
  registeredPlatformAgent({ origin: 'https://loom.example/', skills: PLATFORM_SKILLS });

describe('a2a-agent-card — current-spec shape (§4.4.1)', () => {
  it('emits every REQUIRED §4.4.1 field', () => {
    const card = generateAgentCard(meta());
    for (const k of [
      'name', 'description', 'supportedInterfaces', 'version',
      'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills',
    ] as const) {
      expect(card[k], `missing required field ${k}`).toBeDefined();
    }
    expect(Array.isArray(card.supportedInterfaces)).toBe(true);
    expect(card.supportedInterfaces.length).toBeGreaterThan(0);
  });

  it('the preferred interface is the agent endpoint (§4.4.6 tuple)', () => {
    const card = generateAgentCard(meta());
    const [preferred] = card.supportedInterfaces;
    expect(preferred.url).toBe('https://loom.example/api/a2a');
    expect(preferred.protocolBinding).toBe(A2A_PROTOCOL_BINDING_JSONRPC);
    expect(preferred.protocolVersion).toBe(A2A_CARD_PROTOCOL_VERSION);
    // The platform card addresses no single agent → no tenant routing id.
    expect(preferred.tenant).toBeUndefined();
  });

  it('provider carries BOTH required §4.4.2 fields', () => {
    const card = generateAgentCard(meta());
    expect(card.provider?.organization).toBeTruthy();
    expect(card.provider?.url).toBeTruthy();
  });

  it('securitySchemes use the §4.5.1 one-of wrapper', () => {
    const card = generateAgentCard(meta());
    const scheme = card.securitySchemes?.loomBearer;
    expect(scheme?.httpAuthSecurityScheme?.scheme).toBe('Bearer');
    // exactly ONE member present
    expect(Object.keys(scheme || {})).toEqual(['httpAuthSecurityScheme']);
    expect(card.securityRequirements?.[0]?.schemes?.loomBearer).toEqual({ list: [] });
  });

  it('capabilities use extendedAgentCard (§4.4.3), not the 0.3 top-level name only', () => {
    const card = generateAgentCard({ ...meta(), extendedAgentCard: true, streaming: true });
    expect(card.capabilities.extendedAgentCard).toBe(true);
    expect(card.capabilities.streaming).toBe(true);
    // legacy alias preserved for 0.3 clients
    expect(card.supportsAuthenticatedExtendedCard).toBe(true);
  });

  it('keeps the 0.3-line aliases so deployed clients keep working', () => {
    const card = generateAgentCard(meta());
    expect(card.url).toBe(card.supportedInterfaces[0].url);
    expect(card.preferredTransport).toBe(card.supportedInterfaces[0].protocolBinding);
    expect(card.protocolVersion).toBeTruthy();
    expect(card.security?.[0]).toEqual({ loomBearer: [] });
  });

  it('registers the §14.3 well-known path', () => {
    expect(A2A_WELL_KNOWN_PATH).toBe('/.well-known/agent-card.json');
  });
});

describe('a2a-agent-card — generated from REGISTERED metadata', () => {
  const item = { id: 'da-42', displayName: 'Sales Insights', description: 'Answers sales questions.', state: { publishedVersion: '2.1.0' } };

  it('a published data-agent item becomes a conformant card', () => {
    const { card, validation } = generateValidatedAgentCard(
      registeredAgentFromItem({
        item,
        kind: 'data-agent',
        endpoint: 'https://loom.example/api/items/data-agent/da-42/a2a',
        platformEndpoint: 'https://loom.example/api/a2a',
      }),
    );
    expect(validation.ok, validation.errors.join('; ')).toBe(true);
    expect(card.name).toBe('Sales Insights');
    // version comes from the REGISTERED state, not invented
    expect(card.version).toBe('2.1.0');
    expect(card.skills[0].id).toBe(itemAgentSkillId('Sales Insights'));
    // second interface = the shared platform endpoint + the §4.4.6 routing id
    expect(card.supportedInterfaces).toHaveLength(2);
    expect(card.supportedInterfaces[1].url).toBe('https://loom.example/api/a2a');
    expect(card.supportedInterfaces[1].tenant).toBe('data-agent:da-42');
  });

  it('defaults the version when the item has none (never invents a number)', () => {
    const { card } = generateValidatedAgentCard(
      registeredAgentFromItem({ item: { id: 'x', displayName: 'X' }, kind: 'agent-flow', endpoint: 'https://l/api' }),
    );
    expect(card.version).toBe('1.0.0');
  });

  it('a mesh agent declares its egress profile as a §4.4.4 extension', () => {
    const { card, validation } = generateValidatedAgentCard(
      registeredAgentFromMeshAgent({
        agent: { id: 'g', name: 'Gov', kind: 'governance', egressProfile: 'gov' },
        endpoint: 'https://loom.example/api/mesh/a2a/g',
      }),
    );
    expect(validation.ok, validation.errors.join('; ')).toBe(true);
    expect(card.capabilities.extensions?.[0]?.params).toEqual({ egressProfile: 'gov' });
    expect(card.supportedInterfaces[0].tenant).toBe('mesh:g');
  });

  it('agentInterfaceTenant omits the routing id for the platform card', () => {
    expect(agentInterfaceTenant('platform', 'platform')).toBeUndefined();
    expect(agentInterfaceTenant('agent-flow', 'af-1')).toBe('agent-flow:af-1');
  });
});

describe('a2a-agent-card — validator', () => {
  const good = () => generateAgentCard(meta());

  it('accepts a generated card', () => {
    expect(validateAgentCard(good())).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects a non-object', () => {
    expect(validateAgentCard(null).ok).toBe(false);
    expect(validateAgentCard([]).ok).toBe(false);
  });

  it('rejects a card with no supportedInterfaces (§4.4.1)', () => {
    const c = { ...good(), supportedInterfaces: [] };
    const v = validateAgentCard(c);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/supportedInterfaces/);
  });

  it('rejects an interface missing protocolBinding (§4.4.6)', () => {
    const c = good();
    const broken = { ...c, supportedInterfaces: [{ url: 'https://x/a', protocolVersion: '1.0' }] };
    const v = validateAgentCard(broken);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/protocolBinding/);
  });

  it('rejects a provider without url (§4.4.2)', () => {
    const c = { ...good(), provider: { organization: 'CSA Loom' } };
    const v = validateAgentCard(c);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/provider\.url/);
  });

  it('rejects a SecurityScheme that is not exactly one-of (§4.5.1)', () => {
    const c = good();
    const v = validateAgentCard({
      ...c,
      securitySchemes: { x: { httpAuthSecurityScheme: { scheme: 'Bearer' }, mtlsSecurityScheme: {} } },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/exactly one of/);
  });

  it('rejects a skill missing tags (§4.4.5)', () => {
    const c = good();
    const v = validateAgentCard({ ...c, skills: [{ id: 'a', name: 'A', description: 'd' }] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/skills\[0\]\.tags/);
  });

  it('rejects a signature missing its protected header (§4.4.7)', () => {
    const c = good();
    const v = validateAgentCard({ ...c, signatures: [{ signature: 'abc' }] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/signatures\[0\]\.protected/);
  });

  it('warns (does not fail) on a non-HTTPS interface url', () => {
    const c = generateAgentCard({ ...meta(), endpoint: 'http://localhost:3000/api/a2a' });
    const v = validateAgentCard(c);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/HTTPS/);
  });
});

describe('a2a-agent-card — every Loom card surface delegates to the ONE generator', () => {
  it('the platform card (/.well-known/agent-card.json) is conformant', () => {
    const card: A2aSpecAgentCard = buildPlatformAgentCard('https://loom.example');
    const v = validateAgentCard(card);
    expect(v.ok, v.errors.join('; ')).toBe(true);
    expect(card.supportedInterfaces[0].url).toBe('https://loom.example/api/a2a');
    expect(card.skills.map((s) => s.id)).toEqual(PLATFORM_SKILLS.map((s) => s.id));
  });

  it('the per-item card is conformant and carries the tenant routing id', () => {
    const card = buildItemAgentCard({
      id: 'af-9',
      name: 'Payments Investigator',
      endpoint: 'https://loom.example/api/items/agent-flow/af-9/a2a',
      kind: 'agent flow',
      platformEndpoint: 'https://loom.example/api/a2a',
    });
    const v = validateAgentCard(card);
    expect(v.ok, v.errors.join('; ')).toBe(true);
    expect(card.supportedInterfaces[0].tenant).toBe('agent-flow:af-9');
  });

  it('catalog entries report conformance + the addressing tuple', () => {
    const entry = agentCardCatalogEntry(meta(), 'https://loom.example/.well-known/agent-card.json');
    expect(entry.conformant).toBe(true);
    expect(entry.endpoint).toBe('https://loom.example/api/a2a');
    expect(entry.skillIds.length).toBe(PLATFORM_SKILLS.length);
  });
});
