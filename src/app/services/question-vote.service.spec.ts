import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { DISLIKE, LIKE, VoteValue } from '../models/question-vote';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';
import { QuestionVoteService, VoteOutcome, describeVoteOutcome } from './question-vote.service';
import { english } from '../i18n/testing';

/**
 * `FEAT-027`. The optimistic half of the private vote: a tap moves the button
 * at once, the write follows, and a failure puts the button back where the
 * stored vote is. The fakes below control *when* each write and read settles,
 * because every interesting case here is about order — a tap racing the read,
 * two taps racing each other, an account changing while a write is out.
 */

interface FakeUser {
  uid: string;
  isAnonymous: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { user?: FakeUser | null; real?: boolean } = {}) {
  const user = signal<FakeUser | null>(
    options.user === undefined ? { uid: 'u1', isAnonymous: false } : options.user,
  );
  const isFullyAuthenticated = signal(options.real ?? true);
  const firebase = {
    getOwnQuestionVotes: vi.fn(
      (_uid: string, _ids: readonly string[]): Promise<Map<string, VoteValue>> =>
        Promise.resolve(new Map()),
    ),
    setQuestionVote: vi.fn(
      (_uid: string, _id: string, _value: VoteValue | null, _existing: boolean): Promise<void> =>
        Promise.resolve(),
    ),
  };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { user, isFullyAuthenticated } },
      { provide: FirebaseService, useValue: firebase },
    ],
  });
  return { service: TestBed.inject(QuestionVoteService), user, isFullyAuthenticated, firebase };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('QuestionVoteService: reading the caller’s own votes', () => {
  it('reads once for the game’s questions and shows what is stored', async () => {
    const { service, firebase } = setup();
    firebase.getOwnQuestionVotes.mockResolvedValue(
      new Map<string, VoteValue>([
        ['q1', LIKE],
        ['q2', DISLIKE],
      ]),
    );

    await service.load(['q1', 'q2', 'q3']);

    expect(firebase.getOwnQuestionVotes).toHaveBeenCalledExactlyOnceWith('u1', ['q1', 'q2', 'q3']);
    expect(service.valueFor('q1')).toBe(LIKE);
    expect(service.valueFor('q2')).toBe(DISLIKE);
    expect(service.valueFor('q3')).toBeNull();
  });

  // `/game-over` asks about the same questions `/play` already read. A second
  // read would be billed for an answer the tab already has.
  it('asks only about questions it does not know yet', async () => {
    const { service, firebase } = setup();

    await service.load(['q1', 'q2']);
    await service.load(['q1', 'q2']);
    await service.load(['q2', 'q3']);

    expect(firebase.getOwnQuestionVotes.mock.calls.map(([, ids]) => ids)).toEqual([
      ['q1', 'q2'],
      ['q3'],
    ]);
  });

  // An anonymous account cannot have a vote and the read rule would refuse
  // it, so there is nothing to ask — and asking would be a refused read on
  // every custom game most visitors play.
  it('reads nothing for an account that cannot vote', async () => {
    for (const options of [
      { user: { uid: 'anon', isAnonymous: true }, real: false },
      { user: { uid: 'unverified', isAnonymous: false }, real: false },
      { user: null, real: false },
    ]) {
      const { service, firebase } = setup(options);

      await service.load(['q1']);

      expect(firebase.getOwnQuestionVotes).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
    }
  });

  // `CLAUDE.md` §4.4: a remembered failure turns one bad moment into a
  // session that never shows a vote again.
  it('does not remember a failed read', async () => {
    const { service, firebase } = setup();
    firebase.getOwnQuestionVotes
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Map<string, VoteValue>([['q1', LIKE]]));

    await service.load(['q1']);
    expect(service.valueFor('q1')).toBeNull();

    await service.load(['q1']);
    expect(service.valueFor('q1')).toBe(LIKE);
  });

  // The tap is newer than the read, and the write behind it is what will be
  // stored — so the read's older answer must not move the button back.
  it('lets a tap made while the read is out win over the read', async () => {
    const { service, firebase } = setup();
    const read = deferred<Map<string, VoteValue>>();
    firebase.getOwnQuestionVotes.mockReturnValue(read.promise);

    const loading = service.load(['q1']);
    void service.toggle('q1', LIKE);
    read.resolve(new Map<string, VoteValue>([['q1', DISLIKE]]));
    await loading;

    expect(service.valueFor('q1')).toBe(LIKE);
  });

  it('drops an answer that arrives after the account changed', async () => {
    const { service, firebase, user } = setup();
    const read = deferred<Map<string, VoteValue>>();
    firebase.getOwnQuestionVotes.mockReturnValueOnce(read.promise);

    const loading = service.load(['q1']);
    user.set({ uid: 'u2', isAnonymous: false });
    await service.load([]);
    read.resolve(new Map<string, VoteValue>([['q1', LIKE]]));
    await loading;

    expect(service.valueFor('q1')).toBeNull();
  });
});

