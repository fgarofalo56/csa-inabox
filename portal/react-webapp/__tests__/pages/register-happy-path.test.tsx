/**
 * Golden-path end-to-end test for the Source Registration wizard.
 *
 * Walks the wizard from step 0 (Source Type) through all seven steps and
 * confirms that:
 *   1. Each step transition keeps the previously captured data on the
 *      form (observed via the mocked step components).
 *   2. The final "Register Source" click fires `registerSource` with the
 *      correct payload shape.
 *   3. On success, the user is navigated to `/sources`.
 *
 * The sub-step components are mocked so this test stays focused on the
 * wizard orchestrator in `pages/sources/register.tsx` rather than on the
 * internals of each step (those have dedicated unit tests).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockPush = jest.fn();

jest.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/sources/register',
    push: mockPush,
    replace: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
  }),
}));

const mockAccounts = [
  {
    name: 'Jane Doe',
    username: 'jane.doe@contoso.com',
  },
];

jest.mock('@azure/msal-react', () => ({
  useMsal: () => ({
    accounts: mockAccounts,
    instance: {
      acquireTokenSilent: jest.fn().mockResolvedValue({ accessToken: 't' }),
    },
  }),
}));

const mockMutateAsync = jest.fn().mockResolvedValue({ id: 'src-42' });

jest.mock('@/hooks/useApi', () => ({
  useRegisterSource: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

// Minimal sub-step mocks — exercise the form state via register + setValue.
jest.mock('@/components/register', () => {
  const React = require('react');
  return {
    StepSourceType: ({
      selectedType,
      onSelect,
    }: {
      selectedType: string;
      onSelect: (t: string) => void;
    }) => (
      <div data-testid="step-source-type">
        <span>Selected: {selectedType || 'none'}</span>
        <button type="button" onClick={() => onSelect('azure_sql')}>
          Choose Azure SQL
        </button>
      </div>
    ),
    StepConnection: ({
      register,
    }: {
      register: ReturnType<typeof import('react-hook-form').useForm>['register'];
    }) => (
      <div data-testid="step-connection">
        <label htmlFor="name">Name</label>
        <input id="name" {...register('name')} />
        <label htmlFor="domain">Domain</label>
        <input id="domain" {...register('domain')} />
      </div>
    ),
    StepSchema: () => <div data-testid="step-schema">Schema</div>,
    StepIngestion: () => <div data-testid="step-ingestion">Ingestion</div>,
    StepQuality: () => <div data-testid="step-quality">Quality</div>,
    StepOwner: ({
      register,
    }: {
      register: ReturnType<typeof import('react-hook-form').useForm>['register'];
    }) => (
      <div data-testid="step-owner">
        <label htmlFor="team">Team</label>
        <input id="team" {...register('owner.team')} />
      </div>
    ),
    StepReview: () => <div data-testid="step-review">Review</div>,
  };
});

import RegisterSourcePage from '@/pages/sources/register';

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe('SourceRegistrationWizard — happy-path golden test', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockMutateAsync.mockReset().mockResolvedValue({ id: 'src-42' });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('walks from source-type selection to submission and navigates on success', async () => {
    renderWithProviders(<RegisterSourcePage />);

    // Step 0 — select a source type.
    fireEvent.click(screen.getByRole('button', { name: 'Choose Azure SQL' }));

    // Step 0 → 1
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('step-connection')).toBeInTheDocument());

    // Fill the Connection step — the Zod schema only needs a valid name
    // + domain to advance.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'finance-db' } });
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'finance' } });

    // Step 1 → 2 → 3 → 4 → 5 (Owner)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('step-schema')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('step-ingestion')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('step-quality')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('step-owner')).toBeInTheDocument());

    // Fill the Team input (required) and advance to Review.
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'Data Platform' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('step-review')).toBeInTheDocument());

    // Submit.
    const submit = screen.getByRole('button', { name: 'Register Source' });
    fireEvent.click(submit);

    // mutateAsync is invoked with the accumulated form values.
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    const payload = mockMutateAsync.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'finance-db',
      source_type: 'azure_sql',
      domain: 'finance',
      owner: expect.objectContaining({ team: 'Data Platform' }),
    });

    // The wizard schedules a short (1.2s) delay before navigating so the
    // success toast is visible — advance fake timers and assert the push.
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/sources'));
  });
});
