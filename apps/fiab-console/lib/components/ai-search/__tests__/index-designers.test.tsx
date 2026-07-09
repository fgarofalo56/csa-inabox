/**
 * AIF-16 index-designer panes — render smoke tests.
 *
 * The visual scoring-profile / custom-analyzer / CORS+CMK designers replace the
 * former JSON-only path. These specs mount each pane against a minimal index
 * definition and assert its heading + a primary control render, and that a
 * pre-existing definition round-trips into the editable rows (parse path). Per
 * .claude/rules/no-vaporware.md this lifts the designers from B (functional,
 * untested) toward A (functional + Vitest).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScoringProfilesDesigner, AnalyzersDesigner, CorsAndCmkDesigner } from '../index-designers';

const idx = {
  name: 'i',
  fields: [
    { name: 'id', type: 'Edm.String', key: true },
    { name: 'title', type: 'Edm.String', searchable: true },
    { name: 'rating', type: 'Edm.Double', filterable: true, sortable: true },
  ],
  scoringProfiles: [{ name: 'boost-recent', text: { weights: { title: 3 } } }],
  analyzers: [{ '@odata.type': '#Microsoft.Azure.Search.CustomAnalyzer', name: 'my-an', tokenizer: 'whitespace', tokenFilters: ['lowercase'] }],
  corsOptions: { allowedOrigins: ['*'], maxAgeInSeconds: 300 },
};

const noop = () => {};

describe('AIF-16 index designers', () => {
  it('ScoringProfilesDesigner renders existing profiles from the definition', () => {
    render(<ScoringProfilesDesigner idx={idx} indexBase="/api/ai-search/indexes/i" onSaved={noop} />);
    expect(screen.getByText(/Scoring profiles \(1\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('sp-0-name')).toBeInTheDocument();
  });

  it('AnalyzersDesigner renders existing custom analyzers from the definition', () => {
    render(<AnalyzersDesigner idx={idx} indexBase="/api/ai-search/indexes/i" onSaved={noop} />);
    expect(screen.getByText(/Analyzers \(1 custom\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('an-0-name')).toBeInTheDocument();
  });

  it('CorsAndCmkDesigner reflects an enabled CORS section', () => {
    render(<CorsAndCmkDesigner idx={idx} indexBase="/api/ai-search/indexes/i" onSaved={noop} />);
    // The enabled CORS row parsed from corsOptions surfaces its origins input.
    expect(screen.getByLabelText('cors-enabled')).toBeInTheDocument();
    expect(screen.getByLabelText('cors-origins')).toBeInTheDocument();
    expect(screen.getByLabelText('cmk-enabled')).toBeInTheDocument();
  });
});
