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
  startAfter,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * One page of reports as `ReviewerService.getQuestionReports` asks for it —
 * **the same query, field for field**.
 *
 * The bound is in the query because the *client* puts it there, not because
 * the rule can see it: rules are handed the shape of a query and never its
 * `limit`, so nothing below would change if the app asked for the whole
 * collection. Sending the real shape anyway is what keeps these rows about the
 * read the app issues rather than about one nobody performs — and it is the
 * only place outside the e2e suite where that query meets a real Firestore.
 * That is not hypothetical: an earlier version of the service ordered by
 * `documentId()` alone, which Firestore refuses ("does not support descending
 * key scans"), and this helper is where a query the emulator will not run gets
 * caught.
 */
const reportsPage = (ctx: RulesTestContext) =>
  query(
    collection(ctx.firestore(), 'question_reports'),
    orderBy('createdAt', 'desc'),
    orderBy(documentId(), 'desc'),
    limit(25),
  );

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

  // The second page, from the cursor the first one hands back. A rules test
  // rather than only a unit one because a cursor is a query shape, and a query
  // shape is something only a real Firestore can accept or refuse.
  it('allows a reviewer the next page, from a cursor', async () => {
    const first = await getDocs(reportsPage(asVerifiedPassword(env, REVIEWER)));
    const last = first.docs[first.docs.length - 1];
    await assertSucceeds(
      getDocs(
        query(
          collection(asVerifiedPassword(env, REVIEWER).firestore(), 'question_reports'),
          orderBy('createdAt', 'desc'),
          orderBy(documentId(), 'desc'),
          startAfter(last.data()['createdAt'], last.id),
          limit(25),
        ),
      ),
    );
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

/**
 * A report with nobody in it (`FEAT-042`): what the daily sweep leaves thirty
 * days after a report is filed, and `deleteAccount` the moment its reporter
 * leaves — its four content keys copied to a fresh auto-id, with no
 * `reportedBy`, and the original deleted
 * (`functions/src/report-anonymisation.ts`). The Admin SDK writes it,
 * past every rule, so these rows are about the two things the rules still
 * decide: who may read it, and that no client can write anything like it.
 *
 * **No rule changed for it**, and both halves say so from opposite ends. The
 * read rows are accept cases a reader rule that leaned on `reportedBy` — or on
 * the `{window}-{slot}-{uid}` id — would break, which would take every
 * anonymised complaint out of the reviewers' queue while every reject row here
 * went on passing. The write rows pin that a document naming nobody is
 * something only the server can produce: the create rule requires both the
 * capped id and a `reportedBy` equal to the caller, so neither half of the
 * anonymised shape gets in on its own.
 */
describe('question_reports: an anonymised report (FEAT-042)', () => {
  /** An auto-id, as `collection.doc()` mints one: no window, no slot, no uid. */
  const ANONYMISED_ID = 'Xq3vL9aT2bRk8mNc4PdE';
  /** A second auto-id, free, for the creates that must be refused. */
  const FREE_AUTO_ID = 'Lm7pQ2wZ9cVb3nRt6YkA';

  const anonymisedReport = () => {
    const { reportedBy: _reportedBy, ...content } = validReport('anon', {
      detail: 'Two of the answers are the same.',
    });
    return content;
  };

  beforeEach(async () => {
    await grantReviewer(env, REVIEWER);
    await grantReviewer(env, DEMOTED, false);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'question_reports', ANONYMISED_ID), anonymisedReport());
    });
  });

  it('allows a reviewer to get it', async () => {
    await assertSucceeds(getDoc(reportRef(asVerifiedPassword(env, REVIEWER), ANONYMISED_ID)));
  });

  // The page the reports tab reads, field for field, with the anonymised
  // report on it: the queue orders by `createdAt`, which the copy keeps, so it
  // stays where it was in the list rather than falling out of it.
  it('allows a reviewer the page the queue reads, and the page holds it', async () => {
    const page = await assertSucceeds(getDocs(reportsPage(asVerifiedPassword(env, REVIEWER))));
    expect(page.docs.map((report) => report.id)).toContain(ANONYMISED_ID);
  });

  // The list row a per-document rule would still serve — the shape
  // `CLAUDE.md` §4.6 records — so a reviewer read narrowed to documents
  // carrying a reporter fails here, and not only in the `get` above.
  it('allows a reviewer a query constrained to its document id', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(asVerifiedPassword(env, REVIEWER).firestore(), 'question_reports'),
          where(documentId(), '==', ANONYMISED_ID),
        ),
      ),
    );
  });

  it('denies a signed-in account with no role document', async () => {
    await assertFails(getDoc(reportRef(asVerifiedPassword(env, PLAIN), ANONYMISED_ID)));
    await assertFails(getDocs(reportsPage(asVerifiedPassword(env, PLAIN))));
  });

  it('denies an account whose role document says reviewer: false', async () => {
    await assertFails(getDoc(reportRef(asVerifiedPassword(env, DEMOTED), ANONYMISED_ID)));
    await assertFails(getDocs(reportsPage(asVerifiedPassword(env, DEMOTED))));
  });

  // Including the session that filed the original: losing the reporter does
  // not hand the report back to them.
  it('denies the anonymous session that filed the original', async () => {
    await assertFails(getDoc(reportRef(asAnonymous(env, 'anon'), ANONYMISED_ID)));
    await assertFails(getDocs(reportsPage(asAnonymous(env, 'anon'))));
  });

  it('denies a signed-out caller', async () => {
    await assertFails(getDoc(reportRef(asSignedOut(env), ANONYMISED_ID)));
    await assertFails(getDocs(reportsPage(asSignedOut(env))));
  });

  it('refuses a client creating a report in the anonymised shape: an auto-id and no reportedBy', async () => {
    await assertFails(
      setDoc(reportRef(asAnonymous(env, 'anon'), FREE_AUTO_ID), anonymisedReport()),
    );
  });

  // Each half of that shape on its own, so dropping either clause of the
  // create rule fails a row of its own rather than hiding behind the other.
  it('refuses the anonymised shape at an id the volume cap accepts: reportedBy is required', async () => {
    await assertFails(
      setDoc(reportRef(asAnonymous(env, 'anon'), reportDocId('anon')), anonymisedReport()),
    );
  });

  it('refuses a report naming its caller at an auto-id: the id has to carry the window and the uid', async () => {
    await assertFails(
      setDoc(reportRef(asAnonymous(env, 'anon'), FREE_AUTO_ID), validReport('anon')),
    );
  });

  it('refuses a reviewer creating one', async () => {
    await assertFails(
      setDoc(reportRef(asVerifiedPassword(env, REVIEWER), FREE_AUTO_ID), anonymisedReport()),
    );
  });

  it('refuses an update by a reviewer, putting a reporter back included', async () => {
    await assertFails(
      updateDoc(reportRef(asVerifiedPassword(env, REVIEWER), ANONYMISED_ID), {
        reportedBy: REVIEWER,
      }),
    );
  });

  it('refuses the original reporter re-attaching themselves', async () => {
    await assertFails(
      updateDoc(reportRef(asAnonymous(env, 'anon'), ANONYMISED_ID), { reportedBy: 'anon' }),
    );
  });

  it('refuses a delete by a reviewer', async () => {
    await assertFails(deleteDoc(reportRef(asVerifiedPassword(env, REVIEWER), ANONYMISED_ID)));
  });

  // The accept case beside it: filing a report is exactly as it was.
  it('still accepts a report in the client shape beside it', async () => {
    await assertSucceeds(
      setDoc(reportRef(asAnonymous(env, 'anon'), reportDocId('anon')), validReport('anon')),
    );
  });
});
