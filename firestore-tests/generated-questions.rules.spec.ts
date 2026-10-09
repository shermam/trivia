import {
  assertFails,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  asAnonymous,
  asPro,
  asSignedOut,
  asVerifiedPassword,
  createTestEnv,
  grantReviewer,
} from './helpers';

/**
 * `generated_questions` (`FEAT-020` §B, design §2 S8): the question-generation
 * pipeline's staging record, written by the pipeline on the Admin SDK and by
 * no client at all — not even read.
 *
 * **Every row here is a refusal, and that is the specification rather than a
 * gap.** `CLAUDE.md` §4.6 warns that a suite of nothing but `assertFails`
 * passes against a rule that fails 100% closed — and for this collection 100%
 * closed is the rule. What keeps the rows honest is that each one is a request
 * that *would* succeed if the rule allowed it: a document that exists, a write
 * Firestore would otherwise apply, a caller who is somebody. The mutation sweep
 * recorded in `docs/data-model.md` is the evidence — opening the block fails
 * every row, and a reviewer read branch fails exactly the reviewer's two reads.
 *
 * Five callers, one per kind of account the rules distinguish, each refused
 * the same five verbs: read one candidate, list them, create one, update one
 * and delete one.
 */

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-generated-questions');
});
afterAll(() => env.cleanup());

const REVIEWER = 'reviewer-uid';
const PLAYER = 'player-uid';
const SUBSCRIBER = 'pro-uid';

/**
 * A staging record of the shape design §2 describes: a candidate, every
 * stage's verdict, the versions it was judged under and its supporting quote.
 * No uid and no user-typed text — that is what makes it no one's personal
 * data. The exact fields are the pipeline's to settle; with no client path the
 * rules read none of them.
 */
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-2026-10-09-good-place',
    chunk: { sourceUrl: 'https://en.wikipedia.org/wiki/The_Good_Place', revisionId: 1_234_567 },
    candidate: {
      question: 'Which character in The Good Place is an ethics professor?',
      answers: [
        { text: 'Chidi Anagonye', isCorrect: true },
        { text: 'Jason Mendoza', isCorrect: false },
        { text: 'Tahani Al-Jamil', isCorrect: false },
        { text: 'Eleanor Shellstrop', isCorrect: false },
      ],
      difficulty: 'easy',
      tags: ['television', 'the-good-place'],
      format: 'plain',
    },
    supportingQuote: 'Chidi Anagonye, a professor of ethics and moral philosophy',
    stages: {
      s3: { verdict: 'agree', tier: 'mid' },
      s4: { verdict: 'accept', scores: { q11: 5, q12: 4, q13: 4, q14: 4, q15: 4 } },
      s5: { verdict: 'clear' },
    },
    promptVersion: 's2-v1',
    rubricVersion: 'rubric-v1',
    accepted: true,
    ...overrides,
  };
}

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'generated_questions', 'accepted-candidate'), candidate());
    await setDoc(
      doc(db, 'generated_questions', 'rejected-candidate'),
      candidate({ accepted: false, stages: { s4: { verdict: 'reject' } } }),
    );
  });
  await grantReviewer(env, REVIEWER);
});

const candidates = (ctx: RulesTestContext) => collection(ctx.firestore(), 'generated_questions');
const candidateRef = (ctx: RulesTestContext, id: string) =>
  doc(ctx.firestore(), 'generated_questions', id);

/**
 * Who asks. The reviewer is a verified account holding the moderation role,
 * so it is the caller a future "let reviewers see the provenance" change would
 * admit — and the one whose two reads that mutation fails.
 */
const CALLERS: readonly [string, () => RulesTestContext][] = [
  ['a signed-out visitor', () => asSignedOut(env)],
  ['an anonymous session', () => asAnonymous(env, 'anon-uid')],
  ['a signed-in player', () => asVerifiedPassword(env, PLAYER)],
  ['a Pro subscriber', () => asPro(env, SUBSCRIBER)],
  ['a reviewer', () => asVerifiedPassword(env, REVIEWER)],
];

describe.each(CALLERS)('generated_questions: no client path — %s', (_who, as) => {
  it('is refused a read of one candidate', async () => {
    await assertFails(getDoc(candidateRef(as(), 'accepted-candidate')));
  });

  // A list the rule could prove if it allowed it at all: bounded, and filtered
  // on a field every seeded record carries. Refused outright, never trimmed.
  it('is refused a list of the candidates', async () => {
    await assertFails(getDocs(query(candidates(as()), where('accepted', '==', true), limit(10))));
  });

  // Well-formed, at a fresh id, carrying exactly what the pipeline writes — so
  // the refusal is the rule's, not a shape check a better payload could pass.
  it('is refused creating a candidate', async () => {
    await assertFails(setDoc(candidateRef(as(), 'client-candidate'), candidate()));
  });

  // The write that would matter most: turning a rejected candidate into an
  // accepted one, which a promote step would then copy into the bank.
  it('is refused updating a candidate', async () => {
    await assertFails(
      updateDoc(candidateRef(as(), 'rejected-candidate'), {
        accepted: true,
        'stages.s4.verdict': 'accept',
      }),
    );
  });

  it('is refused deleting a candidate', async () => {
    await assertFails(deleteDoc(candidateRef(as(), 'accepted-candidate')));
  });
});
