import { RUN_ID_SHOWN, isMachineGenerated, shownRunId } from './question-provenance.util';

/**
 * The two readings of a stored `provenance` map (`FEAT-020`). The map is the
 * pipeline's word and nothing in `firestore.rules` checks it, so the cases
 * that matter most here are the ones a console can write and the pipeline
 * never would — each has to read as "a person wrote this", which is what an
 * absent map means.
 */
const PROVENANCE = {
  source: 'ai',
  provider: 'example-provider',
  model: 'example-model',
  modelVersion: 'example-model-2026-10-01',
  generatedAt: 1_760_000_000_000,
  runId: '20261009T120000Z-water',
};

describe('isMachineGenerated', () => {
  it('is true for the map the pipeline writes', () => {
    expect(isMachineGenerated(PROVENANCE)).toBe(true);
  });

  it('is true for the one fact a game carries of it', () => {
    expect(isMachineGenerated({ source: 'ai' })).toBe(true);
  });

  it('is false when there is no map, which is every question a person wrote', () => {
    expect(isMachineGenerated(undefined)).toBe(false);
    expect(isMachineGenerated(null)).toBe(false);
  });

  it.each([
    ['another source', { ...PROVENANCE, source: 'human' }],
    ['a differently cased source', { ...PROVENANCE, source: 'AI' }],
    ['no source', { runId: PROVENANCE.runId }],
    ['the bare string', 'ai'],
    ['a list', ['ai']],
    ['a number', 1],
  ])('is false for %s', (_label, provenance) => {
    expect(isMachineGenerated(provenance)).toBe(false);
  });
});

describe('shownRunId', () => {
  it('names the run whole when it is short enough to show', () => {
    expect(shownRunId(PROVENANCE)).toBe('20261009T120000Z-water');
  });

  it('trims what it shows', () => {
    expect(shownRunId({ runId: '  20261009T120000Z-water \n' })).toBe('20261009T120000Z-water');
  });

  /**
   * The pipeline allows a hundred characters and the card holds one line, so
   * a long id is cut — keeping the timestamp it starts with, which is what
   * tells two runs apart.
   */
  it('cuts a long run id to a fixed length, keeping its start', () => {
    const long = `20261009T120000Z-${'the-history-of-the-byzantine-empire-'.repeat(2)}`;
    const shown = shownRunId({ runId: long });

    expect(shown).toHaveLength(RUN_ID_SHOWN);
    expect(shown?.endsWith('…')).toBe(true);
    expect(shown?.startsWith('20261009T120000Z-')).toBe(true);
  });

  it('shows an id of exactly the limit whole', () => {
    const exact = 'r'.repeat(RUN_ID_SHOWN);
    expect(shownRunId({ runId: exact })).toBe(exact);
  });

  it.each([
    ['no map', undefined],
    ['no run id', { source: 'ai' }],
    ['an empty run id', { runId: '' }],
    ['a blank run id', { runId: '   ' }],
    ['a run id that is not a string', { runId: 42 }],
    ['a map that is a string', 'run-1'],
  ])('is null for %s', (_label, provenance) => {
    expect(shownRunId(provenance)).toBeNull();
  });
});
