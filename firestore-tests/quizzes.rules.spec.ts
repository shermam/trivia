import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnonymous,
  asOAuth,
  asPro,
  asSignedOut,
  asUnverifiedPassword,
  asVerifiedPassword,
  createTestEnv,
  grantReviewer,
} from './helpers';

/**
 * `quizzes` (`FEAT-024`): readable when published, writable by no client at all.
 *
 * **With every write denied, the accept cases are nearly the whole of what can
 * go wrong silently.** A rule that refuses everything passes every
 * `assertFails` below — so the reads of a published quiz, by every kind of
 * caller and by the exact query the app sends, are what stop this file passing
 * against a broken rule (`CLAUDE.md` §4.6). The rows were checked by breaking
 * the rule on purpose, clause by clause; `docs/data-model.md` records what each
 * mutation failed.
 */

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-quizzes');
});
afterAll(() => env.cleanup());

/** Who wrote the fixtures — an account that exists, so "the curator" is a caller too. */
const CURATOR = 'curator-uid';
const REVIEWER = 'reviewer-uid';
const PLAYER = 'player-uid';

/** A quiz as the seed script writes one. Spread over it for the variants. */
function quiz(overrides: Record<string, unknown> = {}) {
  return {
    title: 'The 1998 World Cup',
    description: 'Ten questions, in the order the tournament played them.',
    questionIds: ['q-1', 'q-2', 'q-3'],
    createdBy: CURATOR,
    createdAt: 1_759_900_000_000,
    isPublished: true,
    ...overrides,
  };
}

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'quizzes', 'published'), quiz());
    await setDoc(doc(db, 'quizzes', 'older'), quiz({ createdAt: 1_759_000_000_000 }));
    await setDoc(doc(db, 'quizzes', 'draft'), quiz({ isPublished: false }));
    // Written by hand in the console, which is the only way either can exist.
    const { isPublished: _omitted, ...unflagged } = quiz();
    await setDoc(doc(db, 'quizzes', 'no-flag'), unflagged);
    await setDoc(doc(db, 'quizzes', 'string-flag'), quiz({ isPublished: 'true' }));
  });
  await grantReviewer(env, REVIEWER);
});

const quizRef = (ctx: RulesTestContext, id: string) => doc(ctx.firestore(), 'quizzes', id);
const quizzes = (ctx: RulesTestContext) => collection(ctx.firestore(), 'quizzes');

/** The list on `/`, exactly as `FirebaseService.getPublishedQuizzes` sends it. */
const publishedList = (ctx: RulesTestContext) =>
  query(quizzes(ctx), where('isPublished', '==', true), orderBy('createdAt', 'desc'), limit(10));

describe('quizzes: get — a published quiz is public', () => {
  it('serves a published quiz to a signed-out visitor', async () => {
    await assertSucceeds(getDoc(quizRef(asSignedOut(env), 'published')));
  });

  it('serves a published quiz to an anonymous session', async () => {
    await assertSucceeds(getDoc(quizRef(asAnonymous(env, 'anon-uid'), 'published')));
  });

  it('serves a published quiz to an unverified password account', async () => {
    await assertSucceeds(getDoc(quizRef(asUnverifiedPassword(env, PLAYER), 'published')));
  });

  it('serves a published quiz to a verified account', async () => {
    await assertSucceeds(getDoc(quizRef(asVerifiedPassword(env, PLAYER), 'published')));
  });

  it('serves a published quiz to an OAuth account', async () => {
    await assertSucceeds(getDoc(quizRef(asOAuth(env, PLAYER), 'published')));
  });

  it('serves a published quiz to a Pro subscriber', async () => {
    await assertSucceeds(getDoc(quizRef(asPro(env, PLAYER), 'published')));
  });

  it('serves a published quiz to a reviewer', async () => {
    await assertSucceeds(getDoc(quizRef(asVerifiedPassword(env, REVIEWER), 'published')));
  });

  // Nothing about the schema is checked on the way out, because nothing is
  // checked on the way in: there is no allowlist, which is what lets the
  // fields `FEAT-021`, `FEAT-030`, `FEAT-035` and `FEAT-020` §C name be added
  // without a rules deploy. A published quiz carrying all of them still reads.
  it('serves a published quiz carrying fields no feature reads yet', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'quizzes', 'grown'),
        quiz({
          tags: ['football', 'history'],
          language: 'pt-BR',
          sponsorId: null,
          suggestedTimeLimit: 30,
          ownerUid: 'ultra-subscriber',
        }),
      );
    });
    await assertSucceeds(getDoc(quizRef(asSignedOut(env), 'grown')));
  });
});

