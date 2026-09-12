import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  asAnonymous,
  asSignedOut,
  asVerifiedPassword,
  createTestEnv,
  grantReviewer,
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

const REVIEWER = 'reviewer-uid';
const PLAIN = 'plain-uid';
const DEMOTED = 'demoted-uid';

/**
 * One page of reports as `ReviewerService.getQuestionReports` asks for it.
 *
 * The bound is in the query because the *client* puts it there, not because
 * the rule can see it: rules are handed the shape of a query and never its
 * `limit`, so nothing below would change if the app asked for the whole
 * collection. Sending the real shape anyway is what keeps these rows about the
 * read the app issues rather than about one nobody performs.
 */
const reportsPage = (ctx: RulesTestContext) =>
  query(collection(ctx.firestore(), 'question_reports'), orderBy('createdAt', 'desc'), limit(25));

describe('question_reports: read — the reviewers, and nobody else', () => {
  const seededId = () => reportDocId('anon', 5);

  beforeEach(async () => {
    await grantReviewer(env, REVIEWER);
    await grantReviewer(env, DEMOTED, false);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'question_reports', seededId()), validReport('anon'));
    });
  });

  // The accept cases are the load-bearing half of this block: a file of
  // nothing but `assertFails` passes against a rule that denies everyone,
  // which is exactly the rule this one replaced.
  it('allows a reviewer to get one report', async () => {
    await assertSucceeds(getDoc(reportRef(asVerifiedPassword(env, REVIEWER), seededId())));
  });

  it('allows a reviewer the bounded, ordered page the queue reads', async () => {
    await assertSucceeds(getDocs(reportsPage(asVerifiedPassword(env, REVIEWER))));
  });

  /**
   * **Do not delete this as redundant with the row above it.** Together they
   * are what catches a split into `allow get: if isReviewer()` plus `allow
   * list: if false` — the distinction `CLAUDE.md` §4.6 records a worked
   * example of on `user_roles`. Every reject case in this block keeps passing
   * under that split, and so does the `get` accept case, so a suite without a
   * `list` accept row would look like it covered the difference while covering
   * nothing. A query constrained to one document id is the shape Firestore can
   * prove, and is therefore the one a per-document rule would still serve.
   */
  it('allows a reviewer a query constrained to one document id', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(asVerifiedPassword(env, REVIEWER).firestore(), 'question_reports'),
          where(documentId(), '==', seededId()),
        ),
      ),
    );
  });

  // Nothing in the rule is per-document, so an unfiltered list is allowed too,
  // and saying so here is the honest record of what the grant is. Rules cannot
  // require a `limit`; keeping the read bounded is the client's job
  // (`CLAUDE.md` §4.1), pinned by `reviewer.service.spec.ts` rather than here.
  it('allows a reviewer an unfiltered list, because the rule is collection-wide', async () => {
    await assertSucceeds(
      getDocs(query(collection(asVerifiedPassword(env, REVIEWER).firestore(), 'question_reports'))),
    );
  });

  it('denies a signed-in account with no role document', async () => {
    await assertFails(getDoc(reportRef(asVerifiedPassword(env, PLAIN), seededId())));
    await assertFails(getDocs(reportsPage(asVerifiedPassword(env, PLAIN))));
  });

  // The H6 shape: a role document that exists and says `false` is not a
  // reviewer. An existence check, or a truthiness one, would pass this.
  it('denies an account whose role document says reviewer: false', async () => {
    await assertFails(getDoc(reportRef(asVerifiedPassword(env, DEMOTED), seededId())));
    await assertFails(getDocs(reportsPage(asVerifiedPassword(env, DEMOTED))));
  });

  // Filing a report grants nothing over it. A report can quote another user's
  // content and names its author, and the reporter is not the person who acts
  // on it.
  it('denies the report author reading their own report back', async () => {
    await assertFails(getDoc(reportRef(asAnonymous(env, 'anon'), seededId())));
    await assertFails(getDocs(reportsPage(asAnonymous(env, 'anon'))));
  });

  it('denies a signed-out caller', async () => {
    await assertFails(getDoc(reportRef(asSignedOut(env), seededId())));
    await assertFails(getDocs(reportsPage(asSignedOut(env))));
  });
});

describe('question_reports: a report is a record, not a task', () => {
  const seededId = () => reportDocId('anon', 5);

  beforeEach(async () => {
    await grantReviewer(env, REVIEWER);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'question_reports', seededId()), validReport('anon'));
    });
  });

  it('rejects an update, including by the report author', async () => {
    await assertFails(
      updateDoc(reportRef(asAnonymous(env, 'anon'), seededId()), { reason: 'other' }),
    );
  });

  it('rejects a delete, including by the report author', async () => {
    await assertFails(deleteDoc(reportRef(asAnonymous(env, 'anon'), seededId())));
  });

  // Reading a report does not make it yours to resolve or to erase. There is
  // no "handled" flag by design — adding one would mean a client write path
  // into a collection that deliberately has none — so a reviewer acts on the
  // question and leaves the complaint standing.
  it('rejects an update by a reviewer', async () => {
    await assertFails(
      updateDoc(reportRef(asVerifiedPassword(env, REVIEWER), seededId()), { reason: 'other' }),
    );
  });

  it('rejects a delete by a reviewer', async () => {
    await assertFails(deleteDoc(reportRef(asVerifiedPassword(env, REVIEWER), seededId())));
  });
});