describe('QuestionVoteService: a tap', () => {
  /**
   * Decision 1. The buttons are there for everybody — hiding them would hide
   * the feature from most of the traffic — but a tap without a real account
   * writes nothing and says what would let it.
   */
  it('writes nothing without a real account, and says which kind is missing', async () => {
    const cases: [FakeUser | null, VoteOutcome][] = [
      [
        { uid: 'anon', isAnonymous: true },
        { kind: 'needs-account', reason: 'sign-in' },
      ],
      [null, { kind: 'needs-account', reason: 'sign-in' }],
      [
        { uid: 'unverified', isAnonymous: false },
        { kind: 'needs-account', reason: 'verify' },
      ],
    ];
    for (const [user, expected] of cases) {
      const { service, firebase } = setup({ user, real: false });

      expect(await service.toggle('q1', LIKE)).toEqual(expected);
      expect(service.valueFor('q1')).toBeNull();
      expect(firebase.setQuestionVote).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
    }
  });

  it('moves the button before the write lands, then reports it saved', async () => {
    const { service, firebase } = setup();
    const write = deferred<void>();
    firebase.setQuestionVote.mockReturnValue(write.promise);

    const outcome = service.toggle('q1', LIKE);
    expect(service.valueFor('q1')).toBe(LIKE);
    await flush();
    expect(firebase.setQuestionVote).toHaveBeenCalledWith('u1', 'q1', LIKE, false);

    write.resolve();
    expect(await outcome).toEqual({ kind: 'saved', value: LIKE });
  });

  it('removes the vote when the pressed button is pressed again', async () => {
    const { service, firebase } = setup();
    firebase.getOwnQuestionVotes.mockResolvedValue(new Map<string, VoteValue>([['q1', LIKE]]));
    await service.load(['q1']);

    const outcome = await service.toggle('q1', LIKE);

    expect(outcome).toEqual({ kind: 'saved', value: null });
    expect(firebase.setQuestionVote).toHaveBeenCalledWith('u1', 'q1', null, true);
    expect(service.valueFor('q1')).toBeNull();
  });

  // A stored vote is changed with an update of the value alone, so the write
  // is told one is there.
  it('changes a stored vote when the other button is pressed', async () => {
    const { service, firebase } = setup();
    firebase.getOwnQuestionVotes.mockResolvedValue(new Map<string, VoteValue>([['q1', LIKE]]));
    await service.load(['q1']);

    expect(await service.toggle('q1', DISLIKE)).toEqual({ kind: 'saved', value: DISLIKE });
    expect(firebase.setQuestionVote).toHaveBeenCalledWith('u1', 'q1', DISLIKE, true);
    expect(service.valueFor('q1')).toBe(DISLIKE);
  });

  it('puts the button back to the stored vote when the write fails', async () => {
    const { service, firebase } = setup();
    firebase.getOwnQuestionVotes.mockResolvedValue(new Map<string, VoteValue>([['q1', LIKE]]));
    firebase.setQuestionVote.mockRejectedValue(new Error('refused'));
    await service.load(['q1']);

    const outcome = await service.toggle('q1', DISLIKE);

    expect(outcome).toEqual({ kind: 'failed', attempted: DISLIKE, value: LIKE });
    expect(service.valueFor('q1')).toBe(LIKE);
  });

  // With nothing read, "the stored vote" is unknown — the honest place to go
  // back to is what the button showed before the tap.
  it('puts the button back to what it showed when nothing is known about the stored vote', async () => {
    const { service, firebase } = setup();
    firebase.setQuestionVote.mockRejectedValue(new Error('offline'));

    const outcome = await service.toggle('q1', LIKE);

    expect(outcome).toEqual({ kind: 'failed', attempted: LIKE, value: null });
    expect(service.valueFor('q1')).toBeNull();
  });

  /**
   * A like and its removal sent at once could land in either order, and the
   * second to land would decide what is stored while the button showed the
   * other. So they queue, and only the last tap is reported — the earlier one
   * was overtaken before it finished.
   */
  it('sends a question’s writes one after another and reports only the last tap', async () => {
    const { service, firebase } = setup();
    const first = deferred<void>();
    const second = deferred<void>();
    firebase.setQuestionVote.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const liked = service.toggle('q1', LIKE);
    const removed = service.toggle('q1', LIKE);
    await flush();
    expect(firebase.setQuestionVote).toHaveBeenCalledTimes(1);

    first.resolve();
    expect(await liked).toEqual({ kind: 'superseded' });
    await flush();
    // The second write knows the first landed, so it is sent as a change.
    expect(firebase.setQuestionVote).toHaveBeenLastCalledWith('u1', 'q1', null, true);

    second.resolve();
    expect(await removed).toEqual({ kind: 'saved', value: null });
    expect(service.valueFor('q1')).toBeNull();
  });

  it('goes back to what an earlier write stored when the latest one fails', async () => {
    const { service, firebase } = setup();
    const first = deferred<void>();
    const second = deferred<void>();
    firebase.setQuestionVote.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const liked = service.toggle('q1', LIKE);
    const disliked = service.toggle('q1', DISLIKE);
    first.resolve();
    await liked;
    second.reject(new Error('refused'));

    expect(await disliked).toEqual({ kind: 'failed', attempted: DISLIKE, value: LIKE });
    expect(service.valueFor('q1')).toBe(LIKE);
  });

  // Both writes failed and nothing was ever read: the stored vote is whatever
  // it was before the *first* of them, which is what the button showed then.
  it('goes back to what the button showed before the first of two failed writes', async () => {
    const { service, firebase } = setup();
    firebase.setQuestionVote.mockRejectedValue(new Error('offline'));

    const liked = service.toggle('q1', LIKE);
    const removed = service.toggle('q1', LIKE);

    expect(await liked).toEqual({ kind: 'superseded' });
    expect(await removed).toEqual({ kind: 'failed', attempted: null, value: null });
    expect(service.valueFor('q1')).toBeNull();
  });
});

