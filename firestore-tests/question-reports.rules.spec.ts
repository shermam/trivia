import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  asAnonymous,
  asSignedOut,
  asVerifiedPassword,
  createTestEnv,
  reportDocId,
  validReport,
} from './helpers';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-question-reports');
});
afterAll(() => env.cleanup());

const QUESTION_ID = 'reported-question';
// Firestore accepts document IDs well past our 128-char bound, so an
// oversized-but-real document isolates the size rule from the exists() rule.
const LONG_QUESTION_ID = 'q'.repeat(129);

/**
 * The exists() check makes a seeded question the precondition for every
 * accept case — without it a *valid* report is refused for naming a question
 * that isn't there, and each test would pass for the wrong reason.
 */
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const question = {
      category: 'Science',
      type: 'multiple',
      difficulty: 'easy',
      question: 'What is the chemical symbol for water?',
      correct_answer: 'H2O',
      incorrect_answers: ['CO2', 'O2', 'NaCl'],
    };
    await setDoc(doc(ctx.firestore(), 'custom_questions', QUESTION_ID), question);
    await setDoc(doc(ctx.firestore(), 'custom_questions', LONG_QUESTION_ID), question);
  });
});

const reportRef = (ctx: RulesTestContext, id: string) =>
  doc(ctx.firestore(), 'question_reports', id);

describe('question_reports: create — who may report', () => {
  // The whole point of the design (finding H4): most players never sign in,
  // so the reporting channel accepts them. This is the row that flips if the
  // gate is ever "tightened" to isRealAuthedUser by reflex.
  it('allows an anonymous player', async () => {
    await assertSucceeds(
      setDoc(reportRef(asAnonymous(env, 'anon'), reportDocId('anon')), validReport('anon')),
    );
  });

  it('allows a signed-in account', async () => {
    await assertSucceeds(
      setDoc(reportRef(asVerifiedPassword(env, 'u'), reportDocId('u')), validReport('u')),
    );
  });

  it('rejects a signed-out caller', async () => {
    await assertFails(setDoc(reportRef(asSignedOut(env), reportDocId('u')), validReport('u')));
  });
});

describe('question_reports: create — the volume cap in the document ID', () => {
  it('accepts every slot 0-9 in the current window', async () => {
    for (let slot = 0; slot <= 9; slot++) {
      await assertSucceeds(
        setDoc(reportRef(asAnonymous(env, 'anon'), reportDocId('anon', slot)), validReport('anon')),
      );
    }
  });

  it('accepts the neighbouring windows — the tolerated client-clock skew', async () => {
    await assertSucceeds(
      setDoc(reportRef(asAnonymous(env, 'anon'), reportDocId('anon', 0, -1)), validReport('anon')),
    );
    await assertSucceeds(
      setDoc(reportRef(asAnonymous(env, 'anon'), reportDocId('anon', 1, 1)), validReport('anon')),
    );
  });

  it('rejects a window two buckets back', async () => {
    await assertFails(
      setDoc(reportRef(asAnonymous(env, 'anon'), reportDocId('anon', 0, -2)), validReport('anon')),
    );
  });

  it('rejects a slot outside 0-9', async () => {
    await assertFails(
      setDoc(reportRef(asAnonymous(env, 'anon'), reportDocId('anon', 10)), validReport('anon')),
    );
  });

  // setDoc on an existing document is an *update*, and update is denied — so
  // a taken slot refuses exactly like an invalid one. This is the cap
  // actually biting, not just the ID pattern being checked.
  it('rejects reusing a slot that is already taken', async () => {
    const id = reportDocId('anon', 3);
    await assertSucceeds(setDoc(reportRef(asAnonymous(env, 'anon'), id), validReport('anon')));
    await assertFails(setDoc(reportRef(asAnonymous(env, 'anon'), id), validReport('anon')));
  });

  it("rejects an ID carrying someone else's uid — slots are per-user", async () => {
    await assertFails(
      setDoc(reportRef(asAnonymous(env, 'anon'), reportDocId('victim')), validReport('anon')),
    );
  });
});

describe('question_reports: create — schema', () => {
  it('accepts an optional detail with content', async () => {
    await assertSucceeds(
      setDoc(
        reportRef(asAnonymous(env, 'anon'), reportDocId('anon')),
        validReport('anon', { detail: 'The correct answer is misspelled.' }),
      ),
    );
  });

  it('rejects an empty detail — omit it instead', async () => {
    await assertFails(
      setDoc(
        reportRef(asAnonymous(env, 'anon'), reportDocId('anon')),
        validReport('anon', { detail: '' }),
      ),
    );
  });

  it('rejects a detail over 500 characters', async () => {
    await assertFails(
      setDoc(
        reportRef(asAnonymous(env, 'anon'), reportDocId('anon')),
        validReport('anon', { detail: 'x'.repeat(501) }),
      ),
    );
  });

  it('rejects a reason outside the enum', async () => {
    await assertFails(
      setDoc(
        reportRef(asAnonymous(env, 'anon'), reportDocId('anon')),
        validReport('anon', { reason: 'dislike' }),
      ),
    );
  });

  it('rejects a report about a question that does not exist', async () => {
    await assertFails(
      setDoc(
        reportRef(asAnonymous(env, 'anon'), reportDocId('anon')),
        validReport('anon', { questionId: 'no-such-question' }),
      ),
    );
  });

  it('rejects a question ID over 128 characters even when the document exists', async () => {
    await assertFails(
      setDoc(
        reportRef(asAnonymous(env, 'anon'), reportDocId('anon')),
        validReport('anon', { questionId: LONG_QUESTION_ID }),
      ),
    );
  });

  it("rejects a reportedBy that isn't the caller — attribution is self-asserting only", async () => {
    await assertFails(
      setDoc(
        reportRef(asAnonymous(env, 'anon'), reportDocId('anon')),
        validReport('anon', { reportedBy: 'victim' }),
      ),
    );
  });

  it('rejects an undeclared extra key', async () => {
    await assertFails(
      setDoc(
        reportRef(asAnonymous(env, 'anon'), reportDocId('anon')),
        validReport('anon', { severity: 'high' }),
      ),
    );
  });

  it('rejects a createdAt outside the accepted clock window', async () => {
    await assertFails(
      setDoc(
        reportRef(asAnonymous(env, 'anon'), reportDocId('anon')),
        validReport('anon', { createdAt: Date.now() - 600_000 }),
      ),
    );
  });
});

describe('question_reports: everything but create is console-only', () => {
  const seededId = () => reportDocId('anon', 5);

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'question_reports', seededId()), validReport('anon'));
    });
  });

  // A report can quote another user's content and names its author, so not
  // even the reporter may read one back.
  it('rejects a read, including by the report author', async () => {
    await assertFails(getDoc(reportRef(asAnonymous(env, 'anon'), seededId())));
  });

  it('rejects an update, including by the report author', async () => {
    await assertFails(
      updateDoc(reportRef(asAnonymous(env, 'anon'), seededId()), { reason: 'other' }),
    );
  });

  it('rejects a delete, including by the report author', async () => {
    await assertFails(deleteDoc(reportRef(asAnonymous(env, 'anon'), seededId())));
  });
});