describe('quizzes: get — anything unpublished is nobody’s', () => {
  it('refuses a draft to a signed-out visitor', async () => {
    await assertFails(getDoc(quizRef(asSignedOut(env), 'draft')));
  });

  it('refuses a draft to an anonymous session', async () => {
    await assertFails(getDoc(quizRef(asAnonymous(env, 'anon-uid'), 'draft')));
  });

  it('refuses a draft to a Pro subscriber', async () => {
    await assertFails(getDoc(quizRef(asPro(env, PLAYER), 'draft')));
  });

  // There is no moderation of quizzes in the app — a reviewer's role is the
  // question bank — so a reviewer sees what everybody sees.
  it('refuses a draft to a reviewer', async () => {
    await assertFails(getDoc(quizRef(asVerifiedPassword(env, REVIEWER), 'draft')));
  });

  // `createdBy` names the curator, never an owner the rules recognise: there is
  // no author branch to show a draft to, because there is no author in the app.
  it('refuses a draft to the account its createdBy names', async () => {
    await assertFails(getDoc(quizRef(asVerifiedPassword(env, CURATOR), 'draft')));
  });

  it('refuses a quiz with no isPublished at all', async () => {
    await assertFails(getDoc(quizRef(asSignedOut(env), 'no-flag')));
  });

  // A console typo of `"true"` is not a publication, and neither is a `1`.
  // These hold `!= false` off; they cannot tell `== true` from a bare
  // `resource.data.isPublished`, because the rules language refuses a
  // non-boolean condition rather than coercing it — the one mutation the sweep
  // recorded as invisible (`docs/data-model.md`).
  it('refuses a quiz whose isPublished is the string "true"', async () => {
    await assertFails(getDoc(quizRef(asSignedOut(env), 'string-flag')));
  });

  it('refuses a quiz whose isPublished is the number 1', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'quizzes', 'number-flag'), quiz({ isPublished: 1 }));
    });
    await assertFails(getDoc(quizRef(asSignedOut(env), 'number-flag')));
  });

  // A missing quiz is refused rather than reported missing, so a stranger
  // cannot tell a draft's address from one that was never written. The app
  // reads the refusal as "no published quiz here" (`FirebaseService.getQuiz`).
  it('refuses a quiz that does not exist rather than reporting it missing', async () => {
    await assertFails(getDoc(quizRef(asSignedOut(env), 'never-written')));
  });

  it('refuses a signed-in account a quiz that does not exist, the same way', async () => {
    await assertFails(getDoc(quizRef(asVerifiedPassword(env, PLAYER), 'never-written')));
  });
});

describe('quizzes: list — the published ones, filtered for', () => {
  it('serves the list the app sends to a signed-out visitor, published quizzes only', async () => {
    const snapshot = await assertSucceeds(getDocs(publishedList(asSignedOut(env))));
    expect(snapshot.docs.map((document) => document.id)).toEqual(['published', 'older']);
  });

  it('serves the list the app sends to a signed-in account', async () => {
    await assertSucceeds(getDocs(publishedList(asVerifiedPassword(env, PLAYER))));
  });

  // Rules are not filters: an unfiltered query is refused outright rather than
  // narrowed to the published quizzes, which is why the app's query carries
  // the `where` it does.
  it('refuses an unfiltered list', async () => {
    await assertFails(getDocs(query(quizzes(asSignedOut(env)), limit(10))));
  });

  it('refuses a list filtered on something other than isPublished', async () => {
    await assertFails(
      getDocs(query(quizzes(asSignedOut(env)), where('createdBy', '==', CURATOR), limit(10))),
    );
  });

  it('refuses a list of the drafts', async () => {
    await assertFails(
      getDocs(query(quizzes(asSignedOut(env)), where('isPublished', '==', false), limit(10))),
    );
  });

  // The query an owner branch would serve — and there is no owner: the curator
  // named in `createdBy` lists nothing a stranger could not.
  it('refuses the curator a list of their own quizzes, drafts included', async () => {
    await assertFails(
      getDocs(
        query(
          quizzes(asVerifiedPassword(env, CURATOR)),
          where('createdBy', '==', CURATOR),
          limit(10),
        ),
      ),
    );
  });

  it('refuses the drafts to a reviewer as well', async () => {
    await assertFails(
      getDocs(
        query(
          quizzes(asVerifiedPassword(env, REVIEWER)),
          where('isPublished', '==', false),
          limit(10),
        ),
      ),
    );
  });
});

