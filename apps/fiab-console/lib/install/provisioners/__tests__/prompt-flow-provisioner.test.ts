/**
 * prompt-flow provisioner — a missing project is CREATED, not reported (#3510).
 *
 * THE DEFECT. The item type's only path answered a data-plane 404 with
 * status:'remediation' telling the operator to "Create the project under the hub
 * (Foundry portal or the ai-foundry-project editor)". `foundry-client` has
 * exported a working `createProject(name, displayName, description)` the whole
 * time, and `app/api/items/ai-foundry-project/route.ts` calls it in production.
 * auto-bind-by-default.md: a remediation whose fix is an action the PLATFORM
 * could have taken is a defect, not an honest gate.
 *
 * WHAT SURVIVES AS A GATE, and why that is legitimate: a Foundry project is a
 * CHILD of a hub-kind Azure ML workspace, and `createProject` refuses (throws
 * NotDeployedError) rather than inventing a parent. That refusal is the only
 * remaining user-facing state, plus the 403 on the ARM PUT itself.
 *
 * WHAT THESE TESTS DO NOT PROVE. `foundry-client` is mocked — a unit test
 * cannot reach ARM or the AML data plane. Per ux-baseline.md G1 the item is
 * "done" only on a live in-browser install. These pin the CONTROL FLOW that was
 * wrong: 404 -> create -> retry, and no instruction to go create it by hand.
 *
 * MUTATION-PROVEN: drop the `ensureProject()` call from the 404 branch (i.e.
 * restore main's `return remediation404(...)`) and the create-and-retry tests go
 * RED; make `ensureProject` swallow NotDeployedError and the hub-gate test goes
 * RED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const listPromptFlows = vi.fn();
const createPromptFlow = vi.fn();
const updatePromptFlow = vi.fn();
const createProject = vi.fn();

// The error CLASSES are declared INSIDE the factory. `vi.mock` is hoisted above
// every top-level binding, and the provisioner does `e instanceof FoundryError`
// — so a class declared out here is in the temporal dead zone when the factory
// runs, and the whole suite fails to collect. The `vi.fn()` spies survive only
// because they are dereferenced lazily, at call time.
vi.mock('@/lib/azure/foundry-client', () => {
  class FoundryError extends Error {
    status: number;
    constructor(status: number, _body = '', message = 'foundry error') {
      super(message);
      this.status = status;
    }
  }
  // MIRRORS THE REAL CLASS, deliberately. The real NotDeployedError puts a
  // GENERIC sentence in `message` and the useful, var-naming detail in `hint`.
  // A `class NotDeployedError extends Error {}` look-alike would satisfy every
  // type check and silently move the hint into `message` — masking a
  // provisioner that reads the wrong field and prints a dead-end gate. tsc
  // caught exactly that here (`Expected 2 arguments, but got 1`).
  class NotDeployedError extends Error {
    service: string;
    hint: string;
    constructor(service: string, hint: string) {
      super(`${service} is not provisioned in this deployment`);
      this.service = service;
      this.hint = hint;
    }
  }
  return {
    listPromptFlows: (...a: unknown[]) => listPromptFlows(...a),
    createPromptFlow: (...a: unknown[]) => createPromptFlow(...a),
    updatePromptFlow: (...a: unknown[]) => updatePromptFlow(...a),
    createProject: (...a: unknown[]) => createProject(...a),
    FoundryError,
    NotDeployedError,
  };
});

// Imported FROM THE MOCK, so the fixtures thrown below are the exact classes the
// provisioner's `instanceof` checks see. A locally-declared look-alike would
// satisfy the type checker and miss every branch — the shape
// `a-type-correct-fixture-cannot-reach-a-lie-to-the-compiler` warns about.
import { FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';
import { promptFlowProvisioner } from '../prompt-flow';

const CONTENT = {
  kind: 'prompt-flow',
  nodes: [{ kind: 'input', config: { schema: { question: { type: 'string' } } } }],
  edges: [],
  systemPrompt: 'be grounded',
};

let savedProject: string | undefined;

beforeEach(() => {
  savedProject = process.env.LOOM_FOUNDRY_PROJECT;
  process.env.LOOM_FOUNDRY_PROJECT = 'proj-loom';
  listPromptFlows.mockReset();
  createPromptFlow.mockReset();
  updatePromptFlow.mockReset();
  createProject.mockReset();
  listPromptFlows.mockResolvedValue([]);
  createPromptFlow.mockResolvedValue({ flowId: 'flow-1' });
  createProject.mockResolvedValue({ name: 'proj-loom' });
});

afterEach(() => {
  if (savedProject === undefined) delete process.env.LOOM_FOUNDRY_PROJECT;
  else process.env.LOOM_FOUNDRY_PROJECT = savedProject;
});

const run = () =>
  promptFlowProvisioner({ displayName: 'RAG Basic', appId: 'rag-builder', content: CONTENT } as never);

describe('promptFlowProvisioner 404 self-heal (#3510)', () => {
  it('creates the project and retries when the FLOW WRITE 404s', async () => {
    // THE REGRESSION TEST. On main this returned status:'remediation' telling
    // the operator to go create the project.
    createPromptFlow
      .mockRejectedValueOnce(new FoundryError(404, '', 'workspace not found'))
      .mockResolvedValueOnce({ flowId: 'flow-after-create' });

    const r = await run();

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith('proj-loom', 'proj-loom');
    expect(r.status).toBe('created');
    expect(r.resourceId).toBe('flow-after-create');
    expect((r.steps ?? []).join(' ')).toMatch(/Created AI Foundry project 'proj-loom'/);
  });

  it('creates the project and proceeds when the LIST 404s', async () => {
    listPromptFlows.mockRejectedValueOnce(new FoundryError(404, '', 'workspace not found'));

    const r = await run();

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createPromptFlow).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('created');
  });

  it('does NOT create a project when nothing 404s', async () => {
    const r = await run();
    expect(createProject).not.toHaveBeenCalled();
    expect(r.status).toBe('created');
  });

  it('attempts the create AT MOST ONCE — a persistent 404 fails closed, it does not loop', async () => {
    createPromptFlow.mockRejectedValue(new FoundryError(404, '', 'workspace not found'));

    const r = await run();

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('remediation');
    expect(r.gate!.reason).toMatch(/still not usable/i);
    expect(r.gate!.remediation).toMatch(/asynchronous|retry the install/i);
  });
});

describe('promptFlowProvisioner remaining honest gates (#3510)', () => {
  it('gates on a MISSING HUB — the one case the platform cannot fix', async () => {
    createPromptFlow.mockRejectedValueOnce(new FoundryError(404, '', 'workspace not found'));
    createProject.mockRejectedValueOnce(
      new NotDeployedError(
        'AI Foundry project',
        "'hub-loom' was not found as a Microsoft.MachineLearningServices/workspaces resource. " +
          'Set LOOM_FOUNDRY_HUB_NAME to an existing Azure AI Foundry (Azure ML) hub workspace.',
      ),
    );

    const r = await run();

    expect(r.status).toBe('remediation');
    expect(r.gate!.reason).toMatch(/no hub-kind/i);
    // The gate carries createProject's OWN HINT — not its generic `message` —
    // rather than restating a cause this code did not establish (R7). Reading
    // `.message` would print "AI Foundry project is not provisioned in this
    // deployment" and drop the env var, which is the whole remediation.
    expect(r.gate!.remediation).toMatch(/was not found as a Microsoft\.MachineLearningServices/);
    expect(r.gate!.remediation).toMatch(/LOOM_FOUNDRY_HUB_NAME/);
    expect(r.gate!.remediation).not.toMatch(/is not provisioned in this deployment/);
    // It points at what DEPLOYS the hub, per no-vaporware.md's honest-gate rule.
    expect(r.gate!.remediation).toMatch(/platform\/fiab\/bicep/);
  });

  it('gates on a 403 from the project CREATE, naming the role and scope', async () => {
    createPromptFlow.mockRejectedValueOnce(new FoundryError(404, '', 'workspace not found'));
    createProject.mockRejectedValueOnce(new FoundryError(403, '', 'forbidden'));

    const r = await run();

    expect(r.status).toBe('remediation');
    expect(r.gate!.remediation).toMatch(/Contributor/);
    expect(r.gate!.remediation).toMatch(/az role assignment create/);
  });

  it('still gates on a data-plane 403 for an EXISTING project', async () => {
    // POPULATION FLOOR: if no path could gate any more, every "does not tell the
    // user to create it" assertion below would be green over a provisioner that
    // never gates at all.
    createPromptFlow.mockRejectedValueOnce(new FoundryError(403, '', 'forbidden'));

    const r = await run();

    expect(r.status).toBe('remediation');
    expect(r.gate!.remediation).toMatch(/AzureML Data Scientist/);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('NO remaining gate tells the operator to go create the project by hand', async () => {
    const forbidden = /Create the project under the hub|Foundry portal or the ai-foundry-project editor/i;
    const cases: Array<() => void> = [
      () => {
        createPromptFlow.mockRejectedValueOnce(new FoundryError(404, ''));
        createProject.mockRejectedValueOnce(new NotDeployedError('AI Foundry project', 'no hub workspace'));
      },
      () => {
        createPromptFlow.mockRejectedValueOnce(new FoundryError(404, ''));
        createProject.mockRejectedValueOnce(new FoundryError(403, ''));
      },
      () => {
        createPromptFlow.mockRejectedValue(new FoundryError(404, ''));
      },
    ];
    for (const setup of cases) {
      createPromptFlow.mockReset();
      createProject.mockReset();
      createPromptFlow.mockResolvedValue({ flowId: 'flow-1' });
      createProject.mockResolvedValue({ name: 'proj-loom' });
      setup();
      const r = await run();
      expect(r.status).toBe('remediation');
      expect(`${r.gate!.reason} ${r.gate!.remediation}`).not.toMatch(forbidden);
    }
  });

  it('still gates when LOOM_FOUNDRY_PROJECT names nothing at all', async () => {
    delete process.env.LOOM_FOUNDRY_PROJECT;
    const r = await run();
    expect(r.status).toBe('remediation');
    expect(r.gate!.remediation).toMatch(/LOOM_FOUNDRY_PROJECT/);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('skips cleanly on non-prompt-flow content', async () => {
    const r = await promptFlowProvisioner({
      displayName: 'x',
      appId: 'a',
      content: { kind: 'notebook' },
    } as never);
    expect(r.status).toBe('skipped');
  });
});
