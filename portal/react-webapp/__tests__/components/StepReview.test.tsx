/**
 * Tests for the StepReview validation summary (CSA-0124(13)).
 *
 * Covers:
 *   - flattenErrors traverses nested react-hook-form error shapes.
 *   - ValidationSummary renders a success state when there are no errors.
 *   - ValidationSummary renders a grouped list of errors with jump links.
 *   - The "Fix in …" button invokes the onJumpToStep callback with the
 *     correct step index.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { FieldErrors } from 'react-hook-form';
import type { SourceRegistration } from '@/types';
import { ValidationSummary, flattenErrors } from '@/components/register/StepReview';

function makeError(message: string, type = 'required') {
  return { type, message };
}

describe('flattenErrors', () => {
  it('returns an empty array for undefined errors', () => {
    expect(flattenErrors(undefined)).toEqual([]);
  });

  it('captures top-level leaf errors', () => {
    const errors: FieldErrors<SourceRegistration> = {
      name: makeError('Name is required'),
    } as unknown as FieldErrors<SourceRegistration>;
    const flat = flattenErrors(errors);
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({
      path: 'name',
      message: 'Name is required',
      stepIndex: 1,
      stepTitle: 'Connection',
    });
  });

  it('recurses into nested groups like owner.email', () => {
    const errors: FieldErrors<SourceRegistration> = {
      owner: {
        email: makeError('Must be a valid email address'),
        team: makeError('Team is required'),
      },
    } as unknown as FieldErrors<SourceRegistration>;
    const flat = flattenErrors(errors);
    expect(flat).toHaveLength(2);
    const byPath = Object.fromEntries(flat.map((e) => [e.path, e]));
    expect(byPath['owner.email']).toMatchObject({
      stepIndex: 5,
      stepTitle: 'Owner',
    });
    expect(byPath['owner.team']).toMatchObject({ stepIndex: 5 });
  });

  it('routes ingestion/target errors to the Ingestion step', () => {
    const errors: FieldErrors<SourceRegistration> = {
      ingestion: { mode: makeError('Required') },
      target: { container: makeError('Required') },
    } as unknown as FieldErrors<SourceRegistration>;
    const flat = flattenErrors(errors);
    expect(flat.every((e) => e.stepIndex === 3 && e.stepTitle === 'Ingestion')).toBe(true);
  });
});

describe('ValidationSummary', () => {
  it('renders a success state when there are no errors', () => {
    render(<ValidationSummary errors={undefined} />);
    expect(
      screen.getByText(/All required fields are filled in/i),
    ).toBeInTheDocument();
  });

  it('renders an error list with one entry per leaf', () => {
    const errors: FieldErrors<SourceRegistration> = {
      name: makeError('Name is required'),
      owner: { email: makeError('Invalid email') },
    } as unknown as FieldErrors<SourceRegistration>;
    render(<ValidationSummary errors={errors} />);
    expect(screen.getByText(/2 issues to resolve/)).toBeInTheDocument();
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('owner.email')).toBeInTheDocument();
    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Invalid email')).toBeInTheDocument();
  });

  it('renders "Fix in <Step>" buttons that call onJumpToStep with the right index', () => {
    const errors: FieldErrors<SourceRegistration> = {
      owner: { team: makeError('Team is required') },
    } as unknown as FieldErrors<SourceRegistration>;
    const onJump = jest.fn();
    render(<ValidationSummary errors={errors} onJumpToStep={onJump} />);
    const button = screen.getByRole('button', { name: /Fix owner\.team on the Owner step/i });
    fireEvent.click(button);
    expect(onJump).toHaveBeenCalledWith(5);
  });

  it('falls back to a plain "in <Step>" label when onJumpToStep is not provided', () => {
    const errors: FieldErrors<SourceRegistration> = {
      name: makeError('Name is required'),
    } as unknown as FieldErrors<SourceRegistration>;
    render(<ValidationSummary errors={errors} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('in Connection')).toBeInTheDocument();
  });

  it('singularizes "issue" for a single error', () => {
    const errors: FieldErrors<SourceRegistration> = {
      name: makeError('Required'),
    } as unknown as FieldErrors<SourceRegistration>;
    render(<ValidationSummary errors={errors} />);
    expect(screen.getByText(/1 issue to resolve/)).toBeInTheDocument();
  });
});
