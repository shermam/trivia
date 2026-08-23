import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { FirestoreRestClient } from './firestore-rest/firestore-rest.client';
import { ReviewerService } from './reviewer.service';

/**
 * `ReviewerService` decides whether the review link and page render. It is UX
 * and carries no authority — `firestore.rules` is what refuses a non-reviewer's
 * write — but H6 is the standing lesson that a client signal which is *broader*
 * than the server's gate is still a real bug: it unlocks a screen the server is
 * bound to refuse, which the user experiences as a page whose buttons never
 * work. The `reviewer: false` case below is the row that pins the strict half,
 * the same way `subscription.service.spec.ts` pins `role: null`.
 */

interface FakeUser {
  uid: string;
}

function setup(document: unknown, options: { throws?: boolean } = {}) {
  const user = signal<FakeUser | null>(null);
  const paths: string[] = [];
  /**
   * Resolvers keyed by the path that was read, so a test can answer one
   * account's in-flight read and leave another's outstanding. Keeping a single
   * resolver would let the second read overwrite the first, and the
   * stale-answer test below would then pass for the wrong reason — it would be
   * asserting on the *current* account's answer, which is exactly the thing it
   * is supposed to prove cannot happen.
   */
  const pending = new Map<string, (value: unknown) => void>();
  let deferred = false;

  const getDocument = vi.fn((path: string) => {
    paths.push(path);
    if (options.throws) {
      return Promise.reject(new Error('boom'));
    }
    if (deferred) {
      return new Promise((resolve) => pending.set(path, resolve));
    }
    return Promise.resolve(document);
  });

  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { user } },
      { provide: FirestoreRestClient, useValue: { getDocument } },
    ],
  });

  const service = TestBed.inject(ReviewerService);
  return {
    service,
    user,
    paths,
    getDocument,
    defer: () => {
      deferred = true;
    },
    /** Answers the outstanding read for exactly one account. */
    release: (uid: string, value: unknown) => pending.get(`user_roles/${uid}`)?.(value),
    flush: async () => {
      TestBed.tick();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('ReviewerService', () => {
  it('reports a granted reviewer', async () => {
    const h = setup({ data: { reviewer: true } });
    h.user.set({ uid: 'rev' });
    await h.flush();

    expect(h.service.isReviewer()).toBe(true);
    expect(h.service.isResolved()).toBe(true);
  });

  it('reads the caller own document, never a path derived from anything else', async () => {
    const h = setup({ data: { reviewer: true } });
    h.user.set({ uid: 'rev' });
    await h.flush();

    expect(h.paths).toEqual(['user_roles/rev']);
  });

  // The strict half. An existing document that says false is not a reviewer,
  // and must not be mistaken for one by a truthiness or existence check —
  // exactly the shape of the bug H6 shipped.
  it('reports an account whose document says reviewer: false as not a reviewer', async () => {
    const h = setup({ data: { reviewer: false } });
    h.user.set({ uid: 'demoted' });
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);
    expect(h.service.isResolved()).toBe(true);
  });

  it('reports a non-boolean reviewer value as not a reviewer', async () => {
    const h = setup({ data: { reviewer: 'yes' } });
    h.user.set({ uid: 'sneaky' });
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);
  });

  it('reports an account with no role document as not a reviewer', async () => {
    const h = setup(null);
    h.user.set({ uid: 'nobody' });
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);
    expect(h.service.isResolved()).toBe(true);
  });

  it('treats a failed read as not a reviewer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = setup(null, { throws: true });
    h.user.set({ uid: 'rev' });
    await h.flush();

    // The safe direction: a reviewer who has to reload, never a non-reviewer
    // handed a page the server would refuse.
    expect(h.service.isReviewer()).toBe(false);
  });

  it('does not read anything while signed out', async () => {
    const h = setup({ data: { reviewer: true } });
    await h.flush();

    expect(h.getDocument).not.toHaveBeenCalled();
    expect(h.service.isReviewer()).toBe(false);
    expect(h.service.isResolved()).toBe(true);
  });

  it('clears the role on sign-out rather than leaving the last answer behind', async () => {
    const h = setup({ data: { reviewer: true } });
    h.user.set({ uid: 'rev' });
    await h.flush();
    expect(h.service.isReviewer()).toBe(true);

    h.user.set(null);
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);
  });

  // The whole reason this is a document and not a claim is that revocation
  // takes effect immediately. A signal that keeps the old answer after the
  // account changes would hand that back.
  it('does not let a read in flight answer for a different account', async () => {
    const h = setup(null);
    h.defer();
    h.user.set({ uid: 'rev' });
    await h.flush();

    // The reviewer signs out and another account signs in. Only *then* does the
    // first account's read come back saying "yes, a reviewer" — for a user who
    // is no longer signed in.
    h.user.set({ uid: 'someone-else' });
    await h.flush();
    h.release('rev', { data: { reviewer: true } });
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);

    // And the answer that does belong to the current account still lands.
    h.release('someone-else', null);
    await h.flush();
    expect(h.service.isReviewer()).toBe(false);
    expect(h.service.isResolved()).toBe(true);
  });

  it('is unresolved until the register has actually answered', async () => {
    const h = setup(null);
    h.defer();
    h.user.set({ uid: 'rev' });
    await h.flush();

    expect(h.service.isResolved()).toBe(false);
  });
});