describe('quizzes: no client writes, of any shape, by anybody', () => {
  it('refuses a signed-out visitor creating a quiz', async () => {
    await assertFails(setDoc(quizRef(asSignedOut(env), 'new-quiz'), quiz()));
  });

  it('refuses an anonymous session creating a quiz', async () => {
    await assertFails(setDoc(quizRef(asAnonymous(env, 'anon-uid'), 'new-quiz'), quiz()));
  });

  it('refuses a verified account creating a quiz', async () => {
    await assertFails(
      setDoc(quizRef(asVerifiedPassword(env, PLAYER), 'new-quiz'), quiz({ createdBy: PLAYER })),
    );
  });

  it('refuses an OAuth account creating a quiz', async () => {
    await assertFails(setDoc(quizRef(asOAuth(env, PLAYER), 'new-quiz'), quiz()));
  });

  // Contributing questions is what Pro buys; curating quizzes is not part of it.
  it('refuses a Pro subscriber creating a quiz', async () => {
    await assertFails(setDoc(quizRef(asPro(env, PLAYER), 'new-quiz'), quiz({ createdBy: PLAYER })));
  });

  it('refuses a Pro subscriber creating a quiz under an auto-id', async () => {
    await assertFails(addDoc(quizzes(asPro(env, PLAYER)), quiz({ createdBy: PLAYER })));
  });

  it('refuses a reviewer creating a quiz', async () => {
    await assertFails(setDoc(quizRef(asVerifiedPassword(env, REVIEWER), 'new-quiz'), quiz()));
  });

  // Any shape at all — the refusal is not a schema check that a better-formed
  // payload could pass.
  it('refuses an empty document', async () => {
    await assertFails(setDoc(quizRef(asPro(env, PLAYER), 'new-quiz'), {}));
  });

  it('refuses the curator editing a published quiz', async () => {
    await assertFails(
      updateDoc(quizRef(asVerifiedPassword(env, CURATOR), 'published'), { title: 'Renamed' }),
    );
  });

  it('refuses a reviewer editing a published quiz', async () => {
    await assertFails(
      updateDoc(quizRef(asVerifiedPassword(env, REVIEWER), 'published'), {
        questionIds: ['q-9'],
      }),
    );
  });

  it('refuses a reviewer publishing a draft', async () => {
    await assertFails(
      updateDoc(quizRef(asVerifiedPassword(env, REVIEWER), 'draft'), { isPublished: true }),
    );
  });

  it('refuses a Pro subscriber unpublishing a quiz', async () => {
    await assertFails(updateDoc(quizRef(asPro(env, PLAYER), 'published'), { isPublished: false }));
  });

  it('refuses a merge write onto a published quiz', async () => {
    await assertFails(
      setDoc(quizRef(asPro(env, PLAYER), 'published'), { title: 'Mine now' }, { merge: true }),
    );
  });

  it('refuses the curator deleting a quiz', async () => {
    await assertFails(deleteDoc(quizRef(asVerifiedPassword(env, CURATOR), 'published')));
  });

  it('refuses a reviewer deleting a quiz', async () => {
    await assertFails(deleteDoc(quizRef(asVerifiedPassword(env, REVIEWER), 'published')));
  });

  it('refuses a Pro subscriber deleting a draft', async () => {
    await assertFails(deleteDoc(quizRef(asPro(env, PLAYER), 'draft')));
  });

  it('refuses a signed-out visitor deleting a quiz', async () => {
    await assertFails(deleteDoc(quizRef(asSignedOut(env), 'published')));
  });
});
