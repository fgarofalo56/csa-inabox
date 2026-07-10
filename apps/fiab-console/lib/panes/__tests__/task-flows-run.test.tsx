/**
 * Render test — the "Run flow" toolbar button (F11 execution).
 *
 * Opens a workspace's task flow straight into the canvas and asserts the Run
 * button renders. The button is DISABLED when no step links a runnable item and
 * ENABLED once a step links one (a data-pipeline here). We stub the workspaces
 * API module so the component mounts without a live BFF.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TaskFlow, WorkspaceItem } from '@/lib/api/workspaces';

// A flow with a single runnable step (data-pipeline) and one non-runnable step.
const runnableFlow: TaskFlow = {
  id: 'flow-runnable',
  workspaceId: 'ws1',
  displayName: 'Runnable Flow',
  steps: [
    { id: 's1', label: 'Ingest', itemId: 'i1', itemType: 'data-pipeline', x: 0, y: 0 },
    { id: 's2', label: 'Store', itemId: 'i2', itemType: 'lakehouse', x: 200, y: 0 },
  ],
  edges: [{ id: 'e1', source: 's1', target: 's2' }],
  createdBy: 'u',
  createdAt: 'now',
  updatedAt: 'now',
};

// A flow with only a non-runnable linked item.
const inertFlow: TaskFlow = {
  ...runnableFlow,
  id: 'flow-inert',
  displayName: 'Inert Flow',
  steps: [{ id: 's1', label: 'Store', itemId: 'i2', itemType: 'lakehouse', x: 0, y: 0 }],
  edges: [],
};

const items: WorkspaceItem[] = [
  { id: 'i1', workspaceId: 'ws1', displayName: 'Bronze ingest', itemType: 'data-pipeline' } as WorkspaceItem,
  { id: 'i2', workspaceId: 'ws1', displayName: 'Lake', itemType: 'lakehouse' } as WorkspaceItem,
];

let openFlow: TaskFlow = runnableFlow;

vi.mock('@/lib/api/workspaces', async () => {
  const actual = await vi.importActual<any>('@/lib/api/workspaces');
  return {
    ...actual,
    listItems: vi.fn(async () => items),
    listTaskFlows: vi.fn(async () => [openFlow]),
    getTaskFlow: vi.fn(async () => openFlow),
    createTaskFlow: vi.fn(async () => openFlow),
    saveTaskFlow: vi.fn(async () => openFlow),
    deleteTaskFlow: vi.fn(async () => undefined),
    runTaskFlow: vi.fn(async () => 'run-1'),
    getTaskFlowRun: vi.fn(async () => ({ ...openFlow, runId: 'run-1', status: 'running', steps: [] })),
    listTaskFlowRuns: vi.fn(async () => []),
  };
});

// ResizeObserver is required by @xyflow/react; jsdom lacks it.
(globalThis as any).ResizeObserver =
  (globalThis as any).ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

async function mountCanvas(flow: TaskFlow) {
  openFlow = flow;
  const { TaskFlowsPane } = await import('../task-flows');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <FluentProvider theme={webLightTheme}>
      <QueryClientProvider client={qc}>
        <TaskFlowsPane workspaceId="ws1" />
      </QueryClientProvider>
    </FluentProvider>,
  );
  // Open the flow into the canvas via its "Open" action.
  const openBtn = await screen.findByRole('button', { name: /open/i });
  openBtn.click();
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TaskFlowsPane — Run flow button', () => {
  it('renders an ENABLED Run flow button when a step links a runnable item', async () => {
    await mountCanvas(runnableFlow);
    const runBtn = await screen.findByRole('button', { name: /run flow/i });
    expect(runBtn).toBeInTheDocument();
    await waitFor(() => expect(runBtn).not.toBeDisabled());
  });

  it('DISABLES the Run flow button when no step links a runnable item', async () => {
    await mountCanvas(inertFlow);
    const runBtn = await screen.findByRole('button', { name: /run flow/i });
    expect(runBtn).toBeDisabled();
  });
});
