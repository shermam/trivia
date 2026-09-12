import { TriviaQuestion } from '../models/question.model';
import { decodeHtmlEntities } from './html-entities.util';
import { hashQuestionText, normaliseQuestionText, seenKeyFor } from './seen-key.util';

function makeQuestion(overrides: Partial<TriviaQuestion>): TriviaQuestion {
  return {
    id: 'open-1',
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: 'What planet do we live on?',
    correct_answer: 'Earth',
    incorrect_answers: ['Mars'],
    all_answers: [
      { id: 'a', text: 'Earth', isCorrect: true },
      { id: 'b', text: 'Mars', isCorrect: false },
    ],
    source: 'open_trivia',
    ...overrides,
  };
}

describe('seenKeyFor', () => {
  it('keys a community question by its document id, never by its text', () => {
    const first = makeQuestion({ source: 'custom', id: 'doc-a', question: 'Same wording?' });
    const second = makeQuestion({ source: 'custom', id: 'doc-b', question: 'Same wording?' });

    expect(seenKeyFor(first)).toBe('custom:doc-a');
    // Two contributors submitting identical wording are two questions, and
    // answering one must not suppress the other — the mirror image of why the
    // Open Trivia key *is* the text.
    expect(seenKeyFor(second)).not.toBe(seenKeyFor(first));
  });

  /**
   * The whole reason the Open Trivia key is a hash: its ids are minted at
   * fetch time (`open-${Date.now()}-${index}`), so two fetches of the same
   * question carry different ids and keying on one would remember nothing.
   */
  it('keys an Open Trivia question by its wording, across two fetches of it', () => {
    const monday = makeQuestion({ id: 'open-1757600000000-3' });
    const tuesday = makeQuestion({ id: 'open-1757700000000-0' });

    expect(seenKeyFor(monday)).toBe(seenKeyFor(tuesday));
    expect(seenKeyFor(monday).startsWith('otdb:')).toBe(true);
  });

  it('cannot collide a hash with a document id, because the prefixes differ', () => {
    const custom = makeQuestion({ source: 'custom', id: 'x' });
    const openTrivia = makeQuestion({ question: 'x' });

    expect(seenKeyFor(custom)).not.toBe(seenKeyFor(openTrivia));
  });
});

describe('hashQuestionText', () => {
  it('ignores leading, trailing and repeated whitespace', () => {
    expect(hashQuestionText('  Who   wrote\nHamlet? ')).toBe(hashQuestionText('Who wrote Hamlet?'));
  });

  it('ignores case', () => {
    expect(hashQuestionText('WHO WROTE HAMLET?')).toBe(hashQuestionText('who wrote hamlet?'));
  });

  /**
   * The invariant the feature actually needs, and the one that belongs to two
   * pieces of code rather than one: Open Trivia DB returns entity-encoded
   * text, `decodeOpenTriviaText` decodes it **at that source's adapter**
   * (`CLAUDE.md` §4.4), and the hash is taken over what comes out. So the same
   * question served encoded one day and plainly the next is one key — which is
   * asserted here by running the same decode the adapter runs, rather than by
   * decoding a second time inside the hash, which is not idempotent.
   */
  it('is equal for the same question whichever way its entities were encoded', () => {
    const encoded = decodeHtmlEntities('Who said &quot;Let them eat cake&quot;?');
    const plain = decodeHtmlEntities('Who said "Let them eat cake"?');

    expect(encoded).toBe(plain);
    expect(hashQuestionText(encoded)).toBe(hashQuestionText(plain));
  });

  it('separates two different questions', () => {
    expect(hashQuestionText('Who wrote Hamlet?')).not.toBe(hashQuestionText('Who wrote Macbeth?'));
  });

  /**
   * The two halves are zero-padded to a fixed width so they cannot slide into
   * each other. Without the padding, `"1" + "23"` and `"12" + "3"` are the
   * same string, which quietly halves the hash space this exists to widen.
   *
   * **A single input does not check this**, which is how the first version of
   * this test passed against the unpadded version: roughly half of all 32-bit
   * values already render as seven base-36 digits, so whether the padding is
   * there at all depends on the string you happened to pick. Sixty-four fixed
   * inputs make it certain — thirty-four of these have a short half.
   */
  it('renders both halves at a fixed width, whatever the wording hashes to', () => {
    for (let index = 0; index < 64; index++) {
      expect(hashQuestionText(`sample ${index}`)).toHaveLength(14);
    }
  });
});

describe('normaliseQuestionText', () => {
  it('collapses whitespace, trims and case-folds — and does nothing else', () => {
    expect(normaliseQuestionText('  Tom  &  Jerry\t? ')).toBe('tom & jerry ?');
  });

  /**
   * Not a nicety: `decodeHtmlEntities` is not idempotent (`&amp;amp;` decodes
   * to `&amp;` and then to `&`), so a second decode here would give a
   * different key for text that had already been through the adapter.
   */
  it('leaves entity sequences alone, because the adapter already decoded them', () => {
    expect(normaliseQuestionText('a &amp;amp; b')).toBe('a &amp;amp; b');
  });
});