describe('QuestionVoteService: one account at a time', () => {
  it('shows nothing of one account’s votes to the next', async () => {
    const { service, firebase, user } = setup();
    firebase.getOwnQuestionVotes.mockResolvedValue(new Map<string, VoteValue>([['q1', LIKE]]));
    await service.load(['q1']);

    user.set({ uid: 'u2', isAnonymous: false });

    expect(service.valueFor('q1')).toBeNull();
  });

  // An account that stops being a real one — an address changed and not yet
  // verified — cannot vote, so its buttons claim nothing.
  it('shows nothing once the account can no longer vote', async () => {
    const { service, firebase, isFullyAuthenticated } = setup();
    firebase.getOwnQuestionVotes.mockResolvedValue(new Map<string, VoteValue>([['q1', LIKE]]));
    await service.load(['q1']);

    isFullyAuthenticated.set(false);

    expect(service.valueFor('q1')).toBeNull();
  });

  it('reports nothing for a write that lands after the account changed', async () => {
    const { service, firebase, user } = setup();
    const write = deferred<void>();
    firebase.setQuestionVote.mockReturnValueOnce(write.promise);

    const outcome = service.toggle('q1', LIKE);
    user.set({ uid: 'u2', isAnonymous: false });
    await service.load(['q2']);
    write.resolve();

    expect(await outcome).toEqual({ kind: 'superseded' });
    expect(service.valueFor('q1')).toBeNull();
  });
});

describe('describeVoteOutcome', () => {
  it('says what was saved, naming the question by its position', () => {
    expect(english(describeVoteOutcome({ kind: 'saved', value: LIKE }, 3))).toBe(
      'Question 3: you liked this question.',
    );
    expect(english(describeVoteOutcome({ kind: 'saved', value: DISLIKE }, 3))).toBe(
      'Question 3: you disliked this question.',
    );
    expect(english(describeVoteOutcome({ kind: 'saved', value: null }, 3))).toBe(
      'Question 3: your vote was removed.',
    );
  });

  // `CLAUDE.md` §4.4: the cause is not known, so none is narrated.
  it('says a failure did not save, and nothing about why', () => {
    expect(english(describeVoteOutcome({ kind: 'failed', attempted: LIKE, value: null }, 2))).toBe(
      'Question 2: your vote could not be saved. Please try again.',
    );
    expect(english(describeVoteOutcome({ kind: 'failed', attempted: null, value: LIKE }, 2))).toBe(
      'Question 2: your vote could not be removed. Please try again.',
    );
  });

  it('says what a vote needs when there is no real account', () => {
    expect(english(describeVoteOutcome({ kind: 'needs-account', reason: 'sign-in' }, 1))).toBe(
      'Question 1: sign in to like or dislike questions.',
    );
    expect(english(describeVoteOutcome({ kind: 'needs-account', reason: 'verify' }, 1))).toBe(
      'Question 1: verify your email to like or dislike questions.',
    );
  });

  it('says nothing for a tap a later one overtook', () => {
    expect(english(describeVoteOutcome({ kind: 'superseded' }, 1))).toBeNull();
  });
});
