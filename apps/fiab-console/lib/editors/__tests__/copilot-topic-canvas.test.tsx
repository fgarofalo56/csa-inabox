/**
 * CopilotTopicCanvas — Vitest contract test.
 *
 * The canvas is a controlled component (no network). Renders it empty and
 * asserts the UX-406 baseline lift: the guided empty-state launcher and the
 * teaching banner both surface, and the step launcher buttons are present.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CopilotTopicCanvas } from '../copilot-topic-canvas';

describe('CopilotTopicCanvas', () => {
  it('renders the teaching banner and guided empty-state launcher', () => {
    render(
      <CopilotTopicCanvas
        flowYaml=""
        triggerPhrases={[]}
        onChange={() => {}}
      />,
    );
    // Teaching banner (SC-6) lead line.
    expect(screen.getByText(/Author a topic step by step/i)).toBeInTheDocument();
    // Guided empty-state (SC-4) launcher heading + a step path.
    expect(screen.getByText(/Build out this topic/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Question/i).length).toBeGreaterThan(0);
  });
});
