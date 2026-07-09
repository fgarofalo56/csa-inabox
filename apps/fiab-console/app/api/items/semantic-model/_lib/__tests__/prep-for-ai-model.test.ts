/**
 * Unit tests for the pure Prep-for-AI model (G5). No Cosmos / Azure imports —
 * exercises normalization, verified-answer upsert/remove, few-shot conversion,
 * and the schema/instruction grounding composition.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizePrepForAi,
  normalizeSchema,
  normalizeVerifiedAnswer,
  upsertVerifiedAnswer,
  removeVerifiedAnswer,
  verifiedAnswersToExamples,
  exposedSchemaGrounding,
  composeSourceGrounding,
  EMPTY_PREP_FOR_AI,
  type PrepForAiState,
} from '../prep-for-ai-model';

describe('normalizePrepForAi', () => {
  it('returns an empty, well-formed state for junk input', () => {
    expect(normalizePrepForAi(undefined)).toEqual(EMPTY_PREP_FOR_AI);
    expect(normalizePrepForAi(null)).toEqual(EMPTY_PREP_FOR_AI);
    expect(normalizePrepForAi('nope')).toEqual(EMPTY_PREP_FOR_AI);
  });

  it('coerces the three curation fields', () => {
    const s = normalizePrepForAi({
      aiInstructions: 'Revenue means net revenue.',
      schema: [{ table: 'Sales', exposed: false, columns: [{ column: 'Cost', exposed: false }] }],
      verifiedAnswers: [{ question: 'Total?', dax: 'EVALUATE ROW("t", 1)' }],
    });
    expect(s.aiInstructions).toBe('Revenue means net revenue.');
    expect(s.schema).toHaveLength(1);
    expect(s.schema[0].exposed).toBe(false);
    expect(s.verifiedAnswers).toHaveLength(1);
    expect(s.verifiedAnswers[0].id).toBeTruthy();
  });
});

describe('normalizeSchema', () => {
  it('drops malformed tables/columns and dedupes', () => {
    const schema = normalizeSchema([
      { table: 'Sales', exposed: true, columns: [{ column: 'Amount', exposed: true }, { column: 'Amount', exposed: false }] },
      { table: 'Sales', exposed: false, columns: [] }, // duplicate table dropped
      { table: '', exposed: true, columns: [] },        // empty name dropped
      { table: 'Bad;Name', exposed: true, columns: [] }, // invalid char dropped
    ]);
    expect(schema).toHaveLength(1);
    expect(schema[0].table).toBe('Sales');
    expect(schema[0].columns).toHaveLength(1); // deduped column
  });

  it('defaults exposed to true when the flag is absent', () => {
    const schema = normalizeSchema([{ table: 'Dim', columns: [{ column: 'Key' }] }]);
    expect(schema[0].exposed).toBe(true);
    expect(schema[0].columns[0].exposed).toBe(true);
  });
});

describe('normalizeVerifiedAnswer', () => {
  it('requires a question and DAX', () => {
    expect(normalizeVerifiedAnswer({ question: '', dax: 'EVALUATE 1' })).toBeNull();
    expect(normalizeVerifiedAnswer({ question: 'Q', dax: '' })).toBeNull();
  });

  it('preserves createdAt and stamps updatedAt', () => {
    const a = normalizeVerifiedAnswer({ id: 'x1', question: 'Q', dax: 'EVALUATE 1', createdAt: '2020-01-01T00:00:00Z' }, '2026-07-09T00:00:00Z');
    expect(a).not.toBeNull();
    expect(a!.id).toBe('x1');
    expect(a!.createdAt).toBe('2020-01-01T00:00:00Z');
    expect(a!.updatedAt).toBe('2026-07-09T00:00:00Z');
  });
});

describe('upsert / remove verified answers', () => {
  const base: PrepForAiState = { aiInstructions: '', schema: [], verifiedAnswers: [] };

  it('upserts by id and preserves createdAt on edit', () => {
    const a1 = normalizeVerifiedAnswer({ id: 'a', question: 'Q1', dax: 'EVALUATE 1', createdAt: '2020-01-01T00:00:00Z' })!;
    let s = upsertVerifiedAnswer(base, a1);
    expect(s.verifiedAnswers).toHaveLength(1);
    const edited = normalizeVerifiedAnswer({ id: 'a', question: 'Q1 edited', dax: 'EVALUATE 2' })!;
    s = upsertVerifiedAnswer(s, edited);
    expect(s.verifiedAnswers).toHaveLength(1);
    expect(s.verifiedAnswers[0].question).toBe('Q1 edited');
    expect(s.verifiedAnswers[0].createdAt).toBe('2020-01-01T00:00:00Z');
  });

  it('removes by id', () => {
    const a = normalizeVerifiedAnswer({ id: 'a', question: 'Q', dax: 'EVALUATE 1' })!;
    const s = removeVerifiedAnswer(upsertVerifiedAnswer(base, a), 'a');
    expect(s.verifiedAnswers).toHaveLength(0);
  });
});

describe('verifiedAnswersToExamples', () => {
  it('includes verified + unrun, excludes explicitly-failed, dedupes by question', () => {
    const ex = verifiedAnswersToExamples([
      { id: '1', question: 'A', dax: 'EVALUATE 1', lastVerifiedOk: true, createdAt: '', updatedAt: '' },
      { id: '2', question: 'B', dax: 'EVALUATE 2', createdAt: '', updatedAt: '' }, // unrun → included
      { id: '3', question: 'C', dax: 'EVALUATE 3', lastVerifiedOk: false, createdAt: '', updatedAt: '' }, // failed → excluded
      { id: '4', question: 'a', dax: 'EVALUATE 4', lastVerifiedOk: true, createdAt: '', updatedAt: '' }, // dup of A
      { id: '5', question: 'D', dax: '', lastVerifiedOk: true, createdAt: '', updatedAt: '' }, // empty dax → excluded
    ]);
    expect(ex.map((e) => e.question)).toEqual(['A', 'B']);
    expect(ex[0].query).toBe('EVALUATE 1');
  });

  it('handles undefined/empty input', () => {
    expect(verifiedAnswersToExamples(undefined)).toEqual([]);
    expect(verifiedAnswersToExamples([])).toEqual([]);
  });
});

describe('exposedSchemaGrounding', () => {
  it('returns empty string when nothing is hidden (default-ON)', () => {
    expect(exposedSchemaGrounding([])).toBe('');
    expect(exposedSchemaGrounding([{ table: 'T', exposed: true, columns: [{ column: 'c', exposed: true }] }])).toBe('');
  });

  it('names hidden tables and columns', () => {
    const g = exposedSchemaGrounding([
      { table: 'Secret', exposed: false, columns: [] },
      { table: 'Sales', exposed: true, columns: [{ column: 'Cost', exposed: false }, { column: 'Amount', exposed: true }] },
    ]);
    expect(g).toContain('Secret');
    expect(g).toContain('Sales[Cost]');
    expect(g).not.toContain('Amount');
  });
});

describe('composeSourceGrounding', () => {
  it('layers base + AI instructions + exposed schema', () => {
    const prep: PrepForAiState = {
      aiInstructions: 'Use USD.',
      schema: [{ table: 'Secret', exposed: false, columns: [] }],
      verifiedAnswers: [],
    };
    const g = composeSourceGrounding('Base grounding.', prep);
    expect(g).toContain('Base grounding.');
    expect(g).toContain('AI instructions (Prep for AI)');
    expect(g).toContain('Use USD.');
    expect(g).toContain('AI-exposed schema (Prep for AI)');
    expect(g).toContain('Secret');
  });

  it('returns just the base when no prep content exists', () => {
    expect(composeSourceGrounding('Only base.', EMPTY_PREP_FOR_AI)).toBe('Only base.');
  });
});
