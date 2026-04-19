/**
 * Tests for the Owner step of the Source Registration wizard (CSA-0007).
 *
 * Ensures the step collects the backend-required `owner.team` field and
 * surfaces a validation error when it is missing.
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useForm } from 'react-hook-form';

import StepOwner from '@/components/register/StepOwner';
import type { SourceRegistration } from '@/types';

function HarnessForm({
  onSubmit,
  defaults,
}: {
  onSubmit?: (data: SourceRegistration) => void;
  defaults?: Partial<SourceRegistration>;
}) {
  const {
    register,
    watch,
    handleSubmit,
    formState: { errors },
  } = useForm<SourceRegistration>({
    defaultValues: {
      owner: {
        name: 'Jane Doe',
        email: 'jane@contoso.com',
        team: '',
        cost_center: '',
        ...((defaults?.owner as object) ?? {}),
      },
      // Minimum required defaults so the typed form compiles.
      ingestion: { mode: 'full' },
      target: {
        landing_zone: '',
        container: 'bronze',
        path_pattern: '',
        format: 'delta',
      },
      classification: 'internal',
      tags: {},
    } as unknown as SourceRegistration,
  });

  return (
    <form onSubmit={handleSubmit((data) => onSubmit?.(data))}>
      <StepOwner register={register} watch={watch} errors={errors} />
      <button type="submit">Submit</button>
    </form>
  );
}

describe('StepOwner', () => {
  it('renders the required team field', () => {
    render(<HarnessForm />);
    expect(screen.getByLabelText(/Team/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Team/i)).toHaveAttribute('aria-required', 'true');
  });

  it('renders the auto-populated name and email as read-only', () => {
    render(<HarnessForm />);
    const nameInput = screen.getByLabelText(/Owner Name/i) as HTMLInputElement;
    const emailInput = screen.getByLabelText(/Owner Email/i) as HTMLInputElement;
    expect(nameInput).toHaveValue('Jane Doe');
    expect(emailInput).toHaveValue('jane@contoso.com');
    expect(nameInput).toHaveAttribute('readOnly');
    expect(emailInput).toHaveAttribute('readOnly');
  });

  it('renders optional cost_center and data_product fields', () => {
    render(<HarnessForm />);
    expect(screen.getByLabelText(/Cost Center/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Data Product/i)).toBeInTheDocument();
  });

  it('submits the form successfully when team is provided', async () => {
    const submit = jest.fn();
    render(<HarnessForm onSubmit={submit} />);

    fireEvent.change(screen.getByLabelText(/Team/i), {
      target: { value: 'Data Platform Engineering' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    });

    expect(submit).toHaveBeenCalledTimes(1);
    const payload = submit.mock.calls[0][0];
    expect(payload.owner.team).toBe('Data Platform Engineering');
    expect(payload.owner.name).toBe('Jane Doe');
    expect(payload.owner.email).toBe('jane@contoso.com');
  });

  it('blocks submission and surfaces a validation error when team is empty', async () => {
    const submit = jest.fn();
    render(<HarnessForm onSubmit={submit} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    });

    expect(submit).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Team is required/i);
  });

  it('persists cost_center and data_product values on submit', async () => {
    const submit = jest.fn();
    render(<HarnessForm onSubmit={submit} />);

    fireEvent.change(screen.getByLabelText(/Team/i), {
      target: { value: 'Ops' },
    });
    fireEvent.change(screen.getByLabelText(/Cost Center/i), {
      target: { value: 'CC-42' },
    });
    fireEvent.change(screen.getByLabelText(/Data Product/i), {
      target: { value: 'Crop Yields' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    });

    const payload = submit.mock.calls[0][0];
    expect(payload.owner.cost_center).toBe('CC-42');
    expect(payload.owner.data_product).toBe('Crop Yields');
  });
});
